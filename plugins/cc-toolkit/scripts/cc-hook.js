#!/usr/bin/env node
"use strict";
/**
 * cc-hook — Stop hook：每轮回复结束后，把本轮输出速度回吐给用户
 *
 * 在 stdin 收到 Claude Code 的 Stop 事件 JSON，往 stdout 吐
 *   {"systemMessage": "首字 0.8s | 每秒输出 68 tok/s | 缓存命中 92%"}
 * systemMessage 只展示给用户，不会进入模型上下文（不污染对话、不花 token）。
 *
 * 只给三个原始读数，不给结论：首字等待、每秒输出、缓存命中率。
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
 *                               默认 "ttft,decode,cache"
 *                               可选 ttft(首字) decode(每秒输出/纯解码)
 *                                    cache(缓存命中) tps(整轮速度)
 *                                    median(近期中位) tokens(本轮 token 数)
 *                                    thinking(思维链占比) model effort skill
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
 * 三个字段对应三个正交的事实：等多久、生成多快、prompt 缓存有没有生效。
 * 「每秒输出」用 decodeTps（首块 → 末块）而不是整轮 tps —— 后者含 prefill，
 * 和「首字」两段会重复计入同一段时间。块被一次性写盘时 decodeTps 测不出来，
 * 这一段就整条省略，不拿含 prefill 的整轮速度冒充。
 */
function composeMessage(round, rollup, opts) {
  const { show } = opts;
  const mark = round.estimated ? "≈" : "";
  const bits = [];

  if (show.has("ttft") && round.ttftMeaningful) {
    bits.push(`首字 ${(round.ttftMs / 1000).toFixed(1)}s`);
  }
  // decodeTps 的分母已经在 core 里扣掉首字等待，这个数就是纯生成速度
  if (show.has("decode") && round.decodeTps > 0) {
    bits.push(`每秒输出 ${mark}${Math.round(round.decodeTps)} tok/s`);
  }
  if (show.has("cache") && round.cache) bits.push(`缓存命中 ${(round.cache.hitRatio * 100).toFixed(0)}%`);

  // 以下字段默认关着，只有用户显式加进 CC_TOOLKIT_SHOW 才出现
  if (show.has("tps")) bits.push(`整轮 ${mark}${round.tps.toFixed(0)} tok/s`);
  if (show.has("tokens")) bits.push(`${mark}${core.formatTokens(round.tokens)} tok`);
  if (show.has("tps") || show.has("tokens")) {
    bits[bits.length - 1] += ` / ${(round.durMs / 1000).toFixed(1)}s`;
  }
  if (show.has("thinking") && round.thinkingTokens > 0) {
    bits.push(`思考 ${(round.thinkingShare * 100).toFixed(0)}%`);
  }
  if (show.has("model") && round.model) bits.push(round.model);
  if (show.has("effort") && round.effort) bits.push(`effort=${round.effort}`);
  if (show.has("skill") && round.skill) bits.push(`skill=${round.skill}`);

  let msg = bits.join(" | ");

  const med = rollup ? rollup.median : null;
  if (show.has("median") && med != null && rollup.count) {
    msg += `${msg ? " | " : ""}近${rollup.count}条中位 ${med.toFixed(0)} tok/s`;
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
    (env.CC_TOOLKIT_SHOW || "ttft,decode,cache")
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

  // 聚合量：中位数等只在用户把 median 加进 CC_TOOLKIT_SHOW 时才需要
  const samples = show.has("median") ? tracker.recentSamples(undefined, { force: true }) : [];
  const rollup = tracker.rollup(samples);

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

  let msg = composeMessage(round, rollup, { show });
  if (alerts.length) msg += (msg ? "\n" : "") + alerts.join("\n");
  // 三个读数都取不到（单块回复 + 没有 usage）时没有可展示的内容
  if (!msg) return silent("没有可展示的字段");

  const payload = { systemMessage: msg };

  // 把状态落盘，供 statusline 直接读取（避免它每次刷新都回放 2MB 日志）
  try {
    core.writeCache(sessionId, tracker.snapshot({ force: true }));
  } catch {
    /* 缓存失败无所谓 */
  }

  debug("输出:", msg);
  respond(payload);
}

main().catch((err) => {
  console.error("[cc-toolkit] hook 异常:", err && err.message);
  process.exit(0); // 无论如何不要阻塞会话
});
