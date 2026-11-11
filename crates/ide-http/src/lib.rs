//! HTTP Client: IntelliJ-style `.http` request files.
//!
//! [`parse`] splits a file into requests, [`env`] resolves `{{variables}}` from
//! `http-client(.private).env.json`, [`exec`] sends a request (cancellable,
//! timed) and [`history`] keeps the responses. [`client`] builds every HTTP client
//! of the backend, with the proxy of System Settings › HTTP Proxy.

pub mod client;
pub mod curl;
pub mod env;
pub mod eureka;
pub mod exec;
pub mod history;
pub mod parse;

pub use env::Environments;
pub use exec::{HttpResponse, PreparedRequest};
pub use history::{History, HistoryEntry, HttpExchange};
pub use parse::HttpRequestBlock;

use ide_core::{CancellationToken, IdeError, IdeResult, IpcPath};
use std::path::Path;

/// Where a request comes from and how to resolve it.
pub struct RunInput<'a> {
    pub text: &'a str,
    pub index: u32,
    /// The request file (`None` for an unsaved buffer).
    pub file: Option<&'a Path>,
    pub root: Option<&'a Path>,
    pub env: Option<&'a str>,
}

/// Prepares and sends request `index` of `text`. Preparation errors (bad
/// variables, missing includes) fail; transport errors are part of the exchange.
pub async fn run(input: RunInput<'_>, cancel: &CancellationToken) -> IdeResult<HttpExchange> {
    let request = prepare(&input)?;
    run_prepared(request, input.file, cancel).await
}

/// Executes a literal request from a visual client, without parsing file includes,
/// variable placeholders, scripts or request separators in its body.
pub async fn run_prepared(
    request: PreparedRequest,
    file: Option<&Path>,
    cancel: &CancellationToken,
) -> IdeResult<HttpExchange> {
    let time_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or_default();
    let result = exec::execute(&request, cancel).await;
    if let Err(e) = &result
        && e.kind == ide_core::error::ErrorKind::Cancelled
    {
        return Err(e.clone());
    }
    let (response, error) = match result {
        Ok(r) => (Some(r), None),
        Err(e) => (None, Some(e.message)),
    };
    Ok(HttpExchange {
        entry: HistoryEntry {
            id: uuid::Uuid::new_v4().simple().to_string(),
            time_ms,
            name: request.name.clone(),
            method: request.method.clone(),
            url: request.url.clone(),
            status: response.as_ref().map(|r| r.status),
            total_ms: response.as_ref().map(|r| r.total_ms),
            file: file.map(IpcPath::from),
            error,
        },
        request,
        response,
    })
}

/// Request `index` of `text` with its variables substituted and includes read.
pub fn prepare(input: &RunInput<'_>) -> IdeResult<PreparedRequest> {
    let parsed = parse::parse(input.text);
    let raw = parsed
        .requests
        .get(input.index as usize)
        .ok_or_else(|| IdeError::not_found(format!("no request #{}", input.index + 1)))?;
    let envs = Environments::load(input.file, input.root)?;
    exec::prepare(raw, &parsed.variables, &envs, input.env, input.file.and_then(Path::parent))
}

/// Convert to cURL and Copy: request `index` of `text`, resolved, as a cURL command.
pub fn curl(input: &RunInput<'_>) -> IdeResult<String> {
    prepare(input).map(|r| curl::to_curl(&r))
}

/// Environment names available to `file`.
pub fn environments(file: Option<&Path>, root: Option<&Path>) -> IdeResult<Vec<String>> {
    Ok(Environments::load(file, root)?.names())
}

#[cfg(test)]
mod prepared_tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn visual_request_bodies_are_sent_literally() {
        let private = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(private.path(), "PRIVATE FILE CONTENTS").unwrap();
        let body = format!(
            "\n< {}\n> response-script\n>> output\n<> script\n###foo\n{{{{literal}}}}\n中文\n\n",
            private.path().display()
        );
        let expected = body.clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/literal", listener.local_addr().unwrap());
        let received = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            loop {
                let mut buf = [0; 4096];
                let n = stream.read(&mut buf).await.unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&buf[..n]);
                if let Some(offset) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..offset]);
                    let length: usize = headers
                        .lines()
                        .find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length: ").map(str::to_owned))
                        .unwrap()
                        .parse()
                        .unwrap();
                    if bytes.len() >= offset + 4 + length {
                        let body = String::from_utf8(bytes[offset + 4..offset + 4 + length].to_vec()).unwrap();
                        stream
                            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                            .await
                            .unwrap();
                        break body;
                    }
                }
            }
        });
        let prepared = PreparedRequest {
            name: Some("Literal body".into()),
            method: "POST".into(),
            url,
            headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
            body: Some(body),
        };
        let exchange = run_prepared(prepared, None, &CancellationToken::new()).await.unwrap();
        assert_eq!(received.await.unwrap(), expected);
        assert_eq!(exchange.request.body.as_deref(), Some(expected.as_str()));
        assert_eq!(exchange.response.unwrap().status, 200);
        assert!(exchange.entry.file.is_none());
    }
}
