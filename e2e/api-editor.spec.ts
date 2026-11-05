import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const SOURCE = `@RestController
@RequestMapping("/api/orders")
class OrderController {
  @GetMapping(
    path = "/{id}"
  )
  public Order find(@PathVariable String id, @RequestParam(defaultValue = "25") int limit) { return null; }
  @PostMapping
  public Order save(@RequestBody CreateOrder body) { return null; }
}
class CreateOrder { private String name; private int count; }
`;

async function openSource(page: Page, source: string, path: string) {
  await expect(page.locator("#splash")).toBeHidden();
  await page.evaluate(
    async ({ source, path }) => {
      const backendPath = "/src/editor/core/backend.ts";
      const bindingsPath = "/src/bindings.ts";
      const workbenchPath = "/src/workbench/contributions.ts";
      const layoutPath = "/src/workbench/toolwindows/store.ts";
      const { commands } = await import(bindingsPath);
      commands.fsProbe = async () => ({ status: "ok", data: { size: source.length, binary: false, tooLarge: false } });
      commands.fsReadText = async (file: string) => ({
        status: "ok",
        data: file === path ? "" : file.endsWith("application.properties") ? "server.port=9191" : "",
      });
      commands.springRouteSources = async () => ({ status: "ok", data: [] });
      commands.httpHistory = async () => ({ status: "ok", data: [] });
      commands.httpExecuteRaw = async () => {
        throw new Error("Opening an API call must not send a request");
      };
      const backend = (await import(backendPath)).docBackend();
      backend.files.set(path, source);
      (await import(layoutPath)).setToolWindowSize("right", 850);
      await (await import(workbenchPath)).editorService().openFile(path, { focus: true });
    },
    { source, path },
  );
  const editor = page.locator(".cm-editor").first();
  await expect(editor.locator(".cm-content")).toContainText(source.split("\n")[0]!);
  return editor;
}

test("controller gutter icons prepare unsaved API mappings, parameters and JSON without sending", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 1900, height: 1050 });
  const editor = await openSource(page, SOURCE, "/dev/acme-api/OrderController.java");
  const current = SOURCE.replace("/api/orders", "/api/unsaved-orders");
  await editor.locator(".cm-content").fill(current);
  // CodeMirror hides its gutter container from the accessibility tree.
  const calls = editor.locator('.cm-openidea-gutter-spring button[aria-label^="API Call · "]');
  await expect(calls).toHaveCount(2);
  await expect(editor.locator(".cm-openidea-lens").getByRole("button", { name: "API Call", exact: true })).toHaveCount(
    0,
  );
  const icon = await calls.first().boundingBox();
  const method = await editor
    .locator(".cm-line")
    .filter({ hasText: /public Order find\(/ })
    .boundingBox();
  expect(icon!.x + icon!.width).toBeLessThan(method!.x);
  expect(Math.abs(icon!.y + icon!.height / 2 - method!.y - method!.height / 2)).toBeLessThan(3);
  await calls.first().click();
  const client = page.getByRole("region", { name: "API Client", exact: true });
  await expect(client).toBeVisible();
  await expect(client.getByRole("textbox", { name: "Request URL", exact: true })).toHaveValue(
    "/api/unsaved-orders/{id}",
  );
  await expect(client.getByRole("textbox", { name: "Query parameters value 1" })).toHaveValue("25");
  await expect(client.getByRole("textbox", { name: "Request base URL" })).toHaveValue("http://localhost:9191");
  await calls.nth(1).click();
  await expect(client.getByRole("textbox", { name: "Request URL", exact: true })).toHaveValue("/api/unsaved-orders");
  await client.getByRole("tablist", { name: "Request data" }).getByRole("tab", { name: "Body", exact: true }).click();
  await expect(client.getByRole("textbox", { name: "Request body", exact: true })).toHaveValue(
    '{\n  "name": "",\n  "count": 0\n}',
  );
  await calls.nth(1).click();
  await expect(client.getByRole("tablist", { name: "API request tabs" }).getByRole("tab")).toHaveCount(2);
  await page.screenshot({ path: "/tmp/openidea-api-controller-gutter.png", animations: "disabled" });
});

test("Kotlin controller gutter icons offer each mapped URL", async ({ workbench: page }) => {
  const source = `@RestController
@RequestMapping("/api")
class HealthController {
  @GetMapping(value = ["/health", "/ready"])
  fun health(): String = "ok"
}`;
  const editor = await openSource(page, source, "/dev/acme-api/HealthController.kt");
  await editor.locator('.cm-openidea-gutter-spring button[aria-label^="API Call · "]').click();
  await page.getByRole("menuitem", { name: "GET /api/ready", exact: true }).click();
  const client = page.getByRole("region", { name: "API Client", exact: true });
  await expect(client.getByRole("textbox", { name: "Request URL", exact: true })).toHaveValue("/api/ready");
});

for (const theme of ["light", "dark"]) {
  test(`enabled unverified breakpoints stay red while debugging in ${theme} theme`, async ({ workbench: page }) => {
    const path = "/dev/acme-api/breakpoint-test.py";
    const editor = await openSource(page, "def main():\n    value = 1\n    return value\n", path);
    await page.evaluate(async (theme) => {
      const themePath = "/src/workbench/theme.ts";
      const debugPath = "/src/features/debugger/state.ts";
      (await import(themePath)).useThemeOverride.setState({ theme });
      (await import(debugPath)).adoptSession(777, { name: "Synthetic debug session", adapter: "delve" });
    }, theme);
    await editor.locator(".cm-lineNumbers .cm-gutterElement").filter({ hasText: /^2$/ }).click();
    const state = await page.evaluate(async (path) => {
      const storePath = "/src/features/debugger/breakpoints/store.ts";
      const stylePath = "/src/features/debugger/editor/editor.module.css";
      const { applyStates, breakpointsOf } = await import(storePath);
      const bp = breakpointsOf(path)[0];
      if (!bp) throw new Error("Gutter click did not create a breakpoint");
      applyStates(path, [{ line: 1, verified: false, message: "Waiting for executable code" }]);
      const styles = (await import(stylePath)).default;
      return { bp, unverified: styles.unverified, disabled: styles.disabled };
    }, path);
    const marker = editor.locator(`.cm-lineNumbers .${state.unverified}`);
    await expect(marker).toHaveCount(1);
    await expect
      .poll(() =>
        marker.evaluate((element) => {
          const probe = document.createElement("span");
          probe.style.color = "var(--danger)";
          element.append(probe);
          const expected = getComputedStyle(probe).color;
          probe.remove();
          return getComputedStyle(element, "::before").backgroundColor === expected;
        }),
      )
      .toBe(true);
    await page.evaluate(async () => {
      const actionPath = "/src/platform/actions.ts";
      await (await import(actionPath)).executeAction("debug.viewBreakpoints");
    });
    const dialog = page.getByRole("dialog", { name: "Breakpoints", exact: true });
    await expect(dialog).toBeVisible();
    const dot = dialog.locator('[data-look="unverified"]');
    await expect
      .poll(() =>
        dot.evaluate((element) => {
          const probe = document.createElement("span");
          probe.style.color = "var(--danger)";
          element.append(probe);
          const expected = getComputedStyle(probe).color;
          probe.remove();
          return getComputedStyle(element).backgroundColor === expected;
        }),
      )
      .toBe(true);
    const verification = await page.evaluate(
      async ({ path, id }) => {
        const storePath = "/src/features/debugger/breakpoints/store.ts";
        const { useBreakpoints, updateBreakpoint } = await import(storePath);
        const verification = useBreakpoints.getState().status[id];
        updateBreakpoint(path, id, { enabled: false });
        return verification;
      },
      { path, id: state.bp.id },
    );
    expect(verification).toMatchObject({ verified: false, message: "Waiting for executable code" });
    await expect(editor.locator(`.cm-lineNumbers .${state.disabled}`)).toHaveCount(1);
  });
}
