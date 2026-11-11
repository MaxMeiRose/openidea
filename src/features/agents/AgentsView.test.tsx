import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import type { AgentTask } from "@/bindings";
import * as actions from "@/platform/actions";
import { registerActions } from "@/platform/actions";
import { EDITOR_TAB_MIME, type EditorInput } from "@/workbench/contributions";
import { confirmChecked, showError } from "@/workbench/messages";
import { ContextMenuHost, FILES_DRAG, dragSession, hideContextMenu } from "@/ui";
import { AgentsHeaderActions, AgentsLocationActions, AgentsView } from "./AgentsView";
import { SESSION_KIND } from "./model";
import {
  archiveTask,
  unarchiveTask,
  deleteTask,
  dockTask,
  importExternalSession,
  openTask,
  refreshExternalSessions,
  setSessionLocation,
  useAgents,
} from "./store";
import { taskActions, taskMenu, useAgentsHeaderMenu } from "./taskActions";
import { sendPaths } from "./references";
import styles from "./Agents.module.css";

const editor = vi.hoisted(() => ({
  active: undefined as EditorInput | undefined,
  listener: undefined as ((input: EditorInput) => void) | undefined,
  tabInput: undefined as ((paneId: string, tabId: string) => EditorInput | null) | undefined,
}));

vi.mock("@/workbench/contributions", async (original) => ({
  ...(await original<typeof import("@/workbench/contributions")>()),
  maybeEditorService: () => ({
    activeInput: () => editor.active,
    onActiveInputChange: (listener: typeof editor.listener) => {
      editor.listener = listener;
      return () => {
        editor.listener = undefined;
      };
    },
    tabInput: editor.tabInput,
  }),
}));

vi.mock("./store", async (original) => ({
  ...(await original<typeof import("./store")>()),
  openTask: vi.fn((id: string) => editor.listener?.({ kind: "agent-session", key: id, data: { task: id } })),
  archiveTask: vi.fn(async () => {}),
  unarchiveTask: vi.fn(async () => {}),
  deleteTask: vi.fn(async () => {}),
  importExternalSession: vi.fn(async () => {}),
  refreshExternalSessions: vi.fn(async () => {}),
  dockTask: vi.fn(),
  setSessionLocation: vi.fn(),
}));

vi.mock("./SessionEditor", () => ({ SessionEditor: () => <div data-testid="docked-session" /> }));
vi.mock("./references", () => ({ sendPaths: vi.fn(), sendSelection: vi.fn() }));

vi.mock("@/workbench/messages", () => ({
  confirmChecked: vi.fn(async () => ({ checked: false })),
  showError: vi.fn(async () => {}),
}));

function task(
  id: string,
  status: AgentTask["status"] = "ready",
  isolation: AgentTask["isolation"] = "local",
): AgentTask {
  return {
    id,
    title: id,
    status,
    isolation,
    provider: "codex",
    model: null,
    cwd: "/project",
    branch: null,
    base: null,
    baseCommit: null,
    error: null,
    createdMs: 0,
    updatedMs: 0,
    config: [],
    commands: [],
    usage: null,
    queue: [],
  };
}

const row = (id: string) =>
  within(screen.getByRole("tree", { name: "Agent tasks" }))
    .getByText(id)
    .closest('[role="treeitem"]')!;
const select = (id: string, modifiers: MouseEventInit = {}) =>
  fireEvent.mouseDown(row(id), { button: 0, ...modifiers });
const selectedTasks = () =>
  screen
    .queryAllByRole("treeitem", { selected: true })
    .filter((item) => item.getAttribute("aria-level") === "2")
    .map((item) => item.querySelector("[title]")?.getAttribute("title"));
const context = (id: string) => {
  fireEvent.mouseDown(row(id), { button: 2 });
  fireEvent.contextMenu(row(id));
};

let dispose: () => void;
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(actions, "executeAction");
  editor.active = undefined;
  editor.tabInput = undefined;
  vi.mocked(confirmChecked).mockResolvedValue({ checked: false });
  useAgents.setState({
    loaded: true,
    error: null,
    tasks: new Map([task("one"), task("two"), task("three"), task("four")].map((t) => [t.id, t])),
    docked: null,
    dockedTabs: [],
    homeOpen: false,
    sessionLocation: "editor",
    sessionsOpen: false,
    external: [],
    externalError: null,
  });
  dispose = registerActions(taskActions);
});
afterEach(() => {
  dispose();
  hideContextMenu();
  vi.restoreAllMocks();
});

function setup() {
  render(
    <>
      <AgentsHeaderActions />
      <AgentsLocationActions />
      <AgentsView />
      <ContextMenuHost />
    </>,
  );
}

describe("Agents selection", () => {
  it("extends and shrinks a range without opening its lead or losing selection to an editor echo", () => {
    setup();
    select("one");
    expect(setSessionLocation).toHaveBeenCalledWith("toolWindow");
    select("three", { shiftKey: true });
    expect(selectedTasks()).toEqual(["one", "two", "three"]);
    expect(openTask).toHaveBeenCalledTimes(1);
    act(() => editor.listener?.({ kind: SESSION_KIND, key: "one", data: { task: "one" } }));
    expect(selectedTasks()).toEqual(["one", "two", "three"]);
    select("two", { shiftKey: true });
    expect(selectedTasks()).toEqual(["one", "two"]);
    select("four");
    expect(selectedTasks()).toEqual(["four"]);
  });

  it("keeps the initial active task as the anchor for repeated keyboard extension", () => {
    editor.active = { kind: SESSION_KIND, key: "one", data: { task: "one" } };
    setup();
    const tree = screen.getByRole("tree");
    fireEvent.keyDown(tree, { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(tree, { key: "ArrowDown", shiftKey: true });
    expect(selectedTasks()).toEqual(["one", "two", "three"]);
    expect(openTask).not.toHaveBeenCalled();
  });

  it.each(["metaKey", "ctrlKey"])("toggles individual tasks with %s", (modifier) => {
    setup();
    select("one");
    select("three", { [modifier]: true });
    expect(selectedTasks()).toEqual(["one", "three"]);
    select("three", { [modifier]: true });
    expect(selectedTasks()).toEqual(["one"]);
    expect(openTask).toHaveBeenCalledTimes(1);
  });
});

describe("Agents docked view", () => {
  it("imports an external session from history while keeping the docked conversation mounted", async () => {
    useAgents.setState({
      docked: "one",
      external: [
        { provider: "codex", sessionId: "terminal-session", title: "Terminal work", cwd: "/project", updatedMs: 0 },
      ],
    });
    setup();
    const session = screen.getByTestId("docked-session");
    expect(refreshExternalSessions).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Agent sessions" }));
    expect(refreshExternalSessions).toHaveBeenCalledOnce();
    const history = screen.getByRole("dialog", { name: "Agent sessions" });
    expect(within(history).getByText("Sessions from other apps")).toBeVisible();
    expect(within(history).getByText("Terminal work")).toBeVisible();
    await act(async () => fireEvent.click(within(history).getByRole("button", { name: "Import" })));
    expect(importExternalSession).toHaveBeenCalledWith("codex", "terminal-session");
    expect(screen.getByTestId("docked-session")).toBe(session);
  });

  it("searches and filters history without closing or remounting the active conversation", () => {
    useAgents.setState({
      docked: "one",
      tasks: new Map([task("one"), task("two", "needsInput"), task("three", "archived")].map((t) => [t.id, t])),
    });
    setup();
    const session = screen.getByTestId("docked-session");
    fireEvent.click(screen.getByRole("button", { name: "Agent sessions" }));
    const search = screen.getByRole("textbox", { name: "Search sessions" });
    expect(search).toHaveFocus();
    fireEvent.change(search, { target: { value: "three" } });
    const tree = screen.getByRole("tree", { name: "Agent tasks" });
    expect(within(tree).queryByText("one")).toBeNull();
    expect(within(tree).getByText("three")).toBeVisible();
    expect(screen.getByTestId("docked-session")).toBe(session);
    fireEvent.change(search, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Needs input" }));
    expect(within(tree).queryByText("one")).toBeNull();
    fireEvent.click(within(tree).getByText("two"));
    expect(openTask).toHaveBeenCalledWith("two");
    expect(screen.queryByRole("dialog", { name: "Agent sessions" })).toBeNull();
  });

  it("moves an already active restored conversation into the tool window", () => {
    useAgents.setState({ sessionLocation: "toolWindow" });
    editor.active = { kind: SESSION_KIND, key: "agent:two", data: { task: "two" } };
    setup();
    expect(actions.executeAction).toHaveBeenCalledWith("agents.dockTask", "two");
  });

  it("shows multiple open conversations as tabs inside the tool window", () => {
    useAgents.setState({ docked: "one", dockedTabs: ["one", "two"], sessionLocation: "toolWindow" });
    setup();
    const tabs = screen.getByRole("tablist", { name: "Open Agent Sessions" });
    expect(within(tabs).getByRole("tab", { name: "one" })).toHaveAttribute("aria-selected", "true");
    expect(within(tabs).getByRole("tab", { name: "two" })).toHaveAttribute("aria-selected", "false");
  });

  it("opens session history on demand and closes it after switching tasks", () => {
    useAgents.setState({ docked: "one" });
    setup();
    expect(screen.getByTestId("docked-session")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Chat in Editor" })).toBeNull();
    expect(openTask).not.toHaveBeenCalled();
    expect(screen.queryByRole("tree", { name: "Agent tasks" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Agent sessions" }));
    fireEvent.click(within(screen.getByRole("tree", { name: "Agent tasks" })).getByText("two"));
    expect(screen.queryByRole("dialog", { name: "Agent sessions" })).toBeNull();
    expect(actions.executeAction).toHaveBeenCalledWith("agents.openTask", "two");
    expect(openTask).toHaveBeenCalledWith("two");
  });

  it("lets keyboard users browse history before confirming a session", () => {
    useAgents.setState({ docked: "one" });
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Agent sessions" }));
    const tree = screen.getByRole("tree", { name: "Agent tasks" });
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(screen.getByRole("dialog", { name: "Agent sessions" })).toBeTruthy();
    expect(openTask).not.toHaveBeenCalled();
    fireEvent.keyDown(tree, { key: "Enter" });
    expect(openTask).toHaveBeenCalledWith("two");
    expect(screen.queryByRole("dialog", { name: "Agent sessions" })).toBeNull();
  });

  it("includes the current session in history and keeps the conversation mounted", () => {
    useAgents.setState({ docked: "one" });
    setup();
    const session = screen.getByTestId("docked-session");
    fireEvent.click(screen.getByRole("button", { name: "Agent sessions" }));
    const tree = within(screen.getByRole("tree", { name: "Agent tasks" }));
    expect(tree.getByText("one")).toBeTruthy();
    expect(tree.getByText("two")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("tree", { name: "Agent tasks" })).toBeNull();
    expect(screen.getByTestId("docked-session")).toBe(session);
  });

  it("gives the whole tool window to the conversation when the docked task is the only one", () => {
    useAgents.setState({ tasks: new Map([task("one")].map((t) => [t.id, t])), docked: "one" });
    setup();
    expect(screen.queryByRole("tree", { name: "Agent tasks" })).toBeNull();
    expect(screen.getByTestId("docked-session")).toBeTruthy();
  });

  it("keeps the tool-window control without offering an accidental editor switch", () => {
    useAgents.setState({ docked: "one", sessionLocation: "toolWindow" });
    setup();
    expect(screen.queryByRole("button", { name: "Open in Editor" })).toBeNull();
    expect(screen.getByRole("button", { name: "Chat in Tool Window" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: "Chat in Editor" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Chat in Tool Window" }));
    expect(setSessionLocation).toHaveBeenCalledWith("toolWindow");
  });

  it("offers placement in the Agents options menu, checked by the current one", () => {
    useAgents.setState({ sessionLocation: "toolWindow" });
    const { result } = renderHook(() => useAgentsHeaderMenu());
    expect(result.current).toEqual([
      { kind: "action", action: "agents.useToolWindow", icon: "", checked: true },
      { kind: "action", action: "agents.useEditor", icon: "", checked: false },
    ]);
  });

  it("moves the history selection to the tool window without a docked conversation", () => {
    setup();
    expect(screen.queryByRole("button", { name: "Open in Editor" })).toBeNull();
    select("two");
    expect(setSessionLocation).toHaveBeenCalledWith("toolWindow");
    expect(openTask).toHaveBeenCalledWith("two");
    expect(dockTask).not.toHaveBeenCalled();
  });
});

describe("Agents bulk actions", () => {
  it("deletes the right-clicked selection after one confirmation, excluding group headers", async () => {
    const tasks = [task("one", "running"), task("two"), task("three")];
    useAgents.setState({ tasks: new Map(tasks.map((t) => [t.id, t])) });
    setup();
    select("one");
    select("three", { shiftKey: true });
    context("two");
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete (3)…" }));
    await waitFor(() => expect(deleteTask).toHaveBeenCalledTimes(3));
    expect(confirmChecked).toHaveBeenCalledTimes(1);
    expect(confirmChecked).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("3 agent tasks") }),
    );
    expect(vi.mocked(deleteTask).mock.calls).toEqual([
      ["one", false],
      ["two", false],
      ["three", false],
    ]);
  });

  it("right-clicking outside the selection targets only that task", async () => {
    setup();
    select("one");
    select("two", { shiftKey: true });
    context("four");
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete…" }));
    await waitFor(() => expect(deleteTask).toHaveBeenCalledExactlyOnceWith("four", false));
  });

  it("archives only eligible tasks in a mixed selection", async () => {
    const tasks = [task("one", "running"), task("two"), task("three", "archived")];
    useAgents.setState({ tasks: new Map(tasks.map((t) => [t.id, t])) });
    setup();
    fireEvent.doubleClick(within(screen.getByRole("tree", { name: "Agent tasks" })).getByText("Archived"));
    select("one");
    select("three", { shiftKey: true });
    context("two");
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive (1)" }));
    await waitFor(() => expect(archiveTask).toHaveBeenCalledExactlyOnceWith("two"));
  });

  it("unarchives only archived tasks in a mixed selection", async () => {
    const tasks = [task("one"), task("two", "archived"), task("three", "archived")];
    useAgents.setState({ tasks: new Map(tasks.map((t) => [t.id, t])) });
    setup();
    fireEvent.doubleClick(within(screen.getByRole("tree", { name: "Agent tasks" })).getByText("Archived"));
    select("one");
    select("three", { shiftKey: true });
    context("two");
    fireEvent.click(screen.getByRole("menuitem", { name: "Unarchive (2)" }));
    await waitFor(() => expect(unarchiveTask).toHaveBeenCalledTimes(2));
    expect(vi.mocked(unarchiveTask).mock.calls).toEqual([["two"], ["three"]]);
  });

  it("cancels the whole batch", async () => {
    vi.mocked(confirmChecked).mockResolvedValue(null);
    await taskActions.find((action) => action.id === "agents.deleteTasks")!.run({ ctx: {}, arg: ["one", "two"] });
    expect(deleteTask).not.toHaveBeenCalled();
  });

  it.each([false, true])("applies worktree cleanup (%s) only to worktree tasks", async (checked) => {
    const tasks = [task("one"), task("two", "ready", "worktree")];
    useAgents.setState({ tasks: new Map(tasks.map((t) => [t.id, t])) });
    vi.mocked(confirmChecked).mockResolvedValue({ checked });
    await taskActions.find((action) => action.id === "agents.deleteTasks")!.run({ ctx: {}, arg: ["one", "two"] });
    expect(vi.mocked(deleteTask).mock.calls).toEqual([
      ["one", false],
      ["two", checked],
    ]);
  });

  it("continues after an error and reports the failed task", async () => {
    vi.mocked(deleteTask).mockRejectedValueOnce(new Error("Cannot remove worktree"));
    await taskActions.find((action) => action.id === "agents.deleteTasks")!.run({ ctx: {}, arg: ["one", "two"] });
    expect(deleteTask).toHaveBeenCalledTimes(2);
    expect(showError).toHaveBeenCalledWith("Cannot delete agent tasks", "one: Cannot remove worktree");
  });
});

describe("Agents task menu", () => {
  it.each([null, "one"])("keeps placement out of session menus (docked: %s)", (docked) => {
    useAgents.setState({ docked });
    const menu = taskMenu([useAgents.getState().tasks.get("one")!]);
    expect(menu).not.toContainEqual(expect.objectContaining({ action: "agents.dockTask" }));
    expect(menu).not.toContainEqual(expect.objectContaining({ action: "agents.undockTask" }));
    // A click opens the task: the menu doesn't repeat it.
    expect(menu).not.toContainEqual(expect.objectContaining({ action: "agents.openTask" }));
    expect(menu[0]).toMatchObject({ action: "agents.renameTask" });
  });
});

describe("Agents drag & drop", () => {
  // jsdom has no elementFromPoint; the drop target is found through it.
  const pointAt = (el: Element) => {
    const original = document.elementFromPoint;
    document.elementFromPoint = () => el;
    return () => {
      document.elementFromPoint = original;
    };
  };

  it("docks a session editor tab dropped on the tool window and highlights while it hovers", () => {
    editor.tabInput = (paneId, tabId) =>
      paneId === "p" && tabId === "t" ? { kind: SESSION_KIND, key: "agent:one", data: { task: "one" } } : null;
    setup();
    const view = document.querySelector(`.${styles.view}`)!;
    const restore = pointAt(view);
    try {
      const session = dragSession({ type: EDITOR_TAB_MIME, payload: JSON.stringify({ paneId: "p", tabId: "t" }) });
      act(() => session.move(10, 10));
      expect(view.className).toContain(styles.dropTarget);
      act(() => session.drop(10, 10));
      expect(actions.executeAction).toHaveBeenCalledWith("agents.dockTask", "one");
      expect(dockTask).toHaveBeenCalledWith("one");
      expect(view.className).not.toContain(styles.dropTarget);
    } finally {
      restore();
    }
  });

  it("ignores editor tab drags that are not agent sessions", () => {
    editor.tabInput = () => null;
    setup();
    const view = document.querySelector(`.${styles.view}`)!;
    const restore = pointAt(view);
    try {
      const session = dragSession({ type: EDITOR_TAB_MIME, payload: JSON.stringify({ paneId: "p", tabId: "t" }) });
      act(() => session.move(10, 10));
      expect(view.className).not.toContain(styles.dropTarget);
      act(() => session.drop(10, 10));
      expect(dockTask).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("adds files dragged from the project tree or a code editor tab as references", () => {
    editor.tabInput = () => ({ kind: "file", key: "file:a", path: "/project/a.go" });
    setup();
    const view = document.querySelector(`.${styles.view}`)!;
    const restore = pointAt(view);
    try {
      const file = dragSession({ type: FILES_DRAG, payload: "/project/a.go\n/project/b.go" });
      act(() => file.drop(10, 10));
      expect(sendPaths).toHaveBeenCalledWith(["/project/a.go", "/project/b.go"]);
      const tab = dragSession({ type: EDITOR_TAB_MIME, payload: JSON.stringify({ paneId: "p", tabId: "t" }) });
      act(() => tab.drop(10, 10));
      expect(sendPaths).toHaveBeenCalledWith(["/project/a.go"]);
    } finally {
      restore();
    }
  });
});
