use std::collections::HashMap;

use ccusage_adapter_common::jsonl;
use ccusage_core::{TimestampMs, format_rfc3339_millis, parse_ts_timestamp};
use serde::Deserialize;

#[derive(Debug, PartialEq)]
pub(super) struct QoderUsageEvent {
    pub(super) id: String,
    pub(super) session_id: String,
    pub(super) group_session_id: String,
    pub(super) project_path: String,
    pub(super) timestamp: TimestampMs,
    pub(super) timestamp_text: String,
    pub(super) model: String,
    pub(super) input_tokens: u64,
    pub(super) output_tokens: u64,
    pub(super) cache_creation_tokens: u64,
    pub(super) cache_read_tokens: u64,
    pub(super) credits: Option<f64>,
}

#[derive(Debug, Default, Deserialize)]
struct QoderRecord {
    #[serde(default, deserialize_with = "jsonl::non_empty_string")]
    r#type: Option<String>,
    #[serde(default, deserialize_with = "jsonl::non_empty_string")]
    uuid: Option<String>,
    #[serde(
        default,
        rename = "session_id",
        alias = "sessionId",
        deserialize_with = "jsonl::non_empty_string"
    )]
    session_id: Option<String>,
    #[serde(default, deserialize_with = "jsonl::non_empty_string")]
    timestamp: Option<String>,
    #[serde(default, deserialize_with = "jsonl::non_empty_string")]
    cwd: Option<String>,
    #[serde(default, deserialize_with = "jsonl::non_empty_string")]
    model: Option<String>,
    #[serde(default, deserialize_with = "jsonl::lenient_object")]
    message: Option<QoderMessage>,
}

#[derive(Debug, Default, Deserialize)]
struct QoderMessage {
    #[serde(default, deserialize_with = "jsonl::non_empty_string")]
    id: Option<String>,
    #[serde(default, deserialize_with = "jsonl::non_empty_string")]
    model: Option<String>,
    #[serde(default, deserialize_with = "jsonl::lenient_object")]
    usage: Option<QoderUsage>,
}

#[derive(Debug, Default, Deserialize)]
struct QoderUsage {
    #[serde(default, deserialize_with = "jsonl::lenient_u64")]
    input_tokens: u64,
    #[serde(default, deserialize_with = "jsonl::lenient_u64")]
    output_tokens: u64,
    #[serde(default, deserialize_with = "jsonl::lenient_u64")]
    cache_creation_input_tokens: u64,
    #[serde(default, deserialize_with = "jsonl::lenient_u64")]
    cache_read_input_tokens: u64,
    #[serde(default, deserialize_with = "jsonl::lenient_f64")]
    credits: Option<f64>,
}

#[cfg(test)]
pub(super) fn parse_records(content: &[u8]) -> Vec<QoderUsageEvent> {
    parse_records_with_context(
        content,
        TimestampMs::UNIX_EPOCH,
        "unknown",
        "Unknown Project",
    )
}

pub(super) fn parse_records_with_context(
    content: &[u8],
    fallback_timestamp: TimestampMs,
    fallback_session_id: &str,
    fallback_project_path: &str,
) -> Vec<QoderUsageEvent> {
    let mut models_by_session = HashMap::<String, String>::new();
    let mut projects_by_session = HashMap::<String, String>::new();
    let mut event_indexes = HashMap::<String, usize>::new();
    let mut events = Vec::new();

    for (ordinal, record) in jsonl::records::<QoderRecord>(content, None).enumerate() {
        let session_id = record.session_id.as_deref().unwrap_or(fallback_session_id);
        if let Some(model) = record.model.as_ref() {
            models_by_session.insert(session_id.to_string(), model.clone());
        }
        if let Some(project_path) = record.cwd.as_ref() {
            projects_by_session.insert(session_id.to_string(), project_path.clone());
        }
        if record.r#type.as_deref() != Some("assistant") {
            continue;
        }
        let Some(message) = record.message.as_ref() else {
            continue;
        };
        let Some(usage) = message.usage.as_ref() else {
            continue;
        };
        if usage.input_tokens == 0
            && usage.output_tokens == 0
            && usage.cache_creation_input_tokens == 0
            && usage.cache_read_input_tokens == 0
            && usage.credits.unwrap_or_default() <= 0.0
        {
            continue;
        }
        let timestamp = record
            .timestamp
            .as_deref()
            .and_then(parse_ts_timestamp)
            .unwrap_or(fallback_timestamp);
        let timestamp_text = format_rfc3339_millis(timestamp);
        let id = record
            .uuid
            .or_else(|| message.id.clone())
            .unwrap_or_else(|| format!("{session_id}:{}:{ordinal}", timestamp.as_millis()));
        let model = message
            .model
            .clone()
            .or_else(|| models_by_session.get(session_id).cloned())
            .unwrap_or_else(|| "unknown".to_string());
        let project_path = record
            .cwd
            .clone()
            .or_else(|| projects_by_session.get(session_id).cloned())
            .unwrap_or_else(|| fallback_project_path.to_string());
        let event = QoderUsageEvent {
            id: id.clone(),
            session_id: session_id.to_string(),
            group_session_id: fallback_session_id.to_string(),
            project_path,
            timestamp,
            timestamp_text,
            model,
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cache_creation_tokens: usage.cache_creation_input_tokens,
            cache_read_tokens: usage.cache_read_input_tokens,
            credits: usage.credits.filter(|credits| *credits > 0.0),
        };
        let dedup_key = format!("{fallback_session_id}\0{id}");
        if let Some(index) = event_indexes.get(&dedup_key).copied() {
            events[index] = event;
        } else {
            event_indexes.insert(dedup_key, events.len());
            events.push(event);
        }
    }

    events
}

#[cfg(test)]
mod tests {
    use super::parse_records;

    #[test]
    fn parses_assistant_usage_with_top_level_uuid_and_inherited_model() {
        let events = parse_records(
            br#"{"type":"system","subtype":"init","session_id":"session-a","model":"qwen3-coder-plus"}
{"type":"assistant","uuid":"assistant-a","session_id":"session-a","timestamp":"2026-08-26T12:34:56.000Z","message":{"role":"assistant","usage":{"input_tokens":100,"output_tokens":50,"cache_creation_input_tokens":10,"cache_read_input_tokens":20}}}
"#,
        );

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id, "assistant-a");
        assert_eq!(events[0].session_id, "session-a");
        assert_eq!(events[0].model, "qwen3-coder-plus");
        assert_eq!(events[0].input_tokens, 100);
        assert_eq!(events[0].output_tokens, 50);
        assert_eq!(events[0].cache_creation_tokens, 10);
        assert_eq!(events[0].cache_read_tokens, 20);
    }

    #[test]
    fn keeps_the_last_snapshot_for_a_repeated_assistant_uuid() {
        let events = parse_records(
            br#"{"type":"system","subtype":"init","session_id":"session-a","model":"qwen3-coder-plus"}
{"type":"assistant","uuid":"assistant-a","session_id":"session-a","message":{"usage":{"input_tokens":10,"output_tokens":1}}}
{"type":"assistant","uuid":"assistant-a","session_id":"session-a","message":{"usage":{"input_tokens":20,"output_tokens":2}}}
"#,
        );

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].input_tokens, 20);
        assert_eq!(events[0].output_tokens, 2);
    }

    #[test]
    fn ignores_cumulative_result_usage() {
        let events = parse_records(
            br#"{"type":"system","subtype":"init","session_id":"session-a","model":"qwen3-coder-plus"}
{"type":"assistant","uuid":"assistant-a","session_id":"session-a","message":{"usage":{"input_tokens":10,"output_tokens":1}}}
{"type":"result","session_id":"session-a","usage":{"input_tokens":999,"output_tokens":999}}
"#,
        );

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].input_tokens, 10);
        assert_eq!(events[0].output_tokens, 1);
    }
}
