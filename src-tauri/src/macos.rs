//! Native project tabs keep independent IDE sessions in one fullscreen Space.
use crate::windows::{Launch, WindowsState};
use ide_core::{IdeError, IdeResult};
use ide_workspace::window_groups::{TabbingPreference, should_group_new_project};
use objc2::{MainThreadMarker, rc::Retained, runtime::ProtocolObject};
use objc2_app_kit::{NSWindow, NSWindowOrderingMode, NSWindowUserTabbingPreference};
use objc2_foundation::{NSNotificationCenter, NSObjectProtocol};
use tauri::{AppHandle, Manager, WebviewWindow};

fn on_main<T: Send + 'static>(
    app: &AppHandle,
    action: impl FnOnce(MainThreadMarker) -> IdeResult<T> + Send + 'static,
) -> IdeResult<T> {
    if let Some(mtm) = MainThreadMarker::new() {
        return action(mtm);
    }
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let _ = tx.send(action(MainThreadMarker::new().expect("AppKit main thread")));
    })
    .map_err(|e| IdeError::internal(e.to_string()))?;
    rx.recv().map_err(|e| IdeError::internal(e.to_string()))?
}

thread_local! {
    static GROUP_MUTATION: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

struct GroupMutation(bool);

impl GroupMutation {
    fn new() -> Self {
        Self(GROUP_MUTATION.with(|current| current.replace(true)))
    }
}

impl Drop for GroupMutation {
    fn drop(&mut self) {
        GROUP_MUTATION.with(|current| current.set(self.0));
    }
}

pub fn group_mutating() -> bool {
    GROUP_MUTATION.with(std::cell::Cell::get)
}

/// Read AppKit's order after native tab dragging or detaching.
pub fn native_group_members(app: &AppHandle, members: &[String], caller: &str) -> IdeResult<Vec<String>> {
    let windows = members.iter().filter_map(|label| app.get_webview_window(label)).collect::<Vec<_>>();
    let caller = caller.to_owned();
    on_main(app, move |mtm| {
        let natives = windows.iter().map(|w| native_window(w, mtm)).collect::<IdeResult<Vec<_>>>()?;
        let index =
            windows.iter().position(|w| w.label() == caller).ok_or_else(|| IdeError::not_found("Window closed"))?;
        let Some(group) = natives[index].tabGroup() else { return Ok(vec![caller]) };
        Ok(group
            .windows()
            .iter()
            .filter_map(|native| {
                natives
                    .iter()
                    .position(|candidate| std::ptr::eq::<NSWindow>(native.as_ref(), candidate.as_ref()))
                    .map(|index| windows[index].label().to_owned())
            })
            .collect())
    })
}

fn native_window(window: &WebviewWindow, _mtm: MainThreadMarker) -> IdeResult<Retained<NSWindow>> {
    let pointer = window.ns_window().map_err(|e| IdeError::internal(e.to_string()))?;
    // Retain only on the AppKit thread, while the owning WebviewWindow is alive.
    unsafe { Retained::retain(pointer.cast::<NSWindow>()) }.ok_or_else(|| IdeError::not_found("Window closed"))
}

/// AppKit switches the selected native tab without exiting or re-entering fullscreen.
/// Never order out the other members: AppKit removes ordered-out windows from their tab group.
pub fn select_window_group(app: &AppHandle, members: &[String], anchor: &str, target: &str) -> IdeResult<()> {
    let windows = members
        .iter()
        .map(|label| app.get_webview_window(label).ok_or_else(|| IdeError::not_found("Window closed")))
        .collect::<IdeResult<Vec<_>>>()?;
    let anchor = anchor.to_owned();
    let target = target.to_owned();
    on_main(app, move |mtm| {
        let _mutation = GroupMutation::new();
        let natives = windows.iter().map(|w| native_window(w, mtm)).collect::<IdeResult<Vec<_>>>()?;
        let anchor = windows.iter().position(|w| w.label() == anchor).unwrap_or(0);
        let selected =
            windows.iter().position(|w| w.label() == target).ok_or_else(|| IdeError::not_found("Window closed"))?;
        // `tabGroup` is nil for independent windows. The explicit window-tabbing API creates it;
        // asking for the property alone does not create a group.
        if natives[anchor].tabGroup().is_none() {
            let other = (anchor + 1) % natives.len();
            natives[anchor].addTabbedWindow_ordered(&natives[other], NSWindowOrderingMode::Above);
        }
        let group = natives[anchor].tabGroup().ok_or_else(|| IdeError::internal("Window cannot be tabbed"))?;
        for native in &natives {
            if !group.windows().containsObject(native) {
                group.addWindow(native);
            }
        }
        // AppKit owns the tab order. Re-inserting an existing member can change
        // `windows` without updating its tab cells, swapping labels and content.
        // Read the native order back into the model instead of re-inserting tabs.
        group.setSelectedWindow(Some(&natives[selected]));
        if natives[selected].isMiniaturized() {
            natives[selected].deminiaturize(None);
        }
        natives[selected].makeKeyAndOrderFront(None);
        tracing::info!(
            target = %target,
            members = natives.len(),
            visible = natives[selected].isVisible(),
            fullscreen = natives[selected].styleMask().contains(objc2_app_kit::NSWindowStyleMask::FullScreen),
            "selected native project tab"
        );
        Ok(())
    })
}

pub fn detach_window(window: &WebviewWindow) -> IdeResult<()> {
    let app = window.app_handle().clone();
    let window = window.clone();
    on_main(&app, move |mtm| {
        let _mutation = GroupMutation::new();
        let native = native_window(&window, mtm)?;
        if let Some(group) = native.tabGroup()
            && group.windows().count() > 1
        {
            group.removeWindow(&native);
            if group.windows().count() == 1
                && group.isTabBarVisible()
                && let Some(selected) = group.selectedWindow()
            {
                selected.toggleTabBar(None);
            }
        }
        if native.tabGroup().is_some_and(|g| g.isTabBarVisible()) {
            native.toggleTabBar(None);
        }
        Ok(())
    })
}

fn tabbing_preference(app: &AppHandle) -> IdeResult<TabbingPreference> {
    fn read(mtm: MainThreadMarker) -> TabbingPreference {
        match NSWindow::userTabbingPreference(mtm) {
            NSWindowUserTabbingPreference::Always => TabbingPreference::Always,
            NSWindowUserTabbingPreference::InFullScreen => TabbingPreference::InFullScreen,
            _ => TabbingPreference::Manually,
        }
    }
    if let Some(mtm) = MainThreadMarker::new() {
        return Ok(read(mtm));
    }
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let _ = tx.send(read(MainThreadMarker::new().expect("AppKit main thread")));
    })
    .map_err(|e| IdeError::internal(e.to_string()))?;
    rx.recv().map_err(|e| IdeError::internal(e.to_string()))
}

/// Capture before building the new window, which takes focus itself.
pub fn new_project_tab_target(app: &AppHandle, launch: &Launch) -> IdeResult<Option<WebviewWindow>> {
    let windows = app.webview_windows();
    let active = windows
        .values()
        .find(|w| w.is_focused().unwrap_or(false))
        .cloned()
        .or_else(|| app.state::<WindowsState>().last_focused().and_then(|label| windows.get(&label).cloned()));
    let active = active.and_then(|w| {
        let label = crate::windows::settings_parent(w.label()).unwrap_or(w.label());
        windows.get(label).cloned()
    });
    let active = active.filter(|w| {
        let host = app.state::<crate::state::AppState>();
        host.project(w.label()).is_ok_and(|p| !p.light) || host.remote_dev.get(w.label()).is_some()
    });
    let fullscreen = active.as_ref().is_some_and(|w| w.is_fullscreen().unwrap_or(false));
    let light_edit = launch.project.is_none() && launch.remote.is_none();
    Ok(should_group_new_project(tabbing_preference(app)?, fullscreen, active.is_some(), light_edit)
        .then_some(active)
        .flatten())
}

struct FullscreenObserver(Retained<ProtocolObject<dyn NSObjectProtocol>>);

impl Drop for FullscreenObserver {
    fn drop(&mut self) {
        let observer: &ProtocolObject<dyn NSObjectProtocol> = &self.0;
        unsafe { NSNotificationCenter::defaultCenter().removeObserver(observer.as_ref()) };
    }
}

thread_local! {
    static FULLSCREEN_EXITS: std::cell::RefCell<std::collections::HashMap<String, FullscreenObserver>> = std::cell::RefCell::default();
}

pub fn forget_fullscreen(label: &str) {
    FULLSCREEN_EXITS.with_borrow_mut(|observers| observers.remove(label));
}

/// Fit the welcome window after AppKit has finished restoring the normal frame.
pub fn leave_fullscreen_for_welcome(window: &WebviewWindow) -> tauri::Result<()> {
    let window = window.clone();
    window.clone().with_webview(move |webview| unsafe {
        let native = &*webview.ns_window().cast::<NSWindow>();
        forget_fullscreen(window.label());
        let source = window.label().to_owned();
        let label = source.clone();
        let block = block2::RcBlock::new(move |_| {
            forget_fullscreen(&label);
            if crate::windows::is_welcome_window(window.app_handle(), window.label())
                && let Err(error) = crate::windows::fit_welcome_window(&window)
            {
                tracing::warn!("cannot fit welcome window: {}", error.message);
            }
        });
        let observer = NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
            Some(objc2_app_kit::NSWindowDidExitFullScreenNotification),
            Some(native),
            None,
            &block,
        );
        FULLSCREEN_EXITS.with_borrow_mut(|observers| {
            observers.insert(source, FullscreenObserver(observer));
        });
        native.toggleFullScreen(None);
    })
}
