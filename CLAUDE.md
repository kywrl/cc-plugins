# cc-plugins

本仓库是 Claude Code 插件市场（market name `cc-plugins`，owner `kywrl`，发布在 `github.com:kywrl/cc-plugins`）。
目前只含一个插件 `cc-toolkit`（v2.4.0）。

## 仓库形态

```
.claude-plugin/marketplace.json      # 市场清单，plugins[] 指向 plugins/cc-toolkit
plugins/cc-toolkit/
  .claude-plugin/plugin.json         # 插件清单（版本号唯一来源）
  hooks/hooks.json                   # Stop hook，装好即生效
  commands/tps*.md                   # 三个斜杠命令
  scripts/cc-{core,watch,hook,doctor}.js
  tests/cc-toolkit.test.js
README.md                            # 面向用户的完整手册（549 行）
CHANGELOG.md                         # Keep a Changelog 格式，中文
```

两级结构决定了改动怎么生效：
`~/.claude/plugins/marketplaces/<市场>/` 是 marketplace.json 的独立 git 克隆，
`~/.claude/plugins/cache/<市场>/<插件>/<版本号>/` 才是真正被 Claude Code 加载的副本。
只 `git push` 或只跑 `marketplace update` 都不会让本地生效。

## 日常命令

跑测试（零依赖、无 `npm install`、无 `package.json`）：

```bash
node --test "plugins/cc-toolkit/tests/*.test.js"
```

单个测试用名字过滤：

```bash
node --test --test-name-pattern="词表一致性" "plugins/cc-toolkit/tests/*.test.js"
```

本地改完即时生效（不装插件、不进市场，重启会话即可）：

```bash
claude --plugin-dir ./plugins/cc-toolkit
```

校验清单文件与组件发现：

```bash
claude plugin validate ./plugins/cc-toolkit
```

```bash
claude plugin details cc-toolkit
```

手动喂一个假 Stop 事件调试 hook（`CC_TOOLKIT_VERBOSE=1` 把「为什么静默退出」打到 stderr）：

```bash
echo '{"session_id":"t","transcript_path":"/path/to/session.jsonl","hook_event_name":"Stop"}' | CC_TOOLKIT_VERBOSE=1 node plugins/cc-toolkit/scripts/cc-hook.js
```

命令行等价入口（不装插件也能跑）：

```bash
node plugins/cc-toolkit/scripts/cc-watch.js --report --history=20
```

## 发版流程（用户已固定的习惯）

改完代码后一次走完：升 `plugin.json` 版本号 → 写 CHANGELOG（Keep a Changelog，中文）→ commit → push `origin/main` → 本地刷新安装。

本地刷新是**两条命令，缺一不可**（第一级克隆与第二级缓存目录都要更新）：

```bash
claude plugin marketplace update cc-plugins
```

```bash
claude plugin update cc-toolkit@cc-plugins
```

`hooks/hooks.json` 里写的是 `node "${CLAUDE_PLUGIN_ROOT}/scripts/cc-hook.js"`，`${CLAUDE_PLUGIN_ROOT}`
由 Claude Code 在运行时替换成**当前版本**目录，所以版本号变化不影响 hook 挂载 —— 不必也不该
再教用户手工往 `settings.json` 的 `hooks.Stop` 里写路径（v2.0.5 删掉 install-hook 正是因为那条
`ls ... | head -1` 的 glob 命令会按字典序选中最旧版本，把用户静默锁在旧版本上）。

## 架构

四个脚本，`cc-core.js` 是唯一有实质逻辑的地方，其余都是薄入口：

- `scripts/cc-core.js` —— 纯函数库 + `SessionTracker` 类。会话文件发现、JSONL 增量解析、
  轮次归档、tok/s 统计、分层归因、三套渲染器（`renderLive` / `renderReport` / `renderInsights`）。
  无副作用，可直接 `require` 进别的脚本。
- `scripts/cc-watch.js` —— CLI：实时 / `--report` / `--insights` / `--once` / `--json`。
- `scripts/cc-hook.js` —— Stop hook：stdin 读事件 → stdout 吐 `{"systemMessage": ...}`。
  只把读数展示给用户，**不进模型上下文**（不花 token）——所以用 `systemMessage` 而不是
  `decision:"block"` 或 `additionalContext`。任何异常都 `exit 0` 静默，绝不干扰会话。
- `scripts/cc-doctor.js` —— 环境自检。

### 数据源与不可绕过的限制

数据源是 Claude Code 自己写的会话日志 `~/.claude/projects/<项目目录名>/<session-id>.jsonl`，
项目目录名 = 工作目录的非字母数字全换成 `-`（`projectDirFor`）。默认只回放文件末尾 2MB
（`REPLAY_TAIL_BYTES`），`--all` 才全量。

会话文件是**内容块级**落盘，不是逐 token 流式写入。这条限制推导出本插件大部分设计：

- 响应结束、`usage.output_tokens` 落盘 → 精确值；正在流式 → 按字符数估算，输出必须带 `≈`。
- `usage` 是**累计快照**且只落在少数 `message.id` 上（第三方 provider 尤其如此）——一律取 `max`，
  不能把「最后见到的值」当增量。
- Claude Code 常把一轮的多个块一次性写盘，时间戳只差 1–3ms（实测占 29%）。这类轮次
  **没有可测的解码区间**，`decodeTps` 必须返回 `null` 而不是算出一个上百万 tok/s 的假数字。

### 三个读数与两个层级：轮 vs 步

**术语是固定的，改文案时别混**：

- **一轮** = 一条用户消息 → 这次回复结束。
- **一步** = 轮内的一次模型生成（一次 API 调用）**及其触发的工具执行**。
  轮内步数 = 轮内的 API 调用次数（= 轮内 `message.id` 个数，实测单轮最多 172 个）。

三个互不重叠的读数，对应三个不同问题（`cc-hook.js` 的 `composeMessage`）：

| 字段 | 含义 | 口径 |
| --- | --- | --- |
| `calls` 本轮步数 | 轮内 `message.id` 个数（模型生成几次） | 无估算/精确之分，不带 `≈` |
| `decodeTps` 每秒输出 | 各**步**内部（首块→末块）跨度**之和**，分子分母同源 | 纯解码 |
| `cache.hitRatio` 缓存命中 | `cache_read / (cache_read + cache_creation + input)` | — |

**默认三格是 `steps,decode,cache`**（`cc-hook.js` 的 `CC_TOOLKIT_SHOW` 默认值）。
`ttft` 仍可显式要，但 2.4.0 起不再是默认读数 —— 见下面「已退役」。

**已退役：`ttftMs` / 「首字」**（2.4.0）。原实现测「你按下回车 → 本轮首个内容块落盘」，
那是**等待 + 首块生成时间**的合计，而首块大小在一轮之间差几十倍（实测 ≥1000 字符时
中位 26–29s，<50 字符时 9–13s），跨轮次比较会把「首块更大」误读成「等得更久」。
更根本的是模型吐出**第一个 token** 的时刻在块级落盘的日志里不可观测。
字段与 `ttftMeaningful` / `medianTtftMs` / `MAX_PLAUSIBLE_TTFT_MS` 都已删除；
词表守卫把 `首字` 列为废弃说法，改文案时别写回去。

`decodeTps` 与整轮 `tps` 是**两个量**：整轮口径含 prefill 与步之间的工具执行时间。
若用整轮首块→末块当 decode 分母，工具等待会被当成解码时间，实测中位从 128 掉到 10 tok/s。

每轮读数与统计视图**切在不同层**，这是有意设计：

- **每轮读数（hook）** 切在**轮**上，走 `latestRound()` → `_describeTurn()`。
  一轮里可能有几十上百步，`_describeTurn` 把它们聚拢起来算（旧实现只读最后一个
  `message.id`，实测低估 tokens 最多 365 倍）。
- **统计样本（`/cc-toolkit:tps`、`cc-watch.js`）** 切在**步**上，走 `_describe(g)`。
  这个粒度能自然剔掉工具执行时间，让历史样本之间可比。

**记账只有一份，读数只有一条路径**（2.3.0 收敛，改这块前务必先读）：

- `groups`（Map，按 id 找**当前步**）与 `currentSteps`（数组，按顺序回看**本轮所有步**）
  是**同一批记录对象**的两个视图 —— `step()` 建记录时同时塞进两者。
  曾经它们各是一套累积器，同一份 usage / 元数据写两遍，必然对不齐。
- 步记录是唯一形态：`_describe` 与 `_describeTurn` 都读同一个记录结构
  （`hasUsage` / `out` / `est` / `ts` / `cacheRead`…）。
- `mergeUsage(step, usage)` 是唯一的 usage 写入点，`applyMeta(target, record)`
  是唯一的元数据写入点（字段清单只此一处）。
- 缓存**按步求和**（`_describeTurn`），不是取某一步：求和才等于「这一轮实际送进模型的
  全部 prompt token」，也才不会因为「带 usage 的那一步恰好没缓存字段」而整轮读不出。

### 容易踩的取舍（改代码前先读这里）

- **统计过滤器 ≠ 本轮读数过滤器。** `MIN_SAMPLE_TOKENS`(50) / `MIN_SAMPLE_MS`(300) 只服务于
  中位数、p90 这类聚合。hook 要走 `latestRound()`（不套过滤），否则用户的
  `CC_TOOLKIT_MIN_TOKENS` 形同虚设 —— v1.0.1 修的就是这个 bug。
- **三格位置固定**：某一项算不出来就渲染 `—`，不让整段消失。`hasAnyRealReading()` 只在
  三格全空时才静默。
- **`truncatedAnchor`**：回放窗口从文件中途开始时，本轮的用户行可能被切掉，`durMs`/`tps`
  的分母少了一整段起点（实测 57 → 133 tok/s 的系统性虚高）。这类轮次**不进聚合**。
- **轮次锚点只认真人输入**：`tool_result` 回流与 `isMeta` 技能注入都不算新一轮（见
  `isHumanInput`），拿它们当锚点会把一轮越切越碎。
- **`null` 与 `0` 语义不同**：`decodeTps: null` 是「测不出来」，`thinkingShare: null` 是
  「provider 没上报这个字段」，都不是 0，渲染时不能混。
- 时间窗口常量集中在 `cc-core.js` 顶部（`STREAMING_WINDOW_MS`、`MAX_ATTRIBUTION_MS`、
  `MIN_DECODE_MS`、`LOW_CACHE_HIT_RATIO`、`MAX_STEPS_PER_TURN`）。
- **步数是轮级量**：`_describe`（步级）里没有 `calls`，渲染时要从 `tracker.currentTurn()`
  取。`renderLive` / `renderReport` 的 `currentSpeed()` 给的是步级读数 —— 别在那儿读 `calls`。

## 测试

`plugins/cc-toolkit/tests/cc-toolkit.test.js`，Node 内置测试运行器，65 个测试，零依赖。
夹具用 `writeTranscript`（每轮 = user 行 + N 个内容块）/ `writeMultiCallTurn`（一轮里多次
API 调用，中间可夹工具间隙）造假 transcript，用 `execFileSync` 起真实子进程跑 hook / CLI，
所以断言的是端到端输出。

**改文案时要留意的两类守卫测试**（它们才是这个仓库真正的回归网）：

- `词表一致性: 文档与描述里不再出现已废弃的说法` —— `retired[]` 是一份「已废弃说法」清单，
  扫描插件目录 + 仓库根 README/CHANGELOG/marketplace.json。发布新版本、改了输出格式或
  删了组件后，**要把旧说法加进这个清单**，否则 549 行 README、plugin.json 描述、
  marketplace.json 描述里逐处手抄的文案就会漏改（实测漏过三处）。
- `引用完整性: ...` —— 校验 `.md` / `hooks.json` 里的 `scripts/*.js` 路径真实存在，
  且脚本名遵循 `cc-` 前缀。README 里的路径写错不会立刻报错，只在该命令被调用时才炸。

测试文件随插件分发，也会从安装缓存里跑：`REPO_ROOT` 只在真的能看到 `plugins/cc-toolkit`
时才纳入扫描范围（`IN_REPO`），否则会读到缓存目录里的历史版本文案而误判失败。
