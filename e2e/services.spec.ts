import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/** Supply detected configurations without launching desktop processes. */
async function configure(page: Page, extra = 0) {
  await page.evaluate(async (extra) => {
    const storePath = "/src/features/run/store.ts";
    const projectPath = "/src/platform/project.ts";
    const { useRun } = await import(storePath);
    const { useProject } = await import(projectPath);
    localStorage.setItem(`openidea.services.runTypes:${useProject.getState().project.root}`, '["spring-boot","npm"]');
    useRun.setState({
      configs: [
        ["gateway", "spring-boot"],
        ["portal", "spring-boot"],
        ["web", "npm"],
        ["worker", "npm"],
        ...Array.from({ length: extra }, (_, i) => [`app-${i}`, "spring-boot"]),
      ].map(([id, kind]) => ({
        id,
        name: id,
        kind,
        command: kind,
        args: [],
        env: {},
        cwd: null,
        detected: true,
        isTest: false,
        debugAdapter: null,
      })),
    });
  }, extra);
  if (!(await page.getByRole("tree", { name: "Services", exact: true }).isVisible()))
    await page.keyboard.press("Meta+8");
  await expect(page.getByRole("tree", { name: "Services", exact: true })).toBeVisible();
}

async function move(page: Page, source: string, target: string) {
  const tree = page.getByRole("tree", { name: "Services", exact: true });
  const sourceRow = tree.getByRole("treeitem", { name: source, exact: true });
  await sourceRow.click();
  const from = await sourceRow.boundingBox();
  const to = await tree.getByRole("treeitem", { name: target, exact: true }).boundingBox();
  if (!from || !to) throw new Error("Service row is not visible");
  await page.mouse.move(from.x + 70, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + 70, to.y + 3, { steps: 8 });
  await page.mouse.up();
}

const rows = (java: string[], npm: string[]) => [
  "Spring Boot",
  "Running",
  "Not Started",
  ...java,
  "npm",
  "Running",
  "Not Started",
  ...npm,
];

test("launching a service keeps one console and puts execution actions above it", async ({ workbench: page }) => {
  await configure(page);
  const services = page.getByRole("region", { name: "Services", exact: true });
  await page
    .getByRole("tree", { name: "Services", exact: true })
    .getByRole("treeitem", { name: "gateway", exact: true })
    .click();
  const actions = services.getByRole("toolbar", { name: "Service console actions" });
  await expect(actions.getByRole("button", { name: "Run", exact: true })).toBeVisible();
  await expect(actions.getByRole("button", { name: "Debug", exact: true })).toBeVisible();
  await expect(services.getByRole("button", { name: "Run", exact: true })).toHaveCount(1);
  await expect(
    services.getByRole("toolbar", { name: "Services actions" }).getByRole("button", { name: "Run", exact: true }),
  ).toHaveCount(0);
  await page.evaluate(async () => {
    const path = "/src/features/run/store.ts";
    const { useRun, startRun } = await import(path);
    const config = useRun.getState().configs.find((c: { id: string }) => c.id === "gateway");
    await startRun({ ...config, focusToolWindow: true, showOnStdout: true, showOnStderr: true });
  });
  await expect(services.getByRole("log")).toBeVisible();
  await expect(services.getByRole("log")).toContainText("Running processes requires the desktop app.");
  await expect(page.getByRole("region", { name: "Run", exact: true })).toBeHidden();
  await expect(services.getByRole("button", { name: "Debug", exact: true })).toHaveCount(1);
  await expect(
    services.getByRole("toolbar", { name: "Run actions" }).getByRole("button", { name: "Rerun", exact: true }),
  ).toHaveCount(0);
  const header = (await actions.boundingBox())!;
  const treeHeader = (await services.getByRole("toolbar", { name: "Services actions" }).boundingBox())!;
  const output = (await services.getByRole("log").boundingBox())!;
  expect(header.y).toBeCloseTo(treeHeader.y, 0);
  expect(header.y + header.height).toBeLessThanOrEqual(output.y);
  await services.screenshot({ path: "/tmp/openidea-services-console.png", animations: "disabled" });
});

test("service pointer ordering works for Java and npm and survives reload", async ({ workbench: page }) => {
  await configure(page);
  const tree = page.getByRole("tree", { name: "Services", exact: true });
  await move(page, "portal", "gateway");
  await expect(tree.getByRole("treeitem")).toHaveText(rows(["portal", "gateway"], ["web", "worker"]));
  await expect(tree.getByRole("treeitem", { name: "portal", exact: true })).toHaveAttribute("aria-selected", "true");
  await move(page, "worker", "web");
  await expect(tree.getByRole("treeitem")).toHaveText(rows(["portal", "gateway"], ["worker", "web"]));
  await page.reload();
  await expect(page.getByRole("tree", { name: "Project" })).toBeVisible();
  await configure(page);
  await expect(tree.getByRole("treeitem")).toHaveText(rows(["portal", "gateway"], ["worker", "web"]));
  await tree.getByRole("treeitem", { name: "web", exact: true }).click();
  await page.getByRole("button", { name: "Move Up", exact: true }).click();
  await expect(tree.getByRole("treeitem")).toHaveText(rows(["portal", "gateway"], ["web", "worker"]));
});

test("service rows move between running and not started as their state changes", async ({ workbench: page }) => {
  await configure(page);
  const tree = page.getByRole("tree", { name: "Services", exact: true });
  await page.evaluate(async () => {
    const storePath = "/src/features/run/store.ts";
    const { useRun } = await import(storePath);
    const config = useRun.getState().configs.find((c: { id: string }) => c.id === "gateway");
    useRun.setState({
      sessions: [
        {
          id: "gateway-run",
          config,
          runId: null,
          status: "running",
          exitCode: null,
          startedAt: 1,
          endedAt: null,
          stdinClosed: false,
        },
      ],
    });
  });
  await expect(tree.getByRole("treeitem")).toHaveText([
    /Spring Boot/,
    "Running",
    /gateway/,
    "Not Started",
    "portal",
    "npm",
    "Running",
    "Not Started",
    "web",
    "worker",
  ]);
  await page.evaluate(async () => {
    const storePath = "/src/features/run/store.ts";
    const { useRun } = await import(storePath);
    useRun.setState({ sessions: useRun.getState().sessions.map((s: object) => ({ ...s, status: "finished" })) });
  });
  await expect(tree.getByRole("treeitem")).toHaveText(rows(["gatewayFinished", "portal"], ["web", "worker"]));
});

test("service dragging scrolls across virtual rows without losing source identity", async ({ workbench: page }) => {
  await configure(page, 100);
  const tree = page.getByRole("tree", { name: "Services", exact: true });
  const source = tree.getByRole("treeitem", { name: "portal", exact: true });
  await source.click();
  const from = await source.boundingBox();
  const bounds = await tree.boundingBox();
  if (!from || !bounds) throw new Error("Service rows are not visible");
  await page.mouse.move(from.x + 70, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 100, bounds.y + bounds.height - 5, { steps: 8 });
  await expect.poll(() => tree.evaluate((el) => el.scrollTop)).toBeGreaterThan(1000);
  const target = tree.getByRole("treeitem", { name: "app-99", exact: true });
  await target.scrollIntoViewIfNeeded();
  const to = await target.boundingBox();
  if (!to) throw new Error("Drop target is not visible");
  await page.mouse.move(to.x + 70, to.y + to.height - 3);
  await page.mouse.up();
  await expect(source).toHaveAttribute("aria-selected", "true");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const key = Object.keys(localStorage).find((k) => k.startsWith("openidea.services.runOrder:"));
        return key ? JSON.parse(localStorage.getItem(key)!)["spring-boot"].slice(-2) : [];
      }),
    )
    .toEqual(["app-99", "portal"]);
});

test("service ports follow Run and Debug startup output and clear between executions", async ({ workbench: page }) => {
  await configure(page);
  const services = page.getByRole("region", { name: "Services", exact: true });
  const row = page
    .getByRole("tree", { name: "Services", exact: true })
    .getByRole("treeitem", { name: /^gateway(?: |$)/ });
  await row.click();
  const id = await page.evaluate(async () => {
    const storePath = "/src/features/run/store.ts";
    const { useRun, startRun, runtime } = await import(storePath);
    const config = useRun.getState().configs.find((config: { id: string }) => config.id === "gateway");
    const session = await startRun(config);
    useRun.setState({
      sessions: useRun
        .getState()
        .sessions.map((item: { id: string }) =>
          item.id === session.id ? { ...item, status: "running", stopped: false } : item,
        ),
    });
    runtime(session.id).console.append({
      kind: "stdout",
      text: "Tomcat started on port(s): 8080 (http), 8443 (https)\n",
    });
    return session.id;
  });
  const badge = services.getByRole("status", { name: "Service ports", exact: true });
  await expect(row).toContainText(":8080, :8443");
  await expect(badge).toHaveText("Ports: 8080, 8443");
  await page.evaluate(async (id) => {
    const storePath = "/src/features/run/store.ts";
    const { useRun } = await import(storePath);
    useRun.setState({
      sessions: useRun
        .getState()
        .sessions.map((item: { id: string }) => (item.id === id ? { ...item, status: "finished" } : item)),
    });
  }, id);
  await expect(badge).toHaveCount(0);
  await page.evaluate(async (id) => {
    const storePath = "/src/features/run/store.ts";
    const { useRun, startRun, runtime } = await import(storePath);
    const config = useRun.getState().configs.find((config: { id: string }) => config.id === "gateway");
    await startRun(config, id);
    useRun.setState({
      sessions: useRun
        .getState()
        .sessions.map((item: { id: string }) =>
          item.id === id ? { ...item, status: "running", stopped: false } : item,
        ),
    });
    runtime(id).console.append({ kind: "stdout", text: "[GIN-debug] Listening and serving HTTP on :9090\n" });
  }, id);
  await expect(badge).toHaveText("Ports: 9090");
  await expect(row).not.toContainText("8080");
  await page.evaluate(async (id) => {
    const storePath = "/src/features/run/store.ts";
    const debugPath = "/src/features/debugger/state.ts";
    const { useRun } = await import(storePath);
    const config = useRun.getState().configs.find((config: { id: string }) => config.id === "gateway");
    useRun.setState({
      sessions: useRun
        .getState()
        .sessions.map((item: { id: string }) => (item.id === id ? { ...item, status: "finished" } : item)),
    });
    const { adoptSession, appendConsole } = await import(debugPath);
    adoptSession(777, { name: config.name, runConfig: config, startedAt: Date.now() + 1000 });
    appendConsole(777, "stdout", "Netty started on port 9091\n");
    appendConsole(777, "console", "Debugger listening on ws://127.0.0.1:9229/token\n");
  }, id);
  await expect(badge).toHaveText("Ports: 9091");
  await expect(row).not.toContainText("9229");
  await services.screenshot({ path: "/tmp/openidea-services-ports.png", animations: "disabled" });
  await page.evaluate(async () => {
    const debugPath = "/src/features/debugger/state.ts";
    (await import(debugPath)).handleDebugEvent(777, { kind: "terminated" });
  });
  await expect(badge).toHaveCount(0);
});

test("Docker Compose editor completes service references and navigates to declarations", async ({
  workbench: page,
}) => {
  await page.evaluate(async () => {
    const backendModule = "/src/editor/core/backend.ts";
    const contribModule = "/src/workbench/contributions.ts";
    const { docBackend } = await import(/* @vite-ignore */ backendModule);
    const { editorService } = await import(/* @vite-ignore */ contribModule);
    const compose = [
      "services:",
      "  postgres:",
      "    image: postgres:16",
      "    networks:",
      "      - backend",
      "  redis:",
      "    image: redis:7",
      "  api:",
      "    build: .",
      "    depends_on:",
      "networks:",
      "  backend:",
      "    driver: bridge",
      "",
    ].join("\n");
    docBackend().files.set("/dev/acme-api/docker-compose.yml", compose);
    await editorService().openFile("/dev/acme-api/docker-compose.yml");
  });

  const editor = page.locator(".cm-editor");
  await expect(editor).toContainText("postgres:16");

  // Complete a service reference under `depends_on:`
  await editor.locator(".cm-line", { hasText: "depends_on:" }).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("- ");
  await page.keyboard.press("Control+Space");
  const popup = page.locator(".cm-tooltip-autocomplete");
  await expect(popup.getByText("postgres", { exact: true })).toBeVisible();
  await expect(popup.getByText("redis", { exact: true })).toBeVisible();
  await expect(popup.getByText("api", { exact: true })).toHaveCount(0);
  await page.keyboard.type("post");
  await expect(popup.getByText("redis", { exact: true })).toBeHidden();
  await page.keyboard.press("Enter");
  await expect(popup).toBeHidden();
  await expect(editor.locator(".cm-activeLine")).toHaveText("    - postgres");

  // Go to Declaration (⌘B) on `- postgres` jumps to `  postgres:` declaration
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Meta+b");
  await expect(editor.locator(".cm-activeLine")).toHaveText("  postgres:");

  // Go to Declaration (⌘B) on `- backend` jumps to `  backend:` under `networks:`
  await editor.locator(".cm-line", { hasText: "      - backend" }).click();
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Meta+b");
  await expect(editor.locator(".cm-activeLine")).toHaveText("  backend:");
});
