/** Docking agent conversations between the editor and the Agents tool window by drag & drop. */
import { expect, test, type Page } from "@playwright/test";

const TASK = {
  id: "t1",
  title: "Repro task",
  status: "ready" as const,
  isolation: "local" as const,
  provider: "codex",
  model: null,
  cwd: "/dev/acme-api",
  branch: null,
  base: null,
  baseCommit: null,
  error: null,
  createdMs: 0,
  updatedMs: 0,
  config: [],
  commands: [],
  usage: null,
  queue: [],
};

/** Seeds one task in the agents store (no backend in plain-browser mode) and docks it. */
async function seedAndDock(page: Page) {
  await page.evaluate(async (task) => {
    // Paths go through variables: knip can't resolve these browser-absolute URLs.
    const storePath = "/src/features/agents/store.ts";
    const store = await import(storePath);
    store.useAgents.setState({
      loaded: true,
      error: null,
      providers: [],
      tasks: new Map([[task.id, task]]),
      unread: new Set(),
      docked: null,
    });
    store.dockTask(task.id);
  }, TASK);
  await page.locator("span[title='Repro task']").first().waitFor();
}

test("keeps the current conversation docked when dragged onto an editor", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("tree", { name: "Project" }).waitFor();
  // An editor pane, so the session tab has a content drop target to land on.
  await page.getByRole("treeitem", { name: "README.md", exact: true }).dblclick();
  await page.getByRole("tab", { name: "README.md" }).waitFor();
  await seedAndDock(page);

  const title = page.locator("span[title='Repro task']").first();
  const to = await page.getByRole("tabpanel").first().boundingBox();
  const from = await title.boundingBox();
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
  await page.mouse.down();
  await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 10 });
  await page.mouse.up();

  await expect(page.getByRole("region", { name: "Editor" }).getByRole("tab", { name: "Repro task" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Agents" }).getByRole("tab", { name: "Repro task" })).toBeVisible();
});

test("keeps the current conversation docked when dragged onto an empty editor", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("tree", { name: "Project" }).waitFor();
  // An accidental drop on an empty editor must also leave the active chat docked.
  await seedAndDock(page);
  await expect(page.locator("[data-editor-area] [role='tabpanel']")).toHaveCount(0);

  const title = page.locator("span[title='Repro task']").first();
  const to = await page.getByText("Drop files here to open them").boundingBox();
  const from = await title.boundingBox();
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
  await page.mouse.down();
  await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 10 });
  await page.mouse.up();

  await expect(page.getByRole("region", { name: "Editor" }).getByRole("tab", { name: "Repro task" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Agents" }).getByRole("tab", { name: "Repro task" })).toBeVisible();
});

test("docks a session tab dropped on the tool window", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("tree", { name: "Project" }).waitFor();
  await page.getByRole("treeitem", { name: "README.md", exact: true }).dblclick();
  await page.getByRole("tab", { name: "README.md" }).waitFor();
  await page.evaluate(async (task) => {
    const storePath = "/src/features/agents/store.ts";
    const modelPath = "/src/features/agents/model.ts";
    const contributionsPath = "/src/workbench/contributions.ts";
    const store = await import(storePath);
    const { TOOL_WINDOW } = await import(modelPath);
    const { toolWindowService } = await import(contributionsPath);
    store.useAgents.setState({
      loaded: true,
      error: null,
      providers: [],
      tasks: new Map([[task.id, task]]),
      unread: new Set(),
      docked: null,
    });
    toolWindowService().show(TOOL_WINDOW, true);
    store.openTaskInEditorLocation(task.id);
  }, TASK);
  const editor = page.getByRole("region", { name: "Editor" });
  const agents = page.getByRole("region", { name: "Agents" });
  await editor.getByRole("tab", { name: "Repro task" }).waitFor();

  const tab = editor.getByRole("tab", { name: "Repro task" });
  const to = await page.getByRole("tree", { name: "Agent tasks" }).boundingBox();
  const from = await tab.boundingBox();
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
  await page.mouse.down();
  await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 10 });
  await page.mouse.up();

  // Docked: the tab closes and the tool window gives itself to the conversation.
  await expect(editor.getByRole("tab", { name: "Repro task" })).toHaveCount(0);
  await expect(page.getByRole("tree", { name: "Agent tasks" })).toHaveCount(0);
  await expect(agents.getByRole("tab", { name: "Repro task" })).toBeVisible();
});

test("keeps multiple conversations as separate side-panel tabs", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("tree", { name: "Project" }).waitFor();
  await page.evaluate(async (task) => {
    const storePath = "/src/features/agents/store.ts";
    const store = await import(storePath);
    const second = { ...task, id: "t2", title: "Second task" };
    store.useAgents.setState({
      loaded: true,
      error: null,
      providers: [],
      tasks: new Map([
        [task.id, task],
        [second.id, second],
      ]),
      unread: new Set(),
      docked: null,
      dockedTabs: [],
      homeOpen: false,
    });
    store.dockTask(task.id);
  }, TASK);
  const agents = page.getByRole("region", { name: "Agents" });
  await agents.getByRole("button", { name: "Agent sessions" }).click();
  await page
    .getByRole("tree", { name: "Agent tasks" })
    .getByRole("treeitem", { name: /Second task/ })
    .click();
  const tabs = agents.getByRole("tablist", { name: "Open Agent Sessions" });
  await expect(tabs.getByRole("tab", { name: "Repro task" })).toBeVisible();
  await expect(tabs.getByRole("tab", { name: "Second task" })).toHaveAttribute("aria-selected", "true");
  await tabs.getByRole("tab", { name: "Repro task" }).click();
  await expect(tabs.getByRole("tab", { name: "Repro task" })).toHaveAttribute("aria-selected", "true");
});
