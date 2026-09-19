# Changelog

本项目的所有重要变更都记录在这里。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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

### 设计要点

- **精确值优先**：已结束的响应一律用 `usage.output_tokens ÷ 真实耗时`；
  只有流式窗口内 usage 尚未落盘时才用字符数估算（CJK ≈ 1.5 字符/tok），并统一标 `≈` 区分。
- **耗时起点取"用户发出消息的时刻"**（上一行日志的时间戳），而不是第一个内容块落盘的时刻，
  否则首块延迟（TTFT）会被漏掉、速度看起来偏快。
- **子代理不计入**：跳过 `isSidechain` 的行，统计的是主会话自身的输出。
- **静默优先**：hook 遇到任何异常、定位不到会话、样本太小，都直接静默退出，绝不干扰会话。
- **收尾语义**：最后一轮等不到下一个 `message.id`，因此统计视图会显式收尾已结束的当前轮，
  避免永远漏掉最新一轮；收尾是无副作用的，不影响"最近一轮"的实时读数。
