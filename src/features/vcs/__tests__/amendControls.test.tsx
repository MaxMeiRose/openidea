import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
vi.mock("../DiffEditor", () => ({ DiffEditor: () => null }));

import { ChangesTree, CommitMessageField, type CommitRunner } from "../CommitView";
import { initialChangelists, useChangelists } from "../changelists";
import { setAmend, useCommit } from "../commitStore";
import { currentPlan } from "../commitSelection";
import { useVcs } from "../store";
import { useProject } from "@/platform/project";

const files: FileStatus[] = [
  { path: "/p/a/client.ts", relPath: "client.ts", staged: null, unstaged: "modified", renamedFrom: null },
  { path: "/p/b/server.ts", relPath: "server.ts", staged: null, unstaged: "modified", renamedFrom: null },
  { path: "/p/b/new.ts", relPath: "new.ts", staged: null, unstaged: "untracked", renamedFrom: null },
];
const runner: CommitRunner = { emptyError: false, clearEmptyError: () => {}, canCommit: false, run: async () => {} };

beforeEach(async () => {
  await setAmend(false);
  localStorage.clear();
  log.mockReset().mockResolvedValue({ status: "ok", data: [{ id: "head", message: "Previous server commit" }] });
  useProject.setState({
    settings: { vcs: { git: { stagingArea: false }, commit: { includeChangesByDefault: false } } },
  });
  useVcs.setState({ root: "/p", repo: "/p/a", roots: ["/p/a", "/p/b"], status: files });
  useChangelists.setState({ root: null, loaded: false, state: initialChangelists() });
  useCommit.setState({
    message: "Draft",
    amend: false,
    amendPreview: null,
    checks: new Map(files.map((file) => [file.path, "none"])),
    excludedStagedRepos: new Set(),
    groupByRepo: true,
    selection: [],
    selectionKeys: [],
  });
});

function renderControls() {
  render(
    <>
      <ChangesTree mode="commit" />
      <CommitMessageField runner={runner} />
    </>,
  );
  return screen.getByRole("checkbox", { name: "Amend" });
}

describe("Amend controls", () => {
  it("disables Amend until files are checked, including when a tree row is selected", () => {
    useCommit.setState({ selection: [files[1]!.path] });
    const amend = renderControls();
    expect(amend).toBeDisabled();
    expect(amend).not.toBeChecked();
    fireEvent.mouseDown(screen.getByRole("checkbox", { name: "Include server.ts in commit" }));
    expect(amend).toBeEnabled();
    expect(amend).not.toBeChecked();
  });

  it("preserves checked files and resets Amend before disabling it after the last file is unchecked", async () => {
    const amend = renderControls();
    const server = screen.getByRole("checkbox", { name: "Include server.ts in commit" });
    const client = screen.getByRole("checkbox", { name: "Include client.ts in commit" });
    fireEvent.mouseDown(server);
    fireEvent.click(amend);
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Commit message" })).toHaveValue("Previous server commit"),
    );
    expect(server).toBeChecked();
    expect(client).not.toBeChecked();
    expect(currentPlan().included).toEqual([files[1]]);
    expect(log).toHaveBeenCalledWith("/p/b", expect.anything());
    fireEvent.mouseDown(server);
    expect(amend).not.toBeChecked();
    expect(amend).toBeDisabled();
    expect(useCommit.getState().amend).toBe(false);
    fireEvent.mouseDown(client);
    expect(amend).toBeEnabled();
    expect(amend).not.toBeChecked();
  });

  it("clears an active Amend when included files disappear", async () => {
    const amend = renderControls();
    fireEvent.mouseDown(screen.getByRole("checkbox", { name: "Include server.ts in commit" }));
    fireEvent.click(amend);
    await waitFor(() => expect(amend).toBeChecked());
    act(() => useVcs.setState({ status: [] }));
    expect(amend).toBeDisabled();
    expect(amend).not.toBeChecked();
    expect(useCommit.getState().amend).toBe(false);
  });
});
