# Changelog

本项目的所有重要变更都记录在这里。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.1] - 2026-09-20

### 修复

- **短回复没有读数。** 统计过滤器（`MIN_SAMPLE_TOKENS = 50`）被误用在「本轮读数」上，
  导致 50 token 以下的轮次在到达 hook 之前就被丢掉——即便用户设置的
  `CC_TOOLKIT_MIN_TOKENS` 比它低也无效。典型症状：只回一句「你好」（实测 46 tok）
  时完全静默。
  现在统计过滤只影响中位数/p90 这类**聚合**，不再决定本轮能否显示；
  本轮读数改用新的 `latestRound()`，只受 `CC_TOOLKIT_MIN_TOKENS` 约束。
  状态栏同样受益（缓存新增 `lastRound` 字段，旧缓存仍兼容）。

### 文档

- **修正上一版关于「第三方 provider 下插件 hook 不生效」的结论。** 该结论来自一个
  `claude -p` CLI 子进程的调试日志，被错误地推广到了长期运行的桌面版进程。
  实测（transcript 的 `stop_hook_summary` 记录）表明插件自带的 hook 在桌面版下正常工作。
  `tengu_plugin_hooks_modules` 是**按进程**决定的，判断实际状态应看
  `stop_hook_summary` 的 `hookInfos`，而不是照抄某次 CLI 运行的日志。
- `hooks 配置方法` 改为「默认无需配置」，手工挂载一节降级为少数情况的备选方案，
  并补上「不要两个 hook 都留，否则每轮两条读数」的警告。

## [1.0.0] - 2026-09-20

首次发布。

### 新增

- **Stop hook**：每轮回复结束后把本轮输出速度作为 `systemMessage` 展示给用户
  （只给用户看，不进模型上下文、不花 token）。usage 未落盘时会轮询几次尽量取到精确值。
- **`/cc-toolkit:tps`**：多行快照 —— 当前一轮 + 最近 N 条 + 中位/p90/最快/最慢，
  另附趋势（近 10 条 vs 更早 10 条）、离群慢样本与估算值占比。
- **`/cc-toolkit:tps-live`**：生成实时监视命令。
- **`/cc-toolkit:tps-doctor`**：环境自检（Node 版本、会话目录、会话定位、输出通道、环境变量）。
- **CLI**：`--once` / `--report` / `--json` / `--all` / `--history=N` / `--interval=MS` / `-p <项目>`。
- **状态栏集成**（可选）：`cc-statusline.js`，优先读 hook 写的缓存，输出 `⚡ 89 tok/s (中位 151)`。
- **环境变量开关**：`CC_TOOLKIT_DISABLE` / `CC_TOOLKIT_MIN_TOKENS` / `CC_TOOLKIT_QUIET` /
  `CC_TOOLKIT_SLOW_TOKENS_PER_SEC` / `CC_TOOLKIT_VERBOSE` / `CC_TOOLKIT_STATUSLINE_PREFIX` /
  `CC_TOOLKIT_STATUSLINE_CACHE_MS`。
- **29 个测试**，基于 Node 内置测试运行器，零依赖。

### 已知限制与应对

- **某些环境下插件自带的 hook 可能不生效**：Claude Code 的
  `tengu_plugin_hooks_modules` 灰度开关为 off 时，「已安装插件的 hook」不会被注册执行。
  该开关**按进程**决定，CLI 子进程与桌面版长期运行的进程可能状态不同。
  应对：用 `/cc-toolkit:install-hook` 或手工把 hook 挂进 `settings.json`
  （**挂的仍然是插件里的脚本**，不是本地脚本）。

### 设计要点

- **精确值优先**：已结束的响应一律用 `usage.output_tokens ÷ 真实耗时`；
  只有流式窗口内 usage 尚未落盘时才用字符数估算（CJK ≈ 1.5 字符/tok），并统一标 `≈` 区分。
- **耗时起点取"用户发出消息的时刻"**（上一行日志的时间戳），而不是第一个内容块落盘的时刻，
  否则首块延迟（TTFT）会被漏掉、速度看起来偏快。
- **子代理不计入**：跳过 `isSidechain` 的行，统计的是主会话自身的输出。
- **静默优先**：hook 遇到任何异常、定位不到会话、样本太小，都直接静默退出，绝不干扰会话。
- **收尾语义**：最后一轮等不到下一个 `message.id`，因此统计视图会显式收尾已结束的当前轮，
  避免永远漏掉最新一轮；收尾是无副作用的，不影响"最近一轮"的实时读数。
