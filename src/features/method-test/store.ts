import { create } from "zustand";
import {
  call,
  commands,
  isCancelled,
  nextRequestId,
  type MethodInvocationResult,
  type RequestId,
  type RunConfig,
} from "@/platform/ipc";
import { useRemote } from "@/platform/remote";
import { editorService, toolWindowService } from "@/workbench/contributions";
import { startRun, stopSession, useRun } from "@/features/run/store";
import { debugWithAgent } from "@/features/run/javaDebug";
import {
  environment,
  javaMethods,
  invocation,
  methodKey,
  newDraft,
  restore,
  type MethodCase,
  type MethodDraft,
  type MethodTarget,
} from "./model";

export const METHOD_TEST_WINDOW = "methodTest";
const KEY = "openidea.methodTest:";
type Status = "idle" | "preparing" | "running" | "stopping" | "done" | "failed" | "stopped";
interface State {
  root: string | null;
  location: string | null;
  draft: MethodDraft | null;
  cases: MethodCase[];
  caseId: string | null;
  status: Status;
  request: RequestId | null;
  sessionId: string | null;
  config: RunConfig | null;
  result: MethodInvocationResult | null;
  resultLabel: string | null;
  error: string | null;
  storageError: string | null;
}
export const useMethodTest = create<State>(() => ({
  root: null,
  location: null,
  draft: null,
  cases: [],
  caseId: null,
  status: "idle",
  request: null,
  sessionId: null,
  config: null,
  result: null,
  resultLabel: null,
  error: null,
  storageError: null,
}));
export const busy = (status: Status) => status === "preparing" || status === "running" || status === "stopping";
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
let generation = 0;
let watching: { generation: number; id: string; configId: string; notBefore: number; finished: number | null } | null =
  null;

function persist() {
  const { location, draft, cases } = useMethodTest.getState();
  if (!location) return;
  try {
    localStorage.setItem(KEY + location, JSON.stringify({ draft, cases }));
    useMethodTest.setState({ storageError: null });
  } catch (error) {
    useMethodTest.setState({ storageError: message(error) });
  }
}
export function openProject(root: string | null, location: string | null = root) {
  const previous = useMethodTest.getState();
  if (previous.root === root && previous.location === location) return;
  generation++;
  watching = null;
  if (previous.request !== null) void commands.cancelRequest(previous.request).catch(() => {});
  if (previous.sessionId && busy(previous.status)) void stopSession(previous.sessionId);
  let saved = restore(null);
  let storageError: string | null = null;
  try {
    saved = restore(location ? localStorage.getItem(KEY + location) : null);
  } catch (error) {
    storageError = message(error);
  }
  useMethodTest.setState({
    ...saved,
    root,
    location,
    caseId: null,
    status: "idle",
    request: null,
    sessionId: null,
    config: null,
    result: null,
    resultLabel: null,
    error: null,
    storageError,
  });
}
export function openMethod(target: MethodTarget) {
  const state = useMethodTest.getState();
  if (busy(state.status)) {
    toolWindowService().show(METHOD_TEST_WINDOW, true);
    return;
  }
  const same = state.draft && methodKey(state.draft.target) === methodKey(target);
  if (!same) {
    generation++;
    watching = null;
  }
  useMethodTest.setState({
    draft: same ? { ...state.draft!, target } : newDraft(target),
    caseId: same ? state.caseId : null,
    error: null,
    ...(!same ? { result: null, resultLabel: null, status: "idle" as const, sessionId: null, config: null } : {}),
  });
  persist();
  toolWindowService().show(METHOD_TEST_WINDOW, true);
}
export function updateDraft(patch: Partial<MethodDraft>) {
  const state = useMethodTest.getState();
  if (!state.draft || busy(state.status)) return;
  useMethodTest.setState({ draft: { ...state.draft, ...patch }, error: null });
  persist();
}
export function saveCase(name: string) {
  const { draft, cases, caseId } = useMethodTest.getState();
  if (!draft || !name.trim()) return;
  const entry: MethodCase = { id: caseId ?? crypto.randomUUID(), name: name.trim(), draft: structuredClone(draft) };
  useMethodTest.setState({ cases: [entry, ...cases.filter((c) => c.id !== entry.id)].slice(0, 30), caseId: entry.id });
  persist();
}
export function loadCase(id: string) {
  const state = useMethodTest.getState();
  if (busy(state.status)) return;
  const entry = state.cases.find((c) => c.id === id);
  if (!entry) return;
  const changed = !state.draft || methodKey(state.draft.target) !== methodKey(entry.draft.target);
  if (changed) {
    generation++;
    watching = null;
  }
  useMethodTest.setState({ draft: structuredClone(entry.draft), caseId: id, error: null });
  if (changed)
    useMethodTest.setState({ result: null, resultLabel: null, status: "idle", sessionId: null, config: null });
  persist();
}
export function removeCase() {
  const { cases, caseId } = useMethodTest.getState();
  useMethodTest.setState({ cases: cases.filter((c) => c.id !== caseId), caseId: null });
  persist();
}
export function newCase() {
  if (!busy(useMethodTest.getState().status)) useMethodTest.setState({ caseId: null });
}

export function observeMethodRuns() {
  return useRun.subscribe((state) => {
    const watch = watching;
    if (!watch || watch.generation !== generation) return;
    const session = [...state.sessions]
      .reverse()
      .find((s) => s.config.id === watch.configId && s.startedAt >= watch.notBefore);
    if (!session) return;
    if (session.status === "starting" || session.status === "running") {
      if (useMethodTest.getState().sessionId !== session.id || useMethodTest.getState().status !== "running")
        useMethodTest.setState({ sessionId: session.id, status: "running", result: null, error: null });
      watch.finished = null;
      return;
    }
    if (watch.finished === session.startedAt) return;
    watch.finished = session.startedAt;
    if (session.stopped) {
      useMethodTest.setState({ status: "stopped", request: null, result: null, error: null });
      return;
    }
    void call(commands.javaMethodResult(watch.id))
      .then((result) => {
        if (watching !== watch || watch.generation !== generation || watch.finished !== session.startedAt) return;
        useMethodTest.setState({
          result,
          status: result?.success ? "done" : "failed",
          request: null,
          error: result ? null : "The process exited without a result. See the Services Console for details.",
        });
      })
      .catch((error) => {
        if (watching === watch) useMethodTest.setState({ status: "failed", request: null, error: message(error) });
      });
  });
}

export async function runMethod(debug = false) {
  const state = useMethodTest.getState();
  if (!state.draft || busy(state.status)) return;
  const current = ++generation;
  watching = null;
  useMethodTest.setState({
    status: "preparing",
    result: null,
    error: null,
    sessionId: null,
    config: null,
    resultLabel: `${state.draft.implementationClass}#${state.draft.target.methodName}`,
  });
  const request = nextRequestId();
  useMethodTest.setState({ request });
  try {
    if (useRemote.getState().session) throw new Error("First-version method tests run on local Maven projects");
    const input = invocation(state.draft);
    await editorService().saveAll();
    if (current !== generation) return;
    const source = await call(commands.fsReadText(state.draft.target.path));
    if (
      !javaMethods(state.draft.target.path, source).some(
        (method) => methodKey(method) === methodKey(state.draft!.target),
      )
    )
      throw new Error("The saved method signature has changed. Reopen it from the editor and update the case.");
    if (current !== generation) return;
    const prepared = await call(commands.javaMethodPrepare(input, request));
    if (current !== generation) return;
    const config = { ...prepared.config, env: { ...environment(state.draft), ...prepared.config.env } };
    watching = { generation: current, id: prepared.id, configId: config.id, notBefore: Date.now(), finished: null };
    useMethodTest.setState({ config, request: null });
    if (debug) await debugWithAgent(config);
    else await startRun(config, undefined, undefined, { consoleLocation: "services", prepared: true });
    if (current !== generation) {
      const session = useRun.getState().sessions.find((session) => session.config.id === config.id);
      if (session && (session.status === "starting" || session.status === "running")) await stopSession(session.id);
      return;
    }
    if (current === generation && useMethodTest.getState().status === "preparing")
      useMethodTest.setState({ status: "failed", error: "The method test could not be started. See the Console." });
  } catch (error) {
    if (current !== generation) return;
    useMethodTest.setState({
      status: isCancelled(error) ? "stopped" : "failed",
      request: null,
      error: isCancelled(error) ? null : message(error),
    });
  }
}
export async function stopMethod() {
  const state = useMethodTest.getState();
  if (state.request !== null || state.status === "preparing") {
    generation++;
    watching = null;
    if (state.request !== null) void commands.cancelRequest(state.request).catch(() => {});
    useMethodTest.setState({ status: "stopped", request: null });
    return;
  }
  if (!state.sessionId) return;
  useMethodTest.setState({ status: "stopping" });
  try {
    await stopSession(state.sessionId);
  } catch (error) {
    useMethodTest.setState({ status: "running", error: message(error) });
  }
}
