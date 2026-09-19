---
description: 把 cc-toolkit 的 Stop hook 写进 settings.json（插件 hook 不生效时用）
argument-hint: "[--print 只预览 | --uninstall 移除 | --project 写进当前项目]"
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

下面是把 Stop hook 挂进 `settings.json` 的操作结果：

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/cc-install-hook.js" $ARGUMENTS`

## 什么时候需要这条命令

用第三方 `ANTHROPIC_BASE_URL` 时，Claude Code 会关闭 GrowthBook 灰度服务，
而 `tengu_plugin_hooks_modules`（控制「**已安装插件**的 hook 是否生效」的开关）
默认值为 off，拿不到下发值 → **插件自带的 `hooks/hooks.json` 不会被注册执行**。
（内置插件不受影响，所以官方 provider 用户开箱即用。）

补救办法就是把 Stop hook 手工挂进 `settings.json`。这条命令会自动完成：
定位插件安装目录 → 生成一条**跨机器、跨版本**都能用的命令 → 合并进配置
（已有同名 hook 就更新，其他 hook 一律原样保留）。

## 转述要点

把命令输出如实念给用户，并强调：

- **需要重启 Claude Code 才生效**。
- 写入的命令长这样（用 glob + 命令替换在运行时定位，所以插件升级换版本号也不会失效）：

  ```
  node "$(ls -d ~/.claude/plugins/cache/*/cc-toolkit/*/scripts/cc-hook.js | head -1)"
  ```

  也就是说，**装的是插件里的脚本，不是你本地的脚本**。

- 想撤销就用 `--uninstall`，它只删本插件装的那条，不碰其他 hook。
- 先预览不落盘用 `--print`。
