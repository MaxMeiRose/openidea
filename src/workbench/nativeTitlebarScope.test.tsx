import { afterEach, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { commands, type Settings } from "@/platform/ipc";
import { usePlatform } from "@/platform/platformInfo";
import { useProject } from "@/platform/project";
import { useNativeTitlebar } from "./nativeTitlebar";

const bus = vi.hoisted(() => {
  type Handler = (event: { payload: number }) => void;
  const listeners: { label: string; handler: Handler }[] = [];
  const subscribe = (label: string, handler: Handler) => {
    const entry = { label, handler };
    listeners.push(entry);
    return Promise.resolve(() => listeners.splice(listeners.indexOf(entry), 1));
  };
  return {
    global: vi.fn((_event: string, handler: Handler) => subscribe("*", handler)),
    scoped: vi.fn((_event: string, handler: Handler) => subscribe("project-a", handler)),
    emitTo: (label: string, payload: number) => {
      for (const item of listeners) if (item.label === "*" || item.label === label) item.handler({ payload });
    },
  };
});
vi.mock("@tauri-apps/api/event", () => ({ listen: bus.global }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow: () => ({ listen: bus.scoped }) }));
vi.mock("@/platform/ipc", async (original) => {
  const ipc = await original<typeof import("@/platform/ipc")>();
  return {
    ...ipc,
    isTauri: () => true,
    commands: { ...ipc.commands, windowSetTitlebarHeight: vi.fn().mockResolvedValue({ status: "ok" }) },
  };
});

const platform = usePlatform.getState();
const project = useProject.getState();
afterEach(() => {
  usePlatform.setState(platform);
  useProject.setState(project);
  document.documentElement.style.removeProperty("--native-top-inset");
  vi.unstubAllGlobals();
});

it("does not subscribe to native insets from other project windows", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  usePlatform.setState({ overlayTitleBar: true });
  useProject.setState({ settings: { appearance: { zoom: 100 } } as Settings });
  const bar = document.createElement("header");
  vi.spyOn(bar, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 800, 40));
  const { unmount } = renderHook(() => useNativeTitlebar(bar));
  await waitFor(() => expect(commands.windowSetTitlebarHeight).toHaveBeenCalled());
  expect(bus.global).not.toHaveBeenCalled();
  expect(bus.scoped).not.toHaveBeenCalled();
  act(() => bus.emitTo("project-a", 36));
  expect(document.documentElement.style.getPropertyValue("--native-top-inset")).toBe("");
  act(() => bus.emitTo("project-b", 0));
  expect(document.documentElement.style.getPropertyValue("--native-top-inset")).toBe("");
  unmount();
});
