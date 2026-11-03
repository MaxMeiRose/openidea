//! Restore project/settings frames independently of the compact welcome window.
//! Role is checked on every event because the same WebView can open/close a project.
mod geometry;

use crate::windows;
use geometry::{Bounds, remember_normal};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use tauri::{AppHandle, Manager, Window, WindowEvent, plugin::TauriPlugin};

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Frame {
    width: u32,
    height: u32,
    x: i32,
    y: i32,
    #[serde(default)]
    prev_x: i32,
    #[serde(default)]
    prev_y: i32,
    maximized: bool,
    fullscreen: bool,
    #[serde(default = "yes")]
    visible: bool,
    #[serde(default = "yes")]
    decorated: bool,
}

fn yes() -> bool {
    true
}

impl Frame {
    fn bounds(&self) -> Bounds {
        let (x, y) = if self.maximized { (self.prev_x, self.prev_y) } else { (self.x, self.y) };
        Bounds { x, y, width: self.width, height: self.height }
    }
}

#[derive(Default)]
struct WindowFrames {
    frames: Mutex<HashMap<String, Frame>>,
    projects: Mutex<HashSet<String>>,
    restoring: Mutex<HashSet<String>>,
    grouped_launches: Mutex<HashSet<String>>,
    pending_modes: Mutex<HashMap<String, (bool, bool)>>,
}

fn key(window: &Window) -> Option<&str> {
    if windows::is_settings_window(window.label()) {
        Some("settings")
    } else if windows::is_welcome_window(window.app_handle(), window.label()) {
        None
    } else {
        Some(window.label())
    }
}

/// Native tabs take their frame from AppKit's containing window. A launch can
/// finish loading either before or after it has joined the native group.
fn group_owns_frame(window: &Window) -> bool {
    window.state::<WindowFrames>().grouped_launches.lock().contains(window.label())
        || window.state::<windows::WindowsState>().groups.lock().group(window.label()).is_some()
}

fn remember(window: &Window) -> tauri::Result<()> {
    let state = window.state::<WindowFrames>();
    if state.restoring.lock().contains(window.label()) {
        return Ok(());
    }
    let Some(key) = key(window) else { return Ok(()) };
    // Inactive AppKit tabs can report their own old frame/style mask. Persist the group's
    // selected frame for every member so restarting a group keeps its fullscreen state.
    let selected =
        window.state::<windows::WindowsState>().groups.lock().group(window.label()).map(|group| group.selected.clone());
    let observed_window = selected
        .and_then(|label| window.app_handle().get_webview_window(&label))
        .map(|window| window.as_ref().window())
        .unwrap_or_else(|| window.clone());
    let fullscreen = observed_window.is_fullscreen()?;
    let maximized = observed_window.is_maximized()?;
    let minimized = observed_window.is_minimized()?;
    let position = observed_window.outer_position()?;
    let size = observed_window.inner_size()?;
    let observed = Bounds { x: position.x, y: position.y, width: size.width, height: size.height };
    let mut frames = state.frames.lock();
    let old = frames.get(key);
    let Some(bounds) = remember_normal(old.map(Frame::bounds), observed, fullscreen || maximized || minimized) else {
        return Ok(());
    };
    let maximized = if fullscreen { old.is_some_and(|f| f.maximized) } else { maximized };
    frames.insert(
        key.to_owned(),
        Frame {
            width: bounds.width,
            height: bounds.height,
            x: bounds.x,
            y: bounds.y,
            prev_x: bounds.x,
            prev_y: bounds.y,
            maximized,
            fullscreen,
            visible: true,
            decorated: true,
        },
    );
    Ok(())
}

fn restore(window: &Window) -> tauri::Result<()> {
    if group_owns_frame(window) {
        return Ok(());
    }
    let Some(key) = key(window) else { return Ok(()) };
    let state = window.state::<WindowFrames>();
    let frame = state.frames.lock().get(key).cloned();
    let Some(frame) = frame.filter(|f| f.width > 0 && f.height > 0) else { return remember(window) };
    let settings = windows::is_settings_window(window.label());
    if !settings {
        // Project groups must be complete before any member starts the native Space animation.
        state.pending_modes.lock().insert(window.label().to_owned(), (frame.maximized, frame.fullscreen));
    }
    state.restoring.lock().insert(window.label().to_owned());
    let result = (|| {
        window.set_size(tauri::PhysicalSize::new(frame.width, frame.height))?;
        let on_screen = window.available_monitors()?.iter().any(|monitor| {
            let area = monitor.work_area();
            i64::from(frame.x) < i64::from(area.position.x) + i64::from(area.size.width)
                && i64::from(frame.x) + i64::from(frame.width) > i64::from(area.position.x)
                && i64::from(frame.y) < i64::from(area.position.y) + i64::from(area.size.height)
                && i64::from(frame.y) + i64::from(frame.height) > i64::from(area.position.y)
        });
        if on_screen {
            window.set_position(tauri::PhysicalPosition::new(frame.x, frame.y))?;
        } else {
            window.center()?;
        }
        if frame.maximized && settings {
            window.maximize()?;
        }
        if frame.fullscreen && settings {
            window.set_fullscreen(true)?;
        }
        Ok(())
    })();
    state.restoring.lock().remove(window.label());
    result
}

/// A restored/new group member takes the anchor's native frame, including its fullscreen Space.
pub fn group_launch(app: &AppHandle, label: &str) {
    app.state::<WindowFrames>().grouped_launches.lock().insert(label.to_owned());
}

pub fn group_launched(app: &AppHandle, label: &str) {
    app.state::<WindowFrames>().grouped_launches.lock().remove(label);
}

/// The frontend calls this after the startup launch and saved group have both been restored.
pub fn finish_project_restore(window: &Window) -> tauri::Result<()> {
    let app = window.app_handle();
    let state = app.state::<WindowFrames>();
    let group = app.state::<windows::WindowsState>().groups.lock().group(window.label()).cloned();
    let target = if let Some(group) = &group {
        // Secondary launches join the already presented group; only main restores its saved mode.
        if window.label() != "main" {
            state.pending_modes.lock().remove(window.label());
            state.grouped_launches.lock().remove(window.label());
            return Ok(());
        }
        app.get_webview_window(&group.selected).map(|window| window.as_ref().window()).unwrap_or_else(|| window.clone())
    } else {
        if state.grouped_launches.lock().contains(window.label()) {
            return Ok(());
        }
        window.clone()
    };
    let mode = {
        let mut modes = state.pending_modes.lock();
        let mode = modes.remove(target.label()).or_else(|| modes.remove(window.label()));
        if let Some(group) = group {
            for label in &group.members {
                modes.remove(label);
                state.grouped_launches.lock().remove(label);
            }
        }
        mode
    };
    if let Some((maximized, fullscreen)) = mode {
        if fullscreen {
            if !target.is_fullscreen()? {
                target.set_fullscreen(true)?;
            }
        } else if maximized && !target.is_maximized()? {
            target.maximize()?;
        }
    }
    Ok(())
}

fn save(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let directory = app.path().app_config_dir()?;
    std::fs::create_dir_all(&directory)?;
    let state = app.state::<WindowFrames>();
    let bytes = serde_json::to_vec_pretty(&*state.frames.lock())?;
    ide_vfs::write_atomic(&directory.join(tauri_plugin_window_state::DEFAULT_FILENAME), &bytes)?;
    Ok(())
}

/// Called after a welcome WebView successfully opens a local/remote project or loose file.
pub fn project_opened(window: &Window) -> tauri::Result<()> {
    let state = window.state::<WindowFrames>();
    if !state.projects.lock().insert(window.label().to_owned()) {
        return Ok(());
    }
    if group_owns_frame(window) {
        // Resizing/centring a newly joined fullscreen tab leaves its content at
        // the normal IDE size inside the fullscreen Space, surrounded by black.
        state.pending_modes.lock().remove(window.label());
        tracing::debug!(window = window.label(), "native tab group owns project frame");
        return Ok(());
    }
    state.restoring.lock().insert(window.label().to_owned());
    let result = windows::fit_project_window(window).and_then(|()| restore(window));
    state.restoring.lock().remove(window.label());
    result
}

/// Snapshot while it still belongs to the project, before its role/geometry changes.
pub fn project_closing(window: &Window) {
    save_window(window);
    window.state::<WindowFrames>().projects.lock().remove(window.label());
    window.state::<WindowFrames>().pending_modes.lock().remove(window.label());
}

fn save_window(window: &Window) {
    if let Err(error) = remember(window) {
        tracing::warn!("cannot remember project window: {error}");
    }
    if let Err(error) = save(window.app_handle()) {
        tracing::warn!("cannot save project window: {error}");
    }
}

pub fn plugin() -> TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("macos-window-state")
        .setup(|app, _| {
            let frames = app
                .path()
                .app_config_dir()
                .ok()
                .and_then(|dir| std::fs::read(dir.join(tauri_plugin_window_state::DEFAULT_FILENAME)).ok())
                .and_then(|bytes| serde_json::from_slice(&bytes).ok())
                .unwrap_or_default();
            app.manage(WindowFrames { frames: Mutex::new(frames), ..Default::default() });
            Ok(())
        })
        .on_window_ready(|window| {
            if key(&window).is_some() {
                if !windows::is_settings_window(window.label()) {
                    window.state::<WindowFrames>().projects.lock().insert(window.label().to_owned());
                }
                if let Err(error) = restore(&window) {
                    tracing::warn!("cannot restore window: {error}");
                }
            }
            let observed = window.clone();
            window.on_window_event(move |event| match event {
                WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                    if let Err(error) = remember(&observed) {
                        tracing::warn!("cannot remember window: {error}");
                    }
                }
                WindowEvent::CloseRequested { .. } => save_window(&observed),
                WindowEvent::Destroyed => {
                    let state = observed.state::<WindowFrames>();
                    state.projects.lock().remove(observed.label());
                    state.pending_modes.lock().remove(observed.label());
                    state.grouped_launches.lock().remove(observed.label());
                    state.restoring.lock().remove(observed.label());
                }
                _ => {}
            });
        })
        .on_event(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                for window in app.webview_windows().values() {
                    let _ = remember(&window.as_ref().window());
                }
                if let Err(error) = save(app) {
                    tracing::warn!("cannot save window state: {error}");
                }
            }
        })
        .build()
}
