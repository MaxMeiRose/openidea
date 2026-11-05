import type { Page } from "@playwright/test";
import type { PreparedRequest } from "../src/bindings";
import { expect, test } from "./fixtures";

const SOURCE = `package com.acme;
@RestController
@RequestMapping("/api/orders")
public class OrderController {
  @GetMapping("/{id}")
  public Order find(@PathVariable String id, @RequestParam(defaultValue = "10") int limit) { return null; }
  @PostMapping
  public Order save(@RequestBody CreateOrder request) { return null; }
}
class CreateOrder { private String name; private int count; }
`;
type Harness = { sent: PreparedRequest[]; sources: Array<{ path: string; selection: { line: number; col: number } }> };

async function harness(page: Page) {
  await expect(page.locator("#splash")).toBeHidden();
  await page.evaluate(async (source) => {
    const bindings = "/src/bindings.ts";
    const contributionPath = "/src/workbench/contributions.ts";
    const layoutPath = "/src/workbench/toolwindows/store.ts";
    const clientPath = "/src/features/api-client/store.ts";
    const { commands } = await import(bindings);
    const { editorService, toolWindowService } = await import(contributionPath);
    const { setToolWindowSize } = await import(layoutPath);
    const data = { sent: [] as PreparedRequest[], sources: [] as Harness["sources"] };
    (window as unknown as { apiHarness: Harness }).apiHarness = data;
    const exchanges: Array<{ entry: { id: string }; request: PreparedRequest }> = [];
    commands.springRouteSources = async () => ({
      status: "ok",
      data: [{ path: "/dev/acme-api/src/main/java/com/acme/OrderController.java", text: source }],
    });
    commands.fsReadText = async (path: string) => ({
      status: "ok",
      data: path.endsWith("OrderController.java")
        ? source
        : path.endsWith("application.properties")
          ? "server.port=9090"
          : "",
    });
    commands.httpExecuteRaw = async (_request: number, prepared: PreparedRequest) => {
      data.sent.push(prepared);
      const id = `api-${exchanges.length + 1}`;
      const exchange = {
        entry: {
          id,
          name: prepared.name,
          method: prepared.method,
          url: prepared.url,
          timeMs: Date.now(),
          status: 200,
          totalMs: 12,
          file: null,
          error: null,
        },
        request: prepared,
        response: {
          status: 200,
          statusText: "OK",
          version: "HTTP/1.1",
          headers: [
            ["Content-Type", "application/json"],
            ["X-Request", id],
          ],
          contentType: "application/json",
          body: JSON.stringify({ url: prepared.url, method: prepared.method, ok: true }),
          size: 99,
          truncated: false,
          ttfbMs: 3,
          totalMs: 12,
        },
      };
      exchanges.unshift(exchange);
      return { status: "ok", data: exchange };
    };
    commands.httpHistory = async () => ({ status: "ok", data: exchanges.map((exchange) => exchange.entry) });
    commands.httpHistoryGet = async (id: string) => ({
      status: "ok",
      data: exchanges.find((exchange) => exchange.entry.id === id),
    });
    editorService().openFile = async (path: string, options: { selection: { line: number; col: number } }) => {
      data.sources.push({ path, selection: options.selection });
    };
    setToolWindowSize("right", 1000);
    toolWindowService().show("apiClient", true);
    await (await import(clientPath)).refreshEndpoints();
  }, SOURCE);
  const client = page.getByRole("region", { name: "API Client", exact: true });
  await expect(client.getByRole("treeitem", { name: "GET /api/orders/{id}", exact: true })).toBeVisible();
  return client;
}
const recorded = (page: Page) => page.evaluate(() => (window as unknown as { apiHarness: Harness }).apiHarness.sent);

test("discovers Spring endpoints, fills parameters, switches environment, restores history and preserves drafts", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 1800, height: 1100 });
  const client = await harness(page);
  await client.getByRole("treeitem", { name: "GET /api/orders/{id}", exact: true }).click();
  await expect(client.getByRole("textbox", { name: "Request URL", exact: true })).toHaveValue("/api/orders/{id}");
  await expect(client.getByRole("textbox", { name: "Query parameters value 1" })).toHaveValue("10");
  await expect(client.getByRole("textbox", { name: "Request base URL" })).toHaveValue("http://localhost:9090");
  await client.getByRole("textbox", { name: "Path parameters value 1" }).fill("a/b");
  await client.getByRole("button", { name: "Go to API source" }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { apiHarness: Harness }).apiHarness.sources))
    .toMatchObject([{ path: "/dev/acme-api/src/main/java/com/acme/OrderController.java", selection: { line: 5 } }]);
  await client.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => recorded(page)).toMatchObject([{ url: "http://localhost:9090/api/orders/a%2Fb?limit=10" }]);
  await expect(client.getByLabel("Response body", { exact: true })).toContainText('"ok": true');
  await client.getByRole("button", { name: "Add API Environment", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add API Environment" });
  await dialog.getByRole("textbox", { name: "Environment name" }).fill("Test");
  await dialog.getByRole("textbox", { name: "Base URL", exact: true }).fill("https://test.example/gateway");
  await dialog.getByRole("textbox", { name: "Default request headers" }).fill("Authorization: Bearer test");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await client.getByRole("button", { name: "Send", exact: true }).click();
  await expect
    .poll(async () => (await recorded(page))[1])
    .toMatchObject({
      url: "https://test.example/gateway/api/orders/a%2Fb?limit=10",
      headers: [["Authorization", "Bearer test"]],
    });
  await expect(client.getByRole("textbox", { name: "Request URL", exact: true })).toHaveValue("/api/orders/{id}");
  await client.getByRole("tab", { name: "History", exact: true }).click();
  await expect(client.getByLabel("Request history").getByRole("button")).toHaveCount(2);
  await client.getByLabel("Request history").getByRole("button").first().click();
  await expect(client.getByRole("tablist", { name: "API request tabs" }).getByRole("tab")).toHaveCount(2);
  await expect(client.getByRole("textbox", { name: "Request URL", exact: true })).toHaveValue(
    "/gateway/api/orders/a%2Fb",
  );
  await expect(client.getByRole("textbox", { name: "Request base URL" })).toHaveValue("https://test.example");
  await client.getByRole("tablist", { name: "API request tabs" }).getByRole("tab").first().click();
  await expect(client.getByRole("textbox", { name: "Path parameters value 1" })).toHaveValue("a/b");
  await page.screenshot({ path: "/tmp/openidea-api-client-wide.png", animations: "disabled" });
  await page.reload();
  await expect(page.getByRole("tree", { name: "Project" })).toBeVisible();
  await harness(page);
  await expect(client.getByRole("tablist", { name: "API request tabs" }).getByRole("tab")).toHaveCount(2);
  await expect(client.getByRole("textbox", { name: "Path parameters value 1" })).toHaveValue("a/b");
});

test("builds JSON skeletons and sends raw bodies and request header overrides without interpreting .http syntax", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 1800, height: 1100 });
  const client = await harness(page);
  await client.getByRole("treeitem", { name: "POST /api/orders", exact: true }).click();
  await client.getByRole("tablist", { name: "Request data" }).getByRole("tab", { name: "Body", exact: true }).click();
  await expect(client.getByRole("textbox", { name: "Request body", exact: true })).toHaveValue(
    '{\n  "name": "",\n  "count": 0\n}',
  );
  const body = "\n< /tmp/private-file\n> script\n###foo\n{{token}}\n  \n";
  await client.getByRole("textbox", { name: "Request body", exact: true }).fill(body);
  await client.getByRole("button", { name: "Send", exact: true }).click();
  await expect
    .poll(async () => (await recorded(page))[0])
    .toMatchObject({
      method: "POST",
      url: "http://localhost:9090/api/orders",
      headers: [["Content-Type", "application/json"]],
      body,
    });
  await client
    .getByRole("tablist", { name: "Response data" })
    .getByRole("tab", { name: "Sent request", exact: true })
    .click();
  await expect(client.getByLabel("Sent request", { exact: true })).toContainText("< /tmp/private-file");
  await client.getByRole("button", { name: "New API request", exact: true }).click();
  await client.getByRole("textbox", { name: "Request URL", exact: true }).fill("https://manual.example/health");
  await client.getByRole("button", { name: "Send", exact: true }).click();
  await expect
    .poll(async () => (await recorded(page))[1])
    .toMatchObject({ url: "https://manual.example/health", method: "GET" });
  await page.evaluate(async () => {
    const module = "/src/workbench/toolwindows/store.ts";
    (await import(module)).setToolWindowSize("right", 420);
  });
  await expect.poll(() => client.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: "/tmp/openidea-api-client-narrow.png", animations: "disabled" });
});
