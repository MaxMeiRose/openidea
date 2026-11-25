import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileStatus } from "@/bindings";

const log = vi.hoisted(() => vi.fn());
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsLog: (...args: unknown[]) => log(...args),
      vcsCommitFiles: async () => ({ status: "ok", data: [] }),
      vcsConfigGet: async () => ({ status: "ok", data: null }),
    },
  };
});

import { checkOf } from "../changes";
import { currentPlan } from "../commitSelection";
import { installCommitMessages, setAmend, useCommit } from "../commitStore";
import { DEFAULT_LIST_ID, initialChangelists, useChangelists } from "../changelists";
import { useVcs } from "../store";
import { useProject } from "@/platform/project";

const a = "/project/a";
const b = "/project/b";
const file = (root: string, name: string, kind: FileStatus["unstaged"] = "modified"): FileStatus => ({
  path: root + "/" + name,
  relPath: name,
  staged: null,
  unstaged: kind,
  renamedFrom: null,
});
const tracked = file(a, "tracked.ts");
const added = file(a, "new.ts", "untracked");
const other = file(b, "other.ts");
const otherAdded = file(b, "new.ts", "untracked");
const conflict = file(a, "conflict.ts", "conflicted");
const files = [tracked, added, other, otherAdded, conflict];
const checksFor = (...included: FileStatus[]) =>
  new Map(files.map((entry) => [entry.path, included.includes(entry) ? ("all" as const) : ("none" as const)]));
const reply = (message: string) => ({ status: "ok" as const, data: [{ id: "head", message }] });

beforeEach(async () => {
  await setAmend(false);
  localStorage.clear();
  log.mockReset().mockImplementation(async (repo) => reply(repo === b ? "Previous B commit" : "Previous A commit"));
  useProject.setState({
    settings: { vcs: { git: { stagingArea: false }, commit: { includeChangesByDefault: false } } },
  });
  useVcs.setState({
    root: "/project",
    repo: a,
    roots: [a, b],
    status: files,
    branch: null,
  });
  useChangelists.setState({ root: null, loaded: false, state: initialChangelists() });
  useCommit.setState({
    message: "Ordinary draft",
    messageChangelist: DEFAULT_LIST_ID,
    amend: false,
    amendPreview: null,
    amendTarget: null,
    author: "",
    authorDate: null,
    checks: checksFor(),
    excludedHunks: new Map(),
    excludedHunkLines: new Map(),
    excludedStagedRepos: new Set(),
    groupByRepo: true,
    selection: [],
    selectionKeys: [],
  });
});

describe("Amend inclusion", () => {
  it("requires an included file before enabling Amend", async () => {
    await setAmend(true);
    expect(useCommit.getState().amend).toBe(false);
    expect(useCommit.getState().message).toBe("Ordinary draft");
    expect(log).not.toHaveBeenCalled();
  });

  it("uses the checked repository and preserves file and tree selections", async () => {
    const checks = checksFor(other);
    useCommit.setState({ checks, selection: [other.path], selectionKeys: ["file:" + other.path] });
    await setAmend(true);
    expect(log).toHaveBeenCalledWith(b, expect.objectContaining({ branch: "HEAD", limit: 1 }));
    expect(useCommit.getState()).toMatchObject({
      amend: true,
      message: "Previous B commit",
      amendPreview: { root: b, status: "ready" },
      selection: [other.path],
      selectionKeys: ["file:" + other.path],
    });
    expect(useCommit.getState().checks).toBe(checks);
    expect(currentPlan().repositories).toEqual([b]);
    expect(currentPlan().included).toEqual([other]);
    expect(checkOf(added, checks)).toBe("none");
    expect(checkOf(otherAdded, checks)).toBe("none");
  });

  it("keeps explicitly checked untracked files included", async () => {
    const checks = checksFor(otherAdded);
    useCommit.setState({ checks });
    await setAmend(true);
    expect(useCommit.getState().checks).toBe(checks);
    expect(currentPlan().included).toEqual([otherAdded]);
    expect(log).toHaveBeenCalledWith(b, expect.anything());
  });

  it("preserves selected repositories and the draft when several repositories are checked", async () => {
    const checks = checksFor(tracked, other);
    useCommit.setState({ checks });
    await setAmend(true);
    expect(useCommit.getState()).toMatchObject({ amend: true, message: "Ordinary draft", amendPreview: null });
    expect(useCommit.getState().checks).toBe(checks);
    expect(new Set(currentPlan().repositories)).toEqual(new Set([a, b]));
    expect(log).not.toHaveBeenCalled();
  });

  it("preserves manual file exclusions when Amend is disabled", async () => {
    useCommit.setState({ checks: checksFor(other, otherAdded) });
    await setAmend(true);
    const checks = new Map(useCommit.getState().checks).set(otherAdded.path, "none" as const);
    useCommit.setState({ checks });
    await setAmend(false);
    expect(useCommit.getState().checks).toBe(checks);
    expect(currentPlan().included).toEqual([other]);
    expect(useCommit.getState().message).toBe("Ordinary draft");
  });

  it("clears Amend when the last file is unchecked and leaves it unchecked after reselection", async () => {
    const dispose = installCommitMessages();
    try {
      useCommit.setState({ checks: checksFor(other) });
      await setAmend(true);
      useCommit.setState({ checks: checksFor() });
      expect(useCommit.getState()).toMatchObject({ amend: false, amendPreview: null, message: "Ordinary draft" });
      useCommit.setState({ checks: checksFor(other) });
      expect(useCommit.getState().amend).toBe(false);
      expect(currentPlan().included).toEqual([other]);
    } finally {
      dispose();
    }
  });

  it("clears Amend when checked files disappear from the status", async () => {
    const dispose = installCommitMessages();
    try {
      useCommit.setState({ checks: checksFor(other) });
      await setAmend(true);
      useVcs.setState({ status: [] });
      expect(useCommit.getState()).toMatchObject({ amend: false, amendPreview: null });
      useVcs.setState({ status: files });
      expect(useCommit.getState().amend).toBe(false);
    } finally {
      dispose();
    }
  });

  it("preserves exclusions when new tracked and untracked files appear", async () => {
    const dispose = installCommitMessages();
    try {
      const checks = checksFor(other);
      useCommit.setState({ checks });
      await setAmend(true);
      const fresh = file(b, "fresh.ts");
      const untracked = file(b, "fresh-new.ts", "untracked");
      useVcs.setState({ status: [...files, fresh, untracked] });
      expect(useCommit.getState().checks).toBe(checks);
      expect(currentPlan().included).toEqual([other]);
    } finally {
      dispose();
    }
  });

  it("keeps the checked repository when the active repository changes", async () => {
    const dispose = installCommitMessages();
    try {
      useCommit.setState({ checks: checksFor(other) });
      await setAmend(true);
      useVcs.setState({ repo: b });
      useVcs.setState({ repo: a });
      expect(useCommit.getState().message).toBe("Previous B commit");
      expect(currentPlan().repositories).toEqual([b]);
    } finally {
      dispose();
    }
  });

  it("updates the original commit when a different repository's files are checked", async () => {
    const dispose = installCommitMessages();
    try {
      useCommit.setState({ checks: checksFor(other) });
      await setAmend(true);
      const checks = checksFor(tracked);
      useCommit.setState({ checks });
      await vi.waitFor(() => expect(useCommit.getState().message).toBe("Previous A commit"));
      expect(useCommit.getState().checks).toBe(checks);
      expect(currentPlan().repositories).toEqual([a]);
    } finally {
      dispose();
    }
  });

  it("restores the shared draft when files from a second repository are included", async () => {
    const dispose = installCommitMessages();
    try {
      useCommit.setState({ checks: checksFor(other) });
      await setAmend(true);
      const checks = checksFor(tracked, other);
      useCommit.setState({ checks });
      expect(useCommit.getState()).toMatchObject({ amend: true, message: "Ordinary draft", amendPreview: null });
      expect(useCommit.getState().checks).toBe(checks);
      expect(new Set(currentPlan().repositories)).toEqual(new Set([a, b]));
    } finally {
      dispose();
    }
  });

  it("discards a pending commit message after the last file is unchecked", async () => {
    let resolve!: (value: ReturnType<typeof reply>) => void;
    log.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const dispose = installCommitMessages();
    try {
      useCommit.setState({ checks: checksFor(other) });
      const pending = setAmend(true);
      useCommit.setState({ checks: checksFor() });
      resolve(reply("Late B commit"));
      await pending;
      expect(useCommit.getState()).toMatchObject({ amend: false, message: "Ordinary draft", amendPreview: null });
    } finally {
      dispose();
    }
  });

  it("preserves a draft edited while the previous commit message is loading", async () => {
    let resolve!: (value: ReturnType<typeof reply>) => void;
    log.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    useCommit.setState({ checks: checksFor(other) });
    const pending = setAmend(true);
    useCommit.setState({ message: "New manual draft" });
    resolve(reply("Previous B commit"));
    await pending;
    expect(useCommit.getState().message).toBe("New manual draft");
  });
});
