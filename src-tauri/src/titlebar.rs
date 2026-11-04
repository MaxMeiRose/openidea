//! Keep the native window buttons aligned with the web toolbar, in AppKit points.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use block2::RcBlock;
use objc2_app_kit::{NSWindow, NSWindowButton, NSWindowStyleMask};
use objc2_core_foundation::{
    CFIndex, CFOptionFlags, CFRetained, CFRunLoop, CFRunLoopActivity, CFRunLoopObserver, kCFRunLoopCommonModes,
};
use objc2_foundation::NSPoint;
use tauri::{Emitter, Manager};

const NATIVE_TOP_INSET: &str = "openidea://native-top-inset";

/// AppKit lays out the title bar in a run loop observer and puts the buttons back at their
/// defaults on resize, title changes and fullscreen exit. Core Animation commits at 2000000, so
/// correcting the frames just before it keeps AppKit's positions off screen.
const BEFORE_COMMIT: CFIndex = 1_999_999;

struct Titlebar {
    height: Rc<Cell<f64>>,
    spacing: Rc<Cell<Option<f64>>>,
    observer: CFRetained<CFRunLoopObserver>,
    inset: Rc<Cell<f64>>,
}

impl Drop for Titlebar {
    fn drop(&mut self) {
        self.observer.invalidate();
    }
}

thread_local! {
    static TITLEBARS: RefCell<HashMap<String, Titlebar>> = RefCell::default();
}

pub fn set_height(window: &tauri::WebviewWindow, height: f64) -> tauri::Result<()> {
    let label = window.label().to_owned();
    let app = window.app_handle().clone();
    // with_webview runs on the AppKit thread; the observer is also delivered there.
    window.with_webview(move |webview| unsafe {
        let native = &*webview.ns_window().cast::<NSWindow>();
        let Some(run_loop) = CFRunLoop::main() else { return };
        TITLEBARS.with_borrow_mut(|bars| {
            if let Some(bar) = bars.get(&label) {
                bar.height.set(height);
                center_buttons(native, height, &bar.spacing);
                publish_inset(&app, &label, native, &bar.inset, true);
                return;
            }
            let shared = Rc::new(Cell::new(height));
            let current = shared.clone();
            // Fullscreen tabs may not have traffic-light buttons yet. Observe the
            // inset anyway and measure their spacing when they become available.
            let spacing = Rc::new(Cell::new(None));
            let current_spacing = spacing.clone();
            let inset = Rc::new(Cell::new(-1.0));
            let current_inset = inset.clone();
            let current_app = app.clone();
            let current_label = label.clone();
            let pointer = native as *const NSWindow;
            let block = RcBlock::new(move |_: *mut CFRunLoopObserver, _: CFRunLoopActivity| {
                center_buttons(&*pointer, current.get(), &current_spacing);
                publish_inset(&current_app, &current_label, &*pointer, &current_inset, false);
            });
            let activities = CFRunLoopActivity::BeforeWaiting.0 as CFOptionFlags;
            let Some(observer) = CFRunLoopObserver::with_handler(None, activities, true, BEFORE_COMMIT, Some(&block))
            else {
                return;
            };
            run_loop.add_observer(Some(&observer), kCFRunLoopCommonModes);
            center_buttons(native, height, &spacing);
            publish_inset(&app, &label, native, &inset, true);
            bars.insert(label, Titlebar { height: shared, spacing, observer, inset });
        });
    })
}

fn publish_inset(app: &tauri::AppHandle, label: &str, window: &NSWindow, previous: &Cell<f64>, force: bool) {
    // Native AppKit tabs occupy chrome above the web toolbar. contentLayoutRect is the
    // public, KVO-compliant unobscured area, including changes during fullscreen transitions.
    let inset = if window.tabGroup().is_some_and(|group| group.isTabBarVisible()) {
        window.contentView().map_or(0.0, |view| {
            let bounds = view.bounds();
            let layout = window.contentLayoutRect();
            (bounds.origin.y + bounds.size.height - layout.origin.y - layout.size.height).max(0.0)
        })
    } else {
        0.0
    };
    if force || (previous.get() - inset).abs() > 0.01 {
        previous.set(inset);
        // `with_webview` still holds Wry's dispatcher window-id lock. Emitting
        // JavaScript synchronously here would try to acquire that same lock.
        // A run-loop block keeps delivery ordered and waits for the callback to return.
        let app = app.clone();
        let label = label.to_owned();
        let block = RcBlock::new(move || {
            let _ = app.emit_to(&label, NATIVE_TOP_INSET, inset);
        });
        if let Some(run_loop) = CFRunLoop::main() {
            unsafe {
                run_loop.perform_block(kCFRunLoopCommonModes.map(|mode| mode.as_ref()), Some(&block));
            }
            run_loop.wake_up();
        }
    }
}

pub fn forget(window: &tauri::Window) {
    let label = window.label().to_owned();
    let _ = window.run_on_main_thread(move || {
        TITLEBARS.with_borrow_mut(|bars| bars.remove(&label));
    });
}

unsafe fn center_buttons(window: &NSWindow, height: f64, spacing: &Cell<Option<f64>>) {
    // Fullscreen and native project tabs use AppKit's own window chrome.
    if window.styleMask().contains(NSWindowStyleMask::FullScreen)
        || window.tabGroup().is_some_and(|group| group.isTabBarVisible())
    {
        return;
    }
    let Some(close) = window.standardWindowButton(NSWindowButton::CloseButton) else { return };
    let Some(minimize) = window.standardWindowButton(NSWindowButton::MiniaturizeButton) else { return };
    let spacing = match spacing.get() {
        Some(spacing) => spacing,
        None => {
            let measured = minimize.frame().origin.x - close.frame().origin.x;
            if !measured.is_finite() || measured < 1.0 {
                return;
            }
            spacing.set(Some(measured));
            measured
        }
    };
    let Some(container) = (unsafe { close.superview().and_then(|view| view.superview()) }) else { return };
    let Some(content) = window.contentView() else { return };
    let mut frame = container.frame();
    let top = frame.origin.y + frame.size.height;
    if (frame.size.height - height).abs() > 0.01 {
        frame.size.height = height;
        frame.origin.y = top - height;
        container.setFrame(frame);
    }
    let bounds = content.bounds();
    let y = bounds.origin.y + if content.isFlipped() { height / 2.0 } else { bounds.size.height - height / 2.0 };
    for (index, kind) in [NSWindowButton::CloseButton, NSWindowButton::MiniaturizeButton, NSWindowButton::ZoomButton]
        .into_iter()
        .enumerate()
    {
        let Some(button) = window.standardWindowButton(kind) else { continue };
        let Some(parent) = (unsafe { button.superview() }) else { continue };
        let center = parent.convertPoint_fromView(NSPoint::new(0.0, y), Some(&content));
        let frame = button.frame();
        let x = 14.0 + index as f64 * spacing;
        let target = center.y - frame.size.height / 2.0;
        if (frame.origin.x - x).abs() > 0.01 || (frame.origin.y - target).abs() > 0.01 {
            button.setFrameOrigin(NSPoint::new(x, target));
        }
    }
}
