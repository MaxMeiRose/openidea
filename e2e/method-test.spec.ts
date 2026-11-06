import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";
import type { MethodInvocation } from "../src/bindings";
interface MethodTestWindow extends Window {
  __methodInput?: MethodInvocation;
  __finishMethodPreparation?: (value: unknown) => void;
  __methodCancelled?: boolean;
}
const SOURCE = `package demo;
@Service public class OrderService {
  public Order find(long id) { return null; }
  public int count() { return 0; }
}`;
async function openService(page: Page) {
  await page.evaluate(async (source) => {
    const bindings = "/src/bindings.ts";
    const backend = "/src/editor/core/backend.ts";
    const workbench = "/src/workbench/contributions.ts";
    const layout = "/src/workbench/toolwindows/store.ts";
    const { commands } = await import(bindings);
    const path = "/dev/acme-api/OrderService.java";
    commands.fsProbe = async () => ({ status: "ok", data: { size: source.length, binary: false, tooLarge: false } });
    commands.fsReadText = async (file: string) => ({ status: "ok", data: file === path ? source : "" });
    commands.javaMethodPrepare = async (invocation) => {
      (window as MethodTestWindow).__methodInput = invocation;
      return {
        status: "ok",
        data: {
          id: "test-id",
          config: {
            id: "java-method:test-id",
            name: "OrderService · find",
            kind: "java-method",
            command: "java",
            args: [],
            cwd: "/dev/acme-api",
            env: {},
            detected: false,
            isTest: false,
            debugAdapter: "java-debug",
            openToolWindow: true,
          },
        },
      };
    };
    commands.javaMethodResult = async () => ({
      status: "ok",
      data: {
        success: true,
        valueJson: '{"id":7,"name":"Example"}',
        durationMs: 12,
        error: null,
        stackTrace: null,
        mockCallsJson: "[]",
      },
    });
    (await import(backend)).docBackend().files.set(path, source);
    (await import(layout)).setToolWindowSize("right", 650);
    await (await import(workbench)).editorService().openFile(path, { focus: true });
  }, SOURCE);
  const button = page.locator('.cm-openidea-gutter-method-test button[aria-label*="#find("]');
  await expect(button).toBeVisible();
  await button.click();
  const panel = page.getByRole("region", { name: "Method Test", exact: true });
  await expect(panel).toBeVisible();
  return panel;
}
test("Service method form preserves cases, passes Spring options, and reuses the Services console", async ({
  workbench: page,
}) => {
  const panel = await openService(page);
  const args = panel.getByRole("textbox", { name: "Method arguments", exact: true });
  await expect(args).toHaveValue("[\n  0\n]");
  await args.fill("[7]");
  await panel.getByRole("textbox", { name: "Method case name" }).fill("Found order");
  await panel.getByRole("button", { name: "Save method case", exact: true }).click();
  await args.fill("[99]");
  await panel.getByRole("button", { name: "Saved method cases", exact: true }).click();
  await page.getByRole("option", { name: /^Found order/ }).click();
  await expect(args).toHaveValue("[7]");
  await panel.getByRole("button", { name: "Execution mode", exact: true }).click();
  await page.getByRole("option", { name: "Spring · selected beans", exact: true }).click();
  await panel.getByRole("tab", { name: "Spring", exact: true }).click();
  await panel.getByRole("textbox", { name: "Spring configuration classes" }).fill("demo.TestConfig");
  await panel.getByRole("textbox", { name: "Method Spring profiles" }).fill("dev");
  await panel.getByRole("textbox", { name: "Method Spring properties" }).fill('{"example.enabled":true}');
  await panel.getByRole("button", { name: "Run method", exact: true }).click();
  await expect(panel.getByLabel("Method return value", { exact: true })).toContainText('"id": 7');
  const input = await page.evaluate(() => (window as MethodTestWindow).__methodInput);
  expect(input).toMatchObject({
    className: "demo.OrderService",
    methodName: "find",
    parameterTypes: ["long"],
    argumentsJson: "[7]",
    mode: "spring",
    profiles: ["dev"],
    configurationClasses: ["demo.TestConfig"],
  });
  await expect(page.getByRole("region", { name: "Run", exact: true })).toBeHidden();
  await expect(page.getByRole("region", { name: "Services", exact: true }).getByRole("log")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Run method", exact: true })).toBeEnabled();
  await panel.screenshot({ path: "/tmp/openidea-method-test-panel.png", animations: "disabled" });
});
test("Stop cancels preparation and ignores its late response", async ({ workbench: page }) => {
  const panel = await openService(page);
  await page.evaluate(async () => {
    const path = "/src/bindings.ts";
    const { commands } = await import(path);
    commands.javaMethodPrepare = () =>
      new Promise((resolve) => {
        (window as MethodTestWindow).__finishMethodPreparation = resolve;
      });
    commands.cancelRequest = async () => {
      (window as MethodTestWindow).__methodCancelled = true;
    };
  });
  await panel.getByRole("button", { name: "Run method", exact: true }).click();
  await expect.poll(() => page.evaluate(() => !!(window as MethodTestWindow).__finishMethodPreparation)).toBe(true);
  await panel.getByRole("button", { name: "Stop method", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("Stopped");
  await page.evaluate(() =>
    (window as MethodTestWindow).__finishMethodPreparation?.({ status: "ok", data: { id: "late", config: {} } }),
  );
  await expect(panel.getByRole("button", { name: "Run method", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (window as MethodTestWindow).__methodCancelled)).toBe(true);
  expect(
    await page.evaluate(async () => {
      const path = "/src/features/run/store.ts";
      return (await import(path)).useRun.getState().sessions.length;
    }),
  ).toBe(0);
});
