"use strict";
/**
 * cc-core.js — Claude Code 会话输出速度 (tok/s) 计算引擎
 *
 * 这是 cc-toolkit 插件的核心。它被三个入口复用：
 *   scripts/cc-toolkit.js      (CLI: 实时 / --once / --report / --json)
 *   scripts/cc-hook.js       (Stop hook: 把速度作为 systemMessage 回吐给用户)
 *   scripts/cc-statusline.js (statusline: 单行摘要)
 *
 * ── 数据来源 ────────────────────────────────────────────────────────────
 *   ~/.claude/projects/<项目目录名>/<session-id>.jsonl
 *
 * ── 关键限制（决定了精度）──────────────────────────────────────────────
 * 会话文件是「内容块级」落盘：一个 thinking / text / tool_use 块写一行，
 * 而不是逐 token 流式写入。因此：
 *   · 已结束的响应 → 用该轮 usage.output_tokens ÷ 耗时，数值精确；
 *   · 正在流式的响应 → 只有块落盘的那一刻才会刷新，token 数由字符数估算（标 ≈）。
 * 这不是 bug，是数据源的固有粒度。所有输出都会用 ≈ 明确区分估算值。
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

/** 每个会话文件只回放末尾这么多字节，避免超大会话文件拖慢启动 */
const REPLAY_TAIL_BYTES = 2_000_000;
/** 距最后一次块落盘小于这个毫秒数，就认为该轮仍在流式中 */
const STREAMING_WINDOW_MS = 3000;
/** 样本过滤：低于这个 token 数或这个时长的响应不进入统计（噪声太大） */
const MIN_SAMPLE_TOKENS = 50;
const MIN_SAMPLE_MS = 300;
/** 最多保留多少条已完成样本 */
const MAX_SAMPLES = 500;
/** 写入文件缓存的上限 */
const MAX_CACHE_ENTRIES = 500;

// ── 小工具 ─────────────────────────────────────────────────────────────

const formatTokens = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(Math.round(n)));
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const hhmmss = (ms) => new Date(ms).toTimeString().slice(0, 8);

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/**
 * 字符数 → token 估算。
 * CJK（码点 > 0x2e80）约 1.5 字符 = 1 token，其余约 4 字符 = 1 token。
 * 只用于流式过程中 usage 尚未落盘的窗口，落盘后会被精确值替换。
 */
function estimateTokens(text) {
  if (!text) return 0;
  let wide = 0;
  let narrow = 0;
  for (const ch of text) {
    if (ch.codePointAt(0) > 0x2e80) wide++;
    else narrow++;
  }
  return wide / 1.5 + narrow / 4;
}

/** 当前工作目录 → Claude Code 的项目目录名（非字母数字一律换成 -） */
function projectDirFor(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

// ── 会话文件发现 ────────────────────────────────────────────────────────

/**
 * 扫描所有会话文件，按修改时间降序。
 * @param {{project?: string|null, projectsDir?: string}} [opts]
 * @returns {Array<{file:string, mtimeMs:number, size:number, project:string, session:string}>}
 */
function listSessions(opts = {}) {
  const projectsDir = opts.projectsDir || PROJECTS_DIR;
  const filter = opts.project || null;
  const out = [];

  let dirs;
  try {
    dirs = fs.readdirSync(projectsDir);
  } catch {
    return out;
  }

  for (const dirName of dirs) {
    if (filter && !dirName.includes(filter)) continue;
    const dir = path.join(projectsDir, dirName);
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const file = path.join(dir, entry);
      try {
        const st = fs.statSync(file);
        if (!st.isFile()) continue;
        out.push({
          file,
          mtimeMs: st.mtimeMs,
          size: st.size,
          project: dirName,
          session: entry.replace(/\.jsonl$/, ""),
        });
      } catch {
        /* 文件在扫描途中消失，忽略 */
      }
    }
  }

  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * 定位要跟踪的会话文件。
 * 优先级：显式指定 > 当前工作目录对应的项目 > 全局最新。
 * @returns {string|null}
 */
function pickSessionFile(opts = {}) {
  if (opts.explicit) return path.resolve(opts.explicit);

  const list = listSessions(opts);
  if (!list.length) return null;

  if (!opts.project) {
    const want = projectDirFor(opts.cwd || process.cwd());
    const hit = list.find((s) => s.project === want);
    if (hit) return hit.file;
  }
  return list[0].file;
}

// ── 会话跟踪器 ──────────────────────────────────────────────────────────

/**
 * 增量跟踪一个会话文件，维护每一轮响应的 token / 耗时 / tok-s 统计。
 */
class SessionTracker {
  constructor(file) {
    this.file = file;
    this.offset = 0;
    this.lastTs = null; // 上一行（任意类型）的时间戳，作为新响应的起点
    this.groups = new Map(); // message.id -> 轮次统计
    this.currentId = null;
    this.samples = []; // 已完成的响应样本
    this.lastEventAt = 0; // 最后一次块落盘的本地时间，用于判断是否仍在流式
    this.parsedLines = 0;
    this.parseErrors = 0;
  }

  /** 从文件末尾附近开始，跳过超长会话的头部 */
  start({ replayTailBytes = REPLAY_TAIL_BYTES } = {}) {
    let st;
    try {
      st = fs.statSync(this.file);
    } catch {
      return this;
    }
    this.offset = Math.max(0, st.size - replayTailBytes);
    this.pump();
    return this;
  }

  _groupOf(id, startTs) {
    let g = this.groups.get(id);
    if (!g) {
      // out = usage 里的精确输出 token 数；est = 由内容字符数估算（仅流式窗口内使用）
      g = { id, start: startTs, end: startTs, out: 0, est: 0, firstAt: null };
      this.groups.set(id, g);
    }
    return g;
  }

  _archive(id) {
    const g = this.groups.get(id);
    if (!g) return;
    this.groups.delete(id);
    if (this.currentId === id) this.currentId = null;

    const tokens = this.tokensOf(g);
    const durMs = g.end - g.start;
    if (tokens >= MIN_SAMPLE_TOKENS && durMs > MIN_SAMPLE_MS) {
      this.samples.push({
        tokens,
        estimated: g.out === 0,
        durMs,
        tps: tokens / (durMs / 1000),
        at: g.end,
      });
    }
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
  }

  /**
   * 归档指定轮次（幂等）。
   */
  archiveRound(id) {
    if (id) this._archive(id);
    return this;
  }

  /**
   * 收尾：把「已经结束、但还没有下一轮来触发归档」的当前轮次也纳入统计视图。
   *
   * 最后一轮永远等不到下一个 message.id。如果不收尾，/cc-toolkit:tps 的统计和状态栏
   * 就永远漏掉最新的一轮（会话越短这个偏差越显眼）。
   *
   * 默认不修改 tracker 状态：只在返回的样本列表里追加当前轮，
   * 这样 tracker.currentSpeed() 仍然能报告「刚结束的这一轮」。
   *
   * @param {{force?: boolean, now?: number}} [opts]
   *   force=true 时无条件收尾（Stop 事件本身就是「本轮已结束」的信号）。
   * @returns {Array} 完整样本列表（已归档 + 收尾的当前轮）
   */
  finalizedSamples({ force = false, now = Date.now() } = {}) {
    const g = this.currentGroup();
    if (!g) return this.samples;
    if (!force && now - g.end < STREAMING_WINDOW_MS) return this.samples;

    const tokens = this.tokensOf(g);
    const durMs = g.end - g.start;
    if (tokens < MIN_SAMPLE_TOKENS || durMs <= MIN_SAMPLE_MS) return this.samples;

    return [
      ...this.samples,
      { tokens, estimated: g.out === 0, durMs, tps: tokens / (durMs / 1000), at: g.end },
    ];
  }

  /** 已归档的样本 + 已结束的当前轮 */
  allSamples(opts) {
    return this.finalizedSamples(opts);
  }

  /** 某一轮的有效 token 数：优先 usage 精确值，否则用估算值 */
  tokensOf(g) {
    return g.out > 0 ? g.out : g.est;
  }

  /** 处理一行 JSONL */
  handleLine(line) {
    let record;
    try {
      record = JSON.parse(line);
      this.parsedLines++;
    } catch {
      this.parseErrors++;
      return;
    }

    // 兼容 progress / summary 等非 assistant 行的时间戳推进
    const ts = record.timestamp ? Date.parse(record.timestamp) : null;

    // 子代理（isSidechain）不计入主会话速度
    if (record.type === "assistant" && record.isSidechain) return;

    if (record.type === "assistant" && record.message && record.message.id) {
      const id = record.message.id;

      if (id !== this.currentId) {
        if (this.currentId) this._archive(this.currentId);
        this.currentId = id;
      }

      const g = this._groupOf(id, this.lastTs ?? ts ?? Date.now());
      for (const block of record.message.content || []) {
        if (block.type === "text") {
          g.est += estimateTokens(block.text || "");
          if (g.firstAt == null) g.firstAt = ts;
        } else if (block.type === "thinking") {
          g.est += estimateTokens(block.thinking || "");
          if (g.firstAt == null) g.firstAt = ts;
        }
      }

      const out = (record.message.usage && record.message.usage.output_tokens) || 0;
      if (out > g.out) g.out = out;
      if (ts) g.end = Math.max(g.end, ts);
      this.lastEventAt = Date.now();
    }

    if (ts && (!this.lastTs || ts > this.lastTs)) this.lastTs = ts;
  }

  /** 增量读取文件新增内容 */
  pump() {
    if (!this.file) return this;
    let st;
    try {
      st = fs.statSync(this.file);
    } catch {
      return this;
    }

    if (st.size < this.offset) this.offset = 0; // 文件被截断 / 轮转
    if (st.size === this.offset) return this;

    const len = st.size - this.offset;
    const buf = Buffer.alloc(len);
    let fd;
    try {
      fd = fs.openSync(this.file, "r");
      fs.readSync(fd, buf, 0, len, this.offset);
    } catch {
      return this;
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    }
    this.offset = st.size;

    const lines = buf.toString("utf8").split("\n");
    // 最后一段可能是不完整的一行，回退 offset 下次再读
    const tail = lines.pop();
    if (tail && tail.length) this.offset -= Buffer.byteLength(tail, "utf8");
    for (const l of lines) if (l.trim()) this.handleLine(l);

    return this;
  }

  /** 当前轮次（可能为 null） */
  currentGroup() {
    return this.currentId ? this.groups.get(this.currentId) || null : null;
  }

  /**
   * 计算某一轮的速度快照。
   * 流式中：分母用「现在」（从本轮第一个块算起）；静止后：用整轮真实耗时。
   */
  speedOf(g, now = Date.now()) {
    const streaming = now - g.end < STREAMING_WINDOW_MS;
    const denomMs = streaming ? (g.firstAt ? now - g.firstAt : now - g.start) : g.end - g.start;
    const denom = denomMs / 1000;
    const tokens = this.tokensOf(g);
    return {
      tokens,
      estimated: g.out === 0,
      streaming,
      denom,
      tps: denom > 0.4 ? tokens / denom : 0,
      start: g.start,
      end: g.end,
    };
  }

  /** 当前轮的速度快照，没有进行中的响应则返回 null */
  currentSpeed(now = Date.now()) {
    const g = this.currentGroup();
    if (!g || this.tokensOf(g) < 1) return null;
    return this.speedOf(g, now);
  }

  /**
   * 最近 n 条样本（含已结束的当前轮，见 finalizedSamples）。
   * @param {number} [n] 省略则返回全部
   * @param {{force?: boolean, now?: number}} [opts] 交给 finalizedSamples
   */
  recentSamples(n, opts) {
    const all = this.finalizedSamples(opts);
    return n == null ? all : all.slice(-n);
  }

  /** 已完成样本的汇总统计 */
  stats(sampleSet) {
    const rows = sampleSet || this.recentSamples();
    if (!rows.length) return null;
    const tpsList = rows.map((d) => d.tps);
    const best = rows.reduce((a, b) => (b.tps > a.tps ? b : a));
    const worst = rows.reduce((a, b) => (b.tps < a.tps ? b : a));
    return {
      count: rows.length,
      median: median(tpsList),
      p90: percentile(tpsList, 90),
      mean: tpsList.reduce((a, b) => a + b, 0) / tpsList.length,
      best,
      worst,
      totalTokens: rows.reduce((a, d) => a + d.tokens, 0),
      totalMs: rows.reduce((a, d) => a + d.durMs, 0),
    };
  }

  /**
   * 把全部样本 + 汇总指标序列化，供跨进程共享（statusline 用）。
   * 不写文件的话 statusline 每次刷新都要回放 2MB 日志，代价太高。
   *
   * 这里用 force 收尾：Stop hook 调用本方法时，事件本身就意味着本轮已结束，
   * 没必要再等 3 秒的流式窗口，否则缓存会永远落后一轮。
   */
  snapshot({ force = false } = {}) {
    return {
      v: 1,
      file: this.file,
      at: Date.now(),
      parsedLines: this.parsedLines,
      samples: this.finalizedSamples({ force }).slice(-MAX_SAMPLES),
    };
  }
}

// ── 跨进程缓存（给 statusline 用）──────────────────────────────────────

function cacheFileFor(sessionId) {
  return path.join(os.tmpdir(), `cc-toolkit-${sessionId || "default"}.json`);
}

/** 读缓存；过期（超过 maxAgeMs）或损坏都返回 null */
function readCache(sessionId, maxAgeMs = 12 * 60 * 60 * 1000) {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFileFor(sessionId), "utf8"));
    if (!raw || raw.v !== 1 || !Array.isArray(raw.samples)) return null;
    if (Date.now() - raw.at > maxAgeMs) return null;
    return raw;
  } catch {
    return null;
  }
}

function writeCache(sessionId, snapshot) {
  try {
    const data = { ...snapshot, samples: (snapshot.samples || []).slice(-MAX_CACHE_ENTRIES) };
    fs.writeFileSync(cacheFileFor(sessionId), JSON.stringify(data), "utf8");
  } catch {
    /* 缓存写不进去不影响主流程 */
  }
}

// ── 构造入口 ────────────────────────────────────────────────────────────

/**
 * 用 Stop hook 的 stdin 事件打开对应会话。
 * 事件里的 transcript_path 比猜项目目录可靠得多。
 */
function trackerForHookEvent(event, opts = {}) {
  const file =
    event && event.transcript_path && fs.existsSync(event.transcript_path)
      ? event.transcript_path
      : pickSessionFile({ ...opts, cwd: (event && event.cwd) || opts.cwd });
  if (!file || !fs.existsSync(file)) return null;
  return new SessionTracker(file).start(opts);
}

// ── 分析：从样本里提炼洞察（给 /cc-toolkit:tps 命令的 AI 解读用）──────────────────

/**
 * 对样本做趋势 / 分布分析，输出结构化事实。
 * 这里只给事实，不下结论 —— 结论交给读它的模型。
 */
function analyze(tracker, { window = 10 } = {}) {
  const all = tracker.recentSamples();
  const recent = all.slice(-window);
  const older = all.slice(-window * 2, -window);

  const recentStats = tracker.stats(recent);
  const olderStats = tracker.stats(older);
  const overallStats = tracker.stats(all);

  let trendPct = null;
  if (recentStats && olderStats && olderStats.median > 0) {
    trendPct = ((recentStats.median - olderStats.median) / olderStats.median) * 100;
  }

  const slowThreshold = overallStats ? Math.max(1, overallStats.median * 0.6) : 0;
  const outliers = all
    .filter((d) => d.tps < slowThreshold)
    .sort((a, b) => a.tps - b.tps)
    .slice(0, 5);

  return {
    sessionId: path.basename(tracker.file).replace(/\.jsonl$/, ""),
    project: path.basename(path.dirname(tracker.file)),
    sampleCount: all.length,
    parsedLines: tracker.parsedLines,
    parseErrors: tracker.parseErrors,
    recent: recentStats,
    earlier: olderStats,
    overall: overallStats,
    trendPct,
    outliers,
    estimatedShare: all.length ? all.filter((d) => d.estimated).length / all.length : 0,
  };
}

// ── 渲染 ────────────────────────────────────────────────────────────────

const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[90m",
  speed: "\x1b[1;36m",
  label: "\x1b[35m",
  ok: "\x1b[32m",
  warn: "\x1b[33m",
  bad: "\x1b[31m",
};

/** tok/s → 颜色：≥50 绿，≥25 黄，其余红 */
const colorFor = (tps) => (tps >= 50 ? COLORS.ok : tps >= 25 ? COLORS.warn : COLORS.bad);

/** 一行式实时读数（带 ANSI 色） */
function renderLive(tracker, now = Date.now()) {
  const c = COLORS;
  const parts = [];
  const snap = tracker.currentSpeed(now);

  if (snap) {
    const mark = snap.estimated ? "≈" : "";
    parts.push(
      `${c.speed}⚡ ${mark}${snap.tps.toFixed(0)} tok/s${c.reset}` +
        `${c.dim} ${snap.streaming ? "本轮" : "最近一轮"}${c.reset} ` +
        `${mark}${formatTokens(snap.tokens)} tok${c.dim}·${snap.denom.toFixed(1)}s${c.reset}`
    );
  } else {
    parts.push(`${c.dim}… 等待响应${c.reset}`);
  }

  if (tracker.samples.length) {
    const last = tracker.samples[tracker.samples.length - 1];
    parts.push(
      `${c.label}上一条${c.reset} ${last.estimated ? "≈" : ""}${formatTokens(last.tokens)} tok / ` +
        `${(last.durMs / 1000).toFixed(1)}s = ${colorFor(last.tps)}${last.tps.toFixed(0)} tok/s${c.reset}`
    );
    const med = median(tracker.samples.slice(-8).map((d) => d.tps));
    if (med != null) {
      parts.push(`${c.label}近8条中位${c.reset} ${colorFor(med)}${med.toFixed(0)} tok/s${c.reset}`);
    }
  }

  const idle = (now - tracker.lastEventAt) / 1000;
  const line = parts.join(`${c.dim} │ ${c.reset}`);
  return idle > 5 ? `${line}${c.dim}  (闲置 ${idle.toFixed(0)}s)${c.reset}` : line;
}

/** 多行快照 —— 供斜杠命令注入（纯文本，无色码） */
function renderReport(tracker, { history = 10 } = {}) {
  const lines = [];
  const now = Date.now();
  lines.push(
    `会话 ${path.basename(tracker.file).replace(/\.jsonl$/, "").slice(0, 8)}  ` +
      `项目 ${path.basename(path.dirname(tracker.file))}`
  );

  const snap = tracker.currentSpeed(now);
  if (snap) {
    const mark = snap.estimated ? "≈" : "";
    lines.push(
      `当前${snap.streaming ? "（流式进行中）" : "（最近一轮，已结束）"}: ` +
        `${mark}${snap.tps.toFixed(0)} tok/s  ${mark}${formatTokens(snap.tokens)} tok / ${snap.denom.toFixed(1)}s`
    );
    if (snap.estimated) {
      lines.push("注：usage 还没落盘，token 数由内容字符数估算（≈）；块写入后会自动换成精确值。");
    }
  } else {
    lines.push("当前: 没有进行中的响应。");
  }

  const rows = tracker.recentSamples(history);
  if (!rows.length) {
    lines.push(`样本不足：本窗口内没有已完成且 时长>${MIN_SAMPLE_MS / 1000}s、token>${MIN_SAMPLE_TOKENS} 的响应。`);
    return lines.join("\n");
  }

  lines.push(`最近 ${rows.length} 条已完成的响应:`);
  for (const d of rows) {
    lines.push(
      `  ${hhmmss(d.at)}  ${d.estimated ? "≈" : " "}${String(Math.round(d.tokens)).padStart(5)} tok / ` +
        `${(d.durMs / 1000).toFixed(1).padStart(5)}s = ${d.tps.toFixed(0).padStart(4)} tok/s`
    );
  }

  const s = tracker.stats(rows);
  lines.push(
    `中位 ${s.median.toFixed(0)} tok/s | p90 ${s.p90.toFixed(0)} | ` +
      `最快 ${s.best.tps.toFixed(0)} (${hhmmss(s.best.at)}) | 最慢 ${s.worst.tps.toFixed(0)} (${hhmmss(s.worst.at)})`
  );
  return lines.join("\n");
}

module.exports = {
  // 常量
  PROJECTS_DIR,
  REPLAY_TAIL_BYTES,
  STREAMING_WINDOW_MS,
  MIN_SAMPLE_TOKENS,
  MIN_SAMPLE_MS,
  MAX_SAMPLES,
  // 工具
  estimateTokens,
  projectDirFor,
  median,
  percentile,
  formatTokens,
  stripAnsi,
  hhmmss,
  // 会话发现
  listSessions,
  pickSessionFile,
  // 核心
  SessionTracker,
  trackerForHookEvent,
  analyze,
  // 缓存
  cacheFileFor,
  readCache,
  writeCache,
  // 渲染
  renderLive,
  renderReport,
  colorFor,
  COLORS,
};
