import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { commands, type RunConfig } from "@/platform/ipc";
import * as contributions from "@/workbench/contributions";
import { startRun, stopSession, useRun, type RunSession } from "@/features/run/store";
import { javaMethods } from "./model";
import { observeMethodRuns, openMethod, openProject, runMethod, stopMethod, useMethodTest } from "./store";

vi.mock("@/platform/ipc", async (original) => {
  const actual = await original<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    commands: {
      ...actual.commands,
      javaMethodPrepare: vi.fn(),
      javaMethodResult: vi.fn(),
      cancelRequest: vi.fn(async () => {}),
      fsReadText: vi.fn(),
    },
  };
});
vi.mock("@/features/run/store", async (original) => ({
  ...(await original<typeof import("@/features/run/store")>()),
  startRun: vi.fn(),
  stopSession: vi.fn(async () => {}),
}));
const ok = <T>(data: T) => ({ status: "ok" as const, data });
const config: RunConfig = {
  id: "java-method:abc",
  name: "DemoService · find",
  kind: "java-method",
  command: "java",
  args: [],
  cwd: "/project",
  env: { JAVA_HOME: "/jdk" },
  detected: false,
  isTest: false,
  debugAdapter: "java-debug",
};
const target = javaMethods(
  "/project/DemoService.java",
  "class DemoService { public String find(int id) { return null; } }",
)[0]!;
let dispose: () => void;
const save = vi.fn(async () => {});
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.spyOn(contributions, "editorService").mockReturnValue({ saveAll: save } as never);
  vi.spyOn(contributions, "toolWindowService").mockReturnValue({ show: vi.fn() } as never);
  openProject("/project");
  openMethod(target);
  useRun.setState({ sessions: [] });
  vi.mocked(commands.javaMethodPrepare).mockResolvedValue(ok({ id: "abc", config }));
  vi.mocked(commands.fsReadText).mockResolvedValue(
    ok("class DemoService { public String find(int id) { return null; } }"),
  );
  vi.mocked(startRun).mockImplementation(async (launched) => {
    const session: RunSession = {
      id: "run-method",
      config: launched,
      runId: 81,
      status: "running",
      exitCode: null,
      startedAt: Date.now(),
      endedAt: null,
      stdinClosed: false,
    };
    useRun.setState({ sessions: [session] });
    return session;
  });
  dispose = observeMethodRuns();
});
afterEach(() => {
  dispose();
  openProject(null);
  vi.restoreAllMocks();
});
it("uses the existing Services console and reads the result after the process exits", async () => {
  vi.mocked(commands.javaMethodResult).mockResolvedValue(
    ok({ success: true, valueJson: '{"id":1}', durationMs: 5, error: null, stackTrace: null, mockCallsJson: "[]" }),
  );
  await runMethod();
  expect(save).toHaveBeenCalled();
  expect(startRun).toHaveBeenCalledWith(expect.objectContaining({ kind: "java-method" }), undefined, undefined, {
    consoleLocation: "services",
    prepared: true,
  });
  expect(useMethodTest.getState().status).toBe("running");
  useRun.setState((state) => ({
    sessions: state.sessions.map((session) => ({ ...session, status: "finished", exitCode: 0, endedAt: 2 })),
  }));
  await waitFor(() => expect(useMethodTest.getState().result?.valueJson).toBe('{"id":1}'));
  expect(useMethodTest.getState().status).toBe("done");
});
it("cancels preparation without launching a process when its late response arrives", async () => {
  let resolve!: (value: Awaited<ReturnType<typeof commands.javaMethodPrepare>>) => void;
  vi.mocked(commands.javaMethodPrepare).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const pending = runMethod();
  await waitFor(() => expect(commands.javaMethodPrepare).toHaveBeenCalled());
  await stopMethod();
  resolve(ok({ id: "abc", config }));
  await pending;
  expect(commands.cancelRequest).toHaveBeenCalled();
  expect(startRun).not.toHaveBeenCalled();
  expect(useMethodTest.getState().status).toBe("stopped");
});
it("does not execute stale on-disk code if the editor cannot save", async () => {
  save.mockRejectedValueOnce(new Error("Disk is read-only"));
  await runMethod();
  expect(commands.javaMethodPrepare).not.toHaveBeenCalled();
  expect(startRun).not.toHaveBeenCalled();
  expect(useMethodTest.getState().error).toContain("read-only");
});
it("stops the tracked process instead of stopping an unrelated run", async () => {
  await runMethod();
  await stopMethod();
  expect(stopSession).toHaveBeenCalledWith("run-method");
});
it("rejects a case whose saved source signature has changed", async () => {
  vi.mocked(commands.fsReadText).mockResolvedValue(ok("class DemoService { public String renamed() {return null;} }"));
  await runMethod();
  expect(commands.javaMethodPrepare).not.toHaveBeenCalled();
  expect(startRun).not.toHaveBeenCalled();
  expect(useMethodTest.getState().error).toContain("signature has changed");
});
