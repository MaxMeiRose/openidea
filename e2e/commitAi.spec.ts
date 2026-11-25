import type { Page } from "@playwright/test";
import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

async function prepareCommit(page: Page) {
  await stubDesktop(page);
  await page.evaluate(async () => {
    const root = "/dev/acme-api";
    const roots = [`${root}/frontend`, `${root}/backend`];
    const files = roots.map((repo, index) => ({
      path: `${repo}/${index === 0 ? "client.ts" : "server.ts"}`,
      relPath: index === 0 ? "client.ts" : "server.ts",
      staged: null,
      unstaged: "modified",
      renamedFrom: null,
    }));
    files.push(
      ...roots.map((repo, index) => ({
        path: `${repo}/${index === 0 ? "client-new.ts" : "server-new.ts"}`,
        relPath: index === 0 ? "client-new.ts" : "server-new.ts",
        staged: null,
        unstaged: "untracked",
        renamedFrom: null,
      })),
    );
    const projectModule = "/src/platform/project.ts";
    const { useProject } = await import(/* @vite-ignore */ projectModule);
    let settings = {
      ...useProject.getState().settings,
      vcs: {
        git: { stagingArea: false },
        commit: {
          includeChangesByDefault: false,
          aiProvider: "codex",
          aiCodexModel: "",
          aiClaudeModel: "",
          aiPrompt: "",
        },
      },
    };
    useProject.setState({ settings });
    Object.assign(window.__ipc.handlers, {
      vcs_roots: () => roots.map((repo) => ({ root: repo, operation: null, head: "main", headCommit: "1111111" })),
      vcs_branch_info: () => ({
        head: "main",
        headCommit: "1111111",
        upstream: null,
        ahead: 0,
        behind: 0,
        operation: null,
      }),
      vcs_status: () => files,
      vcs_file_at: () => "before\n",
      fs_read_text: () => "after\n",
      vcs_diff_hunks: () => [{ kind: "modified", start: 0, lines: 1, oldStart: 0, oldLines: 1, oldText: "before\n" }],
      vcs_log: (args: { repo: string }) => [
        {
          id: "1111111",
          message: args.repo === roots[1] ? "fix: previous server intent" : "fix: previous client intent",
        },
      ],
      vcs_commit_files: () => [{ path: "previous.ts", kind: "modified" }],
      agent_models: (args: { provider: string }) =>
        args.provider === "claude"
          ? [{ value: "sonnet", name: "Sonnet", description: null }]
          : [{ value: "codex-model", name: "Codex model", description: null }],
      agent_generate_commit_message: () => "fix(vcs): preserve repository selections",
      cancel_request: () => null,
      settings_get: () => settings,
      settings_get_global: () => settings,
      settings_set: (args: { key: string; value: string }) => {
        const key = args.key.split(".").pop()!;
        settings = {
          ...settings,
          vcs: { ...settings.vcs, commit: { ...settings.vcs.commit, [key]: JSON.parse(args.value) } },
        };
        return settings;
      },
    });
    const vcsModule = "/src/features/vcs/store.ts";
    const { useVcs, refreshNow } = await import(/* @vite-ignore */ vcsModule);
    useVcs.setState({ available: true, root, repo: roots[0], roots, branchesLoaded: false, stashesLoaded: false });
    await refreshNow();
  });
  await page.keyboard.press("Meta+k");
  return page.getByRole("region", { name: "Commit", exact: true });
}

test("AI generation follows checked repositories after unchecking the active repository", async ({
  workbench: page,
}, testInfo) => {
  const panel = await prepareCommit(page);
  const client = panel.getByRole("checkbox", { name: "Include client.ts in commit" });
  const server = panel.getByRole("checkbox", { name: "Include server.ts in commit" });
  const generate = panel.getByRole("button", { name: "Generate with AI", exact: true });
  const message = panel.getByRole("textbox", { name: "Commit message", exact: true });
  await client.check();
  await server.check();
  await client.uncheck();
  await expect(server).toBeChecked();
  await generate.click();
  await page.screenshot({ path: testInfo.outputPath("selected-repository.png"), animations: "disabled" });
  await expect(message).toHaveValue("fix(vcs): preserve repository selections");
  const [request] = await ipcCalls(page, "agent_generate_commit_message");
  expect(request).toMatchObject({ repo: "/dev/acme-api/backend" });
  expect(JSON.parse(request!.prompt as string).files).toMatchObject([
    { repository: "/dev/acme-api/backend", path: "server.ts" },
  ]);
  await expect(client).not.toBeChecked();

  await client.check();
  await generate.click();
  await expect.poll(async () => (await ipcCalls(page, "agent_generate_commit_message")).length).toBe(2);
  const [, combined] = await ipcCalls(page, "agent_generate_commit_message");
  expect(JSON.parse(combined!.prompt as string).files).toMatchObject([
    { repository: "/dev/acme-api/frontend", path: "client.ts" },
    { repository: "/dev/acme-api/backend", path: "server.ts" },
  ]);
});

test("Amend preserves checked files and AI generation uses their repository, tool and model", async ({
  workbench: page,
}, testInfo) => {
  const panel = await prepareCommit(page);
  const client = panel.getByRole("checkbox", { name: "Include client.ts in commit" });
  const server = panel.getByRole("checkbox", { name: "Include server.ts in commit" });
  const generate = panel.getByRole("button", { name: "Generate with AI", exact: true });
  await expect(client).not.toBeChecked();
  await expect(generate).toBeDisabled();
  await server.check();
  await panel.getByRole("checkbox", { name: "Amend", exact: true }).check();
  await expect(client).not.toBeChecked();
  await expect(server).toBeChecked();
  const untracked = panel.getByRole("treeitem", { name: /Unversioned Files/ }).first();
  await untracked.dblclick();
  await expect(panel.getByRole("checkbox", { name: "Include client-new.ts in commit" })).not.toBeChecked();
  await expect(panel.getByRole("checkbox", { name: "Include server-new.ts in commit" })).not.toBeChecked();
  await expect(panel.getByRole("textbox", { name: "Commit message", exact: true })).toHaveValue(
    "fix: previous server intent",
  );
  await panel.getByRole("button", { name: "Commit AI provider", exact: true }).click();
  await page.getByRole("option", { name: "Claude Code", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Commit AI provider", exact: true })).toContainText("Claude Code");
  await expect
    .poll(async () => (await ipcCalls(page, "agent_models")).some((args) => args.provider === "claude"))
    .toBe(true);
  await panel.getByRole("button", { name: "Commit AI model", exact: true }).click();
  await page.getByRole("option", { name: "Sonnet", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Commit AI model", exact: true })).toContainText("Sonnet");
  await generate.click();
  await expect(panel.getByRole("textbox", { name: "Commit message", exact: true })).toHaveValue(
    "fix(vcs): preserve repository selections",
  );
  const [request] = await ipcCalls(page, "agent_generate_commit_message");
  expect(request).toMatchObject({ provider: "claude", repo: "/dev/acme-api/backend", model: "sonnet" });
  expect(JSON.parse(request!.prompt as string)).toMatchObject({
    amend: true,
    files: [{ path: "server.ts" }],
    previousCommit: { message: "fix: previous server intent" },
  });
  await expect(server).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath("ai-commit-panel.png"), animations: "disabled" });
  await panel.getByRole("checkbox", { name: "Amend", exact: true }).uncheck();
  await expect(client).not.toBeChecked();
  await expect(server).toBeChecked();
});

test("Amend clears and disables with an empty selection and stays unchecked after files are selected again", async ({
  workbench: page,
}, testInfo) => {
  const panel = await prepareCommit(page);
  const client = panel.getByRole("checkbox", { name: "Include client.ts in commit" });
  const server = panel.getByRole("checkbox", { name: "Include server.ts in commit" });
  const amend = panel.getByRole("checkbox", { name: "Amend", exact: true });
  await page.screenshot({ path: testInfo.outputPath("amend-empty.png"), animations: "disabled" });
  await expect(amend).toBeDisabled();
  await expect(amend).not.toBeChecked();
  await server.check();
  await expect(amend).toBeEnabled();
  await expect(amend).not.toBeChecked();
  await amend.check();
  await expect(server).toBeChecked();
  await expect(client).not.toBeChecked();
  await page.screenshot({ path: testInfo.outputPath("amend-selected.png"), animations: "disabled" });
  await server.uncheck();
  await expect(amend).not.toBeChecked();
  await expect(amend).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath("amend-cleared.png"), animations: "disabled" });
  await client.check();
  await expect(amend).toBeEnabled();
  await expect(amend).not.toBeChecked();
  await page.screenshot({ path: testInfo.outputPath("amend-restored.png"), animations: "disabled" });
});

test("AI prompt configuration supports edits and restoring the default", async ({ workbench: page }, testInfo) => {
  const panel = await prepareCommit(page);
  await panel.getByRole("button", { name: "AI Commit Message Settings", exact: true }).click();
  const prompt = page.getByRole("textbox", { name: "Commit message prompt", exact: true });
  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText("Conventional Commits");
  await prompt.fill("Write a concise Chinese commit message.");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  expect((await ipcCalls(page, "settings_set")).find((args) => args.key === "vcs.commit.aiPrompt")).toMatchObject({
    value: JSON.stringify("Write a concise Chinese commit message."),
  });
  await page.getByRole("button", { name: "Restore default prompt", exact: true }).click();
  await expect(prompt).toContainText("Conventional Commits");
  await page.screenshot({ path: testInfo.outputPath("ai-commit-settings.png"), animations: "disabled" });
});
