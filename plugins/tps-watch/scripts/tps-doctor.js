#!/usr/bin/env node
"use strict";
/**
 * tps-doctor — 环境自检
 *
 * 装完插件后跑一下，确认：Node 版本够不够、会话目录在不在、
 * 当前工作目录能不能定位到会话文件、hook / statusline 该往哪配。
 *
 * 用法: node scripts/tps-doctor.js
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const core = require("./tps-core");

const OK = "✅";
const WARN = "⚠️ ";
const BAD = "❌";

const lines = [];
const say = (s = "") => lines.push(s);

say("tps-watch 环境自检");
say("──────────────────");

// ① Node 版本：用到了 fs.readFileSync(0) / Object spread，10 以上稳妥
const major = parseInt(process.versions.node.split(".")[0], 10);
say(
  `${major >= 16 ? OK : BAD} Node.js ${process.versions.node}` +
    (major >= 16 ? "" : "  → 版本过低，请升级到 Node 16 或更高（建议 18+）")
);

// ② 会话目录
const projectsDir = core.PROJECTS_DIR;
if (!fs.existsSync(projectsDir)) {
  say(`${BAD} 会话目录不存在: ${projectsDir}`);
  say("   → 说明还没有用 Claude Code 跑过任何会话，或 HOME 指向不对。");
} else {
  say(`${OK} 会话目录: ${projectsDir}`);
}

// ③ 扫描到的会话数
const sessions = core.listSessions({});
say(`${sessions.length ? OK : WARN} 扫描到 ${sessions.length} 个会话文件`);
if (!sessions.length) {
  say("   → 至少跑一次 Claude Code 会话后才会出现。");
}

// ④ 当前目录能否定位
const picked = core.pickSessionFile({ cwd: process.cwd() });
if (!picked) {
  say(`${BAD} 无法为当前目录定位会话文件`);
  say("   → 用 -p <项目目录名> 显式指定。");
} else {
  const expectedDir = core.projectDirFor(process.cwd());
  const actualDir = path.basename(path.dirname(picked));
  const exact = expectedDir === actualDir;
  say(
    `${exact ? OK : WARN} 当前目录 → 项目目录名 "${expectedDir}"，` +
      `${exact ? "命中" : `未命中，回退到最新会话 "${actualDir}"`}`
  );
  say(`   选中的会话文件: ${path.basename(picked)}`);

  // ⑤ 能不能真的读出样本
  try {
    const tracker = new core.SessionTracker(picked).start();
    const stats = tracker.stats();
    if (stats) {
      say(
        `${OK} 解析成功：${stats.count} 条样本，中位 ${stats.median.toFixed(0)} tok/s，` +
          `已解析 ${tracker.parsedLines} 行（失败 ${tracker.parseErrors} 行）`
      );
    } else {
      say(`${WARN} 能读到文件，但样本不足（低于 ${core.MIN_SAMPLE_TOKENS} tok 或 ${core.MIN_SAMPLE_MS}ms 的响应会被过滤）`);
    }
  } catch (err) {
    say(`${BAD} 解析会话文件失败: ${err && err.message}`);
  }
}

// ⑥ 输出通道
say("");
say("输出通道");
say("────────");
say(`${OK} Stop hook  : node "${path.join(__dirname, "tps-hook.js")}"`);
say("   → 由插件的 hooks/hooks.json 自动挂载，无需手工配置。");
say("     · 每轮回复后显示本轮 tok/s 与近期中位数");
say("     · 手工挂载方式：见 README 的「hooks 配置方法」一节");
say("");
say(`${OK} 状态栏(可选): node "${path.join(__dirname, "tps-statusline.js")}"`);
say("   → 需手工写进 settings.json 的 statusLine；粘贴即用的片段见 README。");
say("");
say("环境变量开关");
say("────────────");
say("  TPS_WATCH_DISABLE=1             临时关闭（hook 与状态栏都受控）");
say("  TPS_WATCH_MIN_TOKENS=30         低于该 token 数的响应不报告");
say("  TPS_WATCH_QUIET=1               只在明显偏慢时才提示");
say("  TPS_WATCH_SLOW_TOKENS_PER_SEC=20  QUIET 模式的「慢」阈值");
say("  TPS_WATCH_VERBOSE=1             把诊断信息写到 stderr");

say("");
say(`缓存目录: ${os.tmpdir()}`);

process.stdout.write(lines.join("\n") + "\n");
