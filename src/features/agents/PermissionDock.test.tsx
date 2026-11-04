import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { AgentEntry, AgentTask } from "@/bindings";
import { PermissionDock } from "./PermissionDock";

const backend = vi.hoisted(() => ({ respond: vi.fn() }));
vi.mock("./store", () => ({ respond: backend.respond }));
const task = { id: "task-a" } as AgentTask;
const request = (id: number): Extract<AgentEntry, { type: "permission" }> => ({
  type: "permission",
  id,
  title: `Run command ${id}`,
  chosen: null,
  options: [
    { id: "allow-once", name: "Allow once", kind: "allow_once" },
    { id: "allow-session", name: "Allow for this session", kind: "allow_always" },
    { id: "decline", name: "Decline", kind: "reject_once" },
    { id: "cancel", name: "Decline and stop", kind: "reject_once" },
  ],
});
beforeEach(() => {
  vi.clearAllMocks();
  backend.respond.mockResolvedValue(undefined);
});

it("keeps separate requests locked until acknowledged, including after navigating away and back", async () => {
  let finish!: () => void;
  backend.respond.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const entries = [request(1), request(2)];
  const view = render(<PermissionDock task={task} entries={entries} />);
  fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
  fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
  expect(backend.respond).toHaveBeenCalledExactlyOnceWith("task-a", 1, "allow-once");
  fireEvent.click(screen.getByRole("button", { name: "Next request" }));
  expect(screen.getByRole("alert", { name: "Run command 2" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Allow once" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Previous request" }));
  expect(screen.getByRole("button", { name: "Allow once" })).toBeDisabled();
  await act(async () => finish());
  expect(screen.getByRole("button", { name: "Allow once" })).toBeDisabled();
  view.rerender(<PermissionDock task={task} entries={[{ ...request(1), chosen: "Allow once" }, request(2)]} />);
  fireEvent.click(screen.getByRole("button", { name: "Decline" }));
  expect(backend.respond).toHaveBeenLastCalledWith("task-a", 2, "decline");
});

it("keeps provider options intact and puts session-wide choices behind More options", () => {
  render(<PermissionDock task={task} entries={[request(1)]} />);
  expect(screen.queryByRole("button", { name: "Allow for this session" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "More options" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Allow for this session" }));
  expect(backend.respond).toHaveBeenCalledWith("task-a", 1, "allow-session");
});

it("shows errors and allows retrying the same request", async () => {
  backend.respond.mockRejectedValueOnce(new Error("Connection closed"));
  render(<PermissionDock task={task} entries={[request(1)]} />);
  fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
  expect(await screen.findByText(/Connection closed/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Allow once" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
  expect(backend.respond).toHaveBeenCalledTimes(2);
});

it("renders agent questions as choices requiring an explicit answer", () => {
  const entry = {
    ...request(5),
    title: "Which database?",
    options: [
      { id: "answer-0", name: "SQLite", kind: "allow_once" },
      { id: "answer-1", name: "PostgreSQL", kind: "allow_once" },
      { id: "reject", name: "Skip", kind: "reject_once" },
    ],
  };
  render(<PermissionDock task={task} entries={[entry]} />);
  const card = screen.getByRole("alert", { name: "Which database?" });
  expect(within(card).getByText("Question from the agent")).toBeVisible();
  expect(screen.getByRole("button", { name: "Submit answer" })).toBeDisabled();
  fireEvent.click(screen.getByRole("radio", { name: "PostgreSQL" }));
  expect(backend.respond).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole("radio", { name: "PostgreSQL" }), { key: "Enter" });
  expect(backend.respond).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
  expect(backend.respond).toHaveBeenCalledWith("task-a", 5, "answer-1");
});

it("does not render resolved requests and exposes every line of a long request", () => {
  const long = { ...request(2), title: `Run command\n${"argument ".repeat(60)}` };
  const view = render(<PermissionDock task={task} entries={[{ ...request(1), chosen: "Decline" }, long]} />);
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  const details = screen.getByText("Request details").closest("details")!;
  fireEvent.click(details.querySelector("summary")!);
  expect(details.querySelector("pre")?.textContent).toBe(long.title);
  view.rerender(<PermissionDock task={task} entries={[{ ...long, chosen: "Allow once" }]} />);
  expect(screen.queryByRole("alert")).toBeNull();
});
