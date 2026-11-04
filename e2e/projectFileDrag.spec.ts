import { expect, openFromTree, test } from "./fixtures";

test("dragging a project file to Agents does not select editor text", async ({ workbench: page }) => {
  const editor = await openFromTree(page, "build.gradle.kts");
  await editor.locator(".cm-content").click();
  await page.keyboard.press("Meta+a");
  await page.keyboard.insertText(Array.from({ length: 80 }, (_, i) => `val sampleLine${i} = ${i}`).join("\n"));
  await page.evaluate(async () => {
    const editorPath = "/src/editor/api.ts";
    const storePath = "/src/features/agents/store.ts";
    const { activeEditor } = await import(editorPath);
    activeEditor()!.view.dispatch({ selection: { anchor: 3 } });
    const store = await import(storePath);
    const task = {
      id: "drag-test",
      title: "Drag test",
      status: "ready",
      isolation: "local",
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
    store.useAgents.setState({
      loaded: true,
      error: null,
      providers: [],
      tasks: new Map([[task.id, task]]),
      unread: new Set(),
      docked: null,
    });
    store.dockTask(task.id);
  });

  const composer = page.getByRole("region", { name: "Agents" }).getByRole("textbox", { name: "Message" });
  await expect(composer).toBeVisible();
  await editor.locator(".cm-scroller").evaluate((element) => {
    element.scrollTop = 0;
  });
  const file = page.getByRole("treeitem", { name: "README.md", exact: true }).locator("[data-project-path]");
  const from = (await file.boundingBox())!;
  const code = (await editor.locator(".cm-line").nth(3).boundingBox())!;
  const to = (await composer.boundingBox())!;
  const selection = () =>
    page.evaluate(async () => {
      const path = "/src/editor/api.ts";
      const { activeEditor } = await import(path);
      const { anchor, head } = activeEditor()!.view.state.selection.main;
      return { anchor, head, dom: window.getSelection()?.toString() };
    });

  await page.evaluate(() => {
    document.addEventListener(
      "mousedown",
      (event) => {
        document.documentElement.dataset.testMouseDownPrevented = String(event.defaultPrevented);
      },
      { once: true },
    );
  });

  await page.mouse.move(from.x + 35, from.y + from.height / 2);
  await page.mouse.down();
  const prevented = await page.evaluate(() => document.documentElement.dataset.testMouseDownPrevented);
  await expect(page.getByRole("tree", { name: "Project" })).toBeFocused();
  await page.mouse.move(code.x + 120, code.y + code.height / 2, { steps: 15 });
  expect(prevented).toBe("true");
  expect(await selection()).toEqual({ anchor: 3, head: 3, dom: "" });
  const dropIndicator = page.getByRole("region", { name: "Editor" }).locator('[class*="dropZone"]');
  await expect(dropIndicator).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 15 });
  await page.mouse.up();

  await expect(composer).toHaveValue(/@README\.md/);
  expect(await selection()).toEqual({ anchor: 3, head: 3, dom: "" });
  await expect(dropIndicator).toHaveCount(0);

  // Ordinary mouse selection in the editor remains available after the drop.
  const line = (await editor.locator(".cm-line").first().boundingBox())!;
  await page.mouse.move(line.x + 12, line.y + line.height / 2);
  await page.mouse.down();
  await page.mouse.move(line.x + 110, line.y + line.height / 2, { steps: 5 });
  await page.mouse.up();
  const selected = await selection();
  expect(selected.anchor).not.toBe(selected.head);
});

test("project files can still be dropped into and split the editor", async ({ workbench: page }) => {
  await openFromTree(page, "build.gradle.kts");
  const editor = page.getByRole("region", { name: "Editor" });
  const panel = editor.getByRole("tabpanel", { name: "build.gradle.kts" });
  const dragFile = async (name: string, x: number, y: number) => {
    const file = page.getByRole("treeitem", { name, exact: true }).locator("[data-project-path]");
    const from = (await file.boundingBox())!;
    await page.mouse.move(from.x + 35, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(x, y, { steps: 15 });
    const indicator = editor.locator('[class*="dropZone"]');
    await expect(indicator).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await page.mouse.up();
  };

  const bounds = (await panel.boundingBox())!;
  await dragFile("README.md", bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await expect(editor.getByRole("tab", { name: "README.md" })).toHaveAttribute("aria-selected", "true");

  const readmePanel = editor.getByRole("tabpanel", { name: "README.md" });
  const readmeBounds = (await readmePanel.boundingBox())!;
  await dragFile("settings.gradle.kts", readmeBounds.x + 10, readmeBounds.y + readmeBounds.height / 2);
  await expect(page.getByRole("region", { name: "Editor" })).toHaveCount(2);
  await expect(page.getByRole("tab", { name: "settings.gradle.kts" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "README.md" })).toBeVisible();
});

test("project tree keeps multi-file selection when dragging", async ({ workbench: page }) => {
  await openFromTree(page, "build.gradle.kts");
  const readme = page.getByRole("treeitem", { name: "README.md", exact: true });
  const settings = page.getByRole("treeitem", { name: "settings.gradle.kts", exact: true });
  await readme.locator("[data-project-path]").click();
  await settings.locator("[data-project-path]").click({ modifiers: ["Meta"] });
  await expect(readme).toHaveAttribute("aria-selected", "true");
  await expect(settings).toHaveAttribute("aria-selected", "true");

  const from = (await readme.locator("[data-project-path]").boundingBox())!;
  const panel = (await page.getByRole("tabpanel", { name: "build.gradle.kts" }).boundingBox())!;
  await page.mouse.move(from.x + 35, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(panel.x + panel.width / 2, panel.y + panel.height / 2, { steps: 15 });
  await page.mouse.up();

  await expect(page.getByRole("tab", { name: "README.md" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "settings.gradle.kts" })).toBeVisible();
  await expect(readme).toHaveAttribute("aria-selected", "true");
  await expect(settings).toHaveAttribute("aria-selected", "true");
});
