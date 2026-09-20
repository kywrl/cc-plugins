#!/usr/bin/env node
"use strict";
/**
 * cc-statusline — 把 tok/s 塞进 Claude Code 的状态栏
 *
 * 状态栏每次刷新都会调用这个脚本，所以它必须便宜：
 *   1. 先读 ~/.tmp/cc-toolkit-<session>.json 缓存（由 Stop hook 写）；
 *   2. 缓存缺失或过期 → 只回放 transcript 末尾 400KB 重算一次，然后写回缓存。
 * 绝不做全量回放，也不遍历样本重算聚合 —— 聚合量由写入方（hook）算好。
 *
 * 用法（放进 settings.json 的 statusLine.command）:
 *   node "${CLAUDE_PLUGIN_ROOT}/scripts/cc-statusline.js"
 *
 * 环境变量:
 *   CC_TOOLKIT_STATUSLINE_PREFIX   前缀，默认 "⚡ "
 *   CC_TOOLKIT_MIN_TOKENS=30       低于该 token 数不显示
 *   CC_TOOLKIT_STATUSLINE_CACHE_MS 缓存有效期，默认 45000
 *   CC_TOOLKIT_STATUSLINE_FIELDS   显示的字段，逗号分隔，默认 "tps,ttft,cache"
 *                                  可选: tps(整轮速度) median(近9条中位)
 *                                        ttft(首字等待) decode(纯解码) cache(缓存命中)
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
  const fields = new Set(
    (env.CC_TOOLKIT_STATUSLINE_FIELDS || "tps,ttft,cache")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );

  // ① 优先用缓存（最新一轮 + 预先算好的聚合量）
  let last = null;
  let rollup = null;
  const cached = sessionId ? core.readCache(sessionId, cacheMs) : null;
  if (cached) {
    last = cached.lastRound || (cached.samples || [])[cached.samples.length - 1] || null;
    rollup = cached.rollup || null;
  } else if (input.transcript_path && fs.existsSync(input.transcript_path)) {
    // ② 缓存过期：只回放末尾 400KB，并顺手把聚合量一起算好写回
    const tracker = new core.SessionTracker(input.transcript_path).start({ replayTailBytes: 400_000 });
    last = tracker.latestRound();
    rollup = tracker.rollup();
    if (sessionId) {
      try {
        core.writeCache(sessionId, tracker.snapshot());
      } catch {
        /* ignore */
      }
    }
  }

  if (!last) process.exit(0);
  if (last.tokens < minTokens) process.exit(0);

  const mark = last.estimated ? "≈" : "";
  const bits = [];

  if (fields.has("tps")) bits.push(`${mark}${last.tps.toFixed(0)} tok/s`);
  if (fields.has("median") && rollup && rollup.median != null) bits.push(`中位 ${rollup.median.toFixed(0)}`);
  // ttftMeaningful: 单块回复的首字恒等于整轮耗时，重复显示只会让人以为算错了
  if (fields.has("ttft") && last.ttftMeaningful) bits.push(`首字 ${(last.ttftMs / 1000).toFixed(1)}s`);
  if (fields.has("decode") && last.decodeTps > 0) bits.push(`解码 ${Math.round(last.decodeTps)}`);
  if (fields.has("cache") && last.cache) bits.push(`缓存 ${(last.cache.hitRatio * 100).toFixed(0)}%`);

  let out = `${prefix}${bits.join(" · ")}`;
  if (last.stoppedByLimit) out += " ⚠截断";
  if (rollup && fields.has("median") && rollup.medianCacheHit != null && !last.cache) {
    out += ` (缓存中位 ${(rollup.medianCacheHit * 100).toFixed(0)}%)`;
  }

  process.stdout.write(out);
}

try {
  main();
} catch {
  process.exit(0);
}
