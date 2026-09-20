#!/usr/bin/env node
"use strict";
/**
 * cc-watch — 实时查看 Claude Code 会话的输出速度 (tok/s)
 *
 * 用法:
 *   node scripts/cc-watch.js                # 实时监视（自动定位当前项目的会话）
 *   node scripts/cc-watch.js --report       # 打印多行快照后退出（给斜杠命令用）
 *   node scripts/cc-watch.js --insights     # 指标分层 + 会话级事实（归因 / 缓存 / 重试）
 *   node scripts/cc-watch.js --once         # 只打印一行汇总后退出
 *   node scripts/cc-watch.js --json         # 输出结构化 JSON（给脚本 / 模型消费）
 *   node scripts/cc-watch.js <file.jsonl>   # 跟踪指定会话文件
 *   node scripts/cc-watch.js -p <项目名>     # 指定项目目录名，如 D--workspace-cc-toolkit
 *   node scripts/cc-watch.js --history=20   # 快照里显示最近多少条（默认 10）
 *   node scripts/cc-watch.js --interval=500 # 实时模式的刷新间隔（毫秒，默认 800）
 *   node scripts/cc-watch.js --all          # 回放整个会话文件（默认只回放末尾 2MB）
 */

const path = require("path");
const core = require("./cc-core");

function parseArgs(argv) {
  const flag = (name) => argv.includes(`--${name}`);
  const value = (name, fallback) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.split("=").slice(1).join("=") : fallback;
  };
  const projIdx = argv.indexOf("-p");

  const intervalRaw = parseInt(value("interval", "800"), 10);
  const historyRaw = parseInt(value("history", "10"), 10);

  return {
    live: !flag("report") && !flag("once") && !flag("json") && !flag("insights"),
    report: flag("report"),
    insights: flag("insights"),
    once: flag("once"),
    json: flag("json"),
    all: flag("all"),
    project: projIdx >= 0 ? argv[projIdx + 1] : null,
    explicit: argv.find((a) => !a.startsWith("-") && a.endsWith(".jsonl")) || null,
    interval: Number.isFinite(intervalRaw) ? Math.max(200, intervalRaw) : 800,
    history: Number.isFinite(historyRaw) && historyRaw > 0 ? historyRaw : 10,
  };
}

/** 统计事实块 —— 给模型解读用，只陈述数据不下结论 */
function renderFacts(tracker) {
  const a = core.analyze(tracker, { window: 10 });
  if (!a.overall) return "样本不足，无法给出统计事实。";

  const lines = ["── 统计事实 ──"];
  lines.push(`样本数 ${a.sampleCount}（其中估算值占 ${(a.estimatedShare * 100).toFixed(0)}%）`);
  lines.push(
    `整体 中位 ${a.overall.median.toFixed(0)} tok/s | 均值 ${a.overall.mean.toFixed(0)} | ` +
      `p90 ${a.overall.p90.toFixed(0)} | 最快 ${a.overall.best.tps.toFixed(0)} | 最慢 ${a.overall.worst.tps.toFixed(0)}`
  );
  if (a.trendPct != null) {
    const dir = a.trendPct >= 0 ? "快" : "慢";
    lines.push(
      `趋势 近10条中位 ${a.recent.median.toFixed(0)} tok/s，` +
        `再往前10条中位 ${a.earlier.median.toFixed(0)} tok/s → 变${dir} ${Math.abs(a.trendPct).toFixed(0)}%`
    );
  } else {
    lines.push("趋势 样本少于 20 条，暂不判断趋势。");
  }
  if (a.outliers.length) {
    lines.push(
      "离群（明显偏慢）" +
        a.outliers
          .map((d) => ` ${core.hhmmss(d.at)} ${d.tps.toFixed(0)} tok/s(${core.formatTokens(d.tokens)}tok/${(d.durMs / 1000).toFixed(1)}s)`)
          .join(" ·")
    );
  }
  lines.push(
    `累计 ${core.formatTokens(a.overall.totalTokens)} tok / ${(a.overall.totalMs / 1000).toFixed(1)}s，` +
      `解析 ${a.parsedLines} 行（失败 ${a.parseErrors} 行）`
  );
  return lines.join("\n");
}

function buildJson(tracker, opts) {
  const a = core.analyze(tracker, { window: opts.history });
  const snap = tracker.currentSpeed();
  const roundOut = (d) => ({
    at: d.at,
    time: core.hhmmss(d.at),
    tps: Number(d.tps.toFixed(2)),
    tokens: Math.round(d.tokens),
    seconds: Number((d.durMs / 1000).toFixed(2)),
    estimated: d.estimated,
    ttftMs: d.ttftMs == null ? null : Math.round(d.ttftMs),
    ttftMeaningful: !!d.ttftMeaningful,
    decodeTps: d.decodeTps > 0 ? Number(d.decodeTps.toFixed(2)) : null,
    decodeMs: d.decodeMs == null ? null : Math.round(d.decodeMs),
    decodeReason: d.decodeReason,
    thinkingTokens: d.thinkingTokens,
    // null = provider 没上报 thinking_tokens 明细，不是「占比为 0」
    thinkingShare: d.thinkingShare == null ? null : Number(d.thinkingShare.toFixed(4)),
    blocks: d.blocks,
    iterations: d.iterations.length,
    cacheHitRatio: d.cache ? Number(d.cache.hitRatio.toFixed(4)) : null,
    model: d.model,
    effort: d.effort,
    skill: d.skill,
    mcp: d.mcp,
    plugin: d.plugin,
    stopReason: d.stopReason,
    stoppedByLimit: d.stoppedByLimit,
  });
  const statsOut = (s) =>
    s
      ? {
          count: s.count,
          median: Number(s.median.toFixed(2)),
          mean: Number(s.mean.toFixed(2)),
          p90: Number(s.p90.toFixed(2)),
          best: Number(s.best.tps.toFixed(2)),
          worst: Number(s.worst.tps.toFixed(2)),
          medianDecodeTps: s.medianDecodeTps == null ? null : Number(s.medianDecodeTps.toFixed(2)),
          decodeCount: s.decodeCount,
          medianTtftMs: s.medianTtftMs == null ? null : Math.round(s.medianTtftMs),
          p90TtftMs: s.p90TtftMs == null ? null : Math.round(s.p90TtftMs),
        }
      : null;

  return {
    session: a.sessionId,
    project: a.project,
    file: tracker.file,
    current: snap ? roundOut(snap) : null,
    samples: tracker.recentSamples(opts.history).map(roundOut),
    stats: statsOut(a.overall),
    recent: statsOut(a.recent),
    earlier: statsOut(a.earlier),
    trendPct: a.trendPct == null ? null : Number(a.trendPct.toFixed(1)),
    decodeTrendPct: a.decodeTrendPct == null ? null : Number(a.decodeTrendPct.toFixed(1)),
    estimatedShare: Number(a.estimatedShare.toFixed(3)),
    // 分层对比：每个维度下样本量 ≥3 的分组
    breakdown: {
      skippedLong: a.breakdown.skippedLong,
      byEffort: a.breakdown.byDifficulty,
      byModel: a.breakdown.byModel,
      bySkill: a.breakdown.bySkill,
      byMcp: a.breakdown.byMcp,
      byPlugin: a.breakdown.byPlugin,
      byThinking: a.breakdown.byThinking,
      byToolUse: a.breakdown.byToolUse,
      byFirstBlock: a.breakdown.byFirstBlock,
    },
    sessionFacts: a.session,
  };
}

function main() {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);

  const file = core.pickSessionFile({ explicit: opts.explicit, project: opts.project });
  if (!file) {
    console.error(
      "未找到会话文件。用 node scripts/cc-watch.js <file.jsonl> 指定，或用 -p <项目名> 过滤。"
    );
    process.exit(1);
  }
  if (!require("fs").existsSync(file)) {
    console.error(`会话文件不存在: ${file}`);
    process.exit(1);
  }

  const tracker = new core.SessionTracker(file).start({
    replayTailBytes: opts.all ? Infinity : undefined,
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify(buildJson(tracker, opts), null, 2) + "\n");
    return;
  }

  if (opts.report) {
    process.stdout.write(core.renderReport(tracker, { history: opts.history }) + "\n");
    process.stdout.write(renderFacts(tracker) + "\n");
    return;
  }

  if (opts.insights) {
    process.stdout.write(core.renderInsights(tracker, { limit: opts.history > 10 ? opts.history : 5 }) + "\n");
    return;
  }

  if (opts.once) {
    process.stdout.write(core.stripAnsi(core.renderLive(tracker)) + "\n");
    return;
  }

  // 实时模式
  process.stdout.write(
    `${core.COLORS.dim}监控 ${path.basename(file)} (${path.basename(path.dirname(file))})` +
      `  Ctrl-C 退出${core.COLORS.reset}\n`
  );
  const timer = setInterval(() => {
    tracker.pump();
    process.stdout.write("\x1b[2K\r" + core.renderLive(tracker));
  }, opts.interval);

  const quit = () => {
    clearInterval(timer);
    process.stdout.write("\n" + core.stripAnsi(core.renderLive(tracker)) + "\n");
    process.exit(0);
  };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
}

main();
