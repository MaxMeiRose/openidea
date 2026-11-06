//! Native project tabs keep independent IDE sessions in one fullscreen Space.
use crate::windows::{Launch, WindowsState};
use ide_core::{IdeError, IdeResult};
use ide_workspace::window_groups::{TabbingPreference, should_group_new_project};
use objc2::{
    MainThreadMarker,
    rc::Retained,
    runtime::{AnyClass, AnyObject, Imp, ProtocolObject, Sel},
};
use objc2_app_kit::{NSWindow, NSWindowOrderingMode, NSWindowUserTabbingPreference};
use objc2_foundation::{NSNotificationCenter, NSObjectProtocol, NSRect};
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
        let label = crate::windows::auxiliary_parent(w.label()).unwrap_or(w.label());
        windows.get(label).cloned()
    });
    let active = active.filter(|w| {
        let host = app.state::<crate::state::AppState>();
        host.project(w.label()).is_ok_and(|p| !p.light) || host.remote_dev.get(w.label()).is_some()
    });
    // A project-tab group is fullscreen through simple fullscreen, which the native flag misses.
    let fullscreen =
        active.as_ref().is_some_and(|w| w.is_fullscreen().unwrap_or(false) || is_simple_fullscreen(w.label()));
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

/// Windows in simple fullscreen. Grouped project windows take turns in one Space; simple
/// fullscreen covers the screen without a Space of its own, so switching projects is a plain
/// show/hide instead of leaving one fullscreen Space and entering another.
static SIMPLE_FULLSCREEN: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

pub fn is_simple_fullscreen(label: &str) -> bool {
    SIMPLE_FULLSCREEN.lock().unwrap().iter().any(|l| l == label)
}

pub fn set_simple_fullscreen(window: &WebviewWindow, on: bool) -> tauri::Result<()> {
    if !on {
        // Before the window goes back to its own frame.
        let target = window.clone();
        window.run_on_main_thread(move || keep_window_buttons(&target, false))?;
    }
    window.set_simple_fullscreen(on)?;
    let any = {
        let mut labels = SIMPLE_FULLSCREEN.lock().unwrap();
        labels.retain(|l| l != window.label());
        if on {
            labels.push(window.label().to_owned());
        }
        !labels.is_empty()
    };
    let target = window.clone();
    window.run_on_main_thread(move || {
        present(any);
        if on {
            keep_window_buttons(&target, true);
        }
    })
}

/// A window in simple fullscreen: its `NSWindow` and the minimum size restored when it leaves.
struct Covering {
    native: usize,
    min_size: objc2_foundation::NSSize,
}

thread_local! {
    static COVERING: std::cell::RefCell<std::collections::HashMap<String, Covering>> = std::cell::RefCell::default();
}

/// Simple fullscreen drops the title bar and resizing; ours is transparent over the web toolbar,
/// so keep it and its buttons, the green one (enabled only for a resizable window) leading back
/// out of fullscreen. A minimum size of the whole screen keeps the edges from being dragged.
/// A titled window is kept below the menu bar or camera housing; see `constrain_frame_rect`.
fn keep_window_buttons(window: &WebviewWindow, on: bool) {
    use objc2_app_kit::NSWindowStyleMask;
    let Ok(pointer) = window.ns_window() else { return };
    let native = unsafe { &*pointer.cast::<NSWindow>() };
    let label = window.label().to_owned();
    if !on {
        if let Some(covering) = COVERING.with_borrow_mut(|windows| windows.remove(&label)) {
            native.setMinSize(covering.min_size);
        }
        return;
    }
    let Some(screen) = native.screen() else { return };
    let frame = screen.frame();
    COVERING.with_borrow_mut(|windows| {
        windows.entry(label).or_insert_with(|| Covering { native: pointer as usize, min_size: native.minSize() });
    });
    native.setMinSize(frame.size);
    native.setStyleMask(native.styleMask() | NSWindowStyleMask::Titled | NSWindowStyleMask::Resizable);
    native.setFrame_display(frame, true);
}

/// Forgets a closed window; true when it was in simple fullscreen.
pub fn forget_simple_fullscreen(app: &AppHandle, label: &str) -> bool {
    let (was, any) = {
        let mut labels = SIMPLE_FULLSCREEN.lock().unwrap();
        let before = labels.len();
        labels.retain(|l| l != label);
        (labels.len() != before, !labels.is_empty())
    };
    if was {
        let label = label.to_owned();
        let _ = app.run_on_main_thread(move || {
            COVERING.with_borrow_mut(|windows| windows.remove(&label));
            present(any);
        });
    }
    was
}

/// Each window restores the presentation options it found on entering, which is wrong once
/// fullscreen has passed between windows; derive them from the windows in fullscreen instead.
fn present(fullscreen: bool) {
    use objc2_app_kit::{NSApplication, NSApplicationPresentationOptions};
    let Some(mtm) = MainThreadMarker::new() else { return };
    let options = if fullscreen {
        NSApplicationPresentationOptions::AutoHideDock | NSApplicationPresentationOptions::AutoHideMenuBar
    } else {
        NSApplicationPresentationOptions::Default
    };
    NSApplication::sharedApplication(mtm).setPresentationOptions(options);
}

type ToggleFullScreen = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject);

static NATIVE_TOGGLE_FULLSCREEN: std::sync::OnceLock<ToggleFullScreen> = std::sync::OnceLock::new();
static APP: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();

/// The green window button, the Globe-F shortcut and the system's Enter Full Screen item all
/// send `toggleFullScreen:`; a grouped window answers it with simple fullscreen instead.
pub fn intercept_toggle_fullscreen(window: &WebviewWindow) {
    let _ = APP.set(window.app_handle().clone());
    let _ = window.with_webview(|webview| unsafe {
        let class = objc2::ffi::object_getClass(webview.ns_window().cast()) as *mut AnyClass;
        let selector = objc2::sel!(toggleFullScreen:);
        if NATIVE_TOGGLE_FULLSCREEN.get().is_some() {
            return;
        }
        let Some(method) = (*class).instance_method(selector) else { return };
        let native: ToggleFullScreen = std::mem::transmute(method.implementation());
        let types = objc2::ffi::method_getTypeEncoding(method);
        let _ = NATIVE_TOGGLE_FULLSCREEN.set(native);
        let replacement: Imp = std::mem::transmute(toggle_fullscreen as ToggleFullScreen);
        objc2::ffi::class_replaceMethod(class, selector, replacement, types);

        let selector = objc2::sel!(constrainFrameRect:toScreen:);
        let Some(method) = (*class).instance_method(selector) else { return };
        let native: ConstrainFrameRect = std::mem::transmute(method.implementation());
        let types = objc2::ffi::method_getTypeEncoding(method);
        let _ = NATIVE_CONSTRAIN_FRAME_RECT.set(native);
        let replacement: Imp = std::mem::transmute(constrain_frame_rect as ConstrainFrameRect);
        objc2::ffi::class_replaceMethod(class, selector, replacement, types);
    });
}

type ConstrainFrameRect = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, NSRect, *mut AnyObject) -> NSRect;

static NATIVE_CONSTRAIN_FRAME_RECT: std::sync::OnceLock<ConstrainFrameRect> = std::sync::OnceLock::new();

/// AppKit keeps a titled window's top edge below the menu bar, and on a notched display below the
/// camera housing, whenever the window is placed, shown or resized. A window in simple fullscreen
/// is titled for its buttons but must still cover the whole screen.
unsafe extern "C-unwind" fn constrain_frame_rect(
    this: *mut AnyObject,
    selector: Sel,
    frame: NSRect,
    screen: *mut AnyObject,
) -> NSRect {
    if COVERING.with_borrow(|windows| windows.values().any(|covering| covering.native == this as usize)) {
        return frame;
    }
    match NATIVE_CONSTRAIN_FRAME_RECT.get() {
        Some(native) => unsafe { native(this, selector, frame, screen) },
        None => frame,
    }
}

unsafe extern "C-unwind" fn toggle_fullscreen(this: *mut AnyObject, selector: Sel, sender: *mut AnyObject) {
    if let Some(window) = APP.get().and_then(|app| simple_fullscreen_window(app, this)) {
        if let Err(error) = crate::window_groups::toggle_fullscreen(&window) {
            tracing::warn!(message = error.message, "cannot toggle fullscreen");
        }
        return;
    }
    if let Some(native) = NATIVE_TOGGLE_FULLSCREEN.get() {
        unsafe { native(this, selector, sender) };
    }
}

/// `native` as a grouped project window (or one still in simple fullscreen) that is not in
/// native fullscreen; one in native fullscreen leaves it the usual way.
fn simple_fullscreen_window(app: &AppHandle, native: *mut AnyObject) -> Option<WebviewWindow> {
    let mask: objc2_app_kit::NSWindowStyleMask = unsafe { objc2::msg_send![native, styleMask] };
    if mask.contains(objc2_app_kit::NSWindowStyleMask::FullScreen) {
        return None;
    }
    let window = app
        .webview_windows()
        .into_values()
        .find(|w| w.ns_window().is_ok_and(|pointer| pointer.cast::<AnyObject>() == native))?;
    let grouped = app.state::<WindowsState>().groups.lock().group(window.label()).is_some();
    (grouped || is_simple_fullscreen(window.label())).then_some(window)
}
