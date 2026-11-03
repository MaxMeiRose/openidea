import { expect, test } from "./fixtures";

test("agent tool groups are collapsed, expand independently, and reveal search matches", async ({
  workbench: page,
}) => {
  await page.evaluate(async () => {
    const storePath = "/src/features/agents/store.ts";
    const store = await import(storePath);
    const task = {
      id: "tool-groups",
      title: "Tool groups fixture",
      status: "running",
      isolation: "local",
      provider: "claude",
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
    const tool = (id: string, name: string, title: string) => ({
      type: "tool",
      id,
      name,
      title,
      kind: "read",
      status: "completed",
      locations: [],
      output: `result ${id}`,
      diffs: [],
    });
    const entries = [
      { type: "thought", text: "Checking" },
      tool("alpha", "Read", "Read alpha.ts"),
      tool("other", "Other", "Other read"),
      tool("beta", "Read", "Read beta.ts"),
      { type: "permission", id: 1, title: "Approval required", options: [], chosen: null },
      tool("gamma", "Read", "Read gamma.ts"),
      { type: "thought", text: "Checking again" },
      tool("delta", "Read", "Read delta.ts"),
    ];
    store.useAgents.setState({
      loaded: true,
      error: null,
      providers: [],
      tasks: new Map([[task.id, task]]),
      entries: new Map([[task.id, entries]]),
      unread: new Set(),
      docked: null,
    });
    store.openTask(task.id);
  });

  const group = page.locator("details").filter({ has: page.getByText("Read", { exact: true }) });
  await expect(group).toHaveCount(1);
  await expect(group).not.toHaveAttribute("open");
  await expect(group.getByText("×3")).toBeVisible();
  await expect(group.getByText("Read alpha.ts")).toBeHidden();
  await expect(page.getByRole("alert", { name: "Approval required" })).toBeVisible();
  await expect(page.getByText("Other read")).toBeVisible();
  await expect(group.getByText("Read gamma.ts")).toBeHidden();
  await expect(page.getByText("Read delta.ts")).toBeVisible();

  await group.locator("summary").first().click();
  await expect(group.getByText("Read alpha.ts")).toBeVisible();
  await expect(group.getByText("Read gamma.ts")).toBeVisible();
  const alpha = group.locator("details").filter({ hasText: "Read alpha.ts" });
  await expect(alpha).not.toHaveAttribute("open");
  await alpha.locator("summary").click();
  await expect(alpha.getByText("result alpha")).toBeVisible();

  await group.locator("summary").first().click();
  await page.keyboard.press("Meta+f");
  const find = page.getByRole("textbox", { name: "Find in Conversation" });
  await find.fill("result alpha");
  await expect(page.getByText("1/1", { exact: true })).toBeVisible();
  await find.press("Enter");
  await expect(group).toHaveAttribute("open");
  await expect(alpha.getByText("result alpha")).toBeVisible();
});
