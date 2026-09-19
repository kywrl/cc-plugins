---
description: 检查 cc-toolkit 的运行环境：Node 版本、会话目录、当前会话定位、hook 是否生效
argument-hint: ""
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

下面是 cc-toolkit 的环境自检结果：

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/tps-doctor.js"`

请把结果转述给用户，并在出现 ❌ 时给出对应的修复动作（脚本会直接打印建议）。数字和路径照抄，不要改动。
