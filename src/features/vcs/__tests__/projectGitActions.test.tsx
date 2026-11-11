import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getAction } from "@/platform/actions";

const mocks = vi.hoisted(() => ({ remotes: vi.fn(), log: vi.fn() }));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: { ...real.commands, vcsRemotes: mocks.remotes, vcsLog: mocks.log },
  };
});

import { registerVcsActions } from "../actions";
import { VcsDialogHost } from "../dialogs";
import * as ops from "../ops";
import { showPushDialog } from "../remoteUi";
import * as vcsStore from "../store";

beforeEach(() => {
  vcsStore.useVcs.setState({
    available: true,
    root: "/p",
    roots: ["/p/front", "/p/back"],
    repo: "/p/front",
    branch: {
      head: "front-main",
      headCommit: "abc",
      upstream: "origin/front-main",
      ahead: 1,
      behind: 0,
      operation: null,
    },
    branches: [],
  });
  mocks.remotes.mockResolvedValue({ status: "ok", data: [{ name: "origin", fetchUrl: "", pushUrl: "" }] });
  mocks.log.mockResolvedValue({ status: "ok", data: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vcsStore.useVcs.setState({ available: false, root: null, roots: [], repo: null, branch: null });
});

it("fetches only the selected repository from the project menu and retains the global action", async () => {
  const remote = vi.spyOn(ops, "runRemote").mockResolvedValue(true);
  const off = registerVcsActions();
  try {
    const fetch = getAction("vcs.fetch")!;
    await fetch.run({ arg: { repo: "/p/back" }, ctx: { vcsAvailable: true } });
    expect(remote).toHaveBeenLastCalledWith({ op: "fetch" }, undefined, ["/p/back"]);
    await fetch.run({ ctx: { vcsAvailable: true } });
    expect(remote).toHaveBeenLastCalledWith({ op: "fetch" }, undefined, ["/p/front", "/p/back"]);
  } finally {
    off();
  }
});

it("shows and loads the selected repository in the push dialog", async () => {
  vi.spyOn(vcsStore, "refreshNow").mockResolvedValue(undefined);
  const remote = vi.spyOn(ops, "runRemote").mockResolvedValue(true);
  render(<VcsDialogHost />);
  await act(async () => showPushDialog({ repo: "/p/front" }));
  expect(screen.getByText("Repository: front")).toBeInTheDocument();
  await waitFor(() => expect(mocks.remotes).toHaveBeenCalledWith("/p/front"));
  expect(mocks.log).toHaveBeenCalledWith("/p/front", expect.anything());
  expect(mocks.log.mock.calls.every(([repo]) => repo === "/p/front")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Push" }));
  await waitFor(() =>
    expect(remote).toHaveBeenCalledWith(
      expect.objectContaining({ op: "push" }),
      expect.any(String),
      ["/p/front"],
      expect.any(Function),
    ),
  );
});

it("does not open a targeted push if the selected repository changed during refresh", async () => {
  vi.spyOn(vcsStore, "refreshNow").mockImplementation(async () => {
    vcsStore.useVcs.setState({ repo: "/p/back" });
  });
  render(<VcsDialogHost />);
  await act(async () => showPushDialog({ repo: "/p/front" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
