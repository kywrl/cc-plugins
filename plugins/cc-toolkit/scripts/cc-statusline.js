#!/usr/bin/env node
"use strict";
/**
 * cc-statusline — 把 tok/s 塞进 Claude Code 的状态栏
 *
 * 状态栏每次刷新都会调用这个脚本，所以它必须便宜：
 *   1. 先读 ~/.tmp/cc-toolkit-<session>.json 缓存（由 Stop hook 写）；
 *   2. 缓存缺失或过期 → 只回放 transcript 末尾 400KB 重算一次，然后写回缓存。
 * 绝不做全量回放。
 *
 * 用法（放进 settings.json 的 statusLine.command）:
 *   node "${CLAUDE_PLUGIN_ROOT}/scripts/cc-statusline.js"
 *
 * 环境变量:
 *   CC_TOOLKIT_STATUSLINE_PREFIX   前缀，默认 "⚡ "
 *   CC_TOOLKIT_MIN_TOKENS=30       低于该 token 数不显示
 *   CC_TOOLKIT_STATUSLINE_CACHE_MS 缓存有效期，默认 45000
 *   CC_TOOLKIT_DISABLE=1           禁用（输出空）
 */

const fs = require("fs");
const path = require("path");
const core = require("./cc-core");

const env = process.env;
if (env.CC_TOOLKIT_DISABLE === "1") process.exit(0);

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function main() {
  let input = {};
  try {
    input = JSON.parse(readStdin() || "{}");
  } catch {
    /* 状态栏没有输入也要能工作 */
  }

  const sessionId =
    input.session_id ||
    (input.transcript_path ? path.basename(input.transcript_path).replace(/\.jsonl$/, "") : null);

  const minTokens = parseInt(env.CC_TOOLKIT_MIN_TOKENS || "30", 10) || 30;
  const cacheMs = parseInt(env.CC_TOOLKIT_STATUSLINE_CACHE_MS || "45000", 10) || 45000;
  const prefix = env.CC_TOOLKIT_STATUSLINE_PREFIX != null ? env.CC_TOOLKIT_STATUSLINE_PREFIX : "⚡ ";

  // ① 优先用缓存
  let samples = null;
  const cached = sessionId ? core.readCache(sessionId, cacheMs) : null;
  if (cached) {
    samples = cached.samples;
  } else if (input.transcript_path && fs.existsSync(input.transcript_path)) {
    // ② 缓存过期：只回放末尾 400KB
    const tracker = new core.SessionTracker(input.transcript_path).start({ replayTailBytes: 400_000 });
    samples = tracker.recentSamples(); // 收尾后的视图：含刚结束但未被归档的最后一轮
    if (sessionId) {
      try {
        core.writeCache(sessionId, tracker.snapshot());
      } catch {
        /* ignore */
      }
    }
  }

  if (!samples || !samples.length) process.exit(0);

  const last = samples[samples.length - 1];
  if (last.tokens < minTokens) process.exit(0);

  const mark = last.estimated ? "≈" : "";
  const med = core.median(samples.slice(-5).map((d) => d.tps));

  let out = `${prefix}${mark}${last.tps.toFixed(0)} tok/s`;
  if (med != null) out += ` (中位 ${med.toFixed(0)})`;

  process.stdout.write(out);
}

try {
  main();
} catch {
  process.exit(0);
}
