import { describe, expect, it } from "vitest";
import { fileHref, filePathTokens, pathLink } from "./conversation";

describe("local file paths", () => {
  const cwd = "/repo";
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
