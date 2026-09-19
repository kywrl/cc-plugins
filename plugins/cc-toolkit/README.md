# cc-toolkit

实时监控 Claude Code 的**输出速度 (tok/s)**。

- 每轮回复结束后显示本轮速度与近期中位数（Stop hook，自动生效）
- `/cc-toolkit:tps` 查看历史分布、趋势与离群样本
- 可选把读数放进状态栏
- 零 npm 依赖、纯本地计算、不联网

```
⚡ 本轮 89 tok/s  (349 tok / 3.9s)  ·  近8条中位 151 tok/s
```

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
| 安静模式（只在偏慢时提示） | `settings.json` → `env.CC_TOOLKIT_QUIET = "1"` |
| 调整显示下限 | `settings.json` → `env.CC_TOOLKIT_MIN_TOKENS = "50"` |
| 临时关掉 | `settings.json` → `env.CC_TOOLKIT_DISABLE = "1"` |

**完整的安装方法、hooks 配置方法（含手工挂进 `settings.json` 的写法）、精度说明与故障排查，见
[仓库根 README](../../README.md)。**

## 数据来源

`~/.claude/projects/<项目目录名>/<session-id>.jsonl` —— Claude Code 自己写的会话日志。
会话日志是**内容块级**落盘，不是逐 token 流式写入，所以正在流式的数值会根据块内容估算并标 `≈`，
块落盘后自动换成精确的 `usage.output_tokens`。

## License

[MIT](LICENSE)
