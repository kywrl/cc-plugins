# cc-toolkit

实时监控 Claude Code 的**输出速度 (tok/s)**，并把**首字等待**和**纯解码速度**分开报。

- 每轮回复结束后显示本轮速度（Stop hook，自动生效）
- `/cc-toolkit:tps` 查看历史分布、趋势与离群样本
- `/cc-toolkit:tps --insights` 按 effort / 模型 / 技能 / MCP 分组对比，并看缓存命中与重试
- 可选把读数放进状态栏
- 零 npm 依赖、纯本地计算、不联网

```
⚡ 本轮 89 tok/s / 3.9s · 首字 3.2s · 解码 142 · 缓存 92%  ·  近8条中位 151 tok/s
```

**为什么不是一个数字**：一轮耗时里混着 prefill（读 prompt）和 decode（写回答）。
合成一个 tok/s 时，prompt 越长读数越低，会被误读成"模型变慢"。本机实测
整轮中位 32–71 tok/s，但纯解码中位 227–486 tok/s —— 差的正是首字等待那几秒。

## 快速开始

安装后让 Claude 回一句有实质内容的话即可，**不需要任何额外配置**。
环境有问题就跑：

```
/cc-toolkit:tps-doctor
```

## 配置

| 想要的效果 | 怎么做 |
| --- | --- |
| 开箱即用的每轮读数 | 安装后自动生效，无需配置 |
| 打开状态栏读数 | 见仓库根 README 的「状态栏集成」 |
| 每轮只看速度，不看其他字段 | `settings.json` → `env.CC_TOOLKIT_SHOW = "tps"` |
| 安静模式（只在偏慢时提示） | `settings.json` → `env.CC_TOOLKIT_QUIET = "1"` |
| 偏慢时发桌面通知 | `settings.json` → `env.CC_TOOLKIT_NOTIFY = "1"` |
| 关掉截断/缓存/重试提示 | `settings.json` → `env.CC_TOOLKIT_ALERTS = "0"` |
| 调整显示下限 | `settings.json` → `env.CC_TOOLKIT_MIN_TOKENS = "50"` |
| 临时关掉 | `settings.json` → `env.CC_TOOLKIT_DISABLE = "1"` |

**完整的安装方法、hooks 配置方法（含手工挂进 `settings.json` 的写法）、精度说明与故障排查，见
[仓库根 README](../../README.md)。**

## 数据来源

`~/.claude/projects/<项目目录名>/<session-id>.jsonl` —— Claude Code 自己写的会话日志。
除了每轮的 `usage`（token 数、缓存读写、thinking 明细），还会解析 `system` 行里的
整轮耗时（`turn_duration`）、API 错误与重试（`api_error`）以及 hook 自身的执行情况
（`stop_hook_summary`）。

会话日志是**内容块级**落盘，不是逐 token 流式写入，所以：

- 正在流式的数值按块内容估算并标 `≈`，块落盘后自动换成精确的 `usage.output_tokens`；
- 纯解码速度只在首末内容块间隔 ≥300ms 时才算（实测 29% 的轮次多个块被一次性写盘，
  时间戳只差几毫秒，没有可测区间）—— 此时留空，不报假数字。

## License

[MIT](LICENSE)
