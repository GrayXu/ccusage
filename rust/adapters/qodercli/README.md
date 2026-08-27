# ccusage-adapter-qodercli

Qoder CLI 适配器：将 Qoder CLI 写入的会话 JSONL 转换为 ccusage 的统一 usage entry。

## Owns

- `loader.rs`：读取文件、跨文件去重和日期入口。
- `parser.rs`：Qoder 记录解析、token/credits/model 映射。
- `paths.rs`：`QODER_CONFIG_DIR`、默认目录和主会话/subagent 文件发现。
- `report.rs`：daily、monthly、weekly、session 的统一报告行。

不属于 Qoder 数据源的功能应保留在 `ccusage-core` 或 `ccusage-adapter-common`。

## Data source

- `${QODER_CONFIG_DIR:-~/.qoder}/projects/{project}/{sessionId}.jsonl`
- `${QODER_CONFIG_DIR:-~/.qoder}/projects/{project}/{parentSession}/subagents/{agent}.jsonl`

记录字段、去重和计费边界见 [`src/README.md`](src/README.md)。文件读取使用 `ccusage-adapter-common` 的并行读取工具。

## Public surface

- `loader::load_entries`
- `loader::has_data`
- `report::report_from_rows`
- `report::summarize_entries`
- `run`

## Depends on

- `ccusage-adapter-common`
- `ccusage-core`
- `jiff`
- `serde`
- `serde_json`

## Build layer

构建在 `adapters` Crane artifact layer 中；该层会在一次 Cargo 调用内并行编译所有 adapter。
