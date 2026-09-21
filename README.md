# cc-toolkit

实时监控 **Claude Code 的输出速度（tok/s）**。

装好即在每轮回复后看到首字等待 / 每秒输出 / 缓存命中；`/cc-toolkit:tps` 查看历史分布、趋势、离群样本与分层归因；可选把读数放进状态栏。
零 npm 依赖、纯本地计算、不联网、不上报。

```
首字 0.8s | 每秒输出 250 tok/s | 缓存命中 92%
```

三个字段回答三个互不重叠的问题：等多久、生成多快、prompt 缓存有没有生效。
「每秒输出」用的是**扣掉首字等待之后**的纯解码速度 —— 若用含 prefill 的整轮速度，
同一段等待会被算进两个字段里。

关键是把**首字等待**和**纯解码速度**分开报 —— 合成一个数字时，prompt 变长会被误读成"模型变慢"。

```text
$ /cc-toolkit:tps
会话 25ac6b0e  项目 D--workspace-cc-toolkit
当前（最近一轮，已结束）: 44 tok/s  141 tok / 3.2s
  拆分: 首字 1.9s · 解码 88 tok/s (跨 1.3s)
  缓存命中 92%
最近 5 条已完成的响应:
  01:44:42    696 tok /   4.6s =  151 tok/s 解码 210 首字2.4s
  01:44:46    332 tok /   3.4s =   99 tok/s 解码 165 首字1.5s
  01:44:54   1657 tok /   7.8s =  212 tok/s 解码 331 首字2.6s
  01:45:01   1331 tok /   7.2s =  184 tok/s 解码 288 首字3.1s
  01:45:05    349 tok /   3.9s =   89 tok/s 解码 142 首字3.2s
中位 151 tok/s | p90 212 | 最快 212 (01:44:54) | 最慢 89 (01:45:05)
纯解码口径（5/5 条可拆分）: 中位 227 tok/s | 首字中位 2.6s
```

`--insights` 还能按 effort 档位 / 模型 / 技能 / MCP 服务分组对比，并给出缓存命中、API 重试、截断等会话级事实：

```text
$ /cc-toolkit:tps --insights
── 指标分层 ──
  按 effort 档位:
    xhigh 32 / 解码 227 tok/s (n=173)
    high  41 / 解码 312 tok/s (n=88)
  按是否带 thinking:
    带 thinking 块 43 / 解码 253 tok/s (n=76)
    无 thinking 块 24 / 解码 111 tok/s (n=97)
── 会话级事实 ──
缓存: 173 条可测，中位命中 43%  ⚠ 94 条低于 50%
API 错误: 3 次 [ECONNRESET×3]，其中 3 次触发了重试
```

---

## 目录

- [为什么需要它](#为什么需要它)
- [安装方法](#安装方法)
- [hooks 配置方法](#hooks-配置方法)
- [斜杠命令](#斜杠命令)
- [状态栏集成（可选）](#状态栏集成可选)
- [环境变量开关](#环境变量开关)
- [数据来源与精度](#数据来源与精度)
- [故障排查](#故障排查)
- [仓库结构](#仓库结构)
- [开发与测试](#开发与测试)
- [License](#license)

---

## 为什么需要它

调模型、换供应商、比较不同 effort 档位的时候，"感觉变快了" 和 "真的变快了" 是两回事。
cc-toolkit 从 Claude Code 自己写的会话日志里算出每一轮的真实输出速度，给你一个可比的数字。

几个典型用法：

- 换了一个 API 供应商 / 网关，想知道吞吐到底差多少；
- 调 `effortLevel` 或换模型，想看速度与质量的实际取舍；
- 会话突然变卡，想确认是模型慢、还是工具调用多、还是自己在读大文件；
- 就想在状态栏里一直看到那个数字。

---

## 安装方法

### 方式一：从 GitHub 安装（推荐）

在本仓库发布后，于 Claude Code 里执行两条命令：

```bash
/plugin marketplace add kywrl/cc-plugins
```

```bash
/plugin install cc-toolkit@cc-plugins
```

第一条把本仓库注册为一个插件市场（`cc-plugins` 是 [marketplace.json](.claude-plugin/marketplace.json) 里声明的市场名），
第二条安装插件。装完 Stop hook 自动生效，**不需要手工改 `settings.json`**。

安装后会写入 `~/.claude/settings.json`（用户级作用域）：

```json
{
  "enabledPlugins": {
    "cc-toolkit@cc-plugins": true
  }
}
```

> 想装到某个项目而不是全局？安装时选择 project 作用域即可，配置会落到 `<项目>/.claude/settings.json`。

### 方式二：从本地目录加载（开发 / 试用）

不用发布也能装。

**直接在会话里注册本地市场并安装**（在仓库根目录启动 Claude Code，然后）：

```bash
/plugin marketplace add ./
```

```bash
/plugin install cc-toolkit@cc-plugins
```

等价 CLI：

```bash
claude plugin marketplace add ./
claude plugin install cc-toolkit@cc-plugins --scope user
```

**或者只加载插件目录、不进市场**（改代码即时生效，适合边改边试）：

```bash
claude --plugin-dir /path/to/cc-toolkit/plugins/cc-toolkit
```

> `--plugin-dir` 要指向**插件目录**（含 `.claude-plugin/plugin.json` 的那一层），
> 不是仓库根目录 —— 仓库根是市场根，只含 `marketplace.json`。

### 方式三：不用插件系统，只要脚本

脚本本身是独立的，`node` 直接跑就行，不依赖插件运行时：

```bash
node /path/to/cc-toolkit/plugins/cc-toolkit/scripts/cc-watch.js --once
```

但这样斜杠命令和自动 hook 都不会有，需要自己按下一节手工配置 hook。

### 前置条件

- **Node.js ≥ 16**（用到 `fs.readFileSync(0)`；建议 18+）。检查：`node --version`
- 没有任何 npm 依赖，不需要 `npm install`
- 首次使用前至少跑过一次 Claude Code 会话（会话日志是数据源）

装完先跑个自检确认环境没问题：

```bash
/cc-toolkit:tps-doctor
```

---

## hooks 配置方法

这是本插件的核心。**默认什么都不用配**——插件自带的 `hooks/hooks.json` 会由
Claude Code 自动加载。只有在下面这种少数情况下才需要手工挂。

### A. 用插件安装 —— 默认就是这条，无需配置

插件的 [hooks/hooks.json](plugins/cc-toolkit/hooks/hooks.json) 会被 Claude Code 自动加载，内容就是：

```json
{
  "description": "Stop hook — 每轮回复结束后把输出速度 (tok/s) 作为 systemMessage 展示给用户",
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/cc-hook.js\"",
            "timeout": 15
          }
        ]
      }
    ]
  }
}
```

几点说明：

| 项 | 说明 |
| --- | --- |
| 事件 | `Stop` —— 每轮助手回复结束时触发一次 |
| `matcher` | **不写**。Stop 事件不支持 matcher，写了也没用 |
| `${CLAUDE_PLUGIN_ROOT}` | 由 Claude Code 在插件 hook 里自动替换成插件安装目录，所以不需要写绝对路径 |
| `timeout` | 15 秒。脚本实际最多等约 0.5 秒（轮询取精确 usage），15 秒是安全余量 |
| 输出 | `{"systemMessage": "..."}` —— **只展示给用户，不进模型上下文**，不花 token、不污染对话 |

> **为什么用 `systemMessage` 而不是别的？**
> Stop hook 的 `decision: "block"` + `reason` 是"阻止 Claude 停下"的控制信号，会把内容喂给模型；
> `hookSpecificOutput.additionalContext` 同样是给模型的。只有 `systemMessage` 是纯净的用户侧提示。

### B. 手工挂进 settings.json —— 少数情况才需要

**什么时候需要**：插件 hook 没生效时。先确认是不是真的没生效——
hook 每次执行都会写一份状态缓存 `<临时目录>/cc-toolkit-<会话id>.json`，
看它的修改时间就知道。

已知会让插件 hook 失效的情况：某些环境下 Claude Code 的 `tengu_plugin_hooks_modules`
灰度开关为 off（调试日志里写 `installed plugins' hooks modules not loaded`），
此时「已安装插件的 hook」不会被注册执行。

⚠️ **别照抄调试日志下结论。** 这个开关是**按进程**决定的：`claude -p` 之类的
CLI 子进程与桌面版长期运行的进程可能状态不同。要判断你的实际环境，
请在**你真正使用的那个进程**里看 `stop_hook_summary` 记录
（transcript 里搜这个字段，`hookInfos` 会列出真正执行过的命令）。

**另一种情况**：你已经有别的 Stop hook，想统一管理，都放到 `settings.json` 里。

> ⚠️ 挂完之后**不要两个都留**——插件自带的 `hooks/hooks.json` 和 `settings.json`
> 里这条会各执行一次，每轮出现**两条**读数。要用这条就先把插件的关掉。

#### B-1. 一条命令搞定（推荐）

装好插件后跑：

```bash
/cc-toolkit:install-hook
```

它会自动定位插件安装目录、生成下面的命令、合并进 `~/.claude/settings.json`
（已有同名 hook 就更新，其他 hook 一律原样保留）。加 `--print` 只预览不落盘，
加 `--uninstall` 只移除本插件那条。

#### B-2. 手工粘贴

想把配置捏在自己手里，就把下面这段合并进配置文件。注意 `hooks` 是与
`permissions`、`env` 平级的**顶层字段**：

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"$(ls -d ~/.claude/plugins/cache/*/cc-toolkit/*/scripts/cc-hook.js | head -1)\"",
            "timeout": 15
          }
        ]
      }
    ]
  }
}
```

**为什么长这样，而不是直接写绝对路径？**

两个约束叠在一起：

1. `settings.json` 里的 hook **拿不到** `${CLAUDE_PLUGIN_ROOT}`（实测为 `null`，
   只有 `CLAUDE_PROJECT_DIR` 可用）——那个变量只在插件自己的 hook 里替换；
2. 插件的真实路径是 `~/.claude/plugins/cache/<市场名>/cc-toolkit/<版本号>/`，
   **版本号那段会随插件更新变化**，写死绝对路径升级后就失效。

所以用「命令替换 + 通配符」让 shell 在**运行时**自己找：
`$(...)` 会执行、`~` 和 `*` 会展开（已实测，Claude Code 的 hook shell 是 Git Bash）。
外层那对双引号是必需的——它保证即使匹配到多个版本、或路径含空格，
也只作为**一个**参数传给 node。

外层的双引号还有一个作用：**挂的是插件里的脚本**，插件更新后路径自动跟着变，
不需要你重配。

> 装在非默认位置？把 `~/.claude` 换成你的路径，或设 `CC_TOOLKIT_PLUGIN_ROOT`
> 指向插件目录（含 `.claude-plugin/plugin.json` 的那一层）。

> 对路径定位不放心？跑 `/cc-toolkit:tps-doctor`，它会实时解析并打印出
> 当前定位到的插件目录。

**已经在用 `~/.claude/tps-watch.js --hook`？** 那是本插件的原始独立脚本。如果两个 hook 同时存在，每轮会打印两条读数。
保留插件版的话，把原来那条删掉再执行 `/hooks` 或重启 Claude Code 让配置生效。

### C. 只挂在特定项目上

把 B 节那段写进 `<项目>/.claude/settings.json`（或用 `/cc-toolkit:install-hook --project`）。
适合团队统一口径——团队每个人都看到同样的计量方式，讨论速度差异时不容易各说各话。

### 挂上之后怎么验证

1. 让 Claude 回一句有实质内容的话（低于 `CC_TOOLKIT_MIN_TOKENS` 会被跳过，默认 30 tok）；
2. 回复结束后应看到 `首字 … | 每秒输出 … tok/s | 缓存命中 …%`；
3. 没看到就调试：

```bash
echo '{"session_id":"t","transcript_path":"/path/to/session.jsonl","hook_event_name":"Stop"}' | CC_TOOLKIT_VERBOSE=1 node /path/to/plugins/cc-toolkit/scripts/cc-hook.js
```

`CC_TOOLKIT_VERBOSE=1` 会把"为什么静默退出"打到 stderr，例如 `样本太小 (12 < 30 tok)`。

---

## 斜杠命令

命令从插件安装时带 `/cc-toolkit:` 前缀：

| 命令 | 作用 |
| --- | --- |
| `/cc-toolkit:tps [条数]` | 多行快照：当前一轮 + **首字等待/纯解码拆分** + 最近 N 条 + 中位/p90/最快/最慢 + 趋势与离群样本，并附**分层归因**（按 effort / 模型 / 技能 / MCP / 是否带 thinking 分组对比）与会话级事实（缓存命中、API 重试、截断）。参数默认 10，可加 `--all` 回放整个会话文件 |
| `/cc-toolkit:tps-live [参数]` | 生成实时监视命令（前台长驻，Ctrl-C 退出）。可选 `--interval=500`、`-p 项目目录名` |
| `/cc-toolkit:tps-doctor` | 环境自检：Node 版本、会话目录、能否定位当前会话、插件路径解析、hook / 状态栏该往哪配 |
| `/cc-toolkit:install-hook` | 把 Stop hook 写进 `settings.json`（插件 hook 没生效、或想统一管理 hook 时用）。`--print` 预览、`--uninstall` 移除、`--project` 写进当前项目 |

命令行等价形式（不装插件也能用）：

```bash
node plugins/cc-toolkit/scripts/cc-watch.js --report --history=20
```

```bash
node plugins/cc-toolkit/scripts/cc-watch.js
```

```bash
node plugins/cc-toolkit/scripts/cc-watch.js --json --history=5
```

完整参数：

| 参数 | 说明 |
| --- | --- |
| （无参数） | 实时监视，默认 800ms 刷新 |
| `--report` | 打印多行快照 + 统计事实后退出 |
| `--insights` | 打印分层对比 + 会话级事实（归因 / 缓存 / 重试 / 截断） |
| `--once` | 只打印一行汇总后退出 |
| `--json` | 输出结构化 JSON，便于接别的脚本 |
| `--history=N` | 快照里显示最近 N 条（默认 10） |
| `--interval=MS` | 实时模式刷新间隔，最小 200（默认 800） |
| `--all` | 回放整个会话文件（默认只回放末尾 2MB） |
| `-p <名字>` | 按项目目录名子串过滤，如 `-p D--workspace-cc-toolkit` |
| `<file.jsonl>` | 直接指定会话文件 |

---

## 状态栏集成（可选）

状态栏每次刷新都会调用脚本，所以插件把**最近一次 Stop hook 的结果缓存到临时目录**，状态栏优先读缓存，
读不到才回放会话末尾 400KB。不会因为状态栏而反复扫大文件。

在 `~/.claude/settings.json` 里加（`statusLine` 与 `hooks` 平级）：

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/cc-statusline.js\"",
    "padding": 0
  }
}
```

注意：`${CLAUDE_PLUGIN_ROOT}` 同样只在插件 hook 里替换 —— 但 `statusLine` 属于 `settings.json`，
所以这里**要写绝对路径**：

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"C:/Users/me/cc-toolkit/plugins/cc-toolkit/scripts/cc-statusline.js\""
  }
}
```

输出形如 `⚡ 89 tok/s · 首字 3.2s · 缓存 92%`。

状态栏空间有限，所以它比 hook 那行更简省：只有 `tps` 直接给数字（`tok/s` 自带单位），
其余段用短标签（「每秒输出」缩短成「解码」）。字段含义与 hook 那行相同，用
`CC_TOOLKIT_STATUSLINE_FIELDS` 控制显示哪些段（逗号分隔）：

- `tps` → `89 tok/s`：整轮速度（含 prefill）
- `ttft` → `首字 3.2s`：首字等待
- `decode` → `解码 227`：每秒输出，纯解码（扣掉首字等待，与「首字」正交）
- `cache` → `缓存 92%`：缓存命中率
- `median` → `中位 151`：近 9 条样本的整轮速度中位（不是 decode 中位）

注意 `CC_TOOLKIT_STATUSLINE_FIELDS` 只认这五个名字。hook 的 `CC_TOOLKIT_SHOW` 另外还有
`tokens` / `thinking` / `model` / `effort` / `skill`，状态栏不渲染 —— 照搬过去不会报错，
只是那一段不出现。

另有两段附加后缀，不占字段名、每次刷新可能出现也可能不出现：

- `⚠ 截断`（渲染为 `⚠截断`）：本轮被 `max_tokens` 截断，受 `CC_TOOLKIT_ALERTS` 控制；
- `(缓存中位 92%)`：开了 `median` 且本轮没有缓存读数时，补一段历史缓存中位。

默认 `tps,ttft,cache`。例如只想要一个数字 —— 注意 `tps` 是含 prefill 的整轮口径，
想看纯生成速度应该选 `decode`：

```json
{ "env": { "CC_TOOLKIT_STATUSLINE_FIELDS": "decode" } }
```

**读到空输出是正常的**：选中的段可能恰好都取不到 —— 单块回复没有可测的 `decode` 区间、
没有 usage 的轮次没有 `cache` 可算、或本轮 token 数低于 `CC_TOOLKIT_MIN_TOKENS`。
这种时候状态栏整段不输出，而不是留一个光秃秃的 `⚡ `。

如果你已经有自己的状态栏脚本了，不想换掉整个 statusLine，可以让它内部调一下本脚本。
**必须把 Claude Code 传来的 stdin 原样转发进去** —— 脚本要从里面取 `session_id` /
`transcript_path` 才能定位会话，读不到就直接输出空：

```bash
TPS=$(printf '%s' "$INPUT" | node "/path/to/cc-toolkit/plugins/cc-toolkit/scripts/cc-statusline.js")
```

注意别用 `</dev/null` 做自测：那样脚本拿不到会话信息，永远输出空，
看起来像状态栏坏了。要验证它有没有工作，喂一段真实的状态栏输入：

```bash
echo '{"session_id":"<会话id>","transcript_path":"~/.claude/projects/<项目目录名>/<会话id>.jsonl"}' \
  | node "/path/to/cc-toolkit/plugins/cc-toolkit/scripts/cc-statusline.js"
```

---

## 环境变量开关

hook 是从 Claude Code 进程继承环境的，所以在 `settings.json` 的 `env` 里设置即可对 hook 生效：

```json
{
  "env": {
    "CC_TOOLKIT_MIN_TOKENS": "50"
  }
}
```

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `CC_TOOLKIT_DISABLE` | — | 设为 `1` 完全禁用（hook 与状态栏都静默退出） |
| `CC_TOOLKIT_MIN_TOKENS` | `30` | 低于该 token 数不报告，避免"嗯"一声也弹个数。设为 `0` 表示不设下限。**只作用于本轮读数**，不影响中位数等统计聚合 |
| `CC_TOOLKIT_SHOW` | `ttft,decode,cache` | 每轮那行包含哪些字段，用 ` \| ` 连接。默认就是三个原始读数。可选 `ttft`（首字等待）`decode`（每秒输出/纯解码）`cache`（缓存命中）`tps`（整轮速度）`median`（近 9 条中位）`tokens`（本轮 token）`thinking` `model` `effort` `skill`。例如只留速度：`CC_TOOLKIT_SHOW=decode,tps` |
| `CC_TOOLKIT_ALERTS` | 开 | 设为 `0` 关掉 hook 与状态栏的截断提示。缓存命中率不在此列 —— 它本身就是默认显示的读数之一。refusal / API 重试这两条只在 hook 里报 |
| `CC_TOOLKIT_VERBOSE` | — | 设为 `1` 把诊断信息写到 stderr |
| `CC_TOOLKIT_STATUSLINE_PREFIX` | `⚡ ` | 状态栏前缀 |
| `CC_TOOLKIT_STATUSLINE_FIELDS` | `tps,ttft,cache` | 状态栏显示哪些段，用 ` · ` 连接。可选 `tps`（整轮速度）`ttft`（首字等待）`decode`（每秒输出）`cache`（缓存命中）`median`（近 9 条中位；开启后会附带 `(缓存中位 N%)`）。**只认这五个名字** —— hook 的 `CC_TOOLKIT_SHOW` 另有 `tokens`/`thinking`/`model`/`effort`/`skill`，状态栏不渲染 |
| `CC_TOOLKIT_STATUSLINE_CACHE_MS` | `45000` | 状态栏缓存有效期（毫秒）。设为 `0` 表示不用缓存，每次刷新都重算 |

只想临时静音一轮，直接在 shell 里 `export CC_TOOLKIT_DISABLE=1` 再启动 Claude Code 即可。

---

## 数据来源与精度

数据源是 Claude Code 自己写的会话日志：

```
~/.claude/projects/<项目目录名>/<session-id>.jsonl
```

`<项目目录名>` 是工作目录把非字母数字字符全部替换成 `-` 的结果，
例如 `D:\workspace\cc-toolkit` → `D--workspace-cc-toolkit`。

### 为什么有时候数字带 `≈`

会话日志是**内容块级**落盘——一个 thinking / text / tool_use 块写一行，**不是逐 token 流式写入**。
这不是插件能绕过的限制，是数据源的粒度。所以：

| 场景 | 精度 | 标记 |
| --- | --- | --- |
| 响应已结束，`usage.output_tokens` 已落盘 | **精确**：真实 token ÷ 真实耗时 | 无标记 |
| 响应正在流式，usage 还没写 | **估算**：块内容按字符数换算（CJK ≈ 1.5 字符/tok，其余 ≈ 4 字符/tok） | `≈` |

所有输出都用 `≈` 明确区分两者，不会拿估算值冒充精确值。hook 与状态栏一致：
估算值所在的每一段都带 `≈`（hook 的「每秒输出」与状态栏的「解码」同样如此）。
usage 落盘后估算值会被自动替换掉。

### 读数口径，别混着看

一轮的耗时里混着两件性质完全不同的事：**prefill**（读 prompt）和 **decode**（写回答）。
合成一个 tok/s 时，prompt 越长读数越低 —— 很容易被误读成"模型变慢了"。所以插件把它们分开报：

| 口径 | 定义 | 实测（本机 3.6 万条响应） |
| --- | --- | --- |
| `首字`（TTFT） | 用户发出消息 → 首个内容块落盘 | 中位 **7.3s**，p90 23s |
| `每秒输出`（decode） | 首个内容块 → 最后一个内容块 | 中位 **227–486 tok/s** |
| `整轮`（tps，默认不显示） | 整轮 token ÷ 整轮耗时（含 prefill） | 中位 32–71 |

**为什么整轮只有几十、每秒输出却有几百**：差的就是首字等待那几秒。所以判断"模型快不快"要看每秒输出，
判断"这次等得久不久"要看首字。hook 那行默认只给前者，因为它才是纯生成速度；
想看含 prefill 的整轮口径，把 `tps` 加进 `CC_TOOLKIT_SHOW`。

两个口径的趋势方向不一致时，几乎总是 prompt 长度变了（prefill 变重），不是模型解码变快慢 ——
报表里会直接提示这一点。

**`每秒输出` 显示为空是正常的**：只有 ≥2 个内容块、且首末块间隔 ≥300ms 才算得出。
实测 29% 的轮次时间戳只差 1–3ms（Claude Code 把多个块一次性写盘），这种根本没有可测区间，
插件宁可留空也不报一个上百万 tok/s 的假数字，也不用含 prefill 的整轮速度去顶替它。
状态栏的 `decode` 段同理；如果它是你选中的唯一一段，这一轮的状态栏就整段不显示。

**状态栏的「首字」偶尔整段不显示**：状态栏为了便宜只回放会话末尾 400KB，
切点可能正好落在某一轮的用户行与其首个内容块之间 —— 那一轮的起点锚就没读到。
这种情况插件会从缓存里补回：hook 用 2MB 窗口已经算准过这一轮的「首字」与起点，
只要还是同一轮（末块时间戳对得上）就直接复用，读数与 hook 完全一致。
只有在**从未算准过**的时候（冷启动、还没写过缓存）才留空 —— 不显示，也不编一个值，
同时这一轮不会被计进中位数/p90。

想彻底避免这种切换，把 `CC_TOOLKIT_STATUSLINE_CACHE_MS` 调小，
让读数更多由 Stop hook（回放 2MB）来写。

### 其他口径

- **耗时起点**：用"上一行日志的时间戳"，也就是用户发出消息的时刻，而不是第一个内容块落盘的时刻。
  否则首字延迟（TTFT）会被漏掉，速度看起来偏快。
- **缓存命中率**：`cache_read ÷ (cache_read + cache_creation + input)`。本机中位 89.7%，
  掉到 50% 以下通常意味着 prompt 缓存没生效（改了 system prompt、换了 provider、
  或前缀被工具结果打散），首字等待和成本都会跟着涨 —— 这个判断从读数本身就能得出，
  所以插件只报数，不额外弹提示。
- **thinking 占比**：`thinking_tokens ÷ output_tokens`，取自 usage 明细。
  注意 thinking token **已经包含在** output_tokens 里，不是额外的量。
  第三方 provider 通常不上报这个字段，此时显示为空，**不等于"模型没有思考"**。
- **子代理不计入**：`isSidechain` 的行会被跳过，统计的是主会话自己的输出。
- **样本过滤**：少于 50 token 或短于 300ms 的响应不进统计（噪声太大）。
- **分层归因**：按 effort / 模型 / 技能 / MCP 服务 / 是否带 thinking 分组对比时，
  会自动排掉时长超过 5 分钟的轮次（用户可能离开过，会污染"模型本事"类的指标），
  并且每组样本量少于 3 条就不显示。跨组比较前先看 `n=`。
- **实时刷新粒度**：流式过程中只有块落盘的那一刻数字才会动，所以实时模式看起来是"跳"的而不是连续滚动的。
- **回放上限**：默认只回放会话文件末尾 2MB，避免超长会话拖慢启动。要全量用 `--all`。

### 从日志里还能读到什么

除了速度，插件还会顺带解析这些旁路信息（`--insights` 里能看到）：

| 来源 | 能回答的问题 |
| --- | --- |
| `system/turn_duration` | Claude Code 自报的整轮耗时（用于交叉校验我们的推算值） |
| `system/api_error` | 有没有网络抖动 / 重试，错误码是什么 |
| `system/stop_hook_summary` | hook 到底跑了没有、有没有报错 |
| `stop_reason: max_tokens` | 这一轮被截断了 —— token 数不是完整输出，速度也不代表全部 |
| `usage.iterations[]` | 一次 API 调用内部循环了几轮 reasoning（仅官方 API 上报） |
| `attributionSkill` / `attributionMcpServer` | 速度能按技能、MCP 工具、插件归因 |
| `effort` / `perMessageEffort` | 不同 effort 档位的实际速度取舍 |

注：`perTurnEffort` 这个字段目前在所有历史会话里都是 `null`，所以还没用上。

---

## 故障排查

**Q: 完全看不到任何输出**

1. 先确认 hook 到底跑没跑——看状态缓存的修改时间：
   `<临时目录>/cc-toolkit-<会话id>.json`（`%TEMP%` / `$TMPDIR`）；
2. 跑 `/cc-toolkit:tps-doctor` 看环境（它会解析并打印当前定位到的插件目录）；
3. 确认 Node 能跑：`node --version`；
4. 手动喂一个假事件看 hook 的原始输出：

```bash
echo '{"session_id":"t","transcript_path":"C:/Users/me/.claude/projects/项目目录名/会话id.jsonl","hook_event_name":"Stop"}' | node "C:/path/to/plugins/cc-toolkit/scripts/cc-hook.js"
```

5. 确认没被环境变量关掉：`CC_TOOLKIT_DISABLE` / `CC_TOOLKIT_MIN_TOKENS`；
6. 还是不行 → 按 [hooks 配置方法](#hooks-配置方法) B 节手工挂进 `settings.json`。

**Q: 回复很短（比如只回一句"你好"）时没有读数？**

这是**已经修掉的 bug**（v1.0.1）。旧版把统计过滤器（≥50 token）误用在
「本轮读数」上，导致短回复在到达 hook 之前就被丢掉——即使你设置的
`CC_TOOLKIT_MIN_TOKENS` 比它低也没用。

现在统计过滤只影响中位数/p90 这类聚合，**不影响本轮读数的显示**。
短回复按 `CC_TOOLKIT_MIN_TOKENS`（默认 30）判断，够了就会显示。

**Q: 怎么确认 hook 到底跑没跑？**

hook 每次执行都会往临时目录写一份状态缓存 `<tmp>/cc-toolkit-<会话id>.json`。
看它的修改时间就知道有没有在跑（`%TEMP%` / `$TMPDIR`）。

想看得更细，检查 transcript 里的 `stop_hook_summary` 记录，它的 `hookInfos`
列出了**真正执行过**的命令：

```bash
grep -o '"subtype":"stop_hook_summary"[^}]*' <会话文件>.jsonl | tail -3
```

这比看调试日志可靠——调试日志里的 `tengu_plugin_hooks_modules` 状态是**按进程**的，
CLI 子进程与桌面版可能不同。

**Q: 插件更新后 hook 失效了？**

不该发生——`settings.json` 里那条命令用的是通配符，会自己跟随版本号。
如果确实失效，跑 `/cc-toolkit:install-hook` 重新生成一条。想确认当前解析结果：

```bash
node ~/.claude/plugins/cache/*/cc-toolkit/*/scripts/cc-resolve.js --print
```

**Q: 数字显示 `0 tok/s` 或一直 "… 等待响应"**

说明当前没有正在流式的响应。跑 `/cc-toolkit:tps` 看历史样本，或用 `--all` 全量回放。

**Q: 抓到了别的会话**

多开会话时自动定位可能猜错。用 `-p D--workspace-cc-toolkit`（`<项目目录名>` 的一部分即可）或直接指定 `.jsonl` 文件。

**Q: 每轮出现两条读数**

除了插件，还有另一个 Stop hook 在跑（例如你原来手工配的 `~/.claude/tps-watch.js --hook`）。
用 `/cc-toolkit:install-hook --print` 可以看出当前 `settings.json` 里有没有额外那条，
留一个、删掉另一个，然后重启 Claude Code。

**Q: 数字忽高忽低**

正常。token 数少的轮次方差天然大（几秒的窗口里多一个块就变化明显）。
看 `/cc-toolkit:tps` 的中位数，别盯单条；`/cc-toolkit:tps` 会明确标出离群样本。

**Q: 和第三方 API 网关一起用**

照常工作。速度反映的是网关 + 模型的实际吞吐，混合了网络与排队延迟——这正是你想测的东西。

---

## 仓库结构

```
cc-plugins/                             # 仓库名 = 市场名
├── .claude-plugin/
│   └── marketplace.json              # 市场清单：市场名 cc-plugins
├── plugins/
│   └── cc-toolkit/                   # 插件：cc-toolkit@cc-plugins
│       ├── .claude-plugin/
│       │   └── plugin.json           # 插件清单
│       ├── hooks/
│       │   └── hooks.json            # Stop hook 声明（自动加载，无需手工配置）
│       ├── commands/
│       │   ├── tps.md                # /cc-toolkit:tps
│       │   ├── tps-live.md           # /cc-toolkit:tps-live
│       │   ├── tps-doctor.md         # /cc-toolkit:tps-doctor
│       │   └── install-hook.md       # /cc-toolkit:install-hook
│       ├── scripts/
│       │   ├── cc-core.js            # 计算引擎：日志解析 / 轮次归档 / tok-s 统计 / 渲染
│       │   ├── cc-watch.js           # CLI：实时 / --once / --report / --json
│       │   ├── cc-hook.js            # Stop hook：回吐 systemMessage + 写状态栏缓存
│       │   ├── cc-statusline.js      # 状态栏：读缓存，输出单行读数
│       │   ├── cc-resolve.js         # 定位已安装插件的脚本目录（跨版本）
│       │   ├── cc-install-hook.js    # 把 Stop hook 写进 settings.json
│       │   └── cc-doctor.js          # 环境自检
│       ├── tests/
│       │   └── cc-toolkit.test.js    # 39 个测试，Node 内置测试运行器，零依赖
│       └── LICENSE
├── LICENSE
└── README.md
```

---

## 开发与测试

零依赖，`git clone` 后直接跑：

```bash
node --test "plugins/cc-toolkit/tests/*.test.js"
```

本地调试插件（不安装、改完即生效）：

```bash
claude --plugin-dir ./plugins/cc-toolkit
```

校验清单文件是否合法：

```bash
claude plugin validate ./plugins/cc-toolkit
```

```bash
claude plugin validate .
```

装完可以看看插件被识别出了哪些组件：

```bash
claude plugin details cc-toolkit
```

（正常应显示 `Skills (4)` + `Hooks (1) Stop`，且 Stop hook 标注为 `harness-only — no model context cost`。）

hook 的调试开关：

```bash
CC_TOOLKIT_VERBOSE=1 claude
```

诊断信息会打到 stderr，正常输出协议不受影响。

### 扩展点

`cc-core.js` 是纯函数库，没有副作用，可以直接 require 进别的脚本：

```js
const core = require("./scripts/cc-core");

const file = core.pickSessionFile({ cwd: process.cwd() });
const tracker = new core.SessionTracker(file).start();
tracker.pump();

console.log(tracker.stats());          // 中位 / p90 / 最快 / 最慢 / 累计
console.log(tracker.currentSpeed());   // 当前一轮
console.log(core.analyze(tracker));    // 趋势、离群样本、估算占比
```

---

## License

[MIT](LICENSE)
