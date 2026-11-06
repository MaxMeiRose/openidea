//! Local-only first version: Maven builds and the disposable method JVM never require jdtls.
use crate::Host;
use ide_core::{IdeError, IdeResult, RequestId};
use ide_run::method::{MethodInvocation, MethodInvocationResult, MethodTools, PreparedMethodInvocation};
use std::sync::OnceLock;

pub async fn prepare(
    host: &Host,
    window: &str,
    invocation: MethodInvocation,
    request: RequestId,
) -> IdeResult<PreparedMethodInvocation> {
    host.require_trust(window)?;
    invocation.validate()?;
    let project = host.project(window)?;
    let cancel = host.begin_project_request(window, request);
    let result = async {
        let module = ide_run::method::module_for_source(&project.root, &invocation.source_path)?;
        let settings = project.settings.effective();
        let jdks = ide_sdk::java::installed_jdks();
        let jdk = ide_sdk::apply::project_jdk(&project.root, &settings)
            .or_else(|| ide_sdk::java::pick_jdk(&jdks, ide_sdk::java::project_java_version(&module)).cloned())
            .ok_or_else(|| IdeError::unavailable("Install a project JDK (Java 8 or newer) to run method tests"))?;
        let javac = jdk.home.join(if cfg!(windows) { "bin/javac.exe" } else { "bin/javac" });
        if jdk.major < 8 || !javac.is_file() {
            return Err(IdeError::unavailable("Method tests require a full JDK 8 or newer, including javac"));
        }
        let wrapper = module
            .ancestors()
            .take_while(|p| p.starts_with(&project.root))
            .map(|p| p.join(if cfg!(windows) { "mvnw.cmd" } else { "mvnw" }))
            .find(|p| p.is_file());
        let maven = ide_sdk::apply::maven_command(&project.root, &settings)
            .or(wrapper)
            .or_else(|| {
                ide_run::which::find_executable(
                    if cfg!(windows) { "mvn.cmd" } else { "mvn" },
                    &std::env::var_os("PATH").unwrap_or_default(),
                )
            })
            .ok_or_else(|| {
                IdeError::unavailable(
                    "Maven was not found. Configure Maven Home or add a Maven wrapper to the project.",
                )
            })?;
        let cache = project.build_cache_dir().join("method-tests");
        let runner = cache.join("runner");
        // One compiler writes this shared runner at a time, including concurrent windows.
        static COMPILER: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
        let _guard = tokio::select! {
            guard=COMPILER.get_or_init(||tokio::sync::Mutex::new(())).lock()=>guard,
            _=cancel.cancelled()=>return Err(IdeError::cancelled()),
        };
        std::fs::create_dir_all(&runner)?;
        let manifest = runner.join("compiled-source.java");
        if std::fs::read_to_string(&manifest).ok().as_deref() != Some(ide_run::method::RUNNER_SOURCE)
            || !runner.join("OpenIdeaMethodRunner.class").is_file()
        {
            let source = runner.join("OpenIdeaMethodRunner.java");
            std::fs::write(&source, ide_run::method::RUNNER_SOURCE)?;
            let mut command = tokio::process::Command::new(javac);
            command
                .args(["-source", "8", "-target", "8", "-encoding", "UTF-8", "-g", "-d"])
                .arg(&runner)
                .arg(&source)
                .kill_on_drop(true);
            let output = tokio::select! {
                output=command.output()=>output?,
                _=cancel.cancelled()=>return Err(IdeError::cancelled()),
            };
            if !output.status.success() {
                return Err(IdeError::invalid(format!(
                    "Cannot compile the method runner: {}",
                    String::from_utf8_lossy(&output.stderr)
                )));
            }
            std::fs::write(&manifest, ide_run::method::RUNNER_SOURCE)?;
        }
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        let tools = MethodTools {
            java_home: jdk.home,
            maven: maven.to_string_lossy().into_owned(),
            maven_options: ide_sdk::apply::maven_options(&project.root, &settings),
        };
        ide_run::method::prepare(&cache, &uuid::Uuid::new_v4().to_string(), &project.root, &module, &tools, &invocation)
    }
    .await;
    host.end_request(request);
    result
}

pub fn result(host: &Host, window: &str, id: &str) -> IdeResult<Option<MethodInvocationResult>> {
    host.require_trust(window)?;
    ide_run::method::read_result(&host.project(window)?.build_cache_dir().join("method-tests"), id)
}
