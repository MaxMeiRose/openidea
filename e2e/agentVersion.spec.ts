import type { Page } from "@playwright/test";
import { expect, stubDesktop, test } from "./fixtures";

test.beforeEach(async ({ workbench: page }) => {
  await stubDesktop(page);
  await page.evaluate(async () => {
    // Load the IPC module in Vite's browser realm, not Playwright's Node process.
    const ipcPath = "/src/platform/ipc.ts";
    const { commands } = await import(ipcPath);
    const provider = {
      id: "omp",
      name: "OMP",
      command: "omp acp",
      program: "omp",
      args: ["acp"],
      defaultProgram: null,
      defaultArgs: [],
      loginHint: null,
      commandOverridden: false,
      commandEditable: true,
      commandReadOnlyReason: null,
      installed: true,
      env: {},
      commands: [],
      source: { kind: "custom" },
      config: [],
      thoughtLevels: {},
    };
    let installed = "18.20.0";
    let cached = installed;
    window.addEventListener("test:agent-upgraded", () => {
      installed = "18.20.2";
    });
    const h = window.__ipc.handlers;
    h.agent_subscribe = () => [];
    h.agent_providers = () => [provider];
    h.agent_models = () => [];
    h.agent_probe = ({ provider: id, refresh }) => {
      if (refresh) cached = installed;
      return { provider: id, name: "omp", version: cached, protocol: "ACP v1", error: null };
    };
    commands.agentRefreshModels = async () => ({
      status: "ok",
      data: {
        provider: "omp",
        config: [],
        thoughtLevels: {},
        refreshing: false,
        refreshedAtMs: Date.now(),
        retryAtMs: null,
        error: null,
      },
    });
    const projectPath = "/src/platform/project.ts";
    const { useProject } = await import(projectPath);
    const project = useProject.getState().project;
    if (project) useProject.setState({ project: { ...project, trusted: true } });
    const storePath = "/src/features/agents/store.ts";
    await (await import(storePath)).connect();
  });
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByRole("button", { name: "New Agent Task", exact: true }).click();
  await chooseAgent(page);
  await expectVersion(page, "18.20.0");
});

test("refreshes an upgraded agent's version on window focus without losing the draft", async ({ workbench: page }) => {
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  await message.focus();
  await page.keyboard.insertText("Keep this unsent draft");
  await page.evaluate(() => {
    window.dispatchEvent(new Event("test:agent-upgraded"));
    window.dispatchEvent(new Event("focus"));
  });
  await expectVersion(page, "18.20.2");
  await expect(message).toHaveText("Keep this unsent draft");
});

test("refreshes an upgraded agent's version when New Task is reopened", async ({ workbench: page }) => {
  await page.getByRole("button", { name: "Close Tab", exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event("test:agent-upgraded")));
  await page.getByRole("button", { name: "New Agent Task", exact: true }).click();
  await chooseAgent(page);
  await expectVersion(page, "18.20.2");
});

/** The agent picker shows its icon; its name and version are in its tooltip. */
async function chooseAgent(page: Page) {
  await page.evaluate(async () => {
    const storePath = "/src/features/agents/store.ts";
    const { updateDraft } = await import(storePath);
    updateDraft({ provider: "omp" });
  });
}

async function expectVersion(page: Page, version: string) {
  await expect(page.locator(`[data-tooltip$=" ${version}"]`).filter({ visible: true })).toHaveCount(1);
}
