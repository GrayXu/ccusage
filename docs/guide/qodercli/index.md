# Qoder CLI 数据源

ccusage 可读取 Qoder CLI 的本地会话 JSONL，并将其纳入默认聚合报告或 `qodercli` 聚焦报告。

## 聚焦视图

```bash
ccusage qodercli daily
ccusage qodercli monthly
ccusage qodercli session
```

默认的 `ccusage daily`、`ccusage weekly`、`ccusage monthly` 和 `ccusage session` 也会自动包含发现到的 Qoder CLI 数据。

## 数据位置

Qoder CLI 的用户配置根默认是 `~/.qoder`。设置 `QODER_CONFIG_DIR` 后，ccusage 从该目录读取会话：

```bash
QODER_CONFIG_DIR="$HOME/.qoder" ccusage qodercli daily
```

```text
~/.qoder/
└── projects/
    └── {project}/
        ├── {sessionId}.jsonl
        └── {parentSession}/
            └── subagents/
                └── {agent}.jsonl
```

主会话和 subagent transcript 都会统计；subagent usage 会归到其父 session。`projects/{project}/transcript/*.jsonl` 是 Qoder IDE 的 transcript 路径，不在 Qoder CLI adapter 的扫描范围内。

## 统计口径

- 只读取 assistant record 的 `message.usage`。
- 分别统计 input、output、cache creation 和 cache read token。
- Qoder 追加同一 assistant `uuid` 的更新快照时，只保留最后一个快照，避免重复计算。
- 模型优先取 assistant message；缺失时继承同一 session 的 `system/init` model。无法确定模型时保留 token，但不虚构 USD 价格。
- `message.usage.credits` 会显示为 Credits；它不是 USD 成本。

## 环境变量

| Variable           | Description                                |
| ------------------ | ------------------------------------------ |
| `QODER_CONFIG_DIR` | 覆盖 Qoder CLI 用户配置根；默认 `~/.qoder` |
| `LOG_LEVEL`        | 控制 ccusage 日志详细程度                  |

## 排障

::: details No Qoder CLI usage data found

确认 Qoder CLI 已写入 `~/.qoder/projects/` 下的主会话 JSONL，或设置 `QODER_CONFIG_DIR` 指向实际用户配置根。没有 `message.usage` 的历史记录不包含可由 ccusage 还原的 token 数据。

:::

::: details Costs showing as $0.00

Qoder 的 Credits 和 USD 不是同一单位。若记录没有可映射到 LiteLLM 的具体模型，ccusage 保留 token 与 Credits，并将 USD 估算显示为 `$0.00`。

:::
