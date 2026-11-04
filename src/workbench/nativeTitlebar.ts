import { useEffect, useRef } from "react";
import { call, commands, isTauri } from "@/platform/ipc";
import { usePlatform } from "@/platform/platformInfo";
import { useProject } from "@/platform/project";
import { useWindowGroup } from "@/platform/windowGroups";
import { clampZoom } from "@/platform/zoom";

export function useNativeTitlebar(bar: HTMLElement | null) {
  const overlay = usePlatform((s) => s.overlayTitleBar);
  const zoom = useProject((s) => (s.settings ? clampZoom(s.settings.appearance?.zoom) : null));
  const lastHeight = useRef<number | null>(null);
  useEffect(() => {
    if (!overlay || !bar || zoom === null) return;
    bar.style.setProperty("--titlebar-zoom", String(zoom / 100));
    const update = () => {
      // Webview zoom scales CSS pixels; Retina scale is already handled by AppKit.
      const height = (bar.getBoundingClientRect().height * zoom) / 100;
      if (height > 0 && height !== lastHeight.current) {
        lastHeight.current = height;
        void call(commands.windowSetTitlebarHeight(height)).catch((e) => {
          if (lastHeight.current === height) lastHeight.current = null;
          console.warn("cannot align window buttons", e);
        });
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(bar);
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let offGroup: (() => void) | undefined;
    let refreshFrame: number | undefined;
    const refresh = () => {
      // The native tab bar may be laid out after the group/focus event.
      lastHeight.current = null;
      update();
      if (refreshFrame !== undefined) cancelAnimationFrame(refreshFrame);
      refreshFrame = requestAnimationFrame(() => {
        refreshFrame = undefined;
        lastHeight.current = null;
        update();
      });
    };
    const onFocus = () => {
      if (useWindowGroup.getState().tabs.length > 1) refresh();
    };
    if (isTauri()) {
      offGroup = useWindowGroup.subscribe((state, previous) => {
        const labels = (tabs: typeof state.tabs) => tabs.map((tab) => tab.label).join("\0");
        if (labels(state.tabs) !== labels(previous.tabs)) refresh();
      });
      window.addEventListener("focus", onFocus);
      void import("@tauri-apps/api/webviewWindow")
        .then(async ({ getCurrentWebviewWindow }) => {
          // A global Tauri listener also receives insets emitted to other windows.
          const off = await getCurrentWebviewWindow().listen<number>("openidea://native-top-inset", ({ payload }) => {
            if (!disposed && Number.isFinite(payload) && payload >= 0)
              document.documentElement.style.setProperty("--native-top-inset", `${(payload * 100) / zoom}px`);
          });
          if (disposed) off();
          else {
            unlisten = off;
            // Request the current inset after subscribing, even if its first native event
            // preceded this title bar mounting (opening/restoring a project group).
            lastHeight.current = null;
            update();
          }
        })
        .catch((e) => console.warn("cannot observe native window chrome", e));
    }
    return () => {
      disposed = true;
      unlisten?.();
      offGroup?.();
      window.removeEventListener("focus", onFocus);
      if (refreshFrame !== undefined) cancelAnimationFrame(refreshFrame);
      observer.disconnect();
      bar.style.removeProperty("--titlebar-zoom");
      document.documentElement.style.removeProperty("--native-top-inset");
    };
  }, [bar, overlay, zoom]);
}
