import { describe, expect, it } from "vitest";
import {
  findAll,
  findRanges,
  fileHref,
  filePathTokens,
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

  it("groups Codex reads, searches and terminal commands separately within a thought", () => {
    const name = "codex:commandExecution";
    const items = groupToolCalls([
      { type: "thought", text: "Inspect" },
      tool("c1", name, "execute"),
      tool("c2", name, "execute"),
      tool("s1", name, "search"),
      tool("r1", name, "read"),
      tool("r2", name, "read"),
      tool("s2", name, "search"),
      tool("r3", name, "read"),
    ]);
    expect(items.flatMap((item) => (item.type === "tools" ? [item.calls.map((call) => call.id)] : []))).toEqual([
      ["c1", "c2"],
      ["s1", "s2"],
      ["r1", "r2", "r3"],
    ]);
    expect(toolGroupLabel(name, "read")).toBe("Read");
    expect(toolGroupLabel(name, "search")).toBe("Search");
    expect(toolGroupLabel(name, "execute")).toBe("Terminal");
  });

  it("recognizes those same groups in older Codex conversations without tool names", () => {
    const items = groupToolCalls(
      [
        { type: "thought", text: "Inspect" },
        tool("c1", null, "execute", "cat one"),
        tool("c2", null, "execute", "cat two"),
        tool("r1", null, "read", "Read one.go"),
        tool("r2", null, "read", "Read two.go"),
        tool("s1", null, "search", "Search abc"),
        tool("s2", null, "search", "Search xyz"),
      ],
      "codex",
    );
    expect(items.flatMap((item) => (item.type === "tools" ? [item.calls.map((call) => call.id)] : []))).toEqual([
      ["c1", "c2"],
      ["r1", "r2"],
      ["s1", "s2"],
    ]);
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
  it("resolves Unicode, spaces, parent paths and local file URLs", () => {
    expect(pathLink("/tmp/输出 目录/报告.md:12:5", cwd)).toEqual({
      path: "/tmp/输出 目录/报告.md",
      line: 11,
      col: 4,
    });
    expect(pathLink("./输出/报告.md", cwd)).toEqual({ path: "/repo/输出/报告.md" });
    expect(pathLink("../报告 一.md", cwd)).toEqual({ path: "/报告 一.md" });
    expect(pathLink("C:\\Users\\me\\report.md:3", cwd)).toEqual({ path: "C:/Users/me/report.md", line: 2 });
    expect(fileHref("file:///tmp/%E6%8A%A5%E5%91%8A%20one.md#L7", cwd)).toEqual({
      path: "/tmp/报告 one.md",
      line: 6,
    });
    expect(fileHref("file://remote-host/tmp/report.md", cwd)).toBeNull();
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

describe("file paths in agent prose", () => {
  it("identifies local paths without consuming punctuation or web URLs", () => {
    const text = '已生成 /tmp/报告.md:12，另存为 src/out.ts 和 "new folder/结果.md"。 https://example.com/no.md';
    const tokens = filePathTokens(text, "/repo");
    expect(tokens.map((token) => text.slice(token.from, token.to))).toEqual([
      "/tmp/报告.md:12",
      "src/out.ts",
      "new folder/结果.md",
    ]);
    expect(tokens.map((token) => token.link.path)).toEqual([
      "/tmp/报告.md",
      "/repo/src/out.ts",
      "/repo/new folder/结果.md",
    ]);
    expect(tokens[0]!.link.line).toBe(11);
  });
  it("recognizes a path with spaces on its own line and a plain local file URL", () => {
    const text = "/tmp/generated files/报告 01.pdf\nfile:///tmp/report%20two.md";
    const tokens = filePathTokens(text, "/repo");
    expect(tokens.map((token) => text.slice(token.from, token.to))).toEqual([
      "/tmp/generated files/报告 01.pdf",
      "file:///tmp/report%20two.md",
    ]);
    expect(tokens.map((token) => token.link.path)).toEqual(["/tmp/generated files/报告 01.pdf", "/tmp/report two.md"]);
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
