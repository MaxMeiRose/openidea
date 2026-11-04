import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { usePlatform } from "@/platform/platformInfo";
import { useProject } from "@/platform/project";
import { useWindowGroup } from "@/platform/windowGroups";
import type { Settings } from "@/platform/ipc";
import { useNativeTitlebar } from "./nativeTitlebar";

const { setHeight, desktop, listen, unlisten } = vi.hoisted(() => {
  const desktop = { enabled: false, onInset: null as ((event: { payload: number }) => void) | null };
  const unlisten = vi.fn();
  return {
    desktop,
    unlisten,
    setHeight: vi.fn().mockResolvedValue({ status: "ok" }),
    listen: vi.fn(async (_event: string, handler: (event: { payload: number }) => void) => {
      desktop.onInset = handler;
      return unlisten;
    }),
  };
});
vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow: () => ({ listen }) }));
vi.mock("@/platform/ipc", async (original) => {
  const ipc = await original<typeof import("@/platform/ipc")>();
  return { ...ipc, isTauri: () => desktop.enabled, commands: { ...ipc.commands, windowSetTitlebarHeight: setHeight } };
});

const platform = usePlatform.getState();
const project = useProject.getState();
const windowGroup = useWindowGroup.getState();
let resize: () => void;
const disconnect = vi.fn();

beforeEach(() => {
  desktop.enabled = false;
  desktop.onInset = null;
  listen.mockClear();
  unlisten.mockClear();
  setHeight.mockClear();
  disconnect.mockClear();
  usePlatform.setState({ overlayTitleBar: true });
  useWindowGroup.setState({ tabs: [] });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
});

afterEach(() => {
  desktop.enabled = false;
  usePlatform.setState(platform);
  useProject.setState(project);
  useWindowGroup.setState(windowGroup);
  vi.unstubAllGlobals();
});

function zoom(percent: number) {
  useProject.setState({ settings: { appearance: { zoom: percent } } as Settings });
}

function titlebar(height: number) {
  const bar = document.createElement("header");
  const rect = vi.spyOn(bar, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 800, height));
  return { bar, rect };
}

describe("native title bar alignment", () => {
  it("keeps the native startup position until saved settings arrive", () => {
    useProject.setState({ settings: null });
    const { bar } = titlebar(40);
    renderHook(() => useNativeTitlebar(bar));
    expect(setHeight).not.toHaveBeenCalled();
    act(() => zoom(110));
    expect(setHeight).toHaveBeenCalledExactlyOnceWith(44);
  });

  it("does not resend the same height on resize notifications or effect remounts", () => {
    zoom(110);
    const { bar } = titlebar(40);
    const { rerender } = renderHook(({ bar }) => useNativeTitlebar(bar), { initialProps: { bar } });
    act(() => resize());
    rerender({ bar: titlebar(40).bar });
    act(() => resize());
    expect(setHeight).toHaveBeenCalledExactlyOnceWith(44);
  });

  it.each([50, 100, 125, 150, 200, 300])("converts CSS height to AppKit points at %s%%", (percent) => {
    zoom(percent);
    const { bar } = titlebar(40);
    renderHook(() => useNativeTitlebar(bar));
    expect(setHeight).toHaveBeenLastCalledWith((40 * percent) / 100);
  });

  it("uses the zoom the webview applies when the setting is out of range", () => {
    zoom(500);
    const { bar } = titlebar(40);
    renderHook(() => useNativeTitlebar(bar));
    expect(setHeight).toHaveBeenLastCalledWith(120);
  });

  it("updates when zoom or compact mode changes, and disconnects on unmount", () => {
    zoom(100);
    const { bar, rect } = titlebar(40);
    const { unmount } = renderHook(() => useNativeTitlebar(bar));
    act(() => zoom(150));
    expect(setHeight).toHaveBeenLastCalledWith(60);
    rect.mockReturnValue(new DOMRect(0, 0, 800, 32));
    act(() => resize());
    expect(setHeight).toHaveBeenLastCalledWith(48);
    unmount();
    expect(disconnect).toHaveBeenCalledTimes(2);
  });

  it("leaves windows without native overlay buttons alone", () => {
    usePlatform.setState({ overlayTitleBar: false });
    const { bar } = titlebar(40);
    renderHook(() => useNativeTitlebar(bar));
    expect(setHeight).not.toHaveBeenCalled();
  });

  it("keeps the web toolbar below native project tabs at the current IDE zoom", async () => {
    desktop.enabled = true;
    zoom(200);
    const { bar } = titlebar(40);
    const { unmount } = renderHook(() => useNativeTitlebar(bar));
    await waitFor(() => expect(listen).toHaveBeenCalledWith("openidea://native-top-inset", expect.any(Function)));
    act(() => desktop.onInset?.({ payload: 36 }));
    expect(document.documentElement.style.getPropertyValue("--native-top-inset")).toBe("18px");
    unmount();
    expect(unlisten).toHaveBeenCalledOnce();
    expect(document.documentElement.style.getPropertyValue("--native-top-inset")).toBe("");
  });

  it("updates native chrome spacing when fullscreen changes without resizing the toolbar", async () => {
    desktop.enabled = true;
    zoom(100);
    const { bar } = titlebar(40);
    renderHook(() => useNativeTitlebar(bar));
    await waitFor(() => expect(listen).toHaveBeenCalledOnce());
    act(() => desktop.onInset?.({ payload: 68 }));
    expect(document.documentElement.style.getPropertyValue("--native-top-inset")).toBe("68px");
    act(() => desktop.onInset?.({ payload: 36 }));
    expect(document.documentElement.style.getPropertyValue("--native-top-inset")).toBe("36px");
    act(() => desktop.onInset?.({ payload: 0 }));
    expect(document.documentElement.style.getPropertyValue("--native-top-inset")).toBe("0px");
  });

  it("rechecks the native inset when project windows join or leave a group", async () => {
    desktop.enabled = true;
    zoom(100);
    const { bar } = titlebar(40);
    renderHook(() => useNativeTitlebar(bar));
    await waitFor(() => expect(listen).toHaveBeenCalledOnce());
    setHeight.mockClear();
    const tabs = [
      { label: "one", name: "One", root: null, current: true },
      { label: "two", name: "Two", root: null, current: false },
    ];
    act(() => useWindowGroup.setState({ tabs }));
    expect(setHeight).toHaveBeenCalledWith(40);
    setHeight.mockClear();
    act(() => useWindowGroup.setState({ tabs: [] }));
    expect(setHeight).toHaveBeenCalledWith(40);
  });

  it("rechecks the native inset when a grouped project becomes focused", async () => {
    desktop.enabled = true;
    zoom(100);
    useWindowGroup.setState({
      tabs: [
        { label: "one", name: "One", root: null, current: true },
        { label: "two", name: "Two", root: null, current: false },
      ],
    });
    const { bar } = titlebar(40);
    renderHook(() => useNativeTitlebar(bar));
    await waitFor(() => expect(listen).toHaveBeenCalledOnce());
    setHeight.mockClear();
    act(() => window.dispatchEvent(new Event("focus")));
    expect(setHeight).toHaveBeenCalledWith(40);
  });

  it("rechecks after layout settles and stops observing after unmount", async () => {
    desktop.enabled = true;
    zoom(100);
    let frame: FrameRequestCallback | undefined;
    const request = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frame = callback;
      return 1;
    });
    const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    const { bar } = titlebar(40);
    const { unmount } = renderHook(() => useNativeTitlebar(bar));
    await waitFor(() => expect(listen).toHaveBeenCalledOnce());
    setHeight.mockClear();
    const tabs = [
      { label: "one", name: "One", root: null, current: true },
      { label: "two", name: "Two", root: null, current: false },
    ];
    act(() => useWindowGroup.setState({ tabs }));
    expect(setHeight).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledOnce();
    act(() => frame?.(0));
    expect(setHeight).toHaveBeenCalledTimes(2);

    setHeight.mockClear();
    act(() => useWindowGroup.setState({ tabs: tabs.map((tab) => ({ ...tab, name: `${tab.name}!` })) }));
    expect(setHeight).not.toHaveBeenCalled();
    act(() => window.dispatchEvent(new Event("focus")));
    unmount();
    expect(cancel).toHaveBeenCalledWith(1);
    setHeight.mockClear();
    act(() => useWindowGroup.setState({ tabs: [] }));
    act(() => window.dispatchEvent(new Event("focus")));
    expect(setHeight).not.toHaveBeenCalled();
    request.mockRestore();
    cancel.mockRestore();
  });
});
