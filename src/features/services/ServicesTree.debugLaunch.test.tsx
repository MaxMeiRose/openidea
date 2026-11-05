import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { registerActions } from "@/platform/actions";
import { setContext } from "@/platform/context";
import type { RunConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { validateSettings } from "@/features/settings/model/schema";
import { registerDebugActions } from "@/features/debugger/actions";
import { resetSessions, useDebug } from "@/features/debugger/state";
import { DebugServiceConsole } from "@/features/debugger/ui/DebugConsole";
import { activate as activateRun } from "@/features/run";
import { onRunExited, startRun, useRun } from "@/features/run/store";
import {
  provideNotificationService,
  provideToolWindowService,
  useDebugRunSessions,
  type ToolWindowService,
} from "@/workbench/contributions";
import { ServicesTreeView } from "./ServicesTree";
import { useServicesTree } from "./tree";

const ipc = vi.hoisted(() => ({
  runConfigs: vi.fn(),
  runStart: vi.fn(),
  runStop: vi.fn(),
  debugStart: vi.fn(),
  debugCapabilities: vi.fn(),
  debugExceptionFilters: vi.fn(),
}));
const confirmRerun = vi.hoisted(() => vi.fn());
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, ...ipc } };
});
vi.mock("@/features/run/dialogs", async (original) => ({
  ...(await original<typeof import("@/features/run/dialogs")>()),
  confirmRerun,
}));
vi.mock("@/features/run/applicationUpdate", async (original) => ({
  ...(await original<typeof import("@/features/run/applicationUpdate")>()),
  listenForApplicationDeactivation: () => () => {},
}));
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  Channel: class {
    onmessage: ((message: unknown) => void) | null = null;
  },
}));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 18,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 18, size: 18 })),
    measureElement: () => {},
    measure: () => {},
    scrollToIndex: () => {},
  }),
}));

const config: RunConfig = {
  id: "go:run:dreoatlas",
  name: "dreoatlas: go run .",
  kind: "go",
  command: "go",
  args: ["run", "."],
  cwd: "dreoatlas",
  env: {},
  detected: true,
  isTest: false,
  debugAdapter: "delve",
};
const other: RunConfig = {
  ...config,
  id: "gradle:run",
  name: "kotlin: gradle run",
  kind: "gradle",
  command: "gradle",
  debugAdapter: "java-debug",
};
const disposers: Array<() => void> = [];
const order: string[] = [];
const actions = () => within(screen.getByRole("toolbar", { name: "Service console actions" }));
const clickDebug = () => fireEvent.click(actions().getByRole("button", { name: /^Debug$/ }));

beforeEach(async () => {
  localStorage.clear();
  vi.clearAllMocks();
  order.length = 0;
  confirmRerun.mockResolvedValue(true);
  ipc.runConfigs.mockResolvedValue({ status: "ok", data: [config, other] });
  ipc.runStart.mockResolvedValue({
    status: "ok",
    data: { id: 7, configId: config.id, name: config.name, pid: 1, running: true, pty: false },
  });
  ipc.runStop.mockImplementation(async () => {
    order.push("stop run");
    queueMicrotask(() => onRunExited(7, 0));
    return { status: "ok", data: null };
  });
  ipc.debugStart.mockImplementation(async () => {
    order.push("start debug");
    return { status: "ok", data: 42 };
  });
  ipc.debugCapabilities.mockResolvedValue({ status: "ok", data: {} });
  ipc.debugExceptionFilters.mockResolvedValue({ status: "ok", data: [] });
  useProject.setState({
    project: { root: "/workspace", name: "workspace", isGit: false, settings: validateSettings({}) } as never,
  });
  useServicesTree.setState({
    roots: {},
    selectedKey: null,
    selectedKeys: new Set(),
    expanded: new Set([
      "run:type:go",
      "run:group:running:go",
      "run:group:not-started:go",
      "run:type:gradle",
      "run:group:running:gradle",
      "run:group:not-started:gradle",
    ]),
  });
  useDebug.setState({ sessions: {}, active: null, console: {} });
  useDebugRunSessions.setState({ sessions: [], serviceSessions: [], Console: DebugServiceConsole });
  localStorage.setItem("openidea.services.runTypes:/workspace", '["go","gradle"]');
  provideNotificationService({ notify: vi.fn() });
  provideToolWindowService({ show: vi.fn(), hide: vi.fn(), isVisible: () => true } as unknown as ToolWindowService);
  setContext("projectOpen", true);
  disposers.push(activateRun(), registerDebugActions());
  await waitFor(() => expect(useRun.getState().loaded).toBe(true));
  useRun.setState({ selectedId: other.id });
  render(<ServicesTreeView />);
  fireEvent.mouseDown(
    within(screen.getByRole("tree", { name: "Services" }))
      .getByText(config.name)
      .closest('[role="treeitem"]')!,
  );
});
afterEach(() => {
  cleanup();
  disposers
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose());
  resetSessions();
  useDebugRunSessions.setState({ sessions: [], serviceSessions: [], Console: null });
  vi.restoreAllMocks();
});

it("shows Go preparation immediately and sends the Services target to native DAP instead of the title-bar selection", async () => {
  let ready!: (value: unknown) => void;
  ipc.debugStart.mockImplementation(
    () =>
      new Promise((resolve) => {
        ready = resolve;
      }),
  );
  clickDebug();
  await waitFor(() => expect(ipc.debugStart).toHaveBeenCalledOnce());
  expect(screen.getByRole("log")).toHaveTextContent(`Starting debugger for ${config.name}`);
  expect(actions().getByRole("button", { name: /^Debug$/ })).toBeDisabled();
  expect(useDebugRunSessions.getState().serviceSessions[0]).toMatchObject({ config, status: "starting" });
  expect(ipc.debugStart).toHaveBeenCalledWith(
    expect.objectContaining({
      name: config.name,
      adapter: "delve",
      cwd: "/workspace/dreoatlas",
      program: "/workspace/dreoatlas",
    }),
  );
  await act(async () => ready({ status: "ok", data: 42 }));
  await waitFor(() => expect(useDebug.getState().sessions[42]?.runConfig?.id).toBe(config.id));
  expect(useRun.getState().selectedId).toBe(other.id);
});

it("keeps a missing Delve error and installation remedy in the selected Console, and retries the same target", async () => {
  ipc.debugStart.mockResolvedValueOnce({
    status: "error",
    error: {
      kind: "unavailable",
      message: "debug adapter `delve` not found (`dlv` is neither installed by OpenIDEA nor on PATH)",
    },
  });
  let installed!: () => void;
  const install = vi.fn(
    (_tool: unknown) =>
      new Promise<void>((resolve) => {
        installed = resolve;
      }),
  );
  disposers.push(registerActions([{ id: "tools.install", title: "Install", run: ({ arg }) => install(arg) }]));
  clickDebug();
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Delve is not installed"));
  expect(screen.getByRole("log")).toHaveTextContent("debug adapter `delve` not found");
  fireEvent.click(screen.getByRole("button", { name: "Install and Debug" }));
  await waitFor(() => expect(install).toHaveBeenCalledWith("delve"));
  expect(screen.getByRole("log")).toHaveTextContent("Installing delve");
  expect(actions().getByRole("button", { name: /^Debug$/ })).toBeDisabled();
  await act(async () => installed());
  await waitFor(() => expect(useDebug.getState().sessions[42]?.runConfig?.id).toBe(config.id));
  expect(ipc.debugStart).toHaveBeenCalledTimes(2);
  for (const [launch] of ipc.debugStart.mock.calls)
    expect(launch).toMatchObject({ name: config.name, adapter: "delve", cwd: "/workspace/dreoatlas" });
  expect(screen.queryByRole("alert")).toBeNull();
});

it("switches a nonparallel ordinary Run to Debug only after stopping its process", async () => {
  await act(async () => {
    await startRun(config);
  });
  clickDebug();
  await waitFor(() => expect(ipc.debugStart).toHaveBeenCalledOnce());
  expect(confirmRerun).toHaveBeenCalledWith(config.name);
  expect(ipc.runStop).toHaveBeenCalledExactlyOnceWith(7);
  expect(order).toEqual(["stop run", "start debug"]);
  expect(useRun.getState().sessions[0]?.status).toBe("finished");
});

it("cancelling the Run-to-Debug restart leaves the existing process alone", async () => {
  await act(async () => {
    await startRun(config);
  });
  confirmRerun.mockResolvedValueOnce(false);
  clickDebug();
  await waitFor(() => expect(confirmRerun).toHaveBeenCalledOnce());
  expect(ipc.runStop).not.toHaveBeenCalled();
  expect(ipc.debugStart).not.toHaveBeenCalled();
  expect(useRun.getState().sessions[0]?.status).toBe("running");
});
