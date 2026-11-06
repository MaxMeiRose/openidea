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
  public Order find(String id) { return null; }
  public int count() { return 0; }
}`;
async function openService(page: Page, source = SOURCE) {
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
  }, source);
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
  const args = panel.getByRole("textbox", { name: "Argument id", exact: true });
  await expect(args).toHaveValue("");
  await args.fill("sku-7");
  await panel.getByRole("textbox", { name: "Method case name" }).fill("Found order");
  await panel.getByRole("button", { name: "Save method case", exact: true }).click();
  await args.fill("changed");
  await panel.getByRole("button", { name: "Saved method cases", exact: true }).click();
  await page.getByRole("option", { name: /^Found order/ }).click();
  await expect(args).toHaveValue("sku-7");
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
    parameterTypes: ["String"],
    argumentsJson: '["sku-7"]',
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

test("method JSON fields accept pointer focus and keyboard input after leaving a Vim editor", async ({
  workbench: page,
}) => {
  const panel = await openService(page);
  await page.evaluate(async () => {
    const path = "/src/platform/actions.ts";
    await (await import(path)).executeAction("vim.toggle");
  });
  const editor = page.locator(".cm-editor .cm-content").first();
  await editor.click();
  await panel
    .getByRole("tablist", { name: "Argument input mode" })
    .getByRole("tab", { name: "JSON", exact: true })
    .click();
  const args = panel.getByRole("textbox", { name: "Method arguments", exact: true });
  await args.click();
  await expect(args).toBeFocused();
  await page.keyboard.press("Meta+A");
  await page.keyboard.type('["sku-1"]');
  await expect(args).toHaveValue('["sku-1"]');
  await panel.getByRole("tab", { name: "Dependencies", exact: true }).click();
  const dependencies = panel.getByRole("textbox", { name: "Method dependencies", exact: true });
  await dependencies.click();
  await page.keyboard.press("Meta+A");
  await page.keyboard.type('{"repository":{"kind":"mock"}}');
  await expect(dependencies).toHaveValue('{"repository":{"kind":"mock"}}');
});

test("typed arguments keep strings, long integers, booleans and collection values distinct", async ({
  workbench: page,
}) => {
  const panel = await openService(
    page,
    `package demo;
import java.util.List;
@Service public class OrderService {
 public Object find(String productId, long count, boolean enabled, Payload body, List<Payload> items) {return null;}
}
class Payload { public String name; }`,
  );
  await panel.getByRole("textbox", { name: "Argument productId", exact: true }).fill('sku-"7",[]');
  const count = panel.getByRole("textbox", { name: "Argument count", exact: true });
  await count.click();
  await page.keyboard.press("Meta+A");
  await page.keyboard.type("-42");
  await expect(count).toHaveValue("-42");
  await count.fill("9007199254740993");
  await panel.getByRole("checkbox", { name: "Argument enabled", exact: true }).check();
  await panel.getByRole("textbox", { name: "Argument body", exact: true }).fill('{"name":"sample"}');
  await panel.getByRole("textbox", { name: "Argument items", exact: true }).fill('[{"name":"one"}]');
  await panel.screenshot({ path: "/tmp/openidea-method-typed-parameters.png", animations: "disabled" });
  await panel
    .getByRole("tablist", { name: "Argument input mode" })
    .getByRole("tab", { name: "JSON", exact: true })
    .click();
  const json = panel.getByRole("textbox", { name: "Method arguments", exact: true });
  await expect(json).toHaveValue('["sku-\\"7\\",[]",9007199254740993,true,{"name":"sample"},[{"name":"one"}]]');
  await panel
    .getByRole("tablist", { name: "Argument input mode" })
    .getByRole("tab", { name: "Parameters", exact: true })
    .click();
  await expect(count).toHaveValue("9007199254740993");
  await panel.getByRole("checkbox", { name: "Null argument productId", exact: true }).check();
  await expect(panel.getByRole("textbox", { name: "Argument productId", exact: true })).toBeDisabled();
  await panel.getByRole("button", { name: "Run method", exact: true }).click();
  expect((await page.evaluate(() => (window as MethodTestWindow).__methodInput))?.argumentsJson).toBe(
    '[null,9007199254740993,true,{"name":"sample"},[{"name":"one"}]]',
  );
});
