import type { Page } from "@playwright/test";
import type { AgentEntry } from "../src/bindings";
import { expect, test } from "./fixtures";

async function seed(page: Page) {
  await expect(page.locator("#splash")).toBeHidden();
  await page.evaluate(async () => {
    const storePath = "/src/features/agents/store.ts";
    const layoutPath = "/src/workbench/toolwindows/store.ts";
    const bindingsPath = "/src/bindings.ts";
    const store = await import(storePath);
    const { setToolWindowSize } = await import(layoutPath);
    const { commands } = await import(bindingsPath);
    const task = (id: string, title: string, status = "ready") => ({
      id,
      title,
      status,
      isolation: "local",
      provider: "codex",
      model: "gpt-test",
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
    });
    const tool = (id: string, title: string) => ({
      type: "tool",
      id,
      name: "codex:commandExecution",
      title,
      kind: "execute",
      status: "completed",
      locations: [],
      output: `${id} output\n` + Array.from({ length: 60 }, (_, i) => `line ${i} ${"x".repeat(180)}`).join("\n"),
      diffs: [],
    });
    const entries = [
      {
        type: "user",
        text: "Review this project and run its tests.",
        attachments: [],
        images: [],
        sentMs: 0,
        doneMs: 1,
      },
      {
        type: "agent",
        text:
          "## Review\n\nThe project has **two areas** to check.\n\n- Read the configuration\n- Run the tests\n\n```ts\nconst project = 'acme';\n```\n\n| Item | Result |\n| --- | --- |\n| Build | Passed |\n| Path | " +
          "verylongfilename".repeat(18) +
          " |",
      },
      { type: "thought", text: "Inspecting the project and its build commands." },
      tool("first", "go test ./..."),
      tool("second", "go vet ./..."),
      ...Array.from({ length: 15 }, (_, i) => ({
        type: "agent",
        text:
          `Paragraph ${i}. This section explains the changes and their impact.\n\n` +
          "Detailed explanation. ".repeat(12),
      })),
      {
        type: "permission",
        id: 1,
        title: "Run go test ./... in /dev/acme-api",
        chosen: null,
        options: [
          { id: "accept", name: "Allow once", kind: "allow_once" },
          { id: "acceptForSession", name: "Allow for this session", kind: "allow_always" },
          { id: "decline", name: "Decline", kind: "reject_once" },
        ],
      },
      {
        type: "permission",
        id: 2,
        title: "Choose deployment environment",
        chosen: null,
        options: [
          { id: "answer-0", name: "Development", kind: "allow_once" },
          { id: "answer-1", name: "Staging", kind: "allow_once" },
          { id: "reject", name: "Skip", kind: "reject_once" },
        ],
      },
    ];
    store.useAgents.setState({
      loaded: true,
      error: null,
      providers: [],
      tasks: new Map([
        ["a", task("a", "Project review", "needsInput")],
        ["b", task("b", "History review")],
        ["c", task("c", "Archived review", "archived")],
      ]),
      entries: new Map([
        ["a", entries],
        ["b", [{ type: "agent", text: "A different conversation." }]],
      ]),
      unread: new Set(["b"]),
      docked: null,
      dockedTabs: [],
      homeOpen: false,
      sessionsOpen: false,
    });
    commands.agentEntries = async (id: string) => ({
      status: "ok",
      data: store.useAgents.getState().entries.get(id) ?? [],
    });
    commands.agentChanges = async () => ({
      status: "ok",
      data: [{ path: "/dev/acme-api/README.md", relPath: "README.md", kind: "modified", added: 1, removed: 0 }],
    });
    commands.agentRespond = async (id: string, permission: number, option: string) => {
      store.useAgents.setState((state: { entries: Map<string, AgentEntry[]> }) => ({
        entries: new Map(state.entries).set(
          id,
          (state.entries.get(id) ?? []).map((entry) =>
            entry.type === "permission" && entry.id === permission
              ? { ...entry, chosen: entry.options.find((o) => o.id === option)?.name ?? "Cancelled" }
              : entry,
          ),
        ),
      }));
      return { status: "ok", data: null };
    };
    setToolWindowSize("right", 600);
    store.dockTask("a");
  });
  await expect(page.getByRole("region", { name: "Agents" }).getByRole("textbox", { name: "Message" })).toBeVisible();
}

test("session history can be searched and switched without closing the conversation or losing drafts", async ({
  workbench: page,
}) => {
  await seed(page);
  const agents = page.getByRole("region", { name: "Agents" });
  await page.getByRole("tree", { name: "Project" }).click();
  await page.mouse.move(600, 300);
  await expect(agents.getByRole("button", { name: "Agent sessions" }).locator("..")).toHaveCSS("opacity", "1");
  await agents.getByRole("textbox", { name: "Message" }).fill("Draft for the first task");
  await agents.getByRole("button", { name: "Agent sessions" }).click();
  const history = agents.getByRole("dialog", { name: "Agent sessions" });
  await expect(history).toBeVisible();
  await expect(history.getByRole("textbox", { name: "Search sessions" })).toBeFocused();
  await history.getByRole("textbox", { name: "Search sessions" }).fill("History");
  await history.getByRole("treeitem", { name: /History review/ }).click();
  await expect(history).toHaveCount(0);
  await expect(agents.getByText("A different conversation.")).toBeVisible();
  await agents.getByRole("textbox", { name: "Message" }).fill("Draft for the second task");
  await agents.getByRole("tab", { name: "Project review" }).click();
  await expect(agents.getByRole("textbox", { name: "Message" })).toHaveValue("Draft for the first task");
  await agents.getByRole("button", { name: "Agent sessions" }).click();
  await page.keyboard.press("Escape");
  await expect(history).toHaveCount(0);
  await expect(agents.getByRole("textbox", { name: "Message" })).toHaveValue("Draft for the first task");
});

test("approval stays beside the composer while scrolling and reviewing changes, and questions keep their answer choices", async ({
  workbench: page,
}) => {
  await seed(page);
  const agents = page.getByRole("region", { name: "Agents" });
  const composer = agents.getByRole("textbox", { name: "Message" });
  await composer.fill("Keep this draft during approval");
  const stream = agents.locator("[data-agent-stream]");
  const card = agents.getByRole("alert", { name: "Run go test ./... in /dev/acme-api" });
  const before = (await card.boundingBox())!;
  const inputBounds = (await composer.boundingBox())!;
  expect(before.y + before.height).toBeLessThanOrEqual(inputBounds.y);
  await stream.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(() => stream.evaluate((element) => element.scrollTop)).toBe(0);
  await expect(card).toBeVisible();
  expect((await card.boundingBox())!.y).toBeCloseTo(before.y, 0);
  await agents.getByRole("button", { name: "Show changes" }).click();
  await expect(card).toBeVisible();
  await expect(agents.getByRole("button", { name: "Allow once" })).toBeVisible();
  await agents.getByRole("button", { name: "Back to conversation" }).click();
  await expect(composer).toHaveValue("Keep this draft during approval");
  await agents.getByRole("button", { name: "More options" }).click();
  await page.getByRole("menuitem", { name: "Allow for this session" }).click();
  const question = agents.getByRole("alert", { name: "Choose deployment environment" });
  await expect(question.getByRole("button", { name: "Submit answer" })).toBeDisabled();
  await question.getByRole("radio", { name: "Staging" }).check();
  await question.getByRole("button", { name: "Submit answer" }).click();
  await expect(agents.locator("[data-agent-permission-dock]")).toHaveCount(0);
  await expect(composer).toHaveValue("Keep this draft during approval");
});

test("tool output, code blocks and tables stay usable in a narrow Agents panel", async ({ workbench: page }) => {
  await seed(page);
  const agents = page.getByRole("region", { name: "Agents" });
  const stream = agents.locator("[data-agent-stream]");
  await stream.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(agents.getByRole("button", { name: "Copy Code" })).toHaveCount(1);
  const group = agents.locator("details").filter({ has: page.getByText("Terminal", { exact: true }) });
  await expect(group).not.toHaveAttribute("open");
  await group.locator("summary").first().click();
  const first = group.locator("details").filter({ has: page.getByText("go test ./...", { exact: true }) });
  await first.locator("summary").click();
  await first.getByRole("button", { name: "Expand output" }).click();
  await expect(page.getByRole("dialog", { name: "Tool output" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Tool output" }).getByText(/first output/)).toBeVisible();
  await page.keyboard.press("Escape");
  await page.evaluate(async () => {
    const path = "/src/workbench/toolwindows/store.ts";
    (await import(path)).setToolWindowSize("right", 320);
  });
  await expect.poll(() => stream.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await expect(agents.getByRole("button", { name: "Agent sessions" })).toBeVisible();
  await expect(agents.getByRole("button", { name: "Allow once" })).toBeVisible();
  await page.screenshot({ path: "/tmp/openidea-agents-ui-narrow.png", animations: "disabled" });
  await page.evaluate(async () => {
    const path = "/src/workbench/toolwindows/store.ts";
    (await import(path)).setToolWindowSize("right", 640);
  });
  await stream.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({ path: "/tmp/openidea-agents-ui-wide.png", animations: "disabled" });
  await page.evaluate(async () => {
    const path = "/src/workbench/theme.ts";
    (await import(path)).useThemeOverride.setState({ theme: "dark" });
  });
  await agents.screenshot({ path: "/tmp/openidea-agents-ui-dark.png", animations: "disabled" });
  await agents.getByRole("button", { name: "Agent sessions" }).click();
  await agents.screenshot({ path: "/tmp/openidea-agents-ui-history.png", animations: "disabled" });
  await page.keyboard.press("Escape");
});
