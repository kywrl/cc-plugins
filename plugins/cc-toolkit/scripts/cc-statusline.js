#!/usr/bin/env node
"use strict";
/**
 * cc-statusline — 把 tok/s 塞进 Claude Code 的状态栏
 *
 * 状态栏每次刷新都会调用这个脚本，所以它必须便宜：
 *   1. 先读 <临时目录>/cc-toolkit-<session>.json 缓存（由 Stop hook 写）；
 *   2. 缓存缺失或过期 → 只回放 transcript 末尾 400KB 重算一次，然后写回缓存。
 * 绝不做全量回放；缓存里只存 lastRound 与预先算好的聚合量，本身不遍历样本。
 *
 * 用法（放进 settings.json 的 statusLine.command）:
 *   node "${CLAUDE_PLUGIN_ROOT}/scripts/cc-statusline.js"
 *
 * 环境变量:
 *   CC_TOOLKIT_STATUSLINE_PREFIX   前缀，默认 "⚡ "
 *   CC_TOOLKIT_MIN_TOKENS=30       低于该 token 数不显示（0 = 全显示）
 *   CC_TOOLKIT_STATUSLINE_CACHE_MS 缓存有效期，默认 45000（0 = 不用缓存）
 *   CC_TOOLKIT_STATUSLINE_FIELDS   显示的字段，逗号分隔，默认 "tps,ttft,cache"
 *                                  可选: tps(整轮速度) ttft(首字等待)
 *                                        decode(每秒输出) cache(缓存命中)
 *                                        median(近期中位；开启后本轮无缓存读数时
 *                                        会附加「(缓存中位 N%)」)
 *                                  只有 tps 不带标签、直接给数字；其余带短标签。
 *                                  字段含义与 hook 的 CC_TOOLKIT_SHOW 相同，
 *                                  但 hook 另有 tokens/thinking/model/effort/skill
 *                                  等字段，状态栏不渲染（见 README）。
 *   CC_TOOLKIT_ALERTS=0            关掉 ⚠截断 提示
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

  // 显式给定的 0 是有意义的（MIN_TOKENS=0 表示全显示、CACHE_MS=0 表示不用缓存），
  // 所以不能用 `|| 默认值` —— 那会把 0 一起换掉。只有缺失或非法才回默认。
  const num = (v, dflt) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : dflt;
  };
  const minTokens = num(env.CC_TOOLKIT_MIN_TOKENS, 30);
  const cacheMs = num(env.CC_TOOLKIT_STATUSLINE_CACHE_MS, 45000);
  const alertsOn = env.CC_TOOLKIT_ALERTS !== "0";
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
  const cached = sessionId ? core.readCache(sessionId, cacheMs, input.transcript_path || null) : null;
  if (cached) {
    last = cached.lastRound || null;
    rollup = cached.rollup || null;
  } else if (input.transcript_path && fs.existsSync(input.transcript_path)) {
    // ② 缓存过期：只回放末尾 400KB，并顺手把聚合量一起算好写回。
    // force:true —— 状态栏只在模型回完话之后才被刷新，本轮已经结束；
    // 不传的话流式窗口内会取到上一轮，还会把上一轮的读数写进缓存。
    const tracker = new core.SessionTracker(input.transcript_path).start({ replayTailBytes: 400_000 });
    last = tracker.latestRound({ force: true });
    rollup = tracker.rollup(tracker.recentSamples(undefined, { force: true }));
    // 没有可读的轮次就别写缓存：空白快照会被 readCache 当成有效命中，
    // 把状态栏空白地锁住整个 TTL。
    if (last && sessionId) {
      try {
        core.writeCache(sessionId, tracker.snapshot({ force: true }));
      } catch {
        /* ignore */
      }
    }
  }

  if (!last) process.exit(0);
  if (last.tokens < minTokens) process.exit(0);

  const mark = last.estimated ? "≈" : "";
  const bits = [];
  // 小数位：太慢的轮次四舍五入到 0 会渲染成一个从没测到的读数，保留一位
  const speed = (v) => (v >= 1 ? v.toFixed(0) : v.toFixed(1));

  if (fields.has("tps")) bits.push(`${mark}${speed(last.tps)} tok/s`);
  if (fields.has("median") && rollup && rollup.median != null) bits.push(`中位 ${speed(rollup.median)}`);
  // ttftMeaningful: 单块回复的首字恒等于整轮耗时，重复显示只会让人以为算错了
  if (fields.has("ttft") && last.ttftMeaningful) bits.push(`首字 ${(last.ttftMs / 1000).toFixed(1)}s`);
  // 与 hook 的「每秒输出」保持同一个口径，包括估算标记
  if (fields.has("decode") && last.decodeTps > 0) bits.push(`解码 ${mark}${speed(last.decodeTps)}`);
  if (fields.has("cache") && last.cache) bits.push(`缓存 ${(last.cache.hitRatio * 100).toFixed(0)}%`);

  const extras = [];
  if (last.stoppedByLimit && alertsOn) extras.push("⚠截断");
  if (rollup && fields.has("median") && rollup.medianCacheHit != null && !last.cache) {
    extras.push(`(缓存中位 ${(rollup.medianCacheHit * 100).toFixed(0)}%)`);
  }

  // 选中的字段这一段恰好都取不到（单块回复的 decode、没有 usage 的 cache）时，
  // 只剩一个光秃秃的前缀，不如什么都不输出
  if (!bits.length) process.exit(0);

  let out = `${prefix}${bits.join(" · ")}`;
  if (extras.length) out += ` ${extras.join(" ")}`;

  process.stdout.write(out);
}

try {
  main();
} catch {
  process.exit(0);
}
