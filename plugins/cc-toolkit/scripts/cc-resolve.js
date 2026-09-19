#!/usr/bin/env node
"use strict";
/**
 * cc-resolve — 定位已安装插件的脚本目录，然后转发执行
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────
 * 用第三方 ANTHROPIC_BASE_URL 时，Claude Code 会关掉 GrowthBook 灰度服务，
 * 而 tengu_plugin_hooks_modules 这个「已安装插件的 hook 是否生效」开关默认
 * 就是 off，拿不到下发值 → 插件自带的 hooks/hooks.json 不会被注册执行。
 * （内置插件不受影响，所以官方 provider 用户开箱即用。）
 *
 * 变通办法是把 hook 写进 settings.json。但 settings.json 里的 hook
 * 拿不到 ${CLAUDE_PLUGIN_ROOT}（实测为 null），而插件真实路径是
 *
 *     ~/.claude/plugins/cache/<市场名>/<插件名>/<版本号>/
 *
 * 版本号那段会随插件更新变化，硬编码绝对路径升级后就失效。
 * 所以这个脚本在运行时把路径解析出来，再转发到真正的实现。
 *
 * ── 定位策略（逐级回退，任一成功即返回）────────────────────────────────
 *   1. CC_TOOLKIT_PLUGIN_ROOT       显式指定，最高优先级
 *   2. ${CLAUDE_PLUGIN_ROOT}        在插件 hook 场景下由 Claude Code 注入
 *   3. installed_plugins.json       读取 installPath 字段（权威，跟随版本）
 *   4. 目录扫描                     遍历 plugins/cache 下的各市场与版本目录
 *
 * 解析失败时打印可操作的指引并以非 0 退出，绝不静默失败。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────
 *   node cc-resolve.js cc-hook.js          # 转发到 cc-hook.js
 *   node cc-resolve.js --print             # 只打印解析出的插件根目录
 *   node cc-resolve.js --which cc-hook.js  # 打印转发目标的完整路径
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const PLUGIN_NAME = "cc-toolkit";

/** Claude Code 配置目录：尊重 CLAUDE_CONFIG_DIR，否则退回 ~/.claude */
function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

/** 某个路径是不是本插件的根目录（含 plugin.json，且脚本齐全） */
function looksLikePluginRoot(dir) {
  if (!dir) return false;
  try {
    if (!fs.existsSync(path.join(dir, ".claude-plugin", "plugin.json"))) return false;
    return fs.existsSync(path.join(dir, "scripts", "cc-core.js"));
  } catch {
    return false;
  }
}

/** 策略 3：从 installed_plugins.json 读 installPath */
function fromInstalledPlugins() {
  const file = path.join(claudeConfigDir(), "plugins", "installed_plugins.json");
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }

  const plugins = data && data.plugins;
  if (!plugins || typeof plugins !== "object") return null;

  // 精确匹配 cc-toolkit@<任意市场>；同为 cc-toolkit 时优先市场名排序靠前的
  const hits = Object.entries(plugins)
    .filter(([key]) => key === PLUGIN_NAME || key.startsWith(`${PLUGIN_NAME}@`))
    .map(([key, val]) => {
      const entry = Array.isArray(val) ? val[0] : val;
      return { key, dir: entry && entry.installPath };
    })
    .filter((h) => looksLikePluginRoot(h.dir));

  if (!hits.length) return null;
  hits.sort((a, b) => a.key.localeCompare(b.key));
  return hits[0].dir;
}

/** 策略 4：扫 plugins/cache/<市场>/<插件>/<版本>/ */
function fromCacheScan() {
  const cacheDir = path.join(claudeConfigDir(), "plugins", "cache");
  let markets;
  try {
    markets = fs.readdirSync(cacheDir);
  } catch {
    return null;
  }

  for (const market of markets) {
    const pluginDir = path.join(cacheDir, market, PLUGIN_NAME);
    let versions;
    try {
      versions = fs.readdirSync(pluginDir);
    } catch {
      continue;
    }
    // 版本目录名排序，取最新的（语义化版本按字典序在多数情况下也成立）
    for (const version of versions.sort().reverse()) {
      const dir = path.join(pluginDir, version);
      if (looksLikePluginRoot(dir)) return dir;
    }
    // 也支持无版本号的扁平布局
    if (looksLikePluginRoot(pluginDir)) return pluginDir;
  }
  return null;
}

/**
 * 解析插件根目录。
 * @returns {string|null}
 */
function resolvePluginRoot() {
  const attempts = [];

  // 1. 显式指定
  if (process.env.CC_TOOLKIT_PLUGIN_ROOT) {
    const dir = process.env.CC_TOOLKIT_PLUGIN_ROOT;
    attempts.push(`CC_TOOLKIT_PLUGIN_ROOT=${dir}`);
    if (looksLikePluginRoot(dir)) return dir;
  }

  // 2. Claude Code 注入（插件 hook 场景）
  if (process.env.CLAUDE_PLUGIN_ROOT) {
    const dir = process.env.CLAUDE_PLUGIN_ROOT;
    attempts.push(`CLAUDE_PLUGIN_ROOT=${dir}`);
    if (looksLikePluginRoot(dir)) return dir;
  }

  // 3. installed_plugins.json
  const fromRegistry = fromInstalledPlugins();
  attempts.push(`installed_plugins.json → ${fromRegistry || "未命中"}`);
  if (fromRegistry) return fromRegistry;

  // 4. 目录扫描
  const fromScan = fromCacheScan();
  attempts.push(`目录扫描 → ${fromScan || "未命中"}`);
  if (fromScan) return fromScan;

  if (process.env.CC_TOOLKIT_VERBOSE === "1") {
    console.error("[cc-resolve] 定位失败，尝试过：");
    for (const a of attempts) console.error("  ·", a);
  }
  return null;
}

function fail() {
  console.error(
    [
      "cc-resolve: 找不到 cc-toolkit 插件的安装目录。",
      "",
      "可能原因与对策：",
      "  1. 插件没装 → 运行 /plugin install cc-toolkit@cc-plugins",
      "  2. 装在非默认位置 → 设环境变量 CC_TOOLKIT_PLUGIN_ROOT 指向插件目录",
      "     （插件目录 = 含 .claude-plugin/plugin.json 的那一层）",
      "  3. Claude Code 配置目录非默认 → 设 CLAUDE_CONFIG_DIR",
      "",
      `已查找: ${path.join(claudeConfigDir(), "plugins")}`,
      "排查: node cc-resolve.js --print",
    ].join("\n")
  );
  process.exit(1);
}

function main() {
  const argv = process.argv.slice(2);
  const root = resolvePluginRoot();

  if (argv.includes("--print")) {
    if (!root) fail();
    process.stdout.write(root + "\n");
    return;
  }

  if (!root) fail();

  const whichIdx = argv.indexOf("--which");
  if (whichIdx >= 0) {
    const target = argv[whichIdx + 1];
    if (!target) {
      console.error("cc-resolve: --which 需要一个脚本名，例如 --which cc-hook.js");
      process.exit(2);
    }
    process.stdout.write(path.join(root, "scripts", target) + "\n");
    return;
  }

  // 转发模式：argv[0] 是目标脚本名，其余参数原样传下去
  const target = argv[0];
  if (!target) {
    console.error("cc-resolve: 缺少目标脚本名。用法: node cc-resolve.js cc-hook.js [参数...]");
    process.exit(2);
  }

  const script = path.join(root, "scripts", target);
  if (!fs.existsSync(script)) {
    console.error(`cc-resolve: 目标脚本不存在: ${script}`);
    process.exit(1);
  }

  // 用子进程转发，保持 stdin/stdout/stderr 直连 —— Stop hook 靠 stdin 收事件、
  // stdout 吐 JSON，任何缓冲或改写都会破坏协议。
  const { spawnSync } = require("child_process");
  const res = spawnSync(process.execPath, [script, ...argv.slice(1)], {
    stdio: "inherit",
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: root },
  });

  if (res.error) {
    console.error("cc-resolve: 执行失败:", res.error.message);
    process.exit(1);
  }
  process.exit(res.status == null ? 1 : res.status);
}

main();
