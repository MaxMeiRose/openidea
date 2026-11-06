import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileStatus, LineHunk, Settings } from "@/bindings";

const mocks = vi.hoisted(() => ({
  fileAt: vi.fn(),
  working: vi.fn(),
  hunks: vi.fn(),
  generate: vi.fn(),
  cancel: vi.fn(),
  log: vi.fn(),
  files: vi.fn(),
}));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsFileAt: mocks.fileAt,
      vcsDiffHunks: mocks.hunks,
      agentGenerateCommitMessage: mocks.generate,
      cancelRequest: mocks.cancel,
      vcsLog: mocks.log,
      vcsCommitFiles: mocks.files,
    },
  };
});
vi.mock("../ops", () => ({ readWorkingText: mocks.working }));

import { useProject } from "@/platform/project";
import { initialChangelists, useChangelists } from "../changelists";
import { cancelCommitAi, commitAiContext, generateCommitMessage, useCommitAi } from "../commitAi";
import { useCommit } from "../commitStore";
import { hunkKeys } from "../hunks";
import { useVcs } from "../store";

const file: FileStatus = {
  path: "/p/a/selected.ts",
  relPath: "selected.ts",
  staged: "modified",
  unstaged: "modified",
  renamedFrom: null,
};
const other: FileStatus = { ...file, path: "/p/b/other.ts", relPath: "other.ts" };
const before = "old1\nmid\nold2\n";
const after = "new1\nmid\nnew2\n";
const hunks: LineHunk[] = [
  { start: 0, lines: 1, oldStart: 0, oldLines: 1, oldText: "old1\n", kind: "modified" },
  { start: 2, lines: 1, oldStart: 2, oldLines: 1, oldText: "old2\n", kind: "modified" },
];
const ok = <T>(data: T) => ({ status: "ok" as const, data });

beforeEach(() => {
  vi.resetAllMocks();
  useVcs.setState({ root: "/p", repo: "/p/a", roots: ["/p/a", "/p/b"], status: [file, other] });
  useCommit.setState({
    message: "Draft",
    amend: false,
    checks: new Map([[file.path, "all"]]),
    excludedHunks: new Map(),
  });
  useChangelists.setState({ state: initialChangelists() });
  useProject.setState({
    settings: {
      vcs: { commit: { aiProvider: "claude", aiClaudeModel: "sonnet", aiPrompt: "Use a concise Chinese subject." } },
    } as Settings,
  });
  useCommitAi.setState({ request: null, error: null });
  mocks.fileAt.mockResolvedValue(ok(before));
  mocks.working.mockResolvedValue(after);
  mocks.hunks.mockResolvedValue(hunks);
  mocks.generate.mockResolvedValue(ok("fix(vcs): keep repository selections"));
  mocks.cancel.mockResolvedValue(undefined);
});

describe("AI commit messages", () => {
  it("sends only checked files and uses the configured CLI, model and prompt", async () => {
    await generateCommitMessage();
    const [provider, repo, model, input] = mocks.generate.mock.calls[0]!;
    expect([provider, repo, model]).toEqual(["claude", "/p/a", "sonnet"]);
    const context = JSON.parse(input);
    expect(context.instructions).toBe("Use a concise Chinese subject.");
    expect(context.files.map((item: { path: string }) => item.path)).toEqual(["selected.ts"]);
    expect(mocks.working.mock.calls.every(([path]) => path === file.path)).toBe(true);
    expect(useCommit.getState().message).toBe("fix(vcs): keep repository selections");
    expect(useCommitAi.getState()).toMatchObject({ request: null, error: null });
  });

  it("uses the index when only staged changes are selected", async () => {
    useCommit.setState({ checks: new Map([[file.path, "staged"]]) });
    await commitAiContext();
    expect(mocks.fileAt).toHaveBeenCalledWith(file.path, ":0");
    expect(mocks.working).not.toHaveBeenCalled();
  });

  it("describes the staged change type when the working tree has a different type", async () => {
    useVcs.setState({ status: [{ ...file, staged: "modified", unstaged: "deleted" }] });
    useCommit.setState({ checks: new Map([[file.path, "staged"]]) });
    const { context } = await commitAiContext();
    expect(JSON.parse(context).files[0]).toMatchObject({ kind: "modified", selection: "staged" });
    expect(mocks.working).not.toHaveBeenCalled();
  });

  it("excludes unchecked changed blocks from the prompt", async () => {
    useCommit.setState({
      checks: new Map([[file.path, "hunks"]]),
      excludedHunks: new Map([[file.path, new Set([hunkKeys(after, hunks)[1]!])]]),
    });
    const { context } = await commitAiContext();
    expect(context).toContain("new1");
    expect(context).not.toContain("new2");
    expect(context).not.toContain("old2");
  });

  it("includes the existing commit intent when amending without new files", async () => {
    useCommit.setState({ checks: new Map(), amend: true });
    mocks.log.mockResolvedValue(ok([{ id: "abc", message: "fix: original intent" }]));
    mocks.files.mockResolvedValue(ok([{ path: "previous.ts", kind: "modified" }]));
    const { context } = await commitAiContext();
    expect(JSON.parse(context)).toMatchObject({
      amend: true,
      files: [],
      previousCommit: { message: "fix: original intent", files: [{ path: "previous.ts" }] },
    });
  });

  it("rejects an empty ordinary selection before calling the CLI", async () => {
    useCommit.setState({ checks: new Map() });
    await generateCommitMessage();
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(useCommitAi.getState().error).toContain("Select changes");
    expect(useCommit.getState().message).toBe("Draft");
  });

  it("rejects changes checked in more than the current repository", async () => {
    useCommit.setState({
      checks: new Map([
        [file.path, "all"],
        [other.path, "all"],
      ]),
    });
    await generateCommitMessage();
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(useCommitAi.getState().error).toContain("one repository");
  });

  it("discards a result when selected file contents changed during generation", async () => {
    let resolve!: (value: ReturnType<typeof ok<string>>) => void;
    mocks.generate.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = generateCommitMessage();
    await vi.waitFor(() => expect(mocks.generate).toHaveBeenCalled());
    mocks.working.mockResolvedValue("different content\n");
    mocks.hunks.mockResolvedValue([{ ...hunks[0], lines: 1 }]);
    resolve(ok("Obsolete result"));
    await pending;
    expect(useCommit.getState().message).toBe("Draft");
    expect(useCommitAi.getState().error).toContain("changed during generation");
  });

  it.each(["draft", "repository", "selection", "cancel"])("ignores a late result after changing %s", async (change) => {
    let resolve!: (value: ReturnType<typeof ok<string>>) => void;
    mocks.generate.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = generateCommitMessage();
    await vi.waitFor(() => expect(mocks.generate).toHaveBeenCalled());
    if (change === "draft") useCommit.setState({ message: "New draft" });
    if (change === "repository") useVcs.setState({ repo: "/p/b" });
    if (change === "selection") useCommit.setState({ checks: new Map() });
    if (change === "cancel") cancelCommitAi();
    resolve(ok("Late result"));
    await pending;
    expect(useCommit.getState().message).toBe(change === "draft" ? "New draft" : "Draft");
    expect(mocks.cancel).toHaveBeenCalled();
    expect(useCommitAi.getState().request).toBeNull();
  });

  it("retains the draft and shows an actionable CLI failure", async () => {
    mocks.generate.mockRejectedValue(new Error("Please sign in to Claude Code"));
    await generateCommitMessage();
    expect(useCommit.getState().message).toBe("Draft");
    expect(useCommitAi.getState()).toMatchObject({ request: null, error: "Error: Please sign in to Claude Code" });
  });
});
