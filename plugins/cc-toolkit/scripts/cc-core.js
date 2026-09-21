"use strict";
/**
 * cc-core.js — Claude Code 会话输出速度 (tok/s) 计算引擎
 *
 * 这是 cc-toolkit 插件的核心。它被两个入口复用：
 *   scripts/cc-watch.js      (CLI: 实时 / --once / --report / --json)
 *   scripts/cc-hook.js       (Stop hook: 把速度作为 systemMessage 回吐给用户)
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
 *
 * ── 指标分层：为什么不能只报一个 tok/s ─────────────────────────────────
 * 一轮的耗时里混着两件性质完全不同的事：
 *   · prefill（读 prompt）—— 等待首块落盘，实测中位 7.3s，缓存未命中时更长；
 *   · decode（写回答）  —— 首块到最后一块之间。
 * 合成一个数字时，prompt 越长读数越低，会被误读成「模型变慢」。所以拆开：
 *
 *   ttftMs     上一条记录 → 本轮首个块的间隔（≈ 首字等待，含 prefill +
 *              排队 + 首个 thinking/text 块的生成时间）
 *   decodeTps  首块 → 最后一块之间的速度。这是唯一不含 prefill 的纯解码读数。
 *              需要 ≥2 个内容块；本机实测 70.2% 的响应满足（只有一段输出的
 *              单块回复无法拆分，此时 decodeTps 为 null，只能退回整轮 tps）。
 *   tps        整轮 tokens ÷ 整轮耗时。与旧版本口径一致，保证可比性。
 *
 * 注意 decodeTps 与 tps 不是同一个量：单块回复里 thinking 块可能占了大头，
 * 整轮 tps 因此偏低。两者都报，让读数自己说明问题。
 *
 * ── 第三方 provider 的两个坑（实测）────────────────────────────────────
 *   · usage 是「累计式」：同一 message 的多个块只有末尾若干块带 usage，
 *     且带的是同一个总数（0,0,1573,1573）。必须取 max，且 decode 的终点
 *     要用「最后一个内容块」而不是「带 usage 的那块」。
 *   · 62% 的块 output_tokens 为 0，且没有 thinking_tokens 明细。
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
/** TTFT 超过这个值就不当作「等待首字」——多半是用户去接水了，不是模型慢 */
const MAX_PLAUSIBLE_TTFT_MS = 120_000;
/**
 * 超过这个时长的轮次不参与「TTFT / 缓存命中 / 归因」的聚合。
 * 它们仍会进中位数统计（慢是真的慢），但这类轮次里用户离开的时间
 * 会污染那些「该反映模型本事」的指标。
 */
const MAX_ATTRIBUTION_MS = 5 * 60 * 1000;
/**
 * decode 跨度的下限。低于它就不报 decodeTps —— 不是「很快」，是「测不出来」。
 *
 * Claude Code 常常把一轮的多个内容块一次性写盘，时间戳只差 1~3ms。
 * 实测 11791 个可拆分轮次里有 3438 个（29%）跨度 <300ms，按 token/跨度 算
 * 会得出上百万 tok/s 的荒谬值。这种情况下根本没有可测的解码区间，
 * 必须诚实地返回 null 而不是给一个会被当真的数字。
 */
const MIN_DECODE_MS = 300;
/** 缓存命中率低于这个值时就值得提示：prompt 缓存没生效，钱和延迟都要涨 */
const LOW_CACHE_HIT_RATIO = 0.5;

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

/**
 * 把 usage 里的缓存相关字段提炼成一行摘要。
 *
 * 命中率的定义是 cache_read / (cache_read + cache_creation + input)：
 * 分母是这一轮实际送进模型的全部 prompt token。实测本机中位 89.7%，
 * 掉到 50% 以下通常意味着 prompt 缓存没生效（改了 system prompt、
 * 换了 provider、或前缀被工具结果打散），成本和 TTFT 都会跟着涨。
 *
 * @returns {{read:number, write:number, fresh:number, hitRatio:number|null, ephemeral5m:number, ephemeral1h:number}|null}
 */
function cacheFields(usage) {
  if (!usage) return null;
  const read = usage.cache_read_input_tokens || 0;
  const write = usage.cache_creation_input_tokens || 0;
  const fresh = usage.input_tokens || 0;
  const total = read + write + fresh;
  if (!total) return null;
  const cc = usage.cache_creation || {};
  return {
    read,
    write,
    fresh,
    hitRatio: read / total,
    ephemeral5m: cc.ephemeral_5m_input_tokens || 0,
    ephemeral1h: cc.ephemeral_1h_input_tokens || 0,
  };
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
    this.lastUserTs = null; // 上一条 user 行的时间戳，作为 TTFT 的锚
    this.groups = new Map(); // message.id -> 轮次统计
    this.currentId = null;
    this.samples = []; // 已完成、且通过统计过滤的样本（供中位数/p90 等聚合）
    this.lastRound = null; // 最新一轮（不过滤，供 hook / 状态栏读数）
    this.lastEventAt = 0; // 最后一次块落盘的本地时间，用于判断是否仍在流式
    this.parsedLines = 0;
    this.parseErrors = 0;
    // ── 会话级事件（都来自 system / user 行的旁路信息）──
    this.turnDurations = []; // CLI 自报的整轮耗时（system/turn_duration）
    this.apiErrors = []; // 重试 / 断连记录（system/api_error）
    this.hookRuns = []; // 本会话里 hook 的执行摘要（system/stop_hook_summary）
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

  _groupOf(id, startTs, { anchorSeen = true } = {}) {
    let g = this.groups.get(id);
    if (!g) {
      // out = usage 里的精确输出 token 数；est = 由内容字符数估算（仅无 usage 时兜底）
      g = {
        id,
        start: startTs,
        // anchorSeen=false：本轮的起点锚（用户行）落在回放窗口之外，
        // start 只能用首个内容块兜底。此时「首字等待」和「整轮耗时」都是
        // 算不出来的（分母少了一整段 prefill），必须标出来而不是照常输出。
        anchorSeen,
        end: startTs,
        out: 0,
        est: 0,
        firstAt: null,
        // 块级时间线：firstBlockAt→lastBlockAt 就是纯 decode 跨度
        firstBlockAt: null,
        lastBlockAt: null,
        ttftMs: null,
        blocks: 0,
        firstBlockType: null,
        blockTypes: {},
        thinkingTokens: 0,
        iterations: [],
        usage: null,
        model: null,
        effort: null,
        stopReason: null,
        slug: null,
        skill: null,
        mcp: null,
        mcpTool: null,
        plugin: null,
      };
      this.groups.set(id, g);
    }
    return g;
  }

  /**
   * 把一次 usage 合进轮次统计。
   *
   * 同一 message 的每个内容块都带 usage，且是**累计快照**（官方 provider 每块
   * 都是同一个数，第三方 provider 只有末尾若干块才有值）。所以一律取 max，
   * 不能在流式中途用「最后见到的值」——那是把总数当成增量在用。
   */
  _mergeUsage(g, usage) {
    if (!usage) return;
    g.usage = usage;

    const out = usage.output_tokens || 0;
    if (out > g.out) g.out = out;

    const think = (usage.output_tokens_details && usage.output_tokens_details.thinking_tokens) || 0;
    if (think > g.thinkingTokens) g.thinkingTokens = think;

    const iters = Array.isArray(usage.iterations) ? usage.iterations : [];
    if (iters.length > g.iterations.length) {
      g.iterations = iters.map((it) => ({
        in: it.input_tokens || 0,
        out: it.output_tokens || 0,
        cacheRead: it.cache_read_input_tokens || 0,
        cacheWrite: it.cache_creation_input_tokens || 0,
      }));
    }

    const c = cacheFields(usage);
    if (c && (!g.cache || c.read + c.write + c.fresh > g.cache.read + g.cache.write + g.cache.fresh)) {
      g.cache = c;
    }
    if (!g.serviceTier && usage.service_tier) g.serviceTier = usage.service_tier;
    if (!g.speed && usage.speed) g.speed = usage.speed;
  }

  _archive(id) {
    const g = this.groups.get(id);
    if (!g) return;
    this.groups.delete(id);
    if (this.currentId === id) this.currentId = null;

    const round = this._describe(g, { force: true });
    // 无论大小都记下「最后一轮」——它是 hook / 状态栏的读数来源，
    // 不能被统计过滤器顺手丢掉（短回复也有速度，只是不适合进中位数）。
    this.lastRound = round;

    // 统计样本才需要过滤：太短的轮次方差极大，混进中位数/p90 会污染聚合结果。
    // truncatedAnchor 同理必须排除：那一轮的 durMs 少了一整段首字等待，
    // tps 会系统性偏高（实测 57 → 133），是数据缺口造成的假读数。
    if (!round.truncatedAnchor && round.tokens >= MIN_SAMPLE_TOKENS && round.durMs > MIN_SAMPLE_MS) {
      this.samples.push(round);
    }
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
  }

  /**
   * 把一个轮次的原始累积量，折算成可直接展示 / 聚合的读数。
   *
   * 所有终端时间都用同一个参考点，避免出现「tokens 是最终的、耗时是中途的」
   * 这种分子分母错配 —— 那是第三方 provider 下读数虚高的根因。
   *
   * @param {object} g 内部轮次累积器
   * @param {{now?:number, force?:boolean}} [opts]
   *   force=true 表示调用方确信本轮已结束（Stop 事件），不再等流式窗口。
   */
  _describe(g, { now = Date.now(), force = false } = {}) {
    const tokens = this.tokensOf(g);
    const estimated = g.out === 0;
    const streaming = !force && now - g.end < STREAMING_WINDOW_MS;

    // 终点的两种口径：流式中用「现在」，静止后用最后一块的落盘时刻
    const wholeEnd = streaming ? Math.max(now, g.end) : g.end;
    const firstBlockAt = g.firstBlockAt != null ? g.firstBlockAt : g.end;
    const decodeEnd = streaming ? Math.max(now, g.lastBlockAt || g.end) : g.lastBlockAt || g.end;

    const durMs = Math.max(0, wholeEnd - g.start);
    const tps = durMs > 0 ? tokens / (durMs / 1000) : 0;

    // decode 跨度 = 首块 → 末块。跨度太短（块被一次性写盘）就没有可测区间，
    // 宁可报 null 也不报一个上百万 tok/s 的假数字。
    const decodeMs = g.blocks >= 2 ? Math.max(0, decodeEnd - firstBlockAt) : null;
    const decodeTps = decodeMs >= MIN_DECODE_MS ? tokens / (decodeMs / 1000) : null;

    // thinking 占比：think 可能略大于 out（实测 7/29509 行如此），clamp 一下
    const thinkingTokens = Math.min(g.thinkingTokens, tokens);
    const thinkingShare = tokens > 0 && thinkingTokens ? thinkingTokens / tokens : null;

    return {
      tokens,
      estimated,
      // partial：这一轮已经结束，但 usage 没落盘，token 数只能靠字符估。
      // 与「正在流式所以还不知道」要分开——前者已经翻不了案了。
      partial: !streaming && estimated,
      durMs,
      tps,
      // 锚点没见到（本轮的用户行在回放窗口之外）时，firstBlockAt - start 恒为 0，
      // 报 0 会被渲染成「首字 0.0s」。宁可 null —— 这正是 decodeTps 的处理方式。
      ttftMs: g.anchorSeen ? g.ttftMs : null,
      // 单块回复里首块即末块，ttft 恒等于整轮耗时 —— 此时把「首字 X.Xs」
      // 和「整轮 X.Xs」一起显示只是重复，反而让人以为是 bug。这种轮次
      // 只在真的存在「首块之后还有内容」时才算有可展示的首字等待。
      ttftMeaningful: g.anchorSeen && g.ttftMs != null && g.end - g.start - g.ttftMs > MIN_DECODE_MS,
      decodeMs,
      decodeTps,
      // 区分「只有一个块所以拆不了」与「块被一次性写盘、跨度测不出来」
      decodeReason:
        decodeTps != null
          ? null
          : g.blocks < 2
            ? "single-block"
            : decodeMs < MIN_DECODE_MS
              ? "not-measurable"
              : "no-usage",
      // truncated-anchor：本轮的起点锚（用户行）没进回放窗口，start 退化成首个
      // 内容块。此时 durMs/tps 的分母少了一整段首字等待，读数会明显偏高
      //（实测同一轮 57 tok/s 被算成 133），不能当作正常样本聚合。
      truncatedAnchor: !g.anchorSeen,
      thinkingTokens,
      thinkingShare,
      blocks: g.blocks,
      blockTypes: g.blockTypes,
      firstBlockType: g.firstBlockType,
      hasToolUse: (g.blockTypes.tool_use || 0) > 0,
      iterations: g.iterations,
      cache: g.cache || null,
      model: g.model,
      effort: g.effort,
      stopReason: g.stopReason,
      stoppedByLimit: g.stopReason === "max_tokens",
      refused: g.stopReason === "refusal",
      slug: g.slug,
      skill: g.skill,
      mcp: g.mcp,
      mcpTool: g.mcpTool,
      plugin: g.plugin,
      streaming,
      at: g.end,
      start: g.start,
    };
  }

  /**
   * 归档指定轮次（幂等）。
   */
  archiveRound(id) {
    if (id) this._archive(id);
    return this;
  }

  /**
   * 最新一轮的读数 —— **不套用统计过滤器**。
   *
   * 这是 hook 与状态栏该用的接口。统计过滤（MIN_SAMPLE_TOKENS / MIN_SAMPLE_MS）
   * 只服务于中位数、p90 这类聚合，不该决定「本轮速度能不能显示」——
   * 否则一条 46 token 的短回复会被 50 的阈值吃掉，用户设的
   * CC_TOOLKIT_MIN_TOKENS 就形同虚设。
   *
   * @param {{force?: boolean, now?: number}} [opts]
   *   force=true 表示「调用方确信本轮已结束」（Stop 事件就是这种信号），
   *   此时不再等 3 秒的流式窗口。
   * @returns {{tokens:number, estimated:boolean, durMs:number, tps:number, at:number, start:number}|null}
   */
  latestRound({ force = false, now = Date.now() } = {}) {
    const g = this.currentGroup();
    if (g && (force || now - g.end >= STREAMING_WINDOW_MS)) {
      const round = this._describe(g, { force: true, now });
      // 至少要有一个 token 和正的耗时，否则除零 / 无意义
      if (round.tokens >= 1 && round.durMs > 0) return round;
    }
    return this.lastRound || null;
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
   * 注意这里是**统计视图**，仍套用统计过滤器；要拿「本轮是多少」请用 latestRound()。
   *
   * @param {{force?: boolean, now?: number}} [opts]
   *   force=true 时无条件收尾（Stop 事件本身就是「本轮已结束」的信号）。
   * @returns {Array} 完整样本列表（已归档 + 收尾的当前轮）
   */
  finalizedSamples({ force = false, now = Date.now() } = {}) {
    const g = this.currentGroup();
    if (!g) return this.samples;
    if (!force && now - g.end < STREAMING_WINDOW_MS) return this.samples;

    const round = this._describe(g, { force: true, now });
    if (round.truncatedAnchor) return this.samples;
    if (round.tokens < MIN_SAMPLE_TOKENS || round.durMs <= MIN_SAMPLE_MS) return this.samples;
    return [...this.samples, round];
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

    const ts = record.timestamp ? Date.parse(record.timestamp) : null;

    // ── 旁路事件：不参与速度计算，但能回答「刚才那轮为什么慢」──
    if (record.type === "system") {
      if (record.subtype === "turn_duration" && record.durationMs > 0) {
        // CLI 自报的整轮耗时。比我们自己推的准，但落盘频率低（实测占比很小），
        // 所以只作为交叉校验，不用它取代推算值。
        this.turnDurations.push({
          at: ts,
          durationMs: record.durationMs,
          messageCount: record.messageCount || 0,
        });
        if (this.turnDurations.length > 200) this.turnDurations.shift();
      } else if (record.subtype === "api_error") {
        const err = record.error || {};
        this.apiErrors.push({
          at: ts,
          message: err.message || "",
          formatted: err.formatted || "",
          code: (err.connection && err.connection.code) || null,
          isNetworkDown: !!err.isNetworkDown,
          retryAttempt: record.retryAttempt || 0,
          maxRetries: record.maxRetries || 0,
          source: record.source || null,
        });
        if (this.apiErrors.length > 200) this.apiErrors.shift();
      } else if (record.subtype === "stop_hook_summary") {
        // 这里记录的是 hook 自己的执行情况 —— 包括本插件。用来诊断
        // 「hook 到底跑了没有、有没有报错」，而不是猜。
        this.hookRuns.push({
          at: ts,
          hookCount: record.hookCount || 0,
          hasOutput: !!record.hasOutput,
          errors: record.hookErrors || [],
          preventedContinuation: !!record.preventedContinuation,
          commands: (record.hookInfos || []).map((h) => h.command).filter(Boolean),
        });
        if (this.hookRuns.length > 100) this.hookRuns.shift();
      }
    }

    if (record.type === "user" && ts) {
      // TTFT 的锚点：用户按下回车那一刻。用上一条 user 行而不是上一条任意记录，
      // 因为 assistant 块之间夹着的 tool_result / attachment 会把锚点推后。
      if (this.lastUserTs == null || ts > this.lastUserTs) this.lastUserTs = ts;
      if (this.lastTs == null || ts > this.lastTs) this.lastTs = ts;
      return;
    }

    // 子代理（isSidechain）不计入主会话速度
    if (record.type === "assistant" && record.isSidechain) return;

    if (record.type === "assistant" && record.message && record.message.id) {
      const id = record.message.id;

      if (id !== this.currentId) {
        if (this.currentId) this._archive(this.currentId);
        this.currentId = id;
      }

      // 起点锚是本轮开始前最后见到的那一行的时间戳。回放窗口从文件中途开始时，
      // 本轮的用户行可能已经被切掉、lastTs 还是 null —— 这时 start 只能用
      // 首个内容块兜底，durMs 会少掉一整段首字等待（见 anchorSeen）。
      const g = this._groupOf(id, this.lastTs ?? ts ?? Date.now(), {
        anchorSeen: this.lastTs != null,
      });

      // TTFT 只在本轮第一个块落盘时算一次
      if (g.firstBlockAt == null && ts) {
        const anchor = g.start;
        const gap = ts - anchor;
        if (gap >= 0 && gap < MAX_PLAUSIBLE_TTFT_MS) g.ttftMs = gap;
      }

      for (const block of record.message.content || []) {
        g.blocks++;
        const bt = block.type || "unknown";
        g.blockTypes[bt] = (g.blockTypes[bt] || 0) + 1;
        if (g.firstBlockType == null) g.firstBlockType = bt;

        if (bt === "text") {
          g.est += estimateTokens(block.text || "");
          if (g.firstAt == null) g.firstAt = ts;
        } else if (bt === "thinking") {
          g.est += estimateTokens(block.thinking || "");
          if (g.firstAt == null) g.firstAt = ts;
        }
      }

      if (ts) {
        if (g.firstBlockAt == null) g.firstBlockAt = ts;
        g.lastBlockAt = ts;
        g.end = Math.max(g.end, ts);
      }

      this._mergeUsage(g, record.message.usage);

      if (record.message.model) g.model = record.message.model;
      if (record.effort) g.effort = record.effort;
      if (record.message.stop_reason) g.stopReason = record.message.stop_reason;
      if (record.slug) g.slug = record.slug;
      if (record.attributionSkill) g.skill = record.attributionSkill;
      if (record.attributionMcpServer) g.mcp = record.attributionMcpServer;
      if (record.attributionMcpTool) g.mcpTool = record.attributionMcpTool;
      if (record.attributionPlugin) g.plugin = record.attributionPlugin;

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
    const d = this._describe(g, { now });
    return { ...d, denom: d.durMs / 1000 };
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

    // 只有 ≥2 个内容块的轮次才算得出纯 decode 速度，样本天然更少
    const decodeRows = rows.filter((d) => d.decodeTps > 0);
    const ttftRows = rows.filter((d) => d.ttftMs >= 0 && d.ttftMs != null);

    return {
      count: rows.length,
      median: median(tpsList),
      p90: percentile(tpsList, 90),
      mean: tpsList.reduce((a, b) => a + b, 0) / tpsList.length,
      best,
      worst,
      totalTokens: rows.reduce((a, d) => a + d.tokens, 0),
      totalMs: rows.reduce((a, d) => a + d.durMs, 0),
      // 纯解码口径
      decodeCount: decodeRows.length,
      medianDecodeTps: median(decodeRows.map((d) => d.decodeTps)),
      // 首字等待口径
      medianTtftMs: median(ttftRows.map((d) => d.ttftMs)),
      p90TtftMs: percentile(ttftRows.map((d) => d.ttftMs), 90),
    };
  }

  /**
   * 指标分层：把样本切成几组能各自回答一个问题的数字。
   * 只给事实，不下结论 —— 结论交给读它的模型。
   *
   * 注意各组的样本量不同：P3/P4 会排掉 >5 分钟的轮次（用户可能离开过），
   * 所以 count 会明显小于样本总数，解读时要看 count 而不是想当然。
   */
  breakdown(sampleSet) {
    const rows = sampleSet || this.recentSamples();
    const bounded = rows.filter((d) => d.durMs <= MAX_ATTRIBUTION_MS);
    const group = (keyOf) => {
      const m = new Map();
      for (const d of bounded) {
        const k = keyOf(d);
        if (k == null || k === "") continue;
        (m.get(k) || m.set(k, []).get(k)).push(d);
      }
      return [...m.entries()]
        .map(([key, list]) => {
          const dec = list.filter((d) => d.decodeTps > 0).map((d) => d.decodeTps);
          return {
            key,
            count: list.length,
            medianTps: median(list.map((d) => d.tps)),
            medianDecodeTps: median(dec),
            medianTtftMs: median(list.filter((d) => d.ttftMs != null).map((d) => d.ttftMs)),
            medianTokens: median(list.map((d) => d.tokens)),
          };
        })
        // 少于 3 条的分组没有统计意义，只会让人过度解读
        .filter((x) => x.count >= 3)
        .sort((a, b) => b.count - a.count);
    };

    return {
      boundedCount: bounded.length,
      skippedLong: rows.length - bounded.length,
      byDifficulty: group((d) => d.effort),
      byModel: group((d) => d.model),
      bySkill: group((d) => d.skill),
      byMcp: group((d) => (d.mcp ? `mcp:${d.mcp}` : d.mcpTool ? `mcp:${d.mcpTool}` : null)),
      byPlugin: group((d) => d.plugin),
      byThinking: group((d) =>
        (d.blockTypes && d.blockTypes.thinking) > 0 ? "带 thinking 块" : "无 thinking 块"
      ),
      byToolUse: group((d) => (d.hasToolUse ? "含工具调用" : "纯文本")),
      byFirstBlock: group((d) => d.firstBlockType),
    };
  }

  /** 会话级事实：CLI 自报耗时、API 错误、hook 执行情况、缓存健康度 */
  sessionFacts() {
    const bounded = this.recentSamples().filter((d) => d.durMs <= MAX_ATTRIBUTION_MS);
    const withCache = bounded.filter((d) => d.cache);
    const hits = withCache.map((d) => d.cache.hitRatio);

    // iterations 只在部分 provider 上落盘；按轮次聚合比按行更接近「一次 API 调用」
    const iterRows = bounded.filter((d) => d.iterations && d.iterations.length);
    const multiIter = iterRows.filter((d) => d.iterations.length > 1);

    const errorsByCode = new Map();
    for (const e of this.apiErrors) {
      const k = e.code || e.source || "unknown";
      errorsByCode.set(k, (errorsByCode.get(k) || 0) + 1);
    }

    return {
      turnDurations: {
        count: this.turnDurations.length,
        medianMs: median(this.turnDurations.map((t) => t.durationMs)),
      },
      apiErrors: {
        count: this.apiErrors.length,
        byCode: [...errorsByCode.entries()].map(([code, count]) => ({ code, count })),
        retried: this.apiErrors.filter((e) => e.retryAttempt > 0).length,
      },
      hookRuns: {
        count: this.hookRuns.length,
        withOutput: this.hookRuns.filter((h) => h.hasOutput).length,
        withErrors: this.hookRuns.filter((h) => h.errors.length).length,
        prevented: this.hookRuns.filter((h) => h.preventedContinuation).length,
      },
      cache: {
        sampleCount: withCache.length,
        medianHitRatio: median(hits),
        lowCount: hits.filter((r) => r < LOW_CACHE_HIT_RATIO).length,
      },
      iterations: {
        sampleCount: iterRows.length,
        medianCount: median(iterRows.map((d) => d.iterations.length)),
        multiCount: multiIter.length,
      },
      thinking: {
        sampleCount: bounded.filter((d) => d.thinkingTokens > 0).length,
        medianShare: median(
          bounded.filter((d) => d.thinkingTokens > 0).map((d) => d.thinkingShare)
        ),
        totalTokens: bounded.reduce((a, d) => a + d.thinkingTokens, 0),
        // 有多少轮次真的带 thinking 块，以及其中多少条 usage 给了 token 明细。
        // 两者相等才说明「没有 thinking」是事实，否则只是没上报。
        withBlock: bounded.filter((d) => (d.blockTypes && d.blockTypes.thinking) > 0).length,
        detailCount: bounded.filter((d) => d.thinkingTokens > 0).length,
      },
      anomalies: {
        estimated: bounded.filter((d) => d.estimated).length,
        maxTokens: bounded.filter((d) => d.stoppedByLimit).length,
        refused: bounded.filter((d) => d.refused).length,
      },
    };
  }

  /** hook 用的紧凑聚合：只留单行展示需要的量 */
  rollup(samples) {
    const rows = samples || this.recentSamples();
    const recent = rows.slice(-9);
    const dec = recent.filter((d) => d.decodeTps > 0).map((d) => d.decodeTps);
    const ttfts = recent.filter((d) => d.ttftMs != null).map((d) => d.ttftMs);
    const caches = recent.filter((d) => d.cache).map((d) => d.cache.hitRatio);
    return {
      median: median(recent.map((d) => d.tps)),
      medianDecode: median(dec),
      medianTtftMs: median(ttfts),
      medianCacheHit: median(caches),
      count: recent.length,
    };
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

  // 趋势在纯解码口径下更可信：整轮 tps 的波动很大一部分来自 prompt 长度，
  // 而 prompt 长度是个与模型无关的外生变量。
  let decodeTrendPct = null;
  if (
    recentStats &&
    olderStats &&
    recentStats.medianDecodeTps > 0 &&
    olderStats.medianDecodeTps > 0
  ) {
    decodeTrendPct =
      ((recentStats.medianDecodeTps - olderStats.medianDecodeTps) / olderStats.medianDecodeTps) * 100;
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
    decodeTrendPct,
    outliers,
    estimatedShare: all.length ? all.filter((d) => d.estimated).length / all.length : 0,
    breakdown: tracker.breakdown(all),
    session: tracker.sessionFacts(),
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

/** 缓存命中率 → 颜色：≥70% 绿，≥50% 黄，其余红 */
const colorForCache = (r) => (r >= 0.7 ? COLORS.ok : r >= 0.5 ? COLORS.warn : COLORS.bad);

const pct = (x) => `${(x * 100).toFixed(0)}%`;
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

/** 一行式实时读数（带 ANSI 色） */
function renderLive(tracker, now = Date.now()) {
  const c = COLORS;
  const parts = [];
  const snap = tracker.currentSpeed(now);

  if (snap) {
    const mark = snap.estimated ? "≈" : "";
    let seg =
      `${c.speed}⚡ ${mark}${snap.tps.toFixed(0)} tok/s${c.reset}` +
      `${c.dim} ${snap.streaming ? "本轮" : "最近一轮"}${c.reset} ` +
      `${mark}${formatTokens(snap.tokens)} tok${c.dim}·${secs(snap.durMs)}${c.reset}`;
    // 拆出首字等待与纯解码速度：整轮 tps 里混着 prefill，单看它会误判
    if (snap.ttftMeaningful) seg += `${c.dim} 首字 ${secs(snap.ttftMs)}${c.reset}`;
    if (snap.decodeTps > 0) seg += `${c.dim} 解码 ${Math.round(snap.decodeTps)}${c.reset}`;
    parts.push(seg);
  } else {
    parts.push(`${c.dim}… 等待响应${c.reset}`);
  }

  if (tracker.samples.length) {
    const med = median(tracker.samples.slice(-8).map((d) => d.tps));
    if (med != null) {
      parts.push(`${c.label}近8条中位${c.reset} ${colorFor(med)}${med.toFixed(0)} tok/s${c.reset}`);
    }
  }

  const roll = tracker.rollup(tracker.recentSamples());
  if (roll.medianCacheHit != null) {
    parts.push(`${c.label}缓存${c.reset} ${colorForCache(roll.medianCacheHit)}${pct(roll.medianCacheHit)}${c.reset}`);
  }

  const idle = (now - tracker.lastEventAt) / 1000;
  const line = parts.join(`${c.dim} │ ${c.reset}`);
  return idle > 5 ? `${line}${c.dim}  (闲置 ${idle.toFixed(0)}s)${c.reset}` : line;
}

/** 把一组「键 → 统计」渲染成紧凑的对比行，样本太少的组直接跳过 */
function renderGroups(groups, { limit = 5, unit = "tok/s" } = {}) {
  if (!groups || !groups.length) return null;
  return groups
    .slice(0, limit)
    .map((g) => {
      // 只在真的测出解码速度时才展示；null 表示测不出来，不是 0
      const dec = g.medianDecodeTps != null ? ` / 解码 ${Math.round(g.medianDecodeTps)}` : "";
      return `${g.key} ${Math.round(g.medianTps)}${dec} ${unit} (n=${g.count})`;
    })
    .join("\n    ");
}

/** 多行快照 —— 供斜杠命令注入（纯文本，无色码） */
function renderReport(tracker, { history = 10 } = {}) {
  const lines = [];
  const rows = tracker.recentSamples(history);
  const s = rows.length ? tracker.stats(rows) : null;

  lines.push(
    `会话 ${path.basename(tracker.file).replace(/\.jsonl$/, "").slice(0, 8)}  ` +
      `项目 ${path.basename(path.dirname(tracker.file))}`
  );

  const snap = tracker.currentSpeed();
  if (snap) {
    const mark = snap.estimated ? "≈" : "";
    lines.push(
      `当前${snap.streaming ? "（流式进行中）" : "（最近一轮，已结束）"}: ` +
        `${mark}${snap.tps.toFixed(0)} tok/s  ${mark}${formatTokens(snap.tokens)} tok / ${secs(snap.durMs)}`
    );
    const bits = [];
    if (snap.ttftMeaningful) bits.push(`首字 ${secs(snap.ttftMs)}`);
    if (snap.decodeTps > 0) bits.push(`解码 ${Math.round(snap.decodeTps)} tok/s${snap.decodeMs ? ` (跨 ${secs(snap.decodeMs)})` : ""}`);
    if (bits.length) lines.push(`  拆分: ${bits.join(" · ")}`);
    if (snap.cache) lines.push(`  缓存命中 ${pct(snap.cache.hitRatio)}`);
    if (snap.estimated) {
      lines.push("注：usage 没落盘，token 数由内容字符数估算（≈）。");
    }
    if (snap.stoppedByLimit) lines.push("⚠ 本轮被 max_tokens 截断 —— token 数不是模型的完整输出。");
    if (snap.refused) lines.push("⚠ 本轮以 refusal 结束。");
  } else {
    lines.push("当前: 没有进行中的响应。");
  }

  if (!rows.length) {
    lines.push(`样本不足：本窗口内没有已完成且 时长>${MIN_SAMPLE_MS / 1000}s、token>${MIN_SAMPLE_TOKENS} 的响应。`);
    return lines.join("\n");
  }

  lines.push(`最近 ${rows.length} 条已完成的响应:`);
  for (const d of rows) {
    const mark = d.estimated ? "≈" : " ";
    // 首字与解码成对出现：只有真的测出了解码区间，首字等待才是可解释的信息
    const dec = d.decodeTps > 0 ? ` 解码${String(Math.round(d.decodeTps)).padStart(4)}` : "        ";
    const ttft = d.ttftMeaningful ? ` 首字${(d.ttftMs / 1000).toFixed(1)}s` : "";
    lines.push(
      `  ${hhmmss(d.at)} ${mark}${String(Math.round(d.tokens)).padStart(5)} tok / ` +
        `${secs(d.durMs).padStart(6)} = ${d.tps.toFixed(0).padStart(4)} tok/s${dec}${ttft}` +
        (d.stoppedByLimit ? "  [截断]" : d.refused ? "  [拒答]" : "")
    );
  }

  lines.push(
    `中位 ${s.median.toFixed(0)} tok/s | p90 ${s.p90.toFixed(0)} | ` +
      `最快 ${s.best.tps.toFixed(0)} (${hhmmss(s.best.at)}) | 最慢 ${s.worst.tps.toFixed(0)} (${hhmmss(s.worst.at)})`
  );
  if (s.medianDecodeTps != null) {
    const unmeasurable = s.count - s.decodeCount;
    lines.push(
      `纯解码口径（${s.decodeCount}/${s.count} 条可拆分）: 中位 ${s.medianDecodeTps.toFixed(0)} tok/s` +
        (s.medianTtftMs != null ? ` | 首字中位 ${secs(s.medianTtftMs)}` : "") +
        (unmeasurable ? ` | ${unmeasurable} 条无法拆分` : "")
    );
  } else if (s.medianTtftMs != null) {
    lines.push(`首字中位 ${secs(s.medianTtftMs)}（本窗口没有可拆分 decode 的样本）`);
  }
  return lines.join("\n");
}

/**
 * 深度报表：分层对比 + 会话级事实（api 错误 / 缓存 / 归因）。
 * 与 renderReport 分开，是因为这份内容对每一轮 hook 输出而言太重了。
 */
function renderInsights(tracker, { limit = 5 } = {}) {
  const a = analyze(tracker, { window: 10 });
  const lines = [];
  const S = a.session;

  lines.push("── 指标分层 ──");
  lines.push(
    "（各组只统计时长 ≤ 5 分钟的轮次，n 是各自的实际样本数；" +
      `已跳过 ${a.breakdown.skippedLong} 条超长轮次）`
  );
  const groups = [
    ["按 effort 档位", a.breakdown.byDifficulty],
    ["按模型", a.breakdown.byModel],
    ["按技能(skill)", a.breakdown.bySkill],
    ["按 MCP 服务", a.breakdown.byMcp],
    ["按插件", a.breakdown.byPlugin],
    ["按是否有 thinking", a.breakdown.byThinking],
    ["按是否调用工具", a.breakdown.byToolUse],
    ["按首块类型", a.breakdown.byFirstBlock],
  ];
  let anyGroup = false;
  for (const [title, g] of groups) {
    const rendered = renderGroups(g, { limit });
    if (!rendered) continue;
    anyGroup = true;
    lines.push(`  ${title}:`);
    lines.push(`    ${rendered}`);
  }
  if (!anyGroup) lines.push("  没有分组样本量 ≥3 的维度可对比。");

  if (a.decodeTrendPct != null) {
    lines.push("");
    lines.push("── 趋势 ──");
    lines.push(
      `整轮口径 ${a.trendPct == null ? "-" : (a.trendPct >= 0 ? "+" : "") + a.trendPct.toFixed(0) + "%"}，` +
        `纯解码口径 ${a.decodeTrendPct >= 0 ? "+" : ""}${a.decodeTrendPct.toFixed(0)}%`
    );
    // 两个口径方向相反时，变化几乎总是来自 prompt 长度（prefill），
    // 而不是模型解码本身变快变慢 —— 这正是要拆开报的原因。
    if (a.trendPct != null && a.decodeTrendPct != null && Math.sign(a.trendPct) !== Math.sign(a.decodeTrendPct)) {
      lines.push("  两者方向不一致 → 变化多半来自 prompt 长度（prefill），不是模型解码变快慢。");
    }
  }

  lines.push("");
  lines.push("── 会话级事实 ──");
  const c = S.cache;
  lines.push(
    `缓存: ${c.sampleCount} 条可测，中位命中 ${c.medianHitRatio == null ? "-" : pct(c.medianHitRatio)}` +
      (c.lowCount ? `  ⚠ ${c.lowCount} 条低于 ${pct(LOW_CACHE_HIT_RATIO)}` : "")
  );
  const t = S.thinking;
  if (t.detailCount === 0) {
    // 有 thinking 块，但 usage 里根本没有 thinking_tokens 明细 ——
    // 这是 provider 或 CLI 版本不上报，不是「模型没思考」。
    lines.push(
      `thinking: 本轮次里有 ${t.withBlock} 条含 thinking 块，` +
        "但 usage 里没有 thinking_tokens 明细（该 provider/版本不上报），无法统计占比"
    );
  } else {
    lines.push(
      `thinking: ${t.sampleCount} 条含思维链，中位占输出 ${t.medianShare == null ? "-" : pct(t.medianShare)}，` +
        `累计 ${formatTokens(t.totalTokens)} tok`
    );
  }
  if (S.iterations.sampleCount) {
    lines.push(
      `iterations: ${S.iterations.sampleCount} 条有明细，中位每轮 ${S.iterations.medianCount} 次调用` +
        (S.iterations.multiCount ? `，其中 ${S.iterations.multiCount} 条超过 1 次（内部多轮 reasoning）` : "")
    );
  } else {
    lines.push("iterations: 当前 provider 不写这个字段（官方 API 才有）。");
  }
  lines.push(
    `异常: 估算 ${S.anomalies.estimated} 条` +
      (S.anomalies.maxTokens ? `，被 max_tokens 截断 ${S.anomalies.maxTokens} 条` : "") +
      (S.anomalies.refused ? `，拒答 ${S.anomalies.refused} 条` : "")
  );
  if (S.turnDurations.count) {
    lines.push(
      `CLI 自报整轮耗时: ${S.turnDurations.count} 条，中位 ${secs(S.turnDurations.medianMs)}（用于交叉校验）`
    );
  }
  if (S.apiErrors.count) {
    lines.push(
      `API 错误: ${S.apiErrors.count} 次` +
        (S.apiErrors.byCode.length ? ` [${S.apiErrors.byCode.map((x) => `${x.code}×${x.count}`).join(", ")}]` : "") +
        (S.apiErrors.retried ? `，其中 ${S.apiErrors.retried} 次触发了重试` : "")
    );
  }
  if (S.hookRuns.count) {
    lines.push(
      `Stop hook 执行: ${S.hookRuns.count} 次，有输出 ${S.hookRuns.withOutput} 次` +
        (S.hookRuns.withErrors ? `，报错 ${S.hookRuns.withErrors} 次` : "") +
        (S.hookRuns.prevented ? `，阻止结束 ${S.hookRuns.prevented} 次` : "")
    );
  }
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
  MAX_ATTRIBUTION_MS,
  MIN_DECODE_MS,
  LOW_CACHE_HIT_RATIO,
  // 工具
  estimateTokens,
  projectDirFor,
  cacheFields,
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
  // 渲染
  renderLive,
  renderReport,
  renderInsights,
  colorFor,
  COLORS,
};
