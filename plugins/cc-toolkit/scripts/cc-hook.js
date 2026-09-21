#!/usr/bin/env node
"use strict";
/**
 * cc-hook — Stop hook：每轮回复结束后，把本轮输出速度回吐给用户
 *
 * 在 stdin 收到 Claude Code 的 Stop 事件 JSON，往 stdout 吐
 *   {"systemMessage": "12 步 | 每秒输出 68 tok/s | 缓存命中 92%"}
 * systemMessage 只展示给用户，不会进入模型上下文（不污染对话、不花 token）。
 *
 * 只给三个原始读数，不给结论：本轮步数、每秒输出、缓存命中率。
 * 「偏慢」「缓存命中过低」这类判断从这三个数就能一眼看出，再复述一遍只是噪音。
 *
 * 静默优先：任何异常、定位不到会话、样本太小 —— 都直接 exit 0 什么都不输出，
 * 绝不因为一个测速工具干扰正常会话。
 *
 * 环境变量:
 *   CC_TOOLKIT_DISABLE=1        完全禁用（等于没装这个 hook）
 *   CC_TOOLKIT_MIN_TOKENS=30    低于该 token 数不报告
 *   CC_TOOLKIT_VERBOSE=1        把诊断信息写到 stderr（不影响 hook 协议）
 *   CC_TOOLKIT_SHOW=            控制行里包含哪些字段，逗号分隔
 *                               默认 "steps,decode,cache"
 *                               可选 steps(本轮步数) decode(每秒输出/纯解码)
 *                                    cache(缓存命中) tps(整轮速度)
 *                                    tokens(本轮 token 数) thinking(思维链占比)
 *                                    model effort skill
 *   CC_TOOLKIT_ALERTS=1         打开截断 / refusal / API 重试的额外提示
 */

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

/**
 * 把本轮读数拼成一行。
 *
 * 三个字段对应三个正交的事实：这一轮有多重、生成多快、prompt 缓存有没有生效。
 * 「每秒输出」用 decodeTps（各步内部的跨度之和）而不是整轮 tps ——
 * 后者含 prefill 与中途的工具执行时间，两段会重复计入同一段时间。
 *
 * 三格**位置固定**：算不出来的那个显示 —，而不是整段消失。
 * 缺一段会让「这一行有几个数」在每轮之间跳变，读者得先数一遍才知道少了什么；
 * 固定三格则一眼能看出「哪个数没测到」。
 */
function composeMessage(round, opts) {
  const { show } = opts;
  // 估算标记按字段独立判断：哪个数字来自字符估算，就在哪个前面加 ≈。
  // 整行共用一个标记会让人误以为三个数都是估的。
  const f = round.estimatedFields || {};
  const mark = (key) => (f[key] ? "≈" : "");
  const bits = [];

  // 第一格：本轮步数。一轮里模型生成几次、因此过了几轮工具 —— 这是「这一轮有多重」。
  // 步数来自 message.id 个数，没有估算与精确之分，不参与 ≈ 标记。
  if (show.has("steps")) {
    bits.push(round.calls >= 1 ? `${round.calls} 步` : "步数 —");
  }
  // decodeTps 已有可测区间时才报；测不出就诚实占位，不拿含 prefill / 工具时间的数冒充
  if (show.has("decode")) {
    bits.push(
      round.decodeTps > 0
        ? `每秒输出 ${mark("decode")}${Math.round(round.decodeTps)} tok/s`
        : "每秒输出 —"
    );
  }
  if (show.has("cache")) {
    bits.push(
      round.cache
        ? `缓存命中 ${mark("cache")}${(round.cache.hitRatio * 100).toFixed(0)}%`
        : "缓存命中 —"
    );
  }

  // 以下字段默认关着，只有用户显式加进 CC_TOOLKIT_SHOW 才出现。
  // 同样遵循「算不出就占位」：锚点被切掉时整轮耗时无意义，显示 — 而不是 0。
  if (show.has("tps")) {
    bits.push(round.durMs > 0 ? `整轮 ${round.tps.toFixed(0)} tok/s` : "整轮 —");
  }
  if (show.has("tokens")) {
    bits.push(`${mark("decode")}${core.formatTokens(round.tokens)} tok`);
  }
  if (show.has("tps") || show.has("tokens")) {
    bits[bits.length - 1] += ` / ${(round.durMs / 1000).toFixed(1)}s`;
  }
  if (show.has("thinking") && round.thinkingTokens > 0) {
    bits.push(`思考 ${(round.thinkingShare * 100).toFixed(0)}%`);
  }
  if (show.has("model") && round.model) bits.push(round.model);
  if (show.has("effort") && round.effort) bits.push(`effort=${round.effort}`);
  if (show.has("skill") && round.skill) bits.push(`skill=${round.skill}`);

  return bits.join(" | ");
}

/**
 * 这一行里有没有一个真实读数（而不是清一色的 —）。
 * 全是 — 的话不如不输出 —— 一行占位符对用户没有信息量。
 */
function hasAnyRealReading(round, show) {
  if (show.has("steps") && round.calls >= 1) return true;
  if (show.has("decode") && round.decodeTps > 0) return true;
  if (show.has("cache") && round.cache) return true;
  if (show.has("tps") && round.durMs > 0) return true;
  if (show.has("tokens") && round.tokens >= 1) return true;
  if (show.has("thinking") && round.thinkingTokens > 0) return true;
  if (show.has("model") && round.model) return true;
  if (show.has("effort") && round.effort) return true;
  if (show.has("skill") && round.skill) return true;
  return false;
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

  // 显式给定的 0 有意义（MIN_TOKENS=0 = 全显示），不能用 `|| 默认值` 一起换掉
  const minTokensRaw = parseInt(env.CC_TOOLKIT_MIN_TOKENS, 10);
  const minTokens = Number.isFinite(minTokensRaw) && minTokensRaw >= 0 ? minTokensRaw : 30;
  const alertsOn = env.CC_TOOLKIT_ALERTS !== "0";
  const show = new Set(
    (env.CC_TOOLKIT_SHOW || "steps,decode,cache")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );

  // 等一轮落盘再读数：Stop 事件到达时，最后若干行可能还在缓冲。
  // 判据是「本轮出现过的步里有任意一步带上了 usage」——
  // 只盯某一步会一直等不到（usage 只落在少数步上）。
  const attempts = 4;
  await new Promise((resolve) => {
    const attempt = (left) => {
      tracker.pump();
      const gotUsage = tracker.currentSteps.some((s) => s.hasUsage);
      if (gotUsage) return resolve();
      if (left > 0) return setTimeout(() => attempt(left - 1), 120);
      resolve();
    };
    attempt(attempts);
  });

  // 取本轮读数：latestRound 给的是「用户视角的一轮」（你发消息 → 回复结束），
  // 也是唯一的读数入口。是否报告由下面 CC_TOOLKIT_MIN_TOKENS 一处决定。
  const round = tracker.latestRound();
  if (!round) return silent("没有可报告的轮次");

  if (round.tokens < minTokens) {
    return silent(`样本太小 (${Math.round(round.tokens)} < ${minTokens} tok)`);
  }

  const alerts = [];

  // ── 告警：只报「从三个读数里看不出来的事」 ──
  // 缓存命中率本身就是三个读数之一，不再额外拎出来说一遍。
  if (alertsOn) {
    if (round.stoppedByLimit) {
      alerts.push("⚠ 本轮被 max_tokens 截断，token 数不是完整输出");
    }
    if (round.refused) alerts.push("⚠ 本轮以 refusal 结束");
    // API 重试：只在本轮那段时间窗内发生的才算数
    const recentErrors = tracker.apiErrors.filter((e) => e.at && e.at >= round.start - 2000);
    if (recentErrors.length) {
      const codes = [...new Set(recentErrors.map((e) => e.code || e.source || "error"))].join(",");
      alerts.push(`⚠ 本轮期间有 ${recentErrors.length} 次 API 重试 [${codes}]`);
    }
  }

  let msg = composeMessage(round, { show });
  if (alerts.length) msg += (msg ? "\n" : "") + alerts.join("\n");

  // 三格全是 — 时（连 token 都没有的极短回复）没有可展示的内容，
  // 但只要有任何一个真实读数就照常输出 —— 哪怕另外两格是 —。
  if (!hasAnyRealReading(round, show) && !alerts.length) {
    return silent("三个读数都没测到");
  }

  const payload = { systemMessage: msg };

  debug("输出:", msg);
  respond(payload);
}

main().catch((err) => {
  console.error("[cc-toolkit] hook 异常:", err && err.message);
  process.exit(0); // 无论如何不要阻塞会话
});
