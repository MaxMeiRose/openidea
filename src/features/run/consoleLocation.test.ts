import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LaunchConfig, OutputChunk, RunConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { validateSettings } from "@/features/settings/model/schema";
import {
  provideNotificationService,
  provideToolWindowService,
  registerServiceProvider,
  useActiveServiceView,
  useDebugRunSessions,
  type ToolWindowService,
} from "@/workbench/contributions";
import { startPreparedSession, startSession, useDebug } from "@/features/debugger/state";
import { runServiceProvider } from "./services";
import { rerunSession, resetRuns, runtime, startRun, useRun } from "./store";
import { useServicesTree } from "@/features/services/tree";

const ipc = vi.hoisted(() => ({
  runStart: vi.fn(async (_config: unknown, _channel: unknown) => ({
    status: "ok",
    data: { id: 9, configId: "app", name: "app", pid: 1, running: true, pty: false },
  })),
  debugStart: vi.fn(async () => ({ status: "ok", data: 42 })),
  debugCapabilities: vi.fn(async () => ({ status: "ok", data: {} })),
  debugExceptionFilters: vi.fn(async () => ({ status: "ok", data: [] })),
}));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, ...ipc } };
});
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  Channel: class {
    onmessage: ((message: OutputChunk) => void) | null = null;
  },
}));

const config: RunConfig = {
  id: "app",
  name: "app",
  kind: "shell",
  command: "echo",
  args: [],
  cwd: null,
  env: {},
  detected: false,
  isTest: false,
  debugAdapter: null,
};
const launch: LaunchConfig = {
  name: "app",
  adapter: "js-debug",
  request: "launch",
  program: null,
  args: [],
  cwd: null,
  env: {},
  extraJson: null,
};
const show = vi.fn();
let dispose: () => void;
beforeEach(() => {
  resetRuns();
  localStorage.clear();
  vi.clearAllMocks();
  useProject.setState({ project: { root: "/console-location", name: "app", settings: validateSettings({}) } as never });
  useRun.setState({ configs: [config] });
  useServicesTree.setState({ roots: {}, selectedKey: null, selectedKeys: new Set(), expanded: new Set() });
  useDebug.setState({ sessions: {}, active: null, console: {} });
  useDebugRunSessions.setState({ sessions: [], serviceSessions: [] });
  provideToolWindowService({ show, isVisible: () => false } as unknown as ToolWindowService);
  provideNotificationService({ notify: vi.fn() });
  dispose = registerServiceProvider(runServiceProvider);
});
afterEach(() => {
  dispose();
  resetRuns();
  vi.restoreAllMocks();
});

it("opens and focuses the selected service console without briefly opening Run", async () => {
  await startRun({ ...config, focusToolWindow: true });
  expect(show).toHaveBeenCalledExactlyOnceWith("services", true);
  expect(useActiveServiceView.getState().active).toBe("services");
  expect(useServicesTree.getState().selectedKey).toBe("run:config:app");
  expect(useServicesTree.getState().expanded).toContain("run:group:running:shell");
});

it("an explicit hidden launch overrides the configuration's focus/open flags", async () => {
  await startRun({ ...config, focusToolWindow: true, openToolWindow: true }, undefined, undefined, { show: false });
  expect(show).not.toHaveBeenCalled();
});

it("stdout/stderr reveal stays in Services, while explicitly showing Run keeps that destination", async () => {
  const session = await startRun({ ...config, showOnStdout: true, showOnStderr: true });
  show.mockClear();
  const channel = ipc.runStart.mock.calls[0]![1] as { onmessage: (message: OutputChunk) => void };
  channel.onmessage({ kind: "stdout", text: "application log\n" });
  channel.onmessage({ kind: "stderr", text: "application warning\n" });
  expect(show.mock.calls.every(([target]) => target === "services")).toBe(true);
  expect(show).toHaveBeenCalledTimes(2);
  runtime(session!.id)!.consoleInRun = true;
  show.mockClear();
  channel.onmessage({ kind: "stdout", text: "keep the explicitly chosen output pane\n" });
  expect(show).toHaveBeenCalledExactlyOnceWith("run");
});

it("routes debug preparation and the final adapter session to the same service console", async () => {
  await startPreparedSession(config, async () => launch);
  expect(show).toHaveBeenCalledTimes(2);
  expect(show.mock.calls.every(([target]) => target === "services")).toBe(true);
  expect(useServicesTree.getState().selectedKey).toBe("run:config:app");
});

it("Rerun in an explicitly opened Run window preserves that console destination", async () => {
  const session = (await startRun({ ...config, showOnStdout: true }))!;
  useRun.setState({ sessions: [{ ...session, status: "finished", exitCode: 0 }] });
  const menu = runServiceProvider.menu!({ key: "run:config:app", label: "app", icon: "run" });
  const showInRun = menu.find((item) => "label" in item && item.label === "Show in Run Tool Window");
  expect(showInRun).toBeTruthy();
  (showInRun as { run(): void }).run();
  show.mockClear();
  rerunSession(session.id);
  await vi.waitFor(() => expect(ipc.runStart).toHaveBeenCalledTimes(2));
  expect(runtime(session.id)!.consoleInRun).toBe(true);
  expect(show).toHaveBeenCalledExactlyOnceWith("run", false);
  show.mockClear();
  const channel = ipc.runStart.mock.calls[1]![1] as { onmessage: (message: OutputChunk) => void };
  channel.onmessage({ kind: "stdout", text: "rerun output\n" });
  expect(show).toHaveBeenCalledExactlyOnceWith("run");
});

it("starting again from Services resets an explicitly opened Run destination", async () => {
  const session = (await startRun({ ...config, showOnStdout: true }))!;
  useRun.setState({ sessions: [{ ...session, status: "finished", exitCode: 0 }] });
  runtime(session.id)!.consoleInRun = true;
  show.mockClear();
  const actions = runServiceProvider.detailActions!({ key: "run:config:app", label: "app", icon: "run" });
  actions.find((action) => action.id === "run")!.run();
  await vi.waitFor(() => expect(ipc.runStart).toHaveBeenCalledTimes(2));
  expect(runtime(session.id)!.consoleInRun).toBe(false);
  expect(show).not.toHaveBeenCalled();
  const channel = ipc.runStart.mock.calls[1]![1] as { onmessage: (message: OutputChunk) => void };
  channel.onmessage({ kind: "stdout", text: "service output\n" });
  expect(show).toHaveBeenCalledExactlyOnceWith("services", false);
});

it("standalone debugger launches without a run configuration retain the Debug window", async () => {
  await startSession(launch);
  expect(show).toHaveBeenCalledExactlyOnceWith("debug");
});
