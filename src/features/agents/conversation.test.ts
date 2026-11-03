import { describe, expect, it } from "vitest";
import {
  findAll,
  findRanges,
  formatDuration,
  groupToolCalls,
  pathLink,
  quoteText,
  toolGroupLabel,
  withQuote,
  type ToolCall,
} from "./conversation";

const tool = (id: string, name: string | null, kind = "read", title = id): ToolCall => ({
  type: "tool",
  id,
  name,
  kind,
  title,
  status: "completed",
  locations: [],
  output: null,
  diffs: [],
});

describe("grouping tool calls", () => {
  it("groups the same tool between thoughts while keeping other entries and permissions visible", () => {
    const items = groupToolCalls([
      { type: "thought", text: "first" },
      tool("a", "Read"),
      tool("b", "OtherRead"),
      tool("c", "Read"),
      { type: "permission", id: 1, title: "Approve", options: [], chosen: null },
      tool("d", "Read"),
      { type: "plan", items: [] },
      tool("g", "Read"),
      { type: "thought", text: "second" },
      tool("e", "Read"),
      { type: "agent", text: "progress" },
      tool("f", "Read"),
      { type: "user", text: "next", attachments: [] },
      tool("h", "Read"),
    ]);
    expect(
      items.map((item) => (item.type === "entry" ? item.entry.type : [item.name, item.calls.map((call) => call.id)])),
    ).toEqual([
      "thought",
      ["Read", ["a", "c", "d", "g"]],
      ["OtherRead", ["b"]],
      "permission",
      "plan",
      "thought",
      ["Read", ["e", "f"]],
      "agent",
      "user",
      ["Read", ["h"]],
    ]);
  });

  it("uses names instead of broad kinds and supports older calls without names", () => {
    const items = groupToolCalls([
      tool("a", null, "read", "Read a.ts"),
      tool("b", null, "read", "Read b.ts"),
      tool("c", "Grep", "search", "grep one"),
      tool("d", "Glob", "search", "Find *.ts"),
      tool("e", "mcp__first__run", "other", "first: run"),
      tool("f", "mcp__second__run", "other", "second: run"),
      tool("g", null, "other", ""),
      tool("h", null, "other", ""),
    ]);
    expect(items.map((item) => (item.type === "tools" ? item.calls.map((call) => call.id) : []))).toEqual([
      ["a", "b"],
      ["c"],
      ["d"],
      ["e"],
      ["f"],
      ["g"],
      ["h"],
    ]);
    expect(toolGroupLabel("codex:commandExecution")).toBe("Terminal");
    expect(toolGroupLabel("mcp__first__run")).toBe("first: run");
    expect(toolGroupLabel("codex:dynamicToolCall:docs:search")).toBe("docs:search");
  });
});

describe("quoting", () => {
  it("quotes each line and leaves a line to type on", () => {
    expect(quoteText("one\n\ntwo\n")).toBe("> one\n>\n> two\n\n");
  });
  it("adds the quote after a draft", () => {
    expect(withQuote("", "x")).toBe("> x\n\n");
    expect(withQuote("Why?  ", "x")).toBe("Why?\n\n> x\n\n");
  });
});

describe("pathLink", () => {
  const cwd = "/repo";
  it("resolves relative paths with a line and column", () => {
    expect(pathLink("src/lib.rs", cwd)).toEqual({ path: "/repo/src/lib.rs" });
    expect(pathLink("./src/main.rs:12", cwd)).toEqual({ path: "/repo/src/main.rs", line: 11 });
    expect(pathLink("a/b.ts:3:5", cwd)).toEqual({ path: "/repo/a/b.ts", line: 2, col: 4 });
    expect(pathLink("Cargo.toml", cwd)).toEqual({ path: "/repo/Cargo.toml" });
    expect(pathLink("/abs/x.py#L7", cwd)).toEqual({ path: "/abs/x.py", line: 6 });
  });
  it("ignores code that isn't a path", () => {
    for (const t of [
      "foo()",
      "cargo test",
      "https://x.dev/a.md",
      "inventory",
      "1.5",
      "v2.0",
      "a.b()",
      "failing-tests",
      "tests/",
    ]) {
      expect(pathLink(t, cwd)).toBeNull();
    }
  });
});

describe("formatDuration", () => {
  it("scales the unit", () => {
    expect(formatDuration(850)).toBe("850ms");
    expect(formatDuration(12_400)).toBe("12s");
    expect(formatDuration(65_000)).toBe("1m 05s");
    expect(formatDuration(2 * 3600_000 + 3 * 60_000)).toBe("2h 03m");
  });
});

describe("finding", () => {
  it("finds every occurrence, ignoring case", () => {
    expect(findAll("Abc abc ABC", "abc")).toEqual([0, 4, 8]);
    expect(findAll("aaa", "")).toEqual([]);
  });
  it("maps matches to DOM ranges", () => {
    const root = document.createElement("div");
    root.innerHTML = "<p>one <code>two</code> one</p>";
    expect(findRanges(root, "one").map((r) => r.toString())).toEqual(["one", "one"]);
    expect(findRanges(root, "TWO")).toHaveLength(1);
  });
});
