use std::{
    env,
    path::{Path, PathBuf},
};

use crate::{Result, home, path_utils::expand_home_path};
use ccusage_adapter_common::collect_files_with_extension;

pub(crate) const QODER_CONFIG_DIR_ENV: &str = "QODER_CONFIG_DIR";

pub(super) struct TranscriptContext {
    pub(super) session_id: String,
    pub(super) project_path: String,
}

pub(super) fn discover_transcript_files() -> Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    for root in config_dirs() {
        collect_files_with_extension(&root.join("projects"), "jsonl", &mut files);
    }
    files.retain(|file| transcript_context(file).is_some());
    files.sort();
    files.dedup();
    Ok(files)
}

pub(super) fn transcript_context(file: &Path) -> Option<TranscriptContext> {
    let parts = file
        .components()
        .filter_map(|component| component.as_os_str().to_str())
        .collect::<Vec<_>>();
    let projects_index = parts.iter().rposition(|part| *part == "projects")?;
    let relative = parts.get(projects_index + 1..)?;
    let [project, second, rest @ ..] = relative else {
        return None;
    };
    if rest.is_empty() && second.ends_with(".jsonl") {
        return Some(TranscriptContext {
            session_id: second.trim_end_matches(".jsonl").to_string(),
            project_path: (*project).to_string(),
        });
    }
    if let ["subagents", file_name] = rest
        && file_name.ends_with(".jsonl")
    {
        return Some(TranscriptContext {
            session_id: (*second).to_string(),
            project_path: (*project).to_string(),
        });
    }
    None
}

fn config_dirs() -> Vec<PathBuf> {
    let candidates = env::var(QODER_CONFIG_DIR_ENV)
        .ok()
        .filter(|path| !path.trim().is_empty())
        .map(|path| vec![normalize_config_dir(path.trim())])
        .unwrap_or_else(|| {
            home::home_dir()
                .map(|home| vec![home.join(".qoder")])
                .unwrap_or_default()
        });
    candidates
        .into_iter()
        .filter(|path| path.is_dir())
        .collect()
}

fn normalize_config_dir(raw: &str) -> PathBuf {
    let path = expand_home_path(raw);
    if path.file_name().is_some_and(|name| name == "projects") && path.is_dir() {
        return path.parent().map(Path::to_path_buf).unwrap_or(path);
    }
    path
}

#[cfg(test)]
mod tests {
    use super::discover_transcript_files;
    use crate::paths::QODER_CONFIG_DIR_ENV;
    use ccusage_test_support::{EnvVarGuard, fs_fixture};

    #[test]
    fn discovers_main_and_subagent_qodercli_transcripts_only() {
        let fixture = fs_fixture!({
            "projects/project-a/session-a.jsonl": "{}",
            "projects/project-a/session-a/subagents/agent-a.jsonl": "{}",
            "projects/project-a/transcript/ide-session.jsonl": "{}",
            "projects/project-a/session-a/state.json": "{}",
        });
        let _guard = EnvVarGuard::set(QODER_CONFIG_DIR_ENV, fixture.root());

        let files = discover_transcript_files().unwrap();

        assert_eq!(files.len(), 2);
        assert!(files.iter().any(|path| path.ends_with("session-a.jsonl")));
        assert!(
            files
                .iter()
                .any(|path| path.ends_with("subagents/agent-a.jsonl"))
        );
    }
}
