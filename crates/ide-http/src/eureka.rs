//! The Eureka management gateway used by the Services view.

use ide_core::{CancellationToken, IdeError, IdeResult, error::ErrorKind};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(15);
const MAX_RESPONSE: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EurekaInstance {
    pub instance_id: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct EurekaService {
    pub name: String,
    #[serde(deserialize_with = "instances")]
    #[specta(type = Vec<EurekaInstance>)]
    pub instance: Vec<EurekaInstance>,
}

fn instances<'de, D: serde::Deserializer<'de>>(de: D) -> Result<Vec<EurekaInstance>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum OneOrMany {
        Many(Vec<EurekaInstance>),
        One(EurekaInstance),
    }
    Ok(match OneOrMany::deserialize(de)? {
        OneOrMany::Many(v) => v,
        OneOrMany::One(v) => vec![v],
    })
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
pub enum EurekaStatus {
    UP,
    DOWN,
}

fn endpoint(base: &str, path: &str) -> IdeResult<reqwest::Url> {
    let base = base.trim();
    let base = if base.contains("://") { base.to_owned() } else { format!("http://{base}") };
    let mut url = reqwest::Url::parse(&base).map_err(|_| IdeError::invalid("Invalid Eureka server address"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(IdeError::invalid("Use an HTTP or HTTPS server address without credentials, query or fragment"));
    }
    url.set_path(&format!("{}{path}", url.path().trim_end_matches('/')));
    Ok(url)
}

async fn send(request: reqwest::RequestBuilder, cancel: &CancellationToken) -> IdeResult<Vec<u8>> {
    let work = async {
        let mut response = request
            .header(reqwest::header::ACCEPT, "application/json")
            .timeout(TIMEOUT)
            .send()
            .await
            .map_err(|e| IdeError::new(ErrorKind::Io, crate::client::describe(&e)))?;
        let status = response.status();
        if !status.is_success() {
            return Err(IdeError::new(ErrorKind::Io, format!("Eureka gateway returned HTTP {status}")));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) =
            response.chunk().await.map_err(|e| IdeError::new(ErrorKind::Io, crate::client::describe(&e)))?
        {
            if bytes.len() + chunk.len() > MAX_RESPONSE {
                return Err(IdeError::invalid("Eureka response is too large (maximum 8 MiB)"));
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    };
    tokio::select! {
        result = work => result,
        () = cancel.cancelled() => Err(IdeError::cancelled()),
    }
}

pub async fn services(base: &str, cancel: &CancellationToken) -> IdeResult<Vec<EurekaService>> {
    let url = endpoint(base, "/eureka/services")?;
    let bytes = send(crate::client::shared()?.get(url), cancel).await?;
    let mut services: Vec<EurekaService> =
        serde_json::from_slice(&bytes).map_err(|e| IdeError::invalid(format!("Invalid Eureka service list: {e}")))?;
    services.sort_by(|a, b| a.name.cmp(&b.name));
    for service in &mut services {
        service.instance.sort_by(|a, b| a.instance_id.cmp(&b.instance_id));
    }
    Ok(services)
}

pub async fn set_status(
    base: &str,
    service: &str,
    instance: &str,
    status: EurekaStatus,
    cancel: &CancellationToken,
) -> IdeResult<()> {
    if service.trim().is_empty() || instance.trim().is_empty() {
        return Err(IdeError::invalid("Service name and instance ID are required"));
    }
    let mut url = endpoint(base, "/eureka/server/update")?;
    url.query_pairs_mut().append_pair("serverName", service).append_pair("instance", instance).append_pair(
        "status",
        match status {
            EurekaStatus::UP => "UP",
            EurekaStatus::DOWN => "DOWN",
        },
    );
    let bytes = send(crate::client::shared()?.put(url), cancel).await?;
    // Gateways may return an empty body, a plain message, or a JSON result.
    if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes)
        && (value == false || value.get("success").and_then(|v| v.as_bool()) == Some(false))
    {
        return Err(IdeError::new(ErrorKind::Io, "Eureka gateway rejected the status update"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn server(body: &'static str, status: u16) -> (String, tokio::task::JoinHandle<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            loop {
                let mut buf = [0; 1024];
                let n = stream.read(&mut buf).await.unwrap();
                if n == 0 {
                    break;
                }
                request.extend_from_slice(&buf[..n]);
                if request.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            let response =
                format!("HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            stream.write_all(response.as_bytes()).await.unwrap();
            String::from_utf8(request).unwrap()
        });
        (url, task)
    }

    #[test]
    fn preserves_gateway_prefix_and_rejects_non_http_addresses() {
        assert_eq!(
            endpoint(" host:32044/gateway/ ", "/eureka/services").unwrap().as_str(),
            "http://host:32044/gateway/eureka/services"
        );
        for base in ["file:///tmp/file", "http://user:secret@host", "http://host/?other=1", "http://host/#fragment"] {
            assert!(endpoint(base, "/eureka/services").is_err(), "{base}");
        }
    }

    #[tokio::test]
    async fn reads_gateway_services_and_singleton_instances() {
        let (url, task) = server(
            r#"[{"name":"B","instance":[]},{"name":"A","instance":{"instanceId":"host:app:80","status":"UP"}}]"#,
            200,
        )
        .await;
        let list = services(&url, &CancellationToken::new()).await.unwrap();
        assert_eq!(list[0].name, "A");
        assert_eq!(list[0].instance[0].instance_id, "host:app:80");
        assert!(task.await.unwrap().starts_with("GET /eureka/services HTTP/1.1\r\n"));
    }

    #[tokio::test]
    async fn encodes_status_update_identifiers_without_changing_the_query() {
        let (url, task) = server("", 204).await;
        set_status(&url, "APP & A", "host:app:80/x?foo=1&status=UP", EurekaStatus::DOWN, &CancellationToken::new())
            .await
            .unwrap();
        let request = task.await.unwrap();
        let path = request.split_whitespace().nth(1).unwrap();
        assert!(request.starts_with("PUT "));
        let url = reqwest::Url::parse(&format!("http://host{path}")).unwrap();
        let query: Vec<_> = url.query_pairs().collect();
        assert_eq!(
            query,
            [
                ("serverName".into(), "APP & A".into()),
                ("instance".into(), "host:app:80/x?foo=1&status=UP".into()),
                ("status".into(), "DOWN".into())
            ]
        );
    }

    #[tokio::test]
    async fn reports_http_and_gateway_failures() {
        let (url, task) = server("unavailable", 503).await;
        assert!(services(&url, &CancellationToken::new()).await.unwrap_err().message.contains("503"));
        task.await.unwrap();
        let (url, task) = server(r#"{"success":false}"#, 200).await;
        assert!(set_status(&url, "APP", "instance", EurekaStatus::UP, &CancellationToken::new()).await.is_err());
        task.await.unwrap();
    }

    #[tokio::test]
    async fn cancellation_stops_a_pending_response() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let cancel = CancellationToken::new();
        let request = services(&url, &cancel);
        let stop = async {
            tokio::task::yield_now().await;
            cancel.cancel();
        };
        let (result, ()) = tokio::join!(request, stop);
        assert_eq!(result.unwrap_err().kind, ErrorKind::Cancelled);
    }
}
