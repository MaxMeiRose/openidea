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
      vcsConfigGet: async () => ({ status: "ok", data: null }),
    },
  };
});

import { checkOf } from "../changes";
import { forgetAmendDraft, installPreparedMessage, setAmend, useCommit } from "../commitStore";
import { useVcs } from "../store";

const a = "/project/a";
const b = "/project/b";
const file = (root: string, name: string, kind: FileStatus["unstaged"] = "modified"): FileStatus => ({
  path: `${root}/${name}`,
  relPath: name,
  staged: null,
  unstaged: kind,
  renamedFrom: null,
});
const tracked = file(a, "tracked.ts");
const added = file(a, "new.ts", "untracked");
const other = file(b, "other.ts");
const conflict = file(a, "conflict.ts", "conflicted");
const reply = (message: string) => ({ status: "ok" as const, data: [{ message }] });

beforeEach(() => {
  localStorage.clear();
  forgetAmendDraft();
  log.mockReset().mockImplementation(async (repo) => reply(repo === b ? "Previous B commit" : "Previous A commit"));
  useVcs.setState({
    root: "/project",
    repo: a,
    roots: [a, b],
    status: [tracked, added, other, conflict],
    branch: null,
  });
  useCommit.setState({ message: "Ordinary draft", amend: false, checks: new Map(), excludedHunks: new Map() });
});

describe("Amend selection", () => {
  it("checks committable changes only in the selected repository", async () => {
    useCommit.setState({ checks: new Map([[other.path, "all"]]) });
    await setAmend(true);
    const checks = useCommit.getState().checks;
    expect(checkOf(tracked, checks)).toBe("all");
    expect(checkOf(added, checks)).toBe("all");
    expect(checkOf(other, checks)).toBe("none");
    expect(checkOf(conflict, checks)).toBe("none");
    expect(useCommit.getState().message).toBe("Previous A commit");
  });

  it("restores ordinary selections when Amend is disabled and keeps manual exclusions", async () => {
    useCommit.setState({ checks: new Map([[other.path, "all"]]) });
    await setAmend(true);
    useCommit.setState((state) => ({ checks: new Map(state.checks).set(tracked.path, "none") }));
    await setAmend(false);
    const checks = useCommit.getState().checks;
    expect(checkOf(tracked, checks)).toBe("none");
    expect(checkOf(added, checks)).toBe("none");
    expect(checkOf(other, checks)).toBe("all");
    expect(useCommit.getState().message).toBe("Ordinary draft");
  });

  it("includes new changes on refresh without checking a manually excluded file again", async () => {
    const dispose = installPreparedMessage();
    try {
      await setAmend(true);
      useCommit.setState((state) => ({ checks: new Map(state.checks).set(tracked.path, "none") }));
      const fresh = file(a, "fresh.ts");
      useVcs.setState({ status: [tracked, added, other, conflict, fresh] });
      expect(checkOf(fresh, useCommit.getState().checks)).toBe("all");
      expect(checkOf(tracked, useCommit.getState().checks)).toBe("none");
      expect(checkOf(other, useCommit.getState().checks)).toBe("none");
    } finally {
      dispose();
    }
  });

  it("follows the selected repository while Amend is enabled", async () => {
    const dispose = installPreparedMessage();
    try {
      await setAmend(true);
      useVcs.setState({ repo: b });
      await vi.waitFor(() => expect(useCommit.getState().message).toBe("Previous B commit"));
      expect(checkOf(tracked, useCommit.getState().checks)).toBe("none");
      expect(checkOf(other, useCommit.getState().checks)).toBe("all");
    } finally {
      dispose();
    }
  });

  it("ignores a late message from another repository", async () => {
    let resolve!: (value: ReturnType<typeof reply>) => void;
    log.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const dispose = installPreparedMessage();
    try {
      const pending = setAmend(true);
      useVcs.setState({ repo: b });
      await vi.waitFor(() => expect(useCommit.getState().message).toBe("Previous B commit"));
      resolve(reply("Late A commit"));
      await pending;
      expect(useCommit.getState().message).toBe("Previous B commit");
    } finally {
      dispose();
    }
  });

  it("does not replace a draft edited while the previous commit message is loading", async () => {
    let resolve!: (value: ReturnType<typeof reply>) => void;
    log.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = setAmend(true);
    useCommit.setState({ message: "New manual draft" });
    resolve(reply("Previous A commit"));
    await pending;
    expect(useCommit.getState().message).toBe("New manual draft");
  });
});
