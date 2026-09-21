"use strict";
/**
 * cc-core.js — Claude Code 会话输出速度 (tok/s) 计算引擎
 *
 * 这是 cc-toolkit 插件的核心，只服务于一个入口：
 *   scripts/cc-hook.js  (Stop hook: 把本轮读数作为 systemMessage 回吐给用户)
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
 * ── 三个读数：为什么不能只报一个 tok/s ─────────────────────────────────
 * 一轮的耗时里混着两件性质完全不同的事：
 *   · prefill（读 prompt）—— 等待首块落盘，实测中位 7.3s，缓存未命中时更长；
 *   · decode（写回答）  —— 首块到最后一块之间。
 * 合成一个数字时，prompt 越长读数越低，会被误读成「模型变慢」。所以拆开：
 *
 *   decodeTps  纯解码速度。一轮回复里可能有几十上百步，每步单独
 *              测「首块 → 末块」的跨度再求和 —— 步与步之间夹着的工具执行时间
 *              不属于解码，算进去会把读数压低近十倍（实测 128 → 10 tok/s）。
 *              没有任何一步有可测跨度时返回 null，由调用方显示占位符。
 *   tps        整轮 tokens ÷ 整轮耗时（含 prefill 与工具执行），保证可比性。
 *   calls      本轮步数 —— 这一步数给出「这一轮有多重」。
 *
 * 曾报过的 ttftMs（真人输入 → 首个内容块）已退役，理由见 CHANGELOG 2.4.0：
 * 那一段是**等待 + 首块生成时间**的合计，而首块大小在一轮之间差几十倍
 *（实测首块 ≥1000 字符时中位 26–29s，<50 字符时 9–13s），
 * 跨轮次比较时会把「首块更大」误读成「等得更久」。
 *
 * ── 术语：一轮 vs 一步 ─────────────────────────────────────────────────
 *   · 一轮 = 你按下回车 → 这次回复结束。
 *   · 一步 = 轮内的一次模型生成（一次 API 调用）**及其触发的工具执行**。
 *     轮内的步数 = 轮内的 API 调用次数。
 *
 *   注意 decodeTps 与 tps 不是同一个量：单块回复里 thinking 块可能占了大头，
 *   整轮 tps 因此偏低。两者都报，让读数自己说明问题。
 *
 * ── 读数只有一条路径：轮级 ────────────────────────────────────────────
 * 3.0.0 起插件只保留 Stop hook，步级统计采样链路（_describe / samples /
 * 中位数聚合）随之删除 —— 它唯一的对外出口是 hook 的 median 字段。
 * 现在 `_describeTurn` 是**唯一**的读数入口，由 latestRound() 交给 hook。
 *
 * ── 第三方 provider 的两个坑（实测）────────────────────────────────────
 *   · usage 是「累计式」：同一 message 的多个块只有末尾若干块带 usage，
 *     且带的是同一个总数（0,0,1573,1573）。必须取 max，且 decode 的终点
 *     要用「最后一个内容块」而不是「带 usage 的那块」。
 *   · 62% 的块 output_tokens 为 0，且没有 thinking_tokens 明细。更关键的是
 *     usage 只落在**少数 message.id** 上 —— 一轮里可能有 172 个 id，只有几个
 *     带 usage。只读单个 id 会把整轮 tokens 低估最多 365 倍（实测）。
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

// ── 常量 ───────────────────────────────────────────────────────────────

const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
/** 每个会话文件只回放末尾这么多字节，避免超大会话文件拖慢启动 */
const REPLAY_TAIL_BYTES = 2_000_000;
/**
 * 一轮里最多保留多少步的明细。
 * 实测单轮最多 172 步，留到 600 足够覆盖任何真实回复；
 * 超出只意味着最老的几步不参与轮级聚合 —— 极端防御，不该被触发。
 */
const MAX_STEPS_PER_TURN = 600;
/**
 * decode 跨度的下限。低于它就不报 decodeTps —— 不是「很快」，是「测不出来」。
 *
 * Claude Code 常常把一轮的多个内容块一次性写盘，时间戳只差 1~3ms。
 * 实测 11791 个可拆分轮次里有 3438 个（29%）跨度 <300ms，按 token/跨度 算
 * 会得出上百万 tok/s 的荒谬值。这种情况下根本没有可测的解码区间，
 * 必须诚实地返回 null 而不是给一个会被当真的数字。
 */
const MIN_DECODE_MS = 300;

// ── 小工具 ─────────────────────────────────────────────────────────────

const formatTokens = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(Math.round(n)));

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * 这一行 user 记录是不是「用户真的敲了回车」。
 *
 * 会话文件里 user 行有三种，只有第一种是真人输入：
 *   · content 是字符串            —— 真人敲的提示词
 *   · content 是数组含 tool_result —— 工具结果回流，属于上一轮的内部过程
 *   · content 是数组含 text 且 isMeta —— 技能/系统注入（实测 isMeta=true）
 * 后两种都不是新的一轮，拿它们当轮次锚点会把一轮越切越碎。
 */
function isHumanInput(record) {
  if (!record || record.type !== "user" || record.isMeta) return false;
  const c = record.message && record.message.content;
  if (typeof c === "string") return true;
  if (Array.isArray(c)) return c.length > 0 && !c.some((b) => b && b.type === "tool_result");
  return false;
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
 * 把一次 usage 合进步记录。
 *
 * 同一 message 的每个内容块都带 usage，且是**累计快照**（官方 provider 每块
 * 都是同一个数，第三方 provider 只有末尾若干块才有值）。所以一律取 max，
 * 不能在流式中途用「最后见到的值」——那是把总数当成增量在用。
 *
 * 这里只记原始量（token 数），不折算成读数：读数的唯一入口是 `_describeTurn`，
 * 它把一轮的所有步聚拢起来算（见那里的口径说明）。两边各算一份是两套记账
 * 对不齐的根源 —— 尤其是缓存，一边取单步、一边求和，同一个字段两个口径。
 */
function mergeUsage(step, usage) {
  if (!usage) return;

  const out = usage.output_tokens || 0;
  if (out > step.out) {
    step.out = out;
    step.hasUsage = true;
  }

  const think = (usage.output_tokens_details && usage.output_tokens_details.thinking_tokens) || 0;
  if (think > step.thinking) step.thinking = think;

  const iters = Array.isArray(usage.iterations) ? usage.iterations : [];
  if (iters.length > step.iterations.length) {
    step.iterations = iters.map((it) => ({
      in: it.input_tokens || 0,
      out: it.output_tokens || 0,
      cacheRead: it.cache_read_input_tokens || 0,
      cacheWrite: it.cache_creation_input_tokens || 0,
    }));
  }

  if (usage.cache_read_input_tokens > step.cacheRead) {
    step.cacheRead = usage.cache_read_input_tokens || 0;
  }
  if (usage.cache_creation_input_tokens > step.cacheWrite) {
    step.cacheWrite = usage.cache_creation_input_tokens || 0;
  }
  if (usage.input_tokens > step.fresh) step.fresh = usage.input_tokens || 0;
  const cc = usage.cache_creation || {};
  if (cc.ephemeral_5m_input_tokens > step.cache5m) step.cache5m = cc.ephemeral_5m_input_tokens || 0;
  if (cc.ephemeral_1h_input_tokens > step.cache1h) step.cache1h = cc.ephemeral_1h_input_tokens || 0;

  if (!step.serviceTier && usage.service_tier) step.serviceTier = usage.service_tier;
  if (!step.speed && usage.speed) step.speed = usage.speed;
}

/**
 * 一个记录（步或轮）的 decode 跨度：它的块落盘时刻的 min→max。
 * 只有落在窗口内的步才有这些时间戳，轮聚合时按步分别测再求和（见 `_describeTurn`）。
 */
function spanOf(step) {
  return step.ts.length >= 2 ? Math.max(...step.ts) - Math.min(...step.ts) : 0;
}

/**
 * 只统计**落在跨度内**的那些 token —— 即首块落盘之后落的块。
 *
 * ── 为什么分子必须这么算（2.5.0 前这里虚高一个数量级）──────────────
 * 会话日志是块级落盘，而**一个块要生成完才落盘**。一块 5904 字符的 thinking
 * 可能在 13.9 秒里生成、然后一次性写入，它的时间戳只是落盘那一刻 ——
 * 生成时间在日志里没有对应事件。
 *
 * 于是「首块 → 末块」这个跨度天然**不覆盖首块自己的生成时间**。若分子仍取整步的
 * token（含首块），分母只覆盖尾部一小段，读数就虚高。实测那一步：
 * 1837 token ÷ 794ms = 2314 tok/s（该 provider 正常值约 200）。
 *
 * 把首块整个排除后，分子分母**同时**不含首块：这是唯一同源的口径。
 * 代价是丢掉了首块那部分 token，样本量也变小 —— 但比报一个假数字好。
 *
 * ── 为什么按字符权重摊分，而不是按行记 token ──────────────────────
 * usage 是**累计快照**，而且只在同一 message 的少数行（常常是第一行）上出现 ——
 * 也就是说「整步 token 数」在我们还没见到后面的行时就已经知道了。
 * 解析时按行分配必然错：第一行会把整步的量吃掉。
 * 所以解析时只记每行的**字符权重**，摊分推迟到描述时（那时本步所有行都齐了）。
 */
function tokensWithinSpan(step, stepTokens) {
  const ts = step.ts;
  if (ts.length < 2 || !(stepTokens > 0)) return 0;
  const first = Math.min(...ts);
  const rows = step.rows || [];
  if (!rows.length) return 0;

  const totalWeight = rows.reduce((a, r) => a + (r.est || 0), 0);
  const inSpanWeight = rows.reduce((a, r) => a + (r.at > first ? r.est || 0 : 0), 0);
  // 全部行都没有可估字符（例如只有空 tool_use）→ 无从加权，退回按行数等分
  if (totalWeight <= 0) {
    const inSpanRows = rows.filter((r) => r.at > first).length;
    return (stepTokens * inSpanRows) / rows.length;
  }
  return (stepTokens * inSpanWeight) / totalWeight;
}

/**
 * 缓存的原始量 → 展示用的命中率。
 * 分布与轮上：同一步的缓存字段本来就是这一串 token 的合计，
 * 命中率的定义在两级上是同一个式子（见 `_describeTurn` 的求和说明）。
 */
function cacheOf(step) {
  const total = step.cacheRead + step.cacheWrite + step.fresh;
  if (!total) return null;
  return {
    read: step.cacheRead,
    write: step.cacheWrite,
    fresh: step.fresh,
    hitRatio: step.cacheRead / total,
    ephemeral5m: step.cache5m,
    ephemeral1h: step.cache1h,
  };
}

/**
 * 把一行 assistant 记录的旁路元数据（模型 / effort / 归因 / 截断）写进一个记录。
 *
 * 步记录与轮记录要的是同一批字段，写两份就会有一份先过期 —— 抽成一个函数，
 * 两边各调一次，字段清单只有一处。
 */
function applyMeta(target, record) {
  if (record.message.model) target.model = record.message.model;
  if (record.effort) target.effort = record.effort;
  if (record.message.stop_reason) target.stopReason = record.message.stop_reason;
  if (record.slug) target.slug = record.slug;
  if (record.attributionSkill) target.skill = record.attributionSkill;
  if (record.attributionMcpServer) target.mcp = record.attributionMcpServer;
  if (record.attributionMcpTool) target.mcpTool = record.attributionMcpTool;
  if (record.attributionPlugin) target.plugin = record.attributionPlugin;
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
    this.lastUserTs = null; // 上一条 user 行的时间戳
    /**
     * message.id -> 该步的累计量。**这是唯一的按步记账**。
     *
     * `currentSteps` 与它是同一批记录对象的两个视图：Map 负责「按 id 找当前那一步」，
     * 数组负责「按顺序回看本轮所有步」。轮级读数不在步记录上算，而是由
     * `_describeTurn` 把这批步聚拢起来算 —— 读数的唯一入口。
     *
     * 两处上限（MAX_STEPS_PER_TURN）都只会在极端情况下触发，见该常量。
     */
    this.groups = new Map(); // message.id -> 当前步
    this.currentSteps = []; // 本轮的所有步（按出现顺序）
    this.currentId = null;
    this.lastEventAt = 0; // 最后一次块落盘的本地时间，用于判断是否仍在流式
    this.parsedLines = 0;
    this.parseErrors = 0;
    // ── 用户视角的一轮（「我发一条消息 → 回复结束」）──
    // 一轮回复里可能有几十上百步（实测最多 172 个 message.id），usage 只落在
    // 其中少数 id 上。只读最后一个 id 会把整轮读数丢掉（实测低估 tokens 最多 365 倍）。
    // 所以轮级的读数由 _describeTurn 把**本轮所有步**聚拢起来算。
    this.turn = null; // 见 _openTurn / _describeTurn
    // ── 会话级事件（来自 system 行的旁路信息）──
    this.apiErrors = []; // 重试 / 断连记录（system/api_error），供 hook 的告警用
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

  /**
   * 按 message.id 取一个步累积器，没有就建。
   *
   * 这是**唯一**的记录入口。步记录就是步记录 —— 轮级读数不在它上面算，
   * 而是由 `_describeTurn` 把一轮的所有步聚拢起来算（见那里的口径说明）。
   *
   * @param {number} id message.id，一步一个
   * @param {number} startTs 本轮的起点锚（真人输入那一刻）
   * @param {{anchorSeen?: boolean}} [opts]
   *   anchorSeen=false：本轮的起点锚（用户行）落在回放窗口之外，start 只能用
   *   首个内容块兜底。此时「整轮耗时」算不出来（分母少了一整段 prefill），
   *   必须标出来而不是照常输出。
   */
  step(id, startTs, { anchorSeen = true } = {}) {
    let g = this.groups.get(id);
    if (!g) {
      g = {
        id,
        start: startTs,
        anchorSeen,
        end: startTs,
        // out = usage 里的精确输出 token 数；est = 由内容字符数估算（仅无 usage 时兜底）
        out: 0,
        est: 0,
        // usage 里的 output_tokens 是不是真的给出了非 0 值。哨兵行会带一个
        // {output_tokens: 0}，那等于没有精确值 —— 判据必须是「值非 0」而不是
        // 「见过 usage 对象」，否则会把 0 当成精确读数。
        hasUsage: false,
        // 块的落盘时刻。它的 min→max 就是这一步的纯 decode 跨度（见 spanOf）。
        // 与 firstBlockAt/lastBlockAt 是同一份时间戳，保留两者是因为
        // firstBlockAt 还兼作「这一步有没有落过内容」的判据。
        ts: [],
        // 逐行的落盘时刻与 token 量，供 tokensWithinSpan 只取跨度内的那部分。
        // 每行（一个 JSONL 记录）一个条目 —— 一行可能含多个块，它们同刻落盘。
        rows: [],
        firstBlockAt: null,
        lastBlockAt: null,
        blocks: 0,
        firstBlockType: null,
        blockTypes: {},
        thinking: 0,
        iterations: [],
        // 缓存原始量：由 mergeUsage 取 max，再由 _describeTurn 求和
        cacheRead: 0,
        cacheWrite: 0,
        fresh: 0,
        cache5m: 0,
        cache1h: 0,
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
      this.currentSteps.push(g);
      // 一条回复里的步数实测最多 172，留到 600 是防御性的上限：
      // 超出只意味着最老的几步不参与轮级聚合，不该被触发。
      if (this.currentSteps.length > MAX_STEPS_PER_TURN) this.currentSteps.shift();
    }
    return g;
  }

  // ── 用户视角的一轮：把一次回复里的所有步聚合成一个整体 ──────────────────

  /**
   * 开一轮新的（用户发了消息）。
   * @param {number|null} startTs 真人输入那一刻，作为整轮耗时的锚点
   */
  _openTurn(startTs) {
    if (this.turn) this._archiveTurn(); // 上一轮到此为止
    this.currentSteps = []; // 新一轮从零攒步
    this.turn = {
      start: startTs,
      blocks: 0,
      blockTypes: {},
      firstBlockAt: null,
      lastBlockAt: null,
      model: null,
      effort: null,
      stopReason: null,
      slug: null,
      skill: null,
      mcp: null,
      mcpTool: null,
      plugin: null,
    };
  }

  /**
   * 把一轮里所有步的原始累积量折算成轮级读数。
   *
   * 这是**唯一**的读数入口：轮级读数不在步记录上算。
   *
   * 三个读数各自独立地「能算就算，算不出返回 null」—— 调用方据此显示 —，
   * 而不是因为一个算不出来就整行省略。
   */
  _describeTurn(t) {
    if (!t) return null;

    // 一轮的步来自两个地方：本轮已归档的（走到下一步时归档）与当前这一步。
    const steps = this.currentSteps.slice();

    let tokens = 0;
    let estimated = false; // 整轮口径：有任何一个数字来自字符估算
    let estDecode = false;
    let estCache = false;
    let thinkingTokens = 0; // 取各步的 max（thinking 是 output 的子集，累计会重复）

    let measurableMs = 0; // 可测的 decode 跨度之和
    let measurableTokens = 0; // 只与 measurableMs 同源
    let measurableSteps = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let fresh = 0;
    let cache5m = 0;
    let cache1h = 0;

    for (const c of steps) {
      const stepTokens = c.hasUsage ? c.out : c.est;
      tokens += stepTokens;
      if (!c.hasUsage && c.est > 0) estimated = true;
      if (c.thinking > thinkingTokens) thinkingTokens = c.thinking;

      // 这一步自身的 decode 跨度。单块 / 块被一次性写盘 → 跨度为 0，
      // 没有可测区间，这一步的时间与 token 都不参与 decode 计算。
      // 分子只取**跨度内**落的 token（见 tokensWithinSpan）—— 首块自己的生成时间
      // 不在跨度里，它的 token 也就不能算进来。
      const span = spanOf(c);
      const inSpan = tokensWithinSpan(c, stepTokens);
      if (span >= MIN_DECODE_MS && inSpan > 0) {
        measurableMs += span;
        measurableTokens += inSpan;
        measurableSteps++;
        if (!c.hasUsage) estDecode = true; // 只有走了估算才影响 decode 的精度
      }

      // 缓存按**求和**聚合（而不是取某一步）—— 口径是这一轮实际送进模型的全部 prompt token，
      // 与单步缓存字段的定义一致（cache_read / (read + write + fresh)），是成本该有的口径。
      // 求和还带来一个好处：只要本轮任意一步带了 usage，整轮就算得出缓存命中率。
      cacheRead += c.cacheRead;
      cacheWrite += c.cacheWrite;
      fresh += c.fresh;
      cache5m += c.cache5m;
      cache1h += c.cache1h;
    }

    const cacheTotal = cacheRead + cacheWrite + fresh;
    const cache = cacheTotal > 0
      ? {
          read: cacheRead,
          write: cacheWrite,
          fresh,
          hitRatio: cacheRead / cacheTotal,
          ephemeral5m: cache5m,
          ephemeral1h: cache1h,
        }
      : null;

    // decode：只有累加跨度够长才算得出来，否则 null（调用方显示 —）
    const decodeTps =
      measurableMs >= MIN_DECODE_MS && measurableTokens > 0
        ? measurableTokens / (measurableMs / 1000)
        : null;

    // 整轮耗时：真人输入 → 最后一个内容块（含中途的工具执行时间）。
    // 只用于展示「这一轮等了多久」，不参与 decode 计算。
    const durMs = t.start != null && t.lastBlockAt != null ? Math.max(0, t.lastBlockAt - t.start) : 0;
    const tps = durMs > 0 ? tokens / (durMs / 1000) : 0;

    // thinking 占比：think 可能略大于 out（实测 7/29509 行如此），clamp 一下
    const think = Math.min(thinkingTokens, tokens);

    return {
      tokens,
      estimated,
      estimatedFields: { decode: estDecode, cache: estCache },
      // partial：这一轮已经结束，但 usage 没落盘，token 数只能靠字符估
      partial: estimated,
      durMs,
      tps,
      decodeMs: measurableMs > 0 ? measurableMs : null,
      decodeTps,
      decodeReason:
        decodeTps != null
          ? null
          : t.blocks < 2
            ? "single-block"
            : measurableMs < MIN_DECODE_MS
              ? "not-measurable"
              : "no-usage",
      // 回放窗口从文件中途开始时，本轮的用户行可能已被切掉 —— 锚点没见过，
      // 整轮耗时少了一整段，不能当作正常样本。
      truncatedAnchor: t.start == null,
      thinkingTokens: think,
      thinkingShare: tokens > 0 && think ? think / tokens : null,
      cache,
      blocks: t.blocks,
      blockTypes: t.blockTypes,
      calls: steps.length,
      measurableCalls: measurableSteps,
      hasToolUse: (t.blockTypes.tool_use || 0) > 0,
      model: t.model,
      effort: t.effort,
      stopReason: t.stopReason,
      stoppedByLimit: t.stopReason === "max_tokens",
      refused: t.stopReason === "refusal",
      slug: t.slug,
      skill: t.skill,
      mcp: t.mcp,
      mcpTool: t.mcpTool,
      plugin: t.plugin,
      start: t.start,
      at: t.lastBlockAt,
    };
  }

  /** 归档当前轮（用户又发了消息）—— 读数的唯一来源是 latestRound，所以这里只清状态 */
  _archiveTurn() {
    this.turn = null;
  }

  /** 归档指定的 message.id（幂等） */
  _archive(id) {
    const g = this.groups.get(id);
    if (!g) return;
    this.groups.delete(id);
    if (this.currentId === id) this.currentId = null;
  }

  /**
   * 最新一轮的读数 —— **不套用统计过滤器**，且是**用户视角的一轮**。
   *
   * 这是 hook 该用的接口 —— 也是**唯一**的读数入口。两个关键点：
   *
   * 1. 不套统计过滤。任何阈值都不该决定「本轮速度能不能显示」—— 否则一条
   *    46 token 的短回复会被吃掉，用户设的 CC_TOOLKIT_MIN_TOKENS 就形同虚设。
   *
   * 2. 把「你发出一条消息 → 回复结束」之间的所有步聚合成一轮。
   *    一轮回复里可能有几十上百步（实测最多 172 个 message.id），
   *    而 usage 只落在其中少数 id 上 —— 只读最后一个 id 会把整轮读数丢掉
   *    （实测低估 tokens 最多 365 倍）。
   *
   * 各字段能算就算，算不出返回 null，由调用方决定怎么展示 —— 不要因为
   * 其中一个算不出来就把整条读数作废。
   *
   * @returns {object|null}
   */
  latestRound() {
    if (!this.turn || this.turn.blocks === 0) return null;
    const round = this._describeTurn(this.turn);
    return round && round.tokens >= 1 ? round : null;
  }

  /**
   * 某一步的有效 token 数：优先 usage 精确值，否则用估算值。
   *
   * 两种记录形态都支持：`g.out`（`groups` 里的步累积器）与 `c.hasUsage`
   * （`turn` 里的步累积器）。判据统一成「usage 里的 output_tokens 是不是 0」，
   * 而不是「有没有见过 usage 对象」—— 第三方 provider 的哨兵行会带一个
   * `{output_tokens: 0}`，那等于没有精确值。
   */
  tokensOf(g) {
    return g.hasUsage !== undefined ? (g.hasUsage ? g.out : g.est) : g.out > 0 ? g.out : g.est;
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
    // 只留 api_error：hook 用它在本轮那段时间窗内提示「有过重试」。
    if (record.type === "system" && record.subtype === "api_error") {
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
    }

    if (record.type === "user") {
      // 真人输入 = 新的一轮开始。锚点用「你按下回车那一刻」，
      // tool_result / 技能注入（isMeta）都不是新一轮，不能拿来切开轮次。
      if (isHumanInput(record) && ts) this._openTurn(ts);
      if (ts) {
        if (this.lastUserTs == null || ts > this.lastUserTs) this.lastUserTs = ts;
        if (this.lastTs == null || ts > this.lastTs) this.lastTs = ts;
      }
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

      if (!this.turn) this._openTurn(this.lastTs ?? null); // 回放窗口从中间开始时兜底
      const turn = this.turn;

      // 起点锚是本轮开始前最后见到的那一行的时间戳。回放窗口从文件中途开始时，
      // 本轮的用户行可能已经被切掉、lastTs 还是 null —— 这时 start 只能用
      // 首个内容块兜底，整轮耗时会少掉一段（见 anchorSeen）。
      const step = this.step(id, this.lastTs ?? ts ?? Date.now(), {
        anchorSeen: this.lastTs != null,
      });

      // 一行 assistant 记录只需要遍历一次：步记录与轮聚合要的量都从这里取。
      // 跑两遍循环去喂两份记录，是两份记账迟早对不齐的根源。
      let rowEst = 0;
      for (const block of record.message.content || []) {
        step.blocks++;
        turn.blocks++;
        const bt = block.type || "unknown";
        step.blockTypes[bt] = (step.blockTypes[bt] || 0) + 1;
        turn.blockTypes[bt] = (turn.blockTypes[bt] || 0) + 1;
        if (step.firstBlockType == null) step.firstBlockType = bt;

        // rowEst：**这一行的字符权重**，供 tokensWithinSpan 摊分整步 token。
        // 三类块都要计：只算 text/thinking 会让纯 tool_use 的行权重为 0，
        // 于是整步 token 全压到有文本的那一行（实测工具调用密集的步会因此失真）。
        // 注意 step.est 仍只累计 text/thinking —— 那是「无 usage 时的兜底 token 数」，
        // 与这里的权重是两件事。
        if (bt === "text") {
          const e = estimateTokens(block.text || "");
          step.est += e;
          rowEst += e;
        } else if (bt === "thinking") {
          const e = estimateTokens(block.thinking || "");
          step.est += e;
          rowEst += e;
        } else if (bt === "tool_use") {
          rowEst += estimateTokens(JSON.stringify(block.input || {}));
        }
      }
      // 只记这一行的**字符权重**与落盘时刻。token 的摊分在 tokensWithinSpan 里做 ——
      // 那时本步所有行都齐了，而 usage 常常在第一行就已到达（累计快照）。
      if (ts && (record.message.content || []).length) {
        step.rows.push({ at: ts, est: rowEst });
      }

      if (ts) {
        if (step.firstBlockAt == null) step.firstBlockAt = ts;
        step.lastBlockAt = ts;
        step.end = Math.max(step.end, ts);
        step.ts.push(ts);
        if (turn.firstBlockAt == null) turn.firstBlockAt = ts;
        turn.lastBlockAt = ts;
      }

      mergeUsage(step, record.message.usage);
      applyMeta(step, record);
      applyMeta(turn, record);

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

module.exports = {
  // 常量
  PROJECTS_DIR,
  REPLAY_TAIL_BYTES,
  MIN_DECODE_MS,
  // 工具
  estimateTokens,
  projectDirFor,
  median,
  formatTokens,
  // 会话发现
  listSessions,
  pickSessionFile,
  // 核心
  SessionTracker,
  trackerForHookEvent,
};
