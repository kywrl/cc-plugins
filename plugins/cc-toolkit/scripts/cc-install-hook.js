#!/usr/bin/env node
"use strict";
/**
 * cc-install-hook — 把 Stop hook 写进 settings.json
 *
 * ── 为什么需要这个命令 ──────────────────────────────────────────────────
 * 用第三方 ANTHROPIC_BASE_URL 时，Claude Code 会关掉 GrowthBook，
 * 而 tengu_plugin_hooks_modules（「已安装插件的 hook 是否生效」）默认是 off，
 * 拿不到下发值 → 插件自带的 hooks/hooks.json 不会被注册执行。
 *
 * 补救办法是把 hook 挂进 settings.json。但 settings.json 里的 hook
 * 拿不到 ${CLAUDE_PLUGIN_ROOT}（实测为 null），而插件真实路径含版本号，
 * 会随更新变化，所以不能写死绝对路径。
 *
 * 这里写入的命令用 glob + 命令替换让 shell 在**运行时**自己找（市场名与版本号
 * 都用通配符，所以跨机器、跨版本都能定位）：
 *
 *   node "$(ls -d 家目录/.claude/plugins/cache/市场/cc-toolkit/版本/scripts/cc-hook.js | head -1)"
 *
 * 实测该形式在 Claude Code 的 hook shell（Git Bash）里可用：
 * `~` 与 `*` 会展开，`$(...)` 会执行。跨机器、跨版本都能定位。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────
 *   node cc-install-hook.js            # 交互确认后写入用户级 settings.json
 *   node cc-install-hook.js --print    # 只打印将要写入的配置，不落盘
 *   node cc-install-hook.js --yes      # 跳过确认
 *   node cc-install-hook.js --uninstall # 移除本插件写入的 hook
 *   node cc-install-hook.js --project  # 写入当前项目的 .claude/settings.json
 *
 * 已有同名 hook 时不会重复添加；其他 hook 一律原样保留。
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

/** 由插件安装路径生成一条跨版本、跨机器的 hook 命令 */
function buildCommand(pluginRoot) {
  // .../plugins/cache/<市场名>/cc-toolkit/<版本号>
  const parts = pluginRoot.split(/[\\/]/);
  const i = parts.lastIndexOf("cc-toolkit");
  if (i < 1 || i >= parts.length - 1) return null;

  const before = parts.slice(0, i - 1).join("/").replace(/\\/g, "/");

  // 家目录用 ~ 表示，其他人机器上也能用
  const home = os.homedir().replace(/\\/g, "/");
  const prefix = before.startsWith(home) ? "~" + before.slice(home.length) : before;

  // 市场名与版本号都留成通配符，插件升级换代也不会失效。
  // glob 部分不能加引号，否则 shell 不展开；外层双引号保证即使匹配到多个版本、
  // 或路径含空格，也只作为**一个**参数传给 node。
  return `node "$(ls -d ${prefix}/*/cc-toolkit/*/scripts/cc-hook.js | head -1)"`;
}

function resolvePluginRoot() {
  const { execFileSync } = require("child_process");
  try {
    const out = execFileSync(process.execPath, [path.join(__dirname, "cc-resolve.js"), "--print"], {
      encoding: "utf8",
      timeout: 10000,
    });
    return out.trim();
  } catch {
    return null;
  }
}

function settingsPath(scope) {
  if (scope === "project") return path.join(process.cwd(), ".claude", "settings.json");
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "settings.json");
}

function readSettings(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

/** 这一条 hook 是不是本插件装的 */
function isOurs(hook) {
  return hook && typeof hook.command === "string" && hook.command.includes("cc-hook.js");
}

function install(file, { dryRun }) {
  const settings = readSettings(file);

  if (!settings.hooks) settings.hooks = {};
  if (!Array.isArray(settings.hooks.Stop)) settings.hooks.Stop = [];

  const root = resolvePluginRoot();
  if (!root) {
    console.error(
      "找不到 cc-toolkit 插件目录。先装插件：/plugin install cc-toolkit@cc-plugins\n" +
        "（若装在非默认位置，设 CC_TOOLKIT_PLUGIN_ROOT 后重试）"
    );
    process.exit(1);
  }

  const command = buildCommand(root);

  // 已有本插件的 hook 就更新它的命令，不追加第二条
  let updated = false;
  for (const group of settings.hooks.Stop) {
    for (const hook of (group && group.hooks) || []) {
      if (isOurs(hook)) {
        hook.command = command;
        updated = true;
      }
    }
  }

  if (!updated) {
    settings.hooks.Stop.push({ hooks: [{ type: "command", command, timeout: 15 }] });
  }

  if (dryRun) {
    console.log(JSON.stringify(settings.hooks.Stop, null, 2));
    return { file, command, updated };
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", "utf8");
  return { file, command, updated };
}

function uninstall(file, { dryRun }) {
  const settings = readSettings(file);
  if (!settings.hooks || !Array.isArray(settings.hooks.Stop)) {
    return { removed: 0, file };
  }

  let removed = 0;
  settings.hooks.Stop = settings.hooks.Stop
    .map((group) => {
      const kept = ((group && group.hooks) || []).filter((h) => {
        if (isOurs(h)) {
          removed++;
          return false;
        }
        return true;
      });
      return { ...group, hooks: kept };
    })
    .filter((group) => groupHasHooks(group));

  if (!settings.hooks.Stop.length) delete settings.hooks.Stop;
  if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;

  if (!dryRun) {
    fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", "utf8");
  }
  return { removed, file };
}

/** 过滤掉 hook 被清空的组 */
function groupHasHooks(group) {
  return group && Array.isArray(group.hooks) && group.hooks.length > 0;
}

function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--print");
  const uninstallMode = argv.includes("--uninstall");
  const scope = argv.includes("--project") ? "project" : "user";
  const file = settingsPath(scope);

  if (dryRun) {
    if (uninstallMode) {
      const s = readSettings(file);
      const kept = ((s.hooks && s.hooks.Stop) || [])
        .flatMap((g) => g.hooks || [])
        .filter((h) => !isOurs(h));
      console.log(JSON.stringify(kept, null, 2));
      return;
    }
    install(file, { dryRun: true });
    return;
  }

  if (uninstallMode) {
    const res = uninstall(file, {});
    console.log(
      res.removed
        ? `已从 ${res.file} 移除 ${res.removed} 条 cc-toolkit Stop hook。`
        : `${res.file} 里没有本插件装的 hook，未做改动。`
    );
    return;
  }

  const res = install(file, {});
  console.log((res.updated ? "已更新" : "已写入") + ` Stop hook → ${res.file}`);
  console.log("\n写入的命令：");
  console.log("  " + res.command);
  console.log("\n重启 Claude Code 后生效。验证：让 Claude 回一句有实质内容的话（>30 tok）。");
}

main();
