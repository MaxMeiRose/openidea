import { beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { openTarget, openUrl } from "@/features/run/navigate";
import type { RunConfig } from "@/platform/ipc";
import { adoptSession, appendConsole, useDebug } from "../state";
import { DebugConsole, DebugServiceConsole } from "../ui/DebugConsole";

vi.mock("@/features/run/navigate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/run/navigate")>()),
  openTarget: vi.fn(async () => {}),
  openUrl: vi.fn(async () => {}),
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 18,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 18 })),
    measureElement: () => {},
    scrollToIndex: () => {},
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  useDebug.setState({ sessions: {}, console: {}, active: null });
});

it("shows the requested session without changing or following the active debugger", () => {
  adoptSession(1, { name: "one" });
  adoptSession(2, { name: "two" });
  appendConsole(1, "stdout", "service one\n");
  appendConsole(2, "stdout", "service two\n");
  useDebug.setState({ active: 2 });
  const view = render(<DebugServiceConsole sessionId={1} />);
  expect(screen.getByRole("log")).toHaveTextContent("service one");
  expect(screen.getByRole("log")).not.toHaveTextContent("service two");
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(useDebug.getState().active).toBe(2);
  act(() => appendConsole(2, "stdout", "unrelated\n"));
  expect(screen.getByRole("log")).not.toHaveTextContent("unrelated");
  view.rerender(<DebugServiceConsole sessionId={2} />);
  expect(screen.getByRole("log")).toHaveTextContent("service two");
  expect(screen.getByRole("log")).not.toHaveTextContent("service one");
});

it("shares output and clearing with the interactive debugger console", () => {
  const session = adoptSession(1);
  appendConsole(1, "stdout", "shared log\n");
  render(
    <>
      <DebugServiceConsole sessionId={1} />
      <DebugConsole session={session} />
    </>,
  );
  expect(screen.getAllByRole("log").every((log) => log.textContent?.includes("shared log"))).toBe(true);
  expect(screen.getByRole("textbox", { name: "Debug console input" })).toBeEnabled();
  const clear = screen.getAllByRole("button", { name: "Clear Console" })[0]!;
  fireEvent.click(clear);
  for (const log of screen.getAllByRole("log")) expect(within(log).queryByText("shared log")).toBeNull();
  expect(useDebug.getState().console[1]).toEqual([]);
});

it("shows an empty state when its source has been cleared", () => {
  render(<DebugServiceConsole sessionId={99} />);
  expect(screen.getByText("No debug output available")).toBeTruthy();
  expect(screen.queryByRole("log")).toBeNull();
});

it("explains why a remote attached process may have no application logs", () => {
  adoptSession(1, {
    launch: {
      name: "remote",
      adapter: "java-debug",
      request: "attach",
      program: null,
      args: [],
      cwd: "/p",
      env: {},
      extraJson: null,
    },
  });
  render(<DebugServiceConsole sessionId={1} />);
  expect(screen.getByText("The attached process may not provide standard output to the debugger.")).toBeTruthy();
});

it("opens source links from both Services and the interactive Debug console using the launch directory", () => {
  const config: RunConfig = {
    id: "go-app",
    name: "Go app",
    kind: "go",
    command: "go",
    args: [],
    cwd: "/workspace/go",
    env: {},
    detected: false,
    isTest: false,
    debugAdapter: "delve",
  };
  const session = adoptSession(1, { runConfig: config });
  appendConsole(1, "stdout", "source=./cmd/main.go:17:4\n");
  render(
    <>
      <DebugServiceConsole sessionId={1} />
      <DebugConsole session={session} />
    </>,
  );
  const links = screen.getAllByRole("link", { name: "./cmd/main.go:17:4" });
  expect(links).toHaveLength(2);
  fireEvent.click(links[0]!);
  fireEvent.click(links[1]!);
  expect(openTarget).toHaveBeenCalledTimes(2);
  expect(openTarget).toHaveBeenCalledWith(
    { path: "./cmd/main.go", line: 17, col: 4, resolve: "path" },
    "/workspace/go",
  );
});

it("recognizes links across ANSI spans and throughout long log lines", () => {
  adoptSession(1);
  appendConsole(
    1,
    "stderr",
    "source=\u001b[31m/project/\u001b[0mmain.go:23 " + "x".repeat(5000) + " /project/other.go:45\n",
  );
  render(<DebugServiceConsole sessionId={1} />);
  const links = screen.getAllByRole("link");
  expect(links.map((link) => link.textContent).join("")).toBe("/project/main.go:23/project/other.go:45");
  fireEvent.click(links[0]!);
  expect(openTarget).toHaveBeenCalledWith({ path: "/project/main.go", line: 23, resolve: "path" }, "/");
});

it("opens URLs from Debug output", () => {
  adoptSession(1);
  appendConsole(1, "console", "Listening on http://localhost:8080/health\n");
  render(<DebugServiceConsole sessionId={1} />);
  fireEvent.click(screen.getByRole("link", { name: "http://localhost:8080/health" }));
  expect(openUrl).toHaveBeenCalledWith("http://localhost:8080/health");
});
