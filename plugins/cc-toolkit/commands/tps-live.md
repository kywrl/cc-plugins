---
description: 实时监视输出速度 (tok/s)，按 Ctrl-C 退出
argument-hint: "[会话文件.jsonl | -p 项目目录名] [--interval=800]"
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

在用户的终端里开启实时测速监视。请执行：

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cc-watch.js" $ARGUMENTS
```

说明给用户（不要执行完就沉默）：

- 这是**前台长驻命令**，会一直刷新直到用户按 Ctrl-C,所以请让用户在自己的终端里跑；如果当前环境无法保持长驻进程，就改用 `/cc-toolkit:tps` 看快照。
- 不带参数时自动定位「当前工作目录对应的项目」的最新会话；多开会话时用 `-p <项目目录名>`（例如 `-p D--workspace-cc-toolkit`）指定。
- 刷新间隔用 `--interval=500` 调整。

把命令给出来即可，不要自己去反复运行它。
