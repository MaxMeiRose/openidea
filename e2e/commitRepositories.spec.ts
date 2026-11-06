import type { Page } from "@playwright/test";
import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

async function stubRepositories(page: Page) {
  await stubDesktop(page);
  await page.evaluate(async () => {
    const roots = ["/dev/acme-api/frontend", "/dev/acme-api/backend"];
    const files = roots.map((root, index) => ({
      path: `${root}/${index === 0 ? "client.ts" : "server.ts"}`,
      relPath: index === 0 ? "client.ts" : "server.ts",
      staged: index === 1 ? "modified" : null,
      unstaged: index === 0 ? "modified" : null,
      renamedFrom: null,
    }));
    const staged = new Set(files.filter((file) => file.staged).map((file) => file.path));
    const committed = new Set<string>();
    const handlers = window.__ipc.handlers;
    handlers.vcs_roots = () => roots.map((root) => ({ root, operation: null, head: "main", headCommit: "1111111" }));
    handlers.vcs_branch_info = () => ({
      head: "main",
      headCommit: "1111111",
      upstream: null,
      ahead: 0,
      behind: 0,
      operation: null,
    });
    handlers.vcs_status = () => files.filter((file) => !committed.has(file.path));
    handlers.vcs_stage = (args) => {
      for (const path of args.paths as string[]) staged.add(path);
      return null;
    };
    handlers.vcs_unstage = (args) => {
      for (const path of args.paths as string[]) staged.delete(path);
      return null;
    };
    handlers.vcs_commit = (args) => {
      for (const path of staged) if (path.startsWith(`${args.repo}/`)) committed.add(path);
      return "2222222";
    };
    const module = "/src/features/vcs/store.ts";
    const { useVcs, refreshNow } = await import(/* @vite-ignore */ module);
    useVcs.setState({
      available: true,
      root: "/dev/acme-api",
      repo: roots[0],
      roots,
      branchesLoaded: false,
      stashesLoaded: false,
    });
    await refreshNow();
  });
}

test("commit changes start unchecked and another repository stays unchecked after committing", async ({
  workbench: page,
}, testInfo) => {
  await stubRepositories(page);
  await page.keyboard.press("Meta+k");
  const panel = page.getByRole("region", { name: "Commit", exact: true });
  const changes = panel.getByRole("tree", { name: "Changes" });
  const client = changes.getByRole("checkbox", { name: "Include client.ts in commit" });
  const server = changes.getByRole("checkbox", { name: "Include server.ts in commit" });
  await expect(client).toBeVisible();
  await expect(server).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("commit-defaults.png"), animations: "disabled" });
  await expect(client).not.toBeChecked();
  await expect(server).not.toBeChecked();
  await expect(panel.getByRole("button", { name: "Commit", exact: true })).toBeDisabled();

  await client.click();
  await expect(server).not.toBeChecked();
  await panel.getByRole("textbox", { name: "Commit message" }).fill("Fix client");
  await panel.getByRole("button", { name: "Commit", exact: true }).click();
  await expect(client).toBeHidden();
  await expect(server).not.toBeChecked();
  expect(await ipcCalls(page, "vcs_commit")).toEqual([
    expect.objectContaining({ repo: "/dev/acme-api/frontend", message: "Fix client" }),
  ]);
  expect((await ipcCalls(page, "vcs_stage")).flatMap((args) => args.paths as string[])).toEqual([
    "/dev/acme-api/frontend/client.ts",
  ]);
  expect(await ipcCalls(page, "vcs_unstage")).toEqual([]);

  await page.evaluate(async () => {
    const module = "/src/features/vcs/store.ts";
    const { selectRepo } = await import(/* @vite-ignore */ module);
    await selectRepo("/dev/acme-api/backend");
  });
  await expect(server).not.toBeChecked();
  await expect(panel.getByRole("button", { name: "Commit", exact: true })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath("commit-after.png"), animations: "disabled" });
});
