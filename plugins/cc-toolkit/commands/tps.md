---
description: 查看输出速度统计 (tok/s)：当前一轮 + 首字等待/纯解码拆分 + 最近若干条已完成响应 + 趋势与分布
argument-hint: "[要显示的最近响应条数，默认 10；可写 --all 回放整个会话文件；--insights 看分层归因]"
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

下面是本地脚本读取会话日志算出的输出速度统计：

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/cc-watch.js" --report --history=$ARGUMENTS`

如果用户想看**分层对比**（按 effort 档位 / 模型 / 技能 / MCP 服务 / 是否带 thinking 分组比较速度）以及**会话级事实**（缓存命中、API 重试、截断、iterations），再跑一次：

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/cc-watch.js" --insights --history=$ARGUMENTS`

把上面脚本的输出原样转述给用户即可，不要重新运行命令。

若输出里出现「没有进行中的响应」，照实说明即可。

## 解读规则

若输出里带「── 统计事实 ──」或「── 指标分层 ──」段落，可以基于它补一句简短解读，但必须遵守：

- 数字一律照抄，不得改动、不得自行推算新数字。
- 只解读输出里实际出现的数据；没提到的不许编。
- 一句话说清即可，不要展开长篇分析。
- 流式中以 ≈ 标注的是字符数估算值，块落盘后会被真实 usage 替换。

### 读这些指标时要注意的口径

- **整轮 tps 与纯解码 decodeTps 不是同一个量。** 整轮里混着 prefill（读 prompt）。
  实测首字等待中位 7.3s，prompt 越长这个数越大。所以「整轮变慢」很可能只是
  prompt 变长，不是模型解码变慢 —— 两个口径的趋势方向不一致时，就是这个原因。
- **decodeTps 显示 null 是正常的**，表示这一步没有可测的解码区间（单个内容块，
  或多个块被一次性写盘、时间戳只差几毫秒）。不要把它读成 0 或很快。
- **thinking 占比为 null** 表示当前 provider/CLI 版本不在 usage 里上报
  `thinking_tokens` 明细，与「模型没有思考」是两回事。
- **分组样本量（n=）各不相同**，因为分成只统计时长 ≤5 分钟的轮次，且要求每组 ≥3 条。
  跨组比较前先看 n。
