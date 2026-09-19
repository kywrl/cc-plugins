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

安装后让 Claude 回一句有实质内容的话即可。

**但如果你的 `ANTHROPIC_BASE_URL` 指向第三方网关/代理**，插件自带的 hook 不会生效
（原因见下），需要补一条命令把它挂进 `settings.json`：

```
/cc-toolkit:install-hook
```

环境有问题就跑：

```
/cc-toolkit:tps-doctor
```

## ⚠️ 第三方 provider 需要额外一步

Claude Code 用 `tengu_plugin_hooks_modules` 这个灰度开关控制「**已安装插件**的 hook
是否生效」，默认值是 **off**。用第三方 `ANTHROPIC_BASE_URL` 时 GrowthBook 被关闭，
拿不到下发值，开关就一直是 off → 插件自带的 `hooks/hooks.json` 不被执行。
（内置插件有豁免，所以官方 provider 用户开箱即用。）

应对就是上面那条 `/cc-toolkit:install-hook`——它把 hook 挂进 `settings.json`，
生成的命令用通配符在运行时定位插件脚本，所以**插件升级换版本号也不会失效**：

```
node "$(ls -d ~/.claude/plugins/cache/*/cc-toolkit/*/scripts/cc-hook.js | head -1)"
```

注意这里**挂的是插件里的脚本，不是本地脚本**。

## 配置

| 想要的效果 | 怎么做 |
| --- | --- |
| 开箱即用的每轮读数 | 安装后自动生效，无需配置 |
| 打开状态栏读数 | 见仓库根 README 的「状态栏集成」 |
| 安静模式（只在偏慢时提示） | `settings.json` → `env.CC_TOOLKIT_QUIET = "1"` |
| 临时关掉 | `settings.json` → `env.CC_TOOLKIT_DISABLE = "1"` |

**完整的安装方法、hooks 配置方法（含手工挂进 `settings.json` 的写法）、精度说明与故障排查，见
[仓库根 README](../../README.md)。**

## 数据来源

`~/.claude/projects/<项目目录名>/<session-id>.jsonl` —— Claude Code 自己写的会话日志。
会话日志是**内容块级**落盘，不是逐 token 流式写入，所以正在流式的数值会根据块内容估算并标 `≈`，
块落盘后自动换成精确的 `usage.output_tokens`。

## License

[MIT](LICENSE)
