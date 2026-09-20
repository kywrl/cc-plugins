#!/usr/bin/env node
"use strict";
/**
 * cc-hook — Stop hook：每轮回复结束后，把本轮输出速度回吐给用户
 *
 * 在 stdin 收到 Claude Code 的 Stop 事件 JSON，往 stdout 吐
 *   {"systemMessage": "⚡ 本轮 68 tok/s …"}
 * systemMessage 只展示给用户，不会进入模型上下文（不污染对话、不花 token）。
 *
 * 静默优先：任何异常、定位不到会话、样本太小 —— 都直接 exit 0 什么都不输出，
 * 绝不因为一个测速工具干扰正常会话。
 *
 * 环境变量:
 *   CC_TOOLKIT_DISABLE=1        完全禁用（等于没装这个 hook）
 *   CC_TOOLKIT_MIN_TOKENS=30    低于该 token 数不报告
 *   CC_TOOLKIT_QUIET=1          只在速度异常慢时才提示
 *   CC_TOOLKIT_SLOW_TOKENS_PER_SEC=20    QUIET 模式下的「慢」阈值
 *   CC_TOOLKIT_VERBOSE=1        把诊断信息写到 stderr（不影响 hook 协议）
 *   CC_TOOLKIT_SHOW=            控制行里包含哪些字段，逗号分隔
 *                               默认 "tps,ttft,decode,cache"
 *                               可选 tps(整轮速度) ttft(首字) decode(纯解码)
 *                                    cache(缓存命中) median(近期中位)
 *                                    tokens(本轮 token 数) thinking(思维链占比)
 *                                    model effort skill
 *   CC_TOOLKIT_ALERTS=1         打开截断 / 低缓存命中 / API 重试的额外提示
 *   CC_TOOLKIT_NOTIFY=1         速度异常慢时发一条桌面通知（OSC 777）
 *   CC_TOOLKIT_NOTIFY_MIN_MS=60000   距上次通知至少间隔多久，默认 60s
 */

const fs = require("fs");
const core = require("./cc-core");

const env = process.env;
const VERBOSE = env.CC_TOOLKIT_VERBOSE === "1";
const debug = (...a) => VERBOSE && console.error("[cc-toolkit]", ...a);

/** 安全输出 hook 协议 JSON 并退出 */
function respond(payload) {
  process.stdout.write(JSON.stringify(payload));
  process.exit(0);
}
const silent = (reason) => {
  debug("静默退出:", reason);
  process.exit(0);
};

// ── QUIET / 通知的跨轮状态 ──────────────────────────────────────────────
// hook 每次都是新进程，想「别刷屏」「别重复通知」就只能落一个极小的文件。

function stateFile(sessionId) {
  return require("path").join(require("os").tmpdir(), `cc-toolkit-state-${sessionId || "default"}.json`);
}

function readState(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(sessionId), "utf8")) || {};
  } catch {
    return {};
  }
}

function writeState(sessionId, state) {
  try {
    fs.writeFileSync(stateFile(sessionId), JSON.stringify(state), "utf8");
  } catch {
    /* 状态写不进去只是会多提示几次，不影响主流程 */
  }
}

/**
 * 把本轮读数拼成一行。
 *
 * 字段化是有意的：默认展示把「等待首字」和「纯解码」分开，
 * 因为合成一个数字时 prefill 会被误读成模型变慢。
 */
function composeMessage(round, rollup, opts) {
  const { show, minTokens } = opts;
  const mark = round.estimated ? "≈" : "";
  const bits = [];

  if (show.has("tps")) bits.push(`${mark}${round.tps.toFixed(0)} tok/s`);
  if (show.has("tokens")) bits.push(`${mark}${core.formatTokens(round.tokens)} tok`);
  if (show.has("tps") || show.has("tokens")) {
    bits[bits.length - 1] += ` / ${(round.durMs / 1000).toFixed(1)}s`;
  }
  // ttftMeaningful: 单块回复的首字恒等于整轮耗时，显示出来只是重复
  if (show.has("ttft") && round.ttftMeaningful) {
    bits.push(`首字 ${(round.ttftMs / 1000).toFixed(1)}s`);
  }
  if (show.has("decode") && round.decodeTps > 0) bits.push(`解码 ${Math.round(round.decodeTps)}`);
  if (show.has("thinking") && round.thinkingTokens > 0) {
    bits.push(`思考 ${(round.thinkingShare * 100).toFixed(0)}%`);
  }
  if (show.has("cache") && round.cache) bits.push(`缓存 ${(round.cache.hitRatio * 100).toFixed(0)}%`);
  if (show.has("model") && round.model) bits.push(round.model);
  if (show.has("effort") && round.effort) bits.push(`effort=${round.effort}`);
  if (show.has("skill") && round.skill) bits.push(`skill=${round.skill}`);

  let msg = `⚡ 本轮 ${bits.join(" · ")}`;

  // 中位数：默认给（旧版行为），除非用户显式把 median 从 show 里去掉
  const med = rollup ? rollup.median : null;
  if (show.has("median") && med != null && rollup.count) {
    msg += `  ·  近${rollup.count}条中位 ${med.toFixed(0)} tok/s`;
  }
  return msg;
}

function readStdin() {
  return new Promise((resolve) => {
    let raw = "";
    // 防御：stdin 意外挂住时不要拖死 Claude Code
    const guard = setTimeout(() => resolve(raw), 5000);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (raw += d));
    process.stdin.on("end", () => {
      clearTimeout(guard);
      resolve(raw);
    });
    process.stdin.on("error", () => {
      clearTimeout(guard);
      resolve(raw);
    });
  });
}

async function main() {
  if (env.CC_TOOLKIT_DISABLE === "1") return silent("CC_TOOLKIT_DISABLE=1");

  const raw = await readStdin();
  let event = {};
  try {
    event = raw ? JSON.parse(raw) : {};
  } catch {
    debug("stdin 不是合法 JSON");
  }

  // 防止 hook 自我递归
  if (event.stop_hook_active) return silent("stop_hook_active");

  const tracker = core.trackerForHookEvent(event, { cwd: process.cwd() });
  if (!tracker) return silent("定位不到会话文件");

  const sessionId = event.session_id || require("path").basename(tracker.file).replace(/\.jsonl$/, "");
  const minTokens = parseInt(env.CC_TOOLKIT_MIN_TOKENS || "30", 10) || 30;
  const alertsOn = env.CC_TOOLKIT_ALERTS !== "0";
  const show = new Set(
    (env.CC_TOOLKIT_SHOW || "tps,ttft,decode,cache,median")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );

  const targetId = tracker.currentId;
  const attempts = 4;
  await new Promise((resolve) => {
    const attempt = (left) => {
      tracker.pump();
      const g = targetId ? tracker.groups.get(targetId) : tracker.currentGroup();
      // 拿到 usage 精确值就可以走了；否则再多等几轮，尽量别用估算值
      if (g && g.out > 0) return resolve();
      if (left > 0) return setTimeout(() => attempt(left - 1), 120);
      resolve();
    };
    attempt(attempts);
  });

  // 取本轮读数：用 latestRound（不走统计过滤器），否则短回复会被
  // MIN_SAMPLE_TOKENS=50 吃掉，用户设的 CC_TOOLKIT_MIN_TOKENS 就形同虚设。
  // force=true —— Stop 事件本身就是「本轮已结束」的信号，不必再等流式窗口。
  const round = tracker.latestRound({ force: true });
  if (!round) return silent("没有可报告的轮次");

  if (round.tokens < minTokens) {
    return silent(`样本太小 (${Math.round(round.tokens)} < ${minTokens} tok)`);
  }
  if (!(round.durMs > 0)) return silent("耗时无效");

  const tps = round.tps;
  const slowThreshold = parseFloat(env.CC_TOOLKIT_SLOW_TOKENS_PER_SEC || "20") || 20;
  const isSlow = tps < slowThreshold;
  const quiet = env.CC_TOOLKIT_QUIET === "1";

  // 聚合量：中位数、缓存中位等都从样本里来（含刚结束的当前轮）
  const samples = tracker.recentSamples(undefined, { force: true });
  const rollup = tracker.rollup(samples);

  const state = readState(sessionId);
  const alerts = [];

  // ── 告警：这些情况下的「慢」有各自的成因，不该只报一个数字 ──
  if (alertsOn) {
    if (round.stoppedByLimit) {
      alerts.push("⚠ 本轮被 max_tokens 截断，token 数不是完整输出");
    }
    if (round.refused) alerts.push("⚠ 本轮以 refusal 结束");
    if (round.cache && round.cache.hitRatio < core.LOW_CACHE_HIT_RATIO) {
      alerts.push(
        `⚠ prompt 缓存命中仅 ${(round.cache.hitRatio * 100).toFixed(0)}%（<${core.LOW_CACHE_HIT_RATIO * 100}%），` +
          "首字等待和成本都会偏高"
      );
    }
    // API 重试：只在本轮那段时间窗内发生的才算数
    const recentErrors = tracker.apiErrors.filter((e) => e.at && e.at >= round.start - 2000);
    if (recentErrors.length) {
      const codes = [...new Set(recentErrors.map((e) => e.code || e.source || "error"))].join(",");
      alerts.push(`⚠ 本轮期间有 ${recentErrors.length} 次 API 重试 [${codes}]`);
    }
  }

  // 慢速反复出现时只提示一次，避免每轮刷屏
  const SLOW_REMIND_MS = 5 * 60 * 1000;
  if (quiet && !isSlow) {
    // QUIET 模式下速度正常：只在告警确实有内容时打扰
    if (!alerts.length) return silent(`QUIET 模式，速度正常 (${tps.toFixed(0)} tok/s)`);
  }
  if (quiet && isSlow) {
    const last = state.lastSlowAt || 0;
    if (Date.now() - last < SLOW_REMIND_MS && !alerts.length) {
      return silent("QUIET 模式，慢速提示在冷却中");
    }
    state.lastSlowAt = Date.now();
  }

  let msg;
  const mark = round.estimated ? "≈" : "";
  if (quiet && isSlow) {
    msg = `🐢 本轮偏慢 ${mark}${tps.toFixed(0)} tok/s (${mark}${core.formatTokens(round.tokens)} tok / ${(round.durMs / 1000).toFixed(1)}s)`;
    if (round.ttftMeaningful) msg += ` · 首字 ${(round.ttftMs / 1000).toFixed(1)}s`;
    if (round.decodeTps > 0) msg += ` · 解码 ${Math.round(round.decodeTps)}`;
    if (rollup.median != null) msg += ` · 近${rollup.count}条中位 ${rollup.median.toFixed(0)} tok/s`;
  } else {
    msg = composeMessage(round, rollup, { show });
  }
  if (alerts.length) msg += "\n" + alerts.join("\n");

  // ── 桌面通知：只在真的异常慢、且离上次通知够久时才发 ──
  const payload = { systemMessage: msg };
  if (env.CC_TOOLKIT_NOTIFY === "1" && isSlow) {
    const gap = parseInt(env.CC_TOOLKIT_NOTIFY_MIN_MS || "60000", 10) || 60000;
    if (Date.now() - (state.lastNotifyAt || 0) >= gap) {
      state.lastNotifyAt = Date.now();
      payload.terminalSequence = core.notifySequence(
        "cc-toolkit",
        `本轮偏慢 ${tps.toFixed(0)} tok/s${round.decodeTps > 0 ? `（解码 ${Math.round(round.decodeTps)}）` : ""}`
      );
    }
  }

  // 把状态落盘，供 statusline 直接读取（避免它每次刷新都回放 2MB 日志）
  try {
    core.writeCache(sessionId, tracker.snapshot({ force: true }));
  } catch {
    /* 缓存失败无所谓 */
  }
  writeState(sessionId, state);

  debug("输出:", msg);
  respond(payload);
}

main().catch((err) => {
  console.error("[cc-toolkit] hook 异常:", err && err.message);
  process.exit(0); // 无论如何不要阻塞会话
});
