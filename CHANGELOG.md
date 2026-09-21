# Changelog

本项目的所有重要变更都记录在这里。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [2.0.0] - 2026-09-21

每个读数都应该只回答一个从它自身看得出来的问题。上一版那行 `⚡ 本轮 11 tok/s / 3.8s`
把 prefill 和 decode 混在一个数字里，又在后面追了「解码」「缓存」「中位」四段 ——
字段越多越没人看，而且真正想知道的「这次等多久、生成多快、缓存有没有生效」反而被淹了。

这一版把每轮那行收敛成三个原始读数，并删掉所有「替用户下结论」的提示。

### 破坏性变更

- **每轮输出格式重写。** 现在固定为

  ```
  首字 0.8s | 每秒输出 250 tok/s | 缓存命中 92%
  ```

  去掉了 `⚡ 本轮` 前缀、`近N条中位` 尾巴，分隔符由 ` · ` 改为 ` | `。
  解析这行的脚本需要同步改。

- **「每秒输出」改用纯解码口径。** 旧版的 `tok/s` 是整轮 token ÷ 整轮耗时（含 prefill），
  与「首字」两段重复计入同一段等待。现在这一栏是 `decodeTps`（首块 → 末块），
  扣掉了首字等待，与「首字」真正正交。**数值会明显变大**（本机整轮中位 32–71，
  纯解码中位 227–486）。想看旧口径就把 `tps` 加进 `CC_TOOLKIT_SHOW`，它会显示为「整轮」。

- **删掉桌面通知。** 移除 `CC_TOOLKIT_NOTIFY` 与 `CC_TOOLKIT_NOTIFY_MIN_MS`。
  它唯一的触发条件是「本轮偏慢」，而这个判断正在被删掉。`cc-core.js` 里已无调用方的
  `notifySequence()` 一并移除。

- **删掉 QUIET 模式。** 移除 `CC_TOOLKIT_QUIET` 与 `CC_TOOLKIT_SLOW_TOKENS_PER_SEC`，
  以及配套的跨轮状态文件（`<tmp>/cc-toolkit-state-<会话id>.json`）。
  hook 现在每轮都输出一行，不再有静默档。

### 变更

- **不再给结论。** 移除「⚠ prompt 缓存命中仅 1%（<50%），首字等待和成本都会偏高」
  与「🐢 本轮偏慢 …」。命中率、首字、每秒输出本身就在同一行上，低不低一眼看得出。
  保留的告警只剩从读数里推不出来的三种：`max_tokens` 截断、refusal、本轮期间 API 重试。

- **`CC_TOOLKIT_SHOW` 默认值** `tps,ttft,decode,cache,median` → `ttft,decode,cache`。
  新增的 `median` 默认关闭，因此不再为了拼中位数去多跑一遍样本聚合。

- **纯解码测不出来时整段省略。** 单个内容块、或首末块间隔 <300ms 的轮次不显示「每秒输出」，
  不再退回含 prefill 的整轮速度冒充 —— 此时那行只剩「首字」和「缓存命中」。

### 文档

- README 与插件 README 的示例输出、配置表、口径说明同步更新；
  口径表由「三个口径」改为按「首字 / 每秒输出 / 整轮（默认不显示）」排列。

## [2.0.1] - 2026-09-21

2.0.0 那行读数是对的，但**状态栏那一侧没跟上**：它自己独立实现了一遍字段渲染，
于是同一轮读数在 hook 和状态栏里口径不同、标记不同、开关也不响应。这一版把两侧
对齐，并修掉几个会让状态栏显示错误读数的问题。

起因是 2.0.0 之后的一次文档整理：那次提交想说明「状态栏字段与 hook 含义一致」，
逐条核对代码时发现这句话本身就不成立 —— 实际问题比措辞多得多。

### 修复

- **状态栏会显示上一轮的速度。** `cc-statusline.js` 调 `latestRound()` / `snapshot()`
  时没传 `force`，本轮最后一个内容块落盘不到 3 秒的话会退回上一轮：实测上一轮
  400 tok/s、本轮 167 tok/s 时状态栏显示 400，而且这份过期读数会被写进缓存钉住
  整个 TTL。hook 一直传了 `force:true`，只有状态栏漏了。

- **空白快照会把状态栏锁死一整个 TTL。** 缓存写在 `!last` 退出判断之前，
  取不到轮次时仍会落盘一份 `lastRound: null` 的快照，而 `readCache` 只校验版本号和
  样本数组，空数组照收。实测状态栏因此空白最长 45 秒（`CC_TOOLKIT_STATUSLINE_CACHE_MS`），
  期间那份 transcript 一直是可报的。现在没有 `lastRound` 就拒写，读的时候也要求它存在。

- **缓存可能串到另一个会话。** 缓存只按 `sessionId` 命名，而 hook 与状态栏各自独立
  推导这个 id；会话目录里确实存在「文件名 ≠ 内部 sessionId」的 transcript。
  快照里本来就写了 `file`，现在读取时比一下，不符就当作未命中并重算。

- **估算值的 `≈` 在状态栏的解码段上丢了。** hook 渲染 `每秒输出 ≈201 tok/s`，
  状态栏渲染 `解码 201` —— 标记只加在了 `tps` 那一段。估算值因此被当成精确值展示，
  也与 README「所有输出都用 `≈` 明确区分」矛盾。

- **`CC_TOOLKIT_ALERTS=0` 管不住状态栏的截断提示。** hook 响应这个开关，
  状态栏的 `⚠截断` 无条件追加。现在两边一致。

- **`CC_TOOLKIT_MIN_TOKENS=0` 与 `CC_TOOLKIT_STATUSLINE_CACHE_MS=0` 被静默换成默认值。**
  `parseInt(...) || 默认值` 对 `0` 和非法值一视同仁，于是「不设下限」「不用缓存」
  这两个唯一有意义的 0 恰好失效。改用显式判断，缺失或非法才回默认。

- **慢轮被渲染成 `0 tok/s`。** `toFixed(0)` 会把 0.3 tok/s 抹成 0，
  报出一个从没测到、外观又像计数器坏了的读数。低于 1 时保留一位小数。

- **选中的字段都取不到时只剩一个 `⚡ `。** 单块回复没有可测的解码区间、没有 usage
  就没有缓存读数，此时输出的光秃前缀既无信息，也与「字段名拼错」无从区分。
  现在整段不输出（hook 早有同样的判断）。

- **状态栏缓存瘦身：不再落全量样本。** 一次刷新要读的快照里有 500 条样本
  （约 270KB）与 `session` 段，而状态栏只用 `lastRound` 和 `rollup` ——
  每次刷新多解析 40 倍的数据。缓存格式升到 v3，只落真正会被读的字段，旧缓存自动失效。

### 变更

- **状态栏的 `median` 段现在写明是整轮口径。** 它取的是近 9 条样本的 `tps` 中位，
  与 `decode` 不是同一个量，原先的说明（「近期中位数」）看不出来。

- **`CC_TOOLKIT_STATUSLINE_FIELDS` 只认五个字段名，README 现在明说了。**
  原先写「字段含义同 `CC_TOOLKIT_SHOW`」，而 hook 另有 `tokens` / `thinking` /
  `model` / `effort` / `skill` —— 照搬过去不报错，只是那一段不出现。

- **README 里 `CC_TOOLKIT_STATUSLINE_FIELDS` 的「只想要一个数字」示例由 `tps` 改成 `decode`。**
  `tps` 是含 prefill 的整轮口径，正是这一版反复提醒不要拿它判断「模型快不快」的那个数。

### 文档

- **`plugin.json` / `marketplace.json` / 插件 README 的描述**仍写着 2.0.0 删掉的
  「本轮速度」，与同一文件里的示例输出自相矛盾，已同步。
- **状态栏那段的说明重写**：字段表逐项标注渲染结果、点明只有 `tps` 不带标签、
  补上 `⚠截断` 与 `(缓存中位 N%)` 两段附加后缀，并说明「读到空输出是正常的」。
- **`TPS=$(node cc-statusline.js </dev/null)` 这个自测配方是错的**（空 stdin 取不到会话，
  必定输出空），改为转发 stdin 的正确写法，并另给一条可验证的调试命令。
- **新增词表一致性测试**：把「已废弃的说法」列成清单扫全部文案（含 `.claude-plugin/`），
  并断言 README 的状态栏字段表与 `cc-statusline.js` 的实现完全一致。
  上一版这类漂移要靠人记住去逐处改，实测漏了两处；现在漏了会红。

## [1.1.1] - 2026-09-21

上一次改名（`tps-*` → `cc-*`）把脚本文件改了名，却漏掉了字符串里的路径。
代码里的 `require` 会立刻报错，但斜杠命令里的路径只在该命令被调用时才炸，
于是坏引用一路活到了发布。这一版修掉并加上防回归检查。

### 修复

- **`/cc-toolkit:tps-doctor` 一跑就报 `MODULE_NOT_FOUND`。** 命令调的是改名前的
  `scripts/tps-doctor.js`，实际文件早已是 `cc-doctor.js`。现在改为正确路径。
- README 里「`claude plugin details` 正常应显示 `Skills (3)`」与实际组件数
  （4 个：`install-hook` / `tps` / `tps-doctor` / `tps-live`）不符，已更正为 `Skills (4)`。
- `cc-core.js` 头部注释把 CLI 入口写成 `scripts/cc-toolkit.js`，实际是 `cc-watch.js`。

### 新增测试

- **引用完整性检查**：扫描插件内所有 `.md` / `.json` / `.js` / `.sh` 里出现的
  `scripts/...` 路径，逐个确认文件存在；另校验命令与 hooks 只调用 `scripts/`
  下真实的入口，且脚本命名遵循 `cc-` 前缀。这类坏引用不再需要靠手工跑一次命令才发现。

## [1.1.0] - 2026-09-20

这一版把「一个 tok/s」拆成能分别回答不同问题的几个数字，并开始把会话日志里的旁路信息
（缓存、重试、截断、归因）用起来。

### 新增

- **首字等待与纯解码速度分开报。** 一轮的耗时里混着 prefill（读 prompt）和 decode（写回答）——
  合成一个数字时，prompt 越长读数越低，很容易被误读成「模型变慢」。
  现在每轮同时给出 `首字 X.Xs`（用户发消息 → 首个内容块落盘）与 `解码 N tok/s`
  （首块 → 末块，唯一不含 prefill 的口径）。本机实测：整轮中位 32–71 tok/s，
  但首字中位 7.3s、纯解码中位 227–486 tok/s——差的正是那几秒等待。
- **缓存命中率。** `cache_read ÷ (cache_read + cache_creation + input)`，本机中位 89.7%。
  可放进状态栏，低于 50% 时单独告警（prompt 缓存没生效，首字等待和成本都会涨）。
- **thinking token 占比与 iterations 明细。** thinking 是 output 的子集，不是额外的量；
  一次 API 调用内部的 reasoning 循环次数从 `usage.iterations` 读出（仅官方 API 上报）。
- **分层归因（`--insights`）**：按 effort 档位 / 模型 / 技能 / MCP 服务 / 插件 /
  是否带 thinking / 是否调用工具 / 首块类型分组对比速度与首字等待。
  自动排掉超过 5 分钟的轮次（用户可能离开过），且每组样本量 <3 不显示。
- **会话级事实**：从 `system/turn_duration`、`system/api_error`、`system/stop_hook_summary`
  读出 CLI 自报耗时、API 重试与错误码、hook 自身的执行情况。
- **告警**：`max_tokens` 截断、`refusal`、缓存命中过低、本轮期间发生 API 重试，
  都会在读数下面加一行说明——这些情况下的「慢」各有成因，不该只报一个数字。
- **可选的桌面通知**（`CC_TOOLKIT_NOTIFY=1`）：偏慢时通过 hook 的 `terminalSequence`
  发一条 OSC 777 通知，带冷却时间。
- 新环境变量 `CC_TOOLKIT_SHOW`（裁剪每轮那行的字段）、`CC_TOOLKIT_ALERTS`、
  `CC_TOOLKIT_NOTIFY`、`CC_TOOLKIT_STATUSLINE_FIELDS`；QUIET 模式的慢速提示增加 5 分钟冷却。
- `cc-doctor` 增加指标可用性检查：能否算出纯解码、缓存是否可测、
  以及 provider 是否上报 `thinking_tokens`。

### 修复

- **纯解码速度在块被一次性写盘时会算出荒谬值。** Claude Code 常把一轮的多个内容块
  一次性写入，时间戳只差 1–3ms。实测 11791 个可拆分轮次里有 3438 个（29%）跨度 <300ms，
  按 `token ÷ 跨度` 会得出上百万 tok/s。现在跨度 <300ms 一律不报解码速度（返回 `null`），
  而不是给一个会被当真的数字。
- **第三方 provider 下的分子分母错配。** 这类 provider 只在末尾若干块写 usage，
  且写的是**累计总数**（如 `0,0,1573,1573`）。旧代码用「最大值 ÷ 到带 usage 那块的耗时」，
  分子是最终总数、分母却是中途时间，读数偏高。现在统一算到最后一块，
  且轮次起点改用上一条 `user` 行（而非上一条任意记录），避免 tool_result / attachment 把起点推后。
- `thinkingShare` 在 provider 不上报该字段时返回 `null` 而非 `0`——
  「没上报」和「占比为零」是两回事，`0` 会被读成「模型没有思考」。

### 变更

- **状态栏缓存版本 v1 → v2**（字段语义已变，旧的 tps 是含 prefill 的口径）。
  读取时会拒绝 v1 缓存并从 transcript 重算，不会显示错误数字。
- `--once` / 实时模式不再重复展示「上一条」样本（与中位数信息冗余）。
- 状态栏默认输出改为 `⚡ 89 tok/s · 首字 3.2s · 缓存 92%`，原有 `(中位 N)` 需显式
  用 `CC_TOOLKIT_STATUSLINE_FIELDS` 打开。

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
