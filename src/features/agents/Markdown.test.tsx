import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { Markdown } from "./Markdown";

const { openFile, openExternalUrl, probe, listeners } = vi.hoisted(() => ({
  openFile: vi.fn().mockResolvedValue(undefined),
  openExternalUrl: vi.fn().mockResolvedValue(undefined),
  probe: vi.fn(),
  listeners: new Set<(event: { created: string[]; modified: string[]; removed: string[] }) => void>(),
}));
vi.mock("@/workbench/contributions", () => ({ editorService: () => ({ openFile }) }));
vi.mock("@/platform/openUrl", () => ({ openExternalUrl }));
vi.mock("@/platform/ipc", async (original) => {
  const actual = await original<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    commands: { ...actual.commands, fsProbe: probe },
    onIdeEvent: (
      _type: string,
      listener: (event: { created: string[]; modified: string[]; removed: string[] }) => void,
    ) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  listeners.clear();
  probe.mockResolvedValue({ status: "ok", data: { size: 0, binary: false, tooLarge: false } });
  window.getSelection()?.removeAllRanges();
});

it("keeps one code toolbar and table wrapper when effects run again, and updates relative file links", async () => {
  const text =
    "```ts\nconst n = 1;\n```\n\n| Name | Result |\n| --- | --- |\n| Build | Passed |\n\nSee reports/result.md";
  const view = render(
    <StrictMode>
      <Markdown text={text} cwd="/first" />
    </StrictMode>,
  );
  expect(screen.getAllByRole("button", { name: "Copy Code" })).toHaveLength(1);
  const table = view.container.querySelector("table")!;
  expect(table.parentElement?.parentElement).toBe(view.container.firstElementChild);
  fireEvent.click(await screen.findByRole("link", { name: "reports/result.md" }));
  expect(openFile).toHaveBeenLastCalledWith("/first/reports/result.md", { focus: true, selection: undefined });
  view.rerender(
    <StrictMode>
      <Markdown text={text} cwd="/second" />
    </StrictMode>,
  );
  expect(screen.getAllByRole("button", { name: "Copy Code" })).toHaveLength(1);
  fireEvent.click(await screen.findByRole("link", { name: "reports/result.md" }));
  expect(openFile).toHaveBeenLastCalledWith("/second/reports/result.md", { focus: true, selection: undefined });
});

it.each([
  ["/Users/thomas/vmos-shots/tiktok-home.jpg", "/Users/thomas/vmos-shots/tiktok-home.jpg", undefined],
  ["images/home.jpg", "/repo/images/home.jpg", undefined],
  ["/tmp/截图%20one.jpg", "/tmp/截图 one.jpg", undefined],
  ["/repo/main.rs:12:5", "/repo/main.rs", { line: 11, col: 4 }],
  ["/repo/main.rs#L7", "/repo/main.rs", { line: 6, col: 0 }],
  ["file:///tmp/%E6%8A%A5%E5%91%8A%20one.md#L7", "/tmp/报告 one.md", { line: 6, col: 0 }],
])("opens a Markdown file link: %s", (href, path, selection) => {
  render(<Markdown text={`[查看文件](${href})`} cwd="/repo" />);
  fireEvent.click(screen.getByRole("link", { name: "查看文件" }));
  expect(openFile).toHaveBeenCalledWith(path, { focus: true, selection });
  expect(openExternalUrl).not.toHaveBeenCalled();
});

it("keeps web links external", () => {
  render(<Markdown text="[Website](https://example.com/image.jpg)" cwd="/repo" />);
  fireEvent.click(screen.getByRole("link"));
  expect(openExternalUrl).toHaveBeenCalledWith("https://example.com/image.jpg");
  expect(openFile).not.toHaveBeenCalled();
});

it("still sanitizes untrusted markup and script URLs", () => {
  const { container } = render(
    <Markdown
      text={'[bad](javascript:alert(1)) <img src="x" onerror="alert(1)"><script>alert(1)</script>'}
      cwd="/repo"
    />,
  );
  expect(container.querySelector("script")).toBeNull();
  expect(container.querySelector("img")).not.toHaveAttribute("onerror");
  fireEvent.click(screen.getByText("bad"));
  expect(openFile).not.toHaveBeenCalled();
  expect(openExternalUrl).not.toHaveBeenCalled();
});

it.each(["#section", "//example.com/image.jpg", "javascript:alert(1)", "/tmp/%ZZ.jpg", "file://remote/tmp/a.md"])(
  "does not open unsupported links as files: %s",
  (href) => {
    const { container } = render(<Markdown text={`[Link](${href})`} cwd="/repo" />);
    fireEvent.click(container.querySelector("a")!);
    expect(openFile).not.toHaveBeenCalled();
    expect(openExternalUrl).not.toHaveBeenCalled();
  },
);

it("opens existing paths in prose, including Unicode and line numbers", async () => {
  render(<Markdown text="已生成 /tmp/报告文件.pdf:12:5 和 reports/季度分析.md。" cwd="/repo" />);
  fireEvent.click(await screen.findByRole("link", { name: "/tmp/报告文件.pdf:12:5" }));
  expect(openFile).toHaveBeenCalledWith("/tmp/报告文件.pdf", { focus: true, selection: { line: 11, col: 4 } });
  const relative = await screen.findByRole("link", { name: "reports/季度分析.md" });
  fireEvent.keyDown(relative, { key: "Enter" });
  expect(openFile).toHaveBeenCalledWith("/repo/reports/季度分析.md", { focus: true, selection: undefined });
});

it("opens quoted and code paths containing spaces", async () => {
  render(<Markdown text={'文件 "/tmp/generated files/报告 01.pdf" 和 `/tmp/截图 02.png`'} cwd="/repo" />);
  fireEvent.click(await screen.findByRole("link", { name: "/tmp/generated files/报告 01.pdf" }));
  fireEvent.click(await screen.findByRole("link", { name: "/tmp/截图 02.png" }));
  expect(openFile).toHaveBeenCalledWith("/tmp/generated files/报告 01.pdf", { focus: true, selection: undefined });
  expect(openFile).toHaveBeenCalledWith("/tmp/截图 02.png", { focus: true, selection: undefined });
});

it("opens an unquoted path containing spaces on its own line", async () => {
  render(<Markdown text="/tmp/generated items/报告 03.pdf" cwd="/repo" />);
  fireEvent.click(await screen.findByRole("link", { name: "/tmp/generated items/报告 03.pdf" }));
  expect(openFile).toHaveBeenCalledWith("/tmp/generated items/报告 03.pdf", { focus: true, selection: undefined });
});

it("links a single path in a code block but not code containing a path", async () => {
  probe.mockImplementation(async (path: string) =>
    path === "/tmp/generated-report.csv"
      ? { status: "ok", data: { size: 0, binary: false, tooLarge: false } }
      : { status: "error", error: { kind: "notFound", message: "missing", data: null } },
  );
  render(
    <Markdown
      text={'```\n/tmp/generated-report.csv\n```\n\n```js\nconst file = "/tmp/example.js";\n```'}
      cwd="/repo"
    />,
  );
  fireEvent.click(await screen.findByRole("link", { name: "/tmp/generated-report.csv" }));
  expect(openFile).toHaveBeenCalledWith("/tmp/generated-report.csv", { focus: true, selection: undefined });
  expect(screen.queryByRole("link", { name: /const file/ })).not.toBeInTheDocument();
});

it("links a newly created file after an earlier existence check failed", async () => {
  probe.mockResolvedValueOnce({ status: "error", error: { kind: "notFound", message: "missing", data: null } });
  render(<Markdown text="`generated/new report.md`" cwd="/repo" />);
  await waitFor(() => expect(probe).toHaveBeenCalledWith("/repo/generated/new report.md"));
  expect(screen.queryByRole("link", { name: "generated/new report.md" })).not.toBeInTheDocument();
  act(() =>
    listeners.forEach((listener) =>
      listener({ created: ["/repo/generated/new report.md"], modified: [], removed: [] }),
    ),
  );
  fireEvent.click(await screen.findByRole("link", { name: "generated/new report.md" }));
  expect(openFile).toHaveBeenCalledWith("/repo/generated/new report.md", { focus: true, selection: undefined });
});

it("does not crash when a file check cannot start", async () => {
  probe.mockImplementationOnce(() => {
    throw new Error("not connected");
  });
  render(<Markdown text="`/tmp/unavailable-agent-file.txt`" cwd="/repo" />);
  await waitFor(() => expect(probe).toHaveBeenCalledWith("/tmp/unavailable-agent-file.txt"));
  expect(screen.queryByRole("link", { name: "/tmp/unavailable-agent-file.txt" })).not.toBeInTheDocument();
});
