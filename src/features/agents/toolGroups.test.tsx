import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import type { AgentEntry, AgentTask } from "@/bindings";
import type { ToolCall } from "./conversation";

const backend = vi.hoisted(() => ({ entries: [] as AgentEntry[] }));
vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  commands: {
    agentEntries: async () => ({ status: "ok", data: backend.entries }),
    agentChanges: async () => ({ status: "ok", data: [] }),
    vcsBranchInfo: async () => ({ status: "ok", data: { head: "main" } }),
  },
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));

import styles from "./Session.module.css";
import { SessionEditor } from "./SessionEditor";
import { useAgents } from "./store";

const task: AgentTask = {
  id: "tools",
  title: "Tool test",
  provider: "claude",
  status: "running",
  isolation: "local",
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
  capabilities: { fork: true, rollback: true, steer: true, images: true },
};
const tool = (id: string, name: string, title: string, status: ToolCall["status"] = "completed"): ToolCall => ({
  type: "tool",
  id,
  name,
  title,
  kind: "read",
  status,
  locations: [],
  output: `output ${id}`,
  diffs: [],
});
const thought: AgentEntry = { type: "thought", text: "thinking" };

beforeEach(() => {
  backend.entries = [];
  useAgents.setState({
    loaded: true,
    tasks: new Map([[task.id, task]]),
    entries: new Map(),
    composers: new Map(),
    focus: null,
  });
});

async function openSession() {
  const view = render(<SessionEditor input={{ kind: "agent-session", key: task.id, data: { task: task.id } }} />);
  await waitFor(() => expect(useAgents.getState().entries.has(task.id)).toBe(true));
  view.container.querySelectorAll(`details.${styles.processRun}`).forEach((fold) => {
    if (!fold.hasAttribute("open")) fireEvent.click(fold.querySelector("summary")!);
  });
  return view;
}

describe("tool call groups", () => {
  it("groups Codex reads, searches and terminal commands into separate collapsed rows", async () => {
    const name = "codex:commandExecution";
    backend.entries = [
      thought,
      { ...tool("c1", name, "first command"), kind: "execute" },
      { ...tool("r1", name, "Read first.go"), kind: "read" },
      { ...tool("s1", name, "Search first"), kind: "search" },
      { ...tool("c2", name, "second command"), name: null, kind: "execute" },
      { ...tool("r2", name, "Read second.go"), name: null, kind: "read" },
      { ...tool("s2", name, "Search second"), name: null, kind: "search" },
    ];
    useAgents.setState({ loaded: true, tasks: new Map([[task.id, { ...task, provider: "codex" }]]) });
    await openSession();
    for (const label of ["Terminal", "Read", "Search"]) {
      const group = (await screen.findByText(label, { exact: true })).closest("details")!;
      expect(group).not.toHaveAttribute("open");
      expect(within(group).getByText("×2")).toBeVisible();
    }
  });

  it("starts collapsed, keeps calls and failures accessible, and leaves permissions visible", async () => {
    backend.entries = [
      thought,
      tool("a", "Read", "Read a.ts"),
      tool("other", "Other", "Other tool"),
      tool("b", "Read", "Read b.ts", "failed"),
      { type: "permission", id: 1, title: "Permission needed", options: [], chosen: null },
      tool("c", "Read", "Read c.ts"),
      thought,
      tool("d", "Read", "Read d.ts"),
    ];
    await openSession();
    const group = (await screen.findByText("Read", { exact: true })).closest("details")!;
    expect(group).not.toHaveAttribute("open");
    expect(within(group).getByText("×2")).toBeVisible();
    expect(within(group.querySelector("summary")!).getByLabelText("Failed")).toBeInTheDocument();
    expect(within(group).getByText("Read a.ts")).not.toBeVisible();
    expect(screen.getByRole("region", { name: "Allow tool call?" })).toBeVisible();
    expect(screen.getByText("Other tool").closest("details")).not.toHaveAttribute("open");
    expect(screen.getByText("Read c.ts").closest("details")).not.toHaveAttribute("open");
    expect(screen.getByText("Read d.ts").closest("details")).not.toHaveAttribute("open");

    fireEvent.click(group.querySelector("summary")!);
    expect(within(group).getByText("Read a.ts")).toBeVisible();
    expect(within(group).getByText("Read b.ts")).toBeVisible();
    expect(screen.getByText("Read c.ts").closest("details")).not.toHaveAttribute("open");
    expect(within(group).getByText("output a")).not.toBeVisible();
    fireEvent.click(within(group).getByText("Read a.ts"));
    expect(within(group).getByText("output a")).toBeVisible();
  });

  it("keeps an expanded group and individual output open as calls stream in", async () => {
    backend.entries = [thought, tool("a", "Read", "Read a.ts", "completed")];
    await openSession();
    const group = (await screen.findByText("Read a.ts")).closest("details")!;
    expect(group).not.toHaveAttribute("open");
    fireEvent.click(group.querySelector("summary")!);
    expect(within(group).getByText("output a")).toBeVisible();

    act(() =>
      useAgents.setState((s) => ({
        entries: new Map(s.entries).set(task.id, [
          thought,
          tool("a", "Read", "Read a.ts"),
          tool("b", "Read", "Read b.ts", "completed"),
        ]),
      })),
    );
    expect(screen.getByText("Read", { exact: true }).closest("details")).toBe(group);
    expect(group).toHaveAttribute("open");
    fireEvent.click(within(group).getByText("Read a.ts"));
    expect(within(group).getByText("output a")).toBeVisible();
    act(() =>
      useAgents.setState((s) => ({
        entries: new Map(s.entries).set(task.id, [
          thought,
          tool("a", "Read", "Read a.ts"),
          tool("b", "Read", "Read b.ts"),
          tool("c", "Read", "Read c.ts", "failed"),
        ]),
      })),
    );
    expect(group).toHaveAttribute("open");
    expect(within(group).getByText("×3")).toBeVisible();
    expect(within(group).getByText("output a")).toBeVisible();
    expect(within(group.querySelector("summary")!).getByLabelText("Failed")).toBeVisible();
  });

  it("starts a replacement call collapsed after the conversation is rolled back", async () => {
    backend.entries = [thought, tool("a", "Read", "Read old.ts")];
    await openSession();
    const oldGroup = (await screen.findByText("Read old.ts")).closest("details")!;
    fireEvent.click(oldGroup.querySelector("summary")!);
    expect(oldGroup).toHaveAttribute("open");

    act(() =>
      useAgents.setState((s) => ({
        entries: new Map(s.entries).set(task.id, [thought, tool("new", "Read", "Read new.ts")]),
      })),
    );
    const newGroup = screen.getByText("Read new.ts").closest("details")!;
    expect(newGroup).not.toBe(oldGroup);
    expect(newGroup).not.toHaveAttribute("open");
    expect(within(newGroup).getByText("output new")).not.toBeVisible();
  });
});
