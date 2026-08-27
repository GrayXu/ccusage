use std::{
    collections::HashMap,
    fs,
    path::Path,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use jiff::tz::TimeZone as JiffTimeZone;

use super::{
    parser::{QoderUsageEvent, parse_records_with_context},
    paths,
};
use crate::{
    LoadedEntry, PricingMap, Result, TimestampMs, TokenUsageRaw, UsageEntry, UsageMessage,
    calculate_cost_for_usage,
    cli::{CostMode, SharedArgs},
    debug_log, format_date_tz, log_level, missing_pricing_model_for_usage, parse_tz,
};
use ccusage_adapter_common::read_files_parallel;

pub fn load_entries(shared: &SharedArgs) -> Result<Vec<LoadedEntry>> {
    crate::progress::track_usage_load(
        crate::progress::UsageLoadAgent("Qoder CLI"),
        shared.json,
        || load_entries_inner(shared),
    )
}

pub fn has_data() -> bool {
    paths::discover_transcript_files()
        .is_ok_and(|files| files.iter().any(|file| fs::read(file).is_ok()))
}

fn load_entries_inner(shared: &SharedArgs) -> Result<Vec<LoadedEntry>> {
    let files = paths::discover_transcript_files()?;
    if files.is_empty() {
        return Ok(Vec::new());
    }
    let pricing = if shared.mode == CostMode::Display {
        None
    } else {
        Some(PricingMap::load_with_overrides(
            shared.offline,
            log_level() != Some(0),
            shared.pricing_overrides.iter(),
        ))
    };
    let loaded = read_files_parallel(&files, shared.single_thread, |file| {
        load_transcript(file).unwrap_or_else(|error| {
            debug_log(
                shared,
                format!(
                    "Failed to read Qoder CLI transcript {}: {error}",
                    file.display()
                ),
            );
            Vec::new()
        })
    });
    let mut deduped = HashMap::<String, QoderUsageEvent>::new();
    for events in loaded {
        for event in events {
            let key = format!(
                "{}\0{}\0{}",
                event.project_path, event.group_session_id, event.id
            );
            deduped.insert(key, event);
        }
    }

    let tz = parse_tz(shared.timezone.as_deref());
    let mut entries = deduped
        .into_values()
        .map(|event| to_loaded_entry(event, tz.as_ref(), shared.mode, pricing.as_ref()))
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| {
        left.timestamp.cmp(&right.timestamp).then_with(|| {
            left.data
                .message
                .id
                .as_deref()
                .cmp(&right.data.message.id.as_deref())
        })
    });
    Ok(entries)
}

fn load_transcript(path: &Path) -> Result<Vec<QoderUsageEvent>> {
    let Some(context) = paths::transcript_context(path) else {
        return Ok(Vec::new());
    };
    let content = fs::read(path)?;
    let fallback_timestamp = file_timestamp(path);
    Ok(parse_records_with_context(
        &content,
        fallback_timestamp,
        &context.session_id,
        &context.project_path,
    ))
}

fn file_timestamp(path: &Path) -> TimestampMs {
    let modified = fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok());
    modified.map_or_else(
        || system_time_timestamp(SystemTime::now()),
        |duration| TimestampMs::from_millis(duration.as_millis().min(i64::MAX as u128) as i64),
    )
}

fn system_time_timestamp(time: SystemTime) -> TimestampMs {
    time.duration_since(UNIX_EPOCH).map_or_else(
        |_| TimestampMs::UNIX_EPOCH,
        |duration| TimestampMs::from_millis(duration.as_millis().min(i64::MAX as u128) as i64),
    )
}

fn to_loaded_entry(
    event: QoderUsageEvent,
    tz: Option<&JiffTimeZone>,
    mode: CostMode,
    pricing: Option<&PricingMap>,
) -> LoadedEntry {
    let usage = TokenUsageRaw {
        input_tokens: event.input_tokens,
        output_tokens: event.output_tokens,
        cache_creation_input_tokens: event.cache_creation_tokens,
        cache_read_input_tokens: event.cache_read_tokens,
        speed: None,
        cache_creation: None,
    };
    let pricing_model = (event.model != "unknown").then_some(event.model.as_str());
    let cost = calculate_cost_for_usage(pricing_model, usage, None, mode, pricing);
    let missing_pricing_model =
        missing_pricing_model_for_usage(pricing_model, usage, None, mode, pricing);
    let data = UsageEntry {
        session_id: Some(event.session_id.clone()),
        timestamp: event.timestamp_text,
        version: None,
        message: UsageMessage {
            usage,
            model: Some(event.model.clone()),
            id: Some(event.id),
        },
        cost_usd: None,
        request_id: None,
        is_api_error_message: None,
        is_sidechain: None,
    };
    LoadedEntry {
        date: format_date_tz(event.timestamp, tz),
        timestamp: event.timestamp,
        project: Arc::from("qodercli"),
        session_id: Arc::from(event.group_session_id),
        project_path: Arc::from(event.project_path),
        cost,
        extra_total_tokens: 0,
        credits: event.credits,
        message_count: None,
        model: Some(event.model),
        usage_limit_reset_time: None,
        missing_pricing_model,
        data,
    }
}

#[cfg(test)]
mod tests {
    use super::load_entries;
    use crate::{
        cli::{CostMode, SharedArgs},
        paths::QODER_CONFIG_DIR_ENV,
    };
    use ccusage_test_support::{EnvVarGuard, fs_fixture};

    #[test]
    fn loads_qodercli_usage_from_a_main_session_transcript() {
        let fixture = fs_fixture!({
            "projects/-Users-gray-workplace-example/session-a.jsonl": concat!(
                r#"{"type":"system","subtype":"init","session_id":"raw-session","cwd":"/workspace/example","model":"qwen3-coder-plus"}"#,
                "\n",
                r#"{"type":"assistant","uuid":"assistant-a","session_id":"raw-session","timestamp":"2026-08-26T12:34:56.000Z","message":{"role":"assistant","usage":{"input_tokens":100,"output_tokens":50,"cache_creation_input_tokens":10,"cache_read_input_tokens":20,"credits":1.25}}}"#,
                "\n"
            ),
        });
        let _guard = EnvVarGuard::set(QODER_CONFIG_DIR_ENV, fixture.root());
        let shared = SharedArgs {
            mode: CostMode::Display,
            timezone: Some("UTC".to_string()),
            ..SharedArgs::default()
        };

        let entries = load_entries(&shared).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].date, "2026-08-26");
        assert_eq!(entries[0].session_id.as_ref(), "session-a");
        assert_eq!(entries[0].project_path.as_ref(), "/workspace/example");
        assert_eq!(entries[0].data.session_id.as_deref(), Some("raw-session"));
        assert_eq!(entries[0].data.message.id.as_deref(), Some("assistant-a"));
        assert_eq!(entries[0].model.as_deref(), Some("qwen3-coder-plus"));
        assert_eq!(entries[0].data.message.usage.input_tokens, 100);
        assert_eq!(entries[0].data.message.usage.output_tokens, 50);
        assert_eq!(
            entries[0].data.message.usage.cache_creation_input_tokens,
            10
        );
        assert_eq!(entries[0].data.message.usage.cache_read_input_tokens, 20);
        assert_eq!(entries[0].credits, Some(1.25));
    }

    #[test]
    fn groups_subagent_usage_under_its_parent_session() {
        let fixture = fs_fixture!({
            "projects/project-a/parent-session/subagents/agent-a.jsonl": concat!(
                r#"{"type":"system","subtype":"init","session_id":"subagent-session","model":"qwen3-coder-plus"}"#,
                "\n",
                r#"{"type":"assistant","uuid":"assistant-a","session_id":"subagent-session","timestamp":"2026-08-26T12:34:56.000Z","message":{"usage":{"input_tokens":100,"output_tokens":50}}}"#,
                "\n"
            ),
        });
        let _guard = EnvVarGuard::set(QODER_CONFIG_DIR_ENV, fixture.root());
        let shared = SharedArgs {
            mode: CostMode::Display,
            ..SharedArgs::default()
        };

        let entries = load_entries(&shared).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].session_id.as_ref(), "parent-session");
        assert_eq!(
            entries[0].data.session_id.as_deref(),
            Some("subagent-session")
        );
    }
}
