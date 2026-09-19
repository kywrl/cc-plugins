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

  const tokens = round.tokens;
  const durMs = round.durMs;
  const estimated = round.estimated;

  if (tokens < minTokens) return silent(`样本太小 (${Math.round(tokens)} < ${minTokens} tok)`);
  if (!(durMs > 0)) return silent("耗时无效");

  const tps = round.tps;
  const slowThreshold = parseFloat(env.CC_TOOLKIT_SLOW_TOKENS_PER_SEC || "20") || 20;
  if (env.CC_TOOLKIT_QUIET === "1" && tps >= slowThreshold) {
    return silent(`QUIET 模式，速度正常 (${tps.toFixed(0)} tok/s)`);
  }

  // 中位数只由通过统计过滤的样本参与（本轮即便太小也不影响它）
  const priorTps = tracker.samples.slice(-9).map((d) => d.tps);

  const mark = estimated ? "≈" : "";
  const med = core.median(priorTps);

  let msg;
  if (env.CC_TOOLKIT_QUIET === "1") {
    msg = `🐢 本轮偏慢 ${mark}${tps.toFixed(0)} tok/s (${mark}${core.formatTokens(tokens)} tok / ${(durMs / 1000).toFixed(1)}s)`;
    if (med != null) msg += ` · 近${priorTps.length}条中位 ${med.toFixed(0)} tok/s`;
  } else {
    msg = `⚡ 本轮 ${mark}${tps.toFixed(0)} tok/s  (${mark}${core.formatTokens(tokens)} tok / ${(durMs / 1000).toFixed(1)}s)`;
    if (med != null) msg += `  ·  近${priorTps.length}条中位 ${med.toFixed(0)} tok/s`;
  }

  // 把状态落盘，供 statusline 直接读取（避免它每次刷新都回放 2MB 日志）
  try {
    core.writeCache(sessionId, tracker.snapshot({ force: true }));
  } catch {
    /* 缓存失败无所谓 */
  }

  debug("输出:", msg);
  respond({ systemMessage: msg });
}

main().catch((err) => {
  console.error("[cc-toolkit] hook 异常:", err && err.message);
  process.exit(0); // 无论如何不要阻塞会话
});
