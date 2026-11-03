import { useEffect, useRef } from "react";
import { call, commands, isTauri } from "@/platform/ipc";
import { usePlatform } from "@/platform/platformInfo";
import { useProject } from "@/platform/project";
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
    if (isTauri()) {
      void import("@tauri-apps/api/event")
        .then(async ({ listen }) => {
          const off = await listen<number>("openidea://native-top-inset", ({ payload }) => {
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
      observer.disconnect();
      bar.style.removeProperty("--titlebar-zoom");
      document.documentElement.style.removeProperty("--native-top-inset");
    };
  }, [bar, overlay, zoom]);
}
