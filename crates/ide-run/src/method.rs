//! Disposable Java method invocations. The launcher has no compile-time framework
//! dependencies; Spring/Jackson/Mockito are taken from the project's test classpath.

use crate::{RunConfig, RunExtras};
use ide_core::{IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const RUNNER_SOURCE: &str = include_str!("method/OpenIdeaMethodRunner.java");

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MethodInvocation {
    pub source_path: PathBuf,
    pub class_name: String,
    pub method_name: String,
    pub parameter_types: Vec<String>,
    pub arguments_json: String,
    /// `object` or `spring`.
    pub mode: String,
    pub dependencies_json: String,
    pub properties_json: String,
    pub configuration_classes: Vec<String>,
    pub profiles: Vec<String>,
    pub maven_profiles: Vec<String>,
    pub heap_mb: u32,
    pub timeout_seconds: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PreparedMethodInvocation {
    pub id: String,
    pub config: RunConfig,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MethodInvocationResult {
    pub success: bool,
    pub value_json: Option<String>,
    pub duration_ms: f64,
    pub error: Option<String>,
    pub stack_trace: Option<String>,
    pub mock_calls_json: String,
}

fn object(text: &str, label: &str) -> IdeResult<()> {
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|e| IdeError::invalid(format!("{label}: {e}")))?;
    if !value.is_object() {
        return Err(IdeError::invalid(format!("{label} must be a JSON object")));
    }
    Ok(())
}

impl MethodInvocation {
    pub fn validate(&self) -> IdeResult<()> {
        if !matches!(self.mode.as_str(), "object" | "spring") {
            return Err(IdeError::invalid("Choose Object or Spring mode"));
        }
        if self.class_name.is_empty() || self.method_name.is_empty() || self.parameter_types.len() > 64 {
            return Err(IdeError::invalid("Choose a public Java method"));
        }
        if !(64..=4096).contains(&self.heap_mb) || !(1..=3600).contains(&self.timeout_seconds) {
            return Err(IdeError::invalid("Heap must be 64–4096 MB; timeout must be 1–3600 seconds"));
        }
        let arguments: serde_json::Value =
            serde_json::from_str(&self.arguments_json).map_err(|e| IdeError::invalid(format!("Arguments: {e}")))?;
        if arguments.as_array().is_none_or(|a| a.len() != self.parameter_types.len()) {
            return Err(IdeError::invalid("Arguments must be a JSON array with one value per parameter"));
        }
        object(&self.dependencies_json, "Dependencies")?;
        object(&self.properties_json, "Properties")?;
        if self
            .profiles
            .iter()
            .chain(&self.maven_profiles)
            .any(|p| p.is_empty() || p.starts_with(['-', '!']) || p.contains([',', '\n', '\r']))
        {
            return Err(IdeError::invalid("Enter Maven/Spring profile names separated by commas"));
        }
        if serde_json::to_vec(self).map_err(|e| IdeError::invalid(e.to_string()))?.len() > 1024 * 1024 {
            return Err(IdeError::invalid("Method invocation is larger than 1 MB"));
        }
        Ok(())
    }
}

/// Nearest Maven module. Calls cannot escape the current project through a source symlink.
pub fn module_for_source(root: &Path, source: &Path) -> IdeResult<PathBuf> {
    let root = dunce::canonicalize(root)?;
    let source = dunce::canonicalize(source)?;
    if !source.starts_with(&root) || source.extension().and_then(|e| e.to_str()) != Some("java") {
        return Err(IdeError::invalid("Choose a Java source inside the current project"));
    }
    source
        .parent()
        .into_iter()
        .flat_map(Path::ancestors)
        .take_while(|dir| dir.starts_with(&root))
        .find(|dir| dir.join("pom.xml").is_file())
        .map(Path::to_path_buf)
        .ok_or_else(|| IdeError::invalid("Method tests currently require a Maven module (pom.xml)"))
}

fn private_file(path: &Path, text: &[u8]) -> IdeResult<()> {
    std::fs::write(path, text)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

fn property(value: &str) -> String {
    value.replace('\\', "\\\\").replace('\n', "\\n").replace('\r', "\\r")
}

pub struct MethodTools {
    pub java_home: PathBuf,
    pub maven: String,
    pub maven_options: Vec<String>,
}

/// Writes the per-invocation request and launcher settings; framework code is never put in the project.
pub fn prepare(
    cache: &Path,
    id: &str,
    root: &Path,
    module: &Path,
    tools: &MethodTools,
    request: &MethodInvocation,
) -> IdeResult<PreparedMethodInvocation> {
    request.validate()?;
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return Err(IdeError::invalid("Invalid method invocation id"));
    }
    let dir = cache.join(id);
    std::fs::create_dir_all(&dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    }
    private_file(
        &dir.join("request.json"),
        &serde_json::to_vec(request).map_err(|e| IdeError::invalid(e.to_string()))?,
    )?;
    let java = tools.java_home.join(if cfg!(windows) { "bin/java.exe" } else { "bin/java" });
    let mut properties = BTreeMap::from([
        ("module".to_owned(), module.to_string_lossy().into_owned()),
        ("java".to_owned(), java.to_string_lossy().into_owned()),
        ("maven".to_owned(), tools.maven.clone()),
        ("heap".to_owned(), request.heap_mb.to_string()),
        ("timeout".to_owned(), request.timeout_seconds.to_string()),
        ("profiles".to_owned(), request.maven_profiles.join(",")),
    ]);
    for (index, arg) in tools.maven_options.iter().enumerate() {
        properties.insert(format!("mavenOption{index}"), arg.clone());
    }
    let text = properties.into_iter().map(|(k, v)| format!("{k}={}\n", property(&v))).collect::<String>();
    private_file(&dir.join("launch.properties"), text.as_bytes())?;
    Ok(PreparedMethodInvocation {
        id: id.to_owned(),
        config: RunConfig {
            id: format!(
                "java-method:{}:{}#{}({})",
                request.source_path.display(),
                request.class_name,
                request.method_name,
                request.parameter_types.join(",")
            ),
            name: format!(
                "{} · {}",
                request.class_name.rsplit('.').next().unwrap_or(&request.class_name),
                request.method_name
            ),
            kind: "java-method".into(),
            command: java.to_string_lossy().into_owned(),
            args: vec![
                "-Xmx64m".into(),
                "-cp".into(),
                cache.join("runner").to_string_lossy().into_owned(),
                "OpenIdeaMethodRunner".into(),
                "--prepare".into(),
                dir.to_string_lossy().into_owned(),
            ],
            cwd: Some(module.to_path_buf().into()),
            env: BTreeMap::from([("JAVA_HOME".into(), tools.java_home.to_string_lossy().into_owned())]),
            detected: false,
            is_test: false,
            debug_adapter: Some("java-debug".into()),
            allow_parallel: false,
            extras: RunExtras {
                module: Some(module.strip_prefix(root).unwrap_or(module).to_string_lossy().into_owned()),
                open_tool_window: Some(true),
                ..RunExtras::default()
            },
        },
    })
}

pub fn read_result(cache: &Path, id: &str) -> IdeResult<Option<MethodInvocationResult>> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return Err(IdeError::invalid("Invalid method invocation id"));
    }
    let path = cache.join(id).join("result.json");
    match std::fs::metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
        Ok(m) if m.len() > 10 * 1024 * 1024 => return Err(IdeError::invalid("Method result exceeds 10 MB")),
        Ok(_) => {}
    }
    Ok(Some(serde_json::from_slice(&std::fs::read(path)?).map_err(|e| IdeError::invalid(e.to_string()))?))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> MethodInvocation {
        MethodInvocation {
            source_path: "Service.java".into(),
            class_name: "demo.Service".into(),
            method_name: "get".into(),
            parameter_types: vec!["long".into()],
            arguments_json: "[1]".into(),
            mode: "object".into(),
            dependencies_json: "{}".into(),
            properties_json: "{}".into(),
            configuration_classes: vec![],
            profiles: vec![],
            maven_profiles: vec![],
            heap_mb: 384,
            timeout_seconds: 120,
        }
    }
    #[test]
    fn rejects_invalid_parameters_before_starting_a_process() {
        let mut r = request();
        assert!(r.validate().is_ok());
        r.arguments_json = "{}".into();
        assert!(r.validate().is_err());
        r.arguments_json = "[]".into();
        assert!(r.validate().is_err());
        r.arguments_json = "[1]".into();
        r.dependencies_json = "[]".into();
        assert!(r.validate().is_err());
    }
    #[test]
    fn finds_the_nearest_module_and_rejects_paths_outside_the_project() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("root");
        let module = root.join("app");
        std::fs::create_dir_all(module.join("src")).unwrap();
        std::fs::write(root.join("pom.xml"), "").unwrap();
        std::fs::write(module.join("pom.xml"), "").unwrap();
        let source = module.join("src/Service.java");
        std::fs::write(&source, "").unwrap();
        assert_eq!(module_for_source(&root, &source).unwrap(), dunce::canonicalize(&module).unwrap());
        assert!(module_for_source(&module.join("src"), &source).is_err());
        assert!(read_result(tmp.path(), "../result").is_err());
    }
}
