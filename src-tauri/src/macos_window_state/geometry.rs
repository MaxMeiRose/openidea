//! Keep the normal frame while AppKit reports fullscreen/maximized screen bounds.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Bounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

pub(super) fn remember_normal(previous: Option<Bounds>, observed: Bounds, expanded: bool) -> Option<Bounds> {
    if expanded || observed.width == 0 || observed.height == 0 { previous } else { Some(observed) }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NORMAL: Bounds = Bounds { x: 120, y: 80, width: 1800, height: 1280 };
    const SCREEN: Bounds = Bounds { x: 0, y: 0, width: 3456, height: 2234 };

    #[test]
    fn fullscreen_and_maximized_resize_events_preserve_the_normal_frame() {
        assert_eq!(remember_normal(Some(NORMAL), SCREEN, true), Some(NORMAL));
        assert_eq!(remember_normal(None, SCREEN, true), None);
    }

    #[test]
    fn restoring_and_resizing_a_normal_window_updates_its_frame() {
        assert_eq!(remember_normal(Some(SCREEN), NORMAL, false), Some(NORMAL));
        assert_eq!(remember_normal(None, NORMAL, false), Some(NORMAL));
    }

    #[test]
    fn zero_sized_windows_do_not_destroy_the_saved_frame() {
        assert_eq!(remember_normal(Some(NORMAL), Bounds { width: 0, ..SCREEN }, false), Some(NORMAL));
    }
}
