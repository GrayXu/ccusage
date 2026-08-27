# Qoder CLI Source

默认数据根目录是 `~/.qoder`，可由 `QODER_CONFIG_DIR` 覆盖。ccusage 只读取 Qoder CLI 的主会话和其 subagent transcript：

```text
projects/{project}/{sessionId}.jsonl
projects/{project}/{parentSession}/subagents/{agent}.jsonl
```

`projects/{project}/transcript/*.jsonl` 是 Qoder IDE 的 transcript 路径，不属于本 adapter 的扫描范围。

## Token and model mapping

- 只统计 `type: "assistant"` 且带有 `message.usage` 的记录。
- `inputTokens` ← `message.usage.input_tokens`
- `outputTokens` ← `message.usage.output_tokens`
- `cacheCreationInputTokens` ← `message.usage.cache_creation_input_tokens`
- `cacheReadInputTokens` ← `message.usage.cache_read_input_tokens`
- `credits` ← 正值的 `message.usage.credits`；Credits 不是 USD，不会当作 `costUSD`。
- 模型优先取 assistant message 自身的 `model`，否则使用同一 session 最近的顶层 `model`（通常来自 `system/init`）；两者都不存在时显示为 `unknown`，不会臆造价格。

Qoder 可能以相同的 assistant `uuid` 追加更新快照。adapter 对每个父 session 保留最后一条快照，以免重复计数。subagent 的 usage 会归到文件路径中的父 session，原始 Qoder `session_id` 仍保留在 entry data 中。

使用中没有持久化 `message.usage` 的记录无法由 ccusage 补算 token 或 USD 成本。
