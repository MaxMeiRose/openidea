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
    const projectModule = "/src/platform/project.ts";
    const { useProject } = await import(/* @vite-ignore */ projectModule);
    let settings = {
      ...useProject.getState().settings,
      vcs: { commit: { aiProvider: "codex", aiCodexModel: "", aiClaudeModel: "", aiPrompt: "" } },
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
      vcs_log: () => [{ id: "1111111", message: "fix: previous intent" }],
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
        settings = { ...settings, vcs: { commit: { ...settings.vcs.commit, [key]: JSON.parse(args.value) } } };
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

test("Amend selects the current repository and AI generation uses the selected tool and model", async ({
  workbench: page,
}, testInfo) => {
  const panel = await prepareCommit(page);
  const client = panel.getByRole("checkbox", { name: "Include client.ts in commit" });
  const server = panel.getByRole("checkbox", { name: "Include server.ts in commit" });
  const generate = panel.getByRole("button", { name: "Generate with AI", exact: true });
  await expect(client).not.toBeChecked();
  await expect(generate).toBeDisabled();
  await panel.getByRole("checkbox", { name: "Amend", exact: true }).check();
  await expect(client).toBeChecked();
  await expect(server).not.toBeChecked();
  await expect(panel.getByRole("textbox", { name: "Commit message", exact: true })).toHaveValue("fix: previous intent");
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
  expect(request).toMatchObject({ provider: "claude", repo: "/dev/acme-api/frontend", model: "sonnet" });
  expect(JSON.parse(request!.prompt as string)).toMatchObject({
    amend: true,
    files: [{ path: "client.ts" }],
    previousCommit: { message: "fix: previous intent" },
  });
  await expect(server).not.toBeChecked();
  await page.screenshot({ path: testInfo.outputPath("ai-commit-panel.png"), animations: "disabled" });
  await panel.getByRole("checkbox", { name: "Amend", exact: true }).uncheck();
  await expect(client).not.toBeChecked();
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
