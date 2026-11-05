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
