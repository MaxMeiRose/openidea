use crate::state::AppState;
use ide_command::desktop_command;
use ide_core::{IdeResult, RequestId};
use ide_http::{HttpExchange, HttpRequestBlock};
use tauri::{State, Window};

/// The requests of an `.http` file (gutter run icons, Run All).
#[desktop_command(trust = trusted)]
#[tauri::command]
#[specta::specta]
pub fn http_requests(text: String) -> Vec<HttpRequestBlock> {
    ide_http::parse::requests(&text)
}

/// System Settings › HTTP Proxy › Check connection: GETs `url` through `proxy` as
/// edited (not yet applied); the response status, or why there was none.
#[desktop_command(trust = always)]
#[tauri::command]
#[specta::specta]
pub async fn proxy_check_connection(proxy: ide_core::settings::ProxySettings, url: String) -> IdeResult<String> {
    ide_http::client::check_connection(&proxy, &url, &ide_core::CancellationToken::new()).await
}

/// A pasted `curl …` command as `.http` request text; `None` when it isn't one.
#[desktop_command(trust = trusted)]
#[tauri::command]
#[specta::specta]
pub fn http_from_curl(command: String) -> Option<String> {
    ide_http::curl::from_curl(&command)
}

/// Sends a literal request from API Client; the body is never interpreted as .http syntax.
#[desktop_command(trust = trusted)]
#[tauri::command]
#[specta::specta]
pub async fn http_execute_raw(
    window: Window,
    state: State<'_, AppState>,
    request: RequestId,
    prepared: ide_http::PreparedRequest,
) -> IdeResult<HttpExchange> {
    let project = state.project(window.label())?;
    let cancel = state.begin_request(request);
    let result = ide_http::send(prepared, None, &cancel).await;
    state.end_request(request);
    let exchange = result?;
    let history = project.http_history.clone();
    let saved = exchange.clone();
    // Complete the history write before exposing the exchange to a history refresh.
    match tauri::async_runtime::spawn_blocking(move || history.add(&saved)).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => tracing::warn!("http history: {}", error.message),
        Err(error) => tracing::warn!("http history: {error}"),
    }
    Ok(exchange)
}

/// Reads the selected Eureka management gateway without browser CORS restrictions.
#[desktop_command(trust = trusted)]
#[tauri::command]
#[specta::specta]
pub async fn eureka_services(
    state: State<'_, AppState>,
    request: RequestId,
    base_url: String,
) -> IdeResult<Vec<ide_http::eureka::EurekaService>> {
    let cancel = state.begin_request(request);
    let result = ide_http::eureka::services(&base_url, &cancel).await;
    state.end_request(request);
    result
}

#[desktop_command(trust = trusted)]
#[tauri::command]
#[specta::specta]
pub async fn eureka_set_status(
    state: State<'_, AppState>,
    request: RequestId,
    base_url: String,
    service: String,
    instance: String,
    status: ide_http::eureka::EurekaStatus,
) -> IdeResult<()> {
    let cancel = state.begin_request(request);
    let result = ide_http::eureka::set_status(&base_url, &service, &instance, status, &cancel).await;
    state.end_request(request);
    result
}

ide_command::desktop_domain!(
    eureka_services,
    eureka_set_status,
    http_execute_raw,
    http_from_curl,
    http_requests,
    proxy_check_connection,
);
