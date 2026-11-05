import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

async function configure(page: Page) {
  await page.evaluate(async () => {
    const bindingsPath = "/src/bindings.ts";
    const contributionPath = "/src/workbench/contributions.ts";
    const layoutPath = "/src/workbench/toolwindows/store.ts";
    const { commands } = await import(bindingsPath);
    const { showServiceView } = await import(contributionPath);
    const { setToolWindowSize } = await import(layoutPath);
    const lists = new Map<string, Array<{ name: string; instance: Array<{ instanceId: string; status: string }> }>>();
    const calls: Array<{ url: string; service: string; instance: string; status: string }> = [];
    (window as unknown as { eurekaWrites: typeof calls }).eurekaWrites = calls;
    const services = (url: string) => {
      if (!lists.has(url))
        lists.set(
          url,
          url.endsWith(":32044")
            ? [
                {
                  name: "ORDERS",
                  instance: [
                    { instanceId: "host-a:orders:8080", status: "UP" },
                    { instanceId: "host-b:orders:8081", status: "DOWN" },
                  ],
                },
                { name: "PAYMENTS", instance: [{ instanceId: "host-c:payments:8082", status: "OUT_OF_SERVICE" }] },
              ]
            : [
                {
                  name: url.endsWith(":32045") ? "TEST-ONLY" : "STAGING",
                  instance: [{ instanceId: "test:app:8080", status: "UP" }],
                },
              ],
        );
      return lists.get(url)!;
    };
    commands.eurekaServices = async (_request: number, url: string) => ({
      status: "ok",
      data: structuredClone(services(url)),
    });
    commands.eurekaSetStatus = async (
      _request: number,
      url: string,
      service: string,
      instance: string,
      status: string,
    ) => {
      calls.push({ url, service, instance, status });
      services(url)
        .find((item) => item.name === service)!
        .instance.find((item) => item.instanceId === instance)!.status = status;
      return { status: "ok", data: null };
    };
    setToolWindowSize("bottom", 520);
    showServiceView("eureka", true);
  });
  const view = page.getByRole("region", { name: "Eureka", exact: true });
  await expect(view).toBeVisible();
  return view;
}

async function addEnvironment(page: Page, name: string, address: string) {
  await page.getByRole("button", { name: "Add Eureka Environment", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add Eureka Environment" });
  await dialog.getByRole("textbox", { name: "Environment name" }).fill(name);
  await dialog.getByRole("textbox", { name: "Server address" }).fill(address);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
}

test("Eureka environments can be added, configured, switched, searched and restored", async ({ workbench: page }) => {
  const view = await configure(page);
  await expect(view.getByText("No Eureka environments")).toBeVisible();
  await addEnvironment(page, "Development", "127.0.0.1:32044");
  await expect(view.getByRole("table")).toContainText("ORDERS");
  await view.getByRole("textbox", { name: "Search Eureka services" }).fill("orders host-b");
  await expect(view.getByRole("table")).toContainText("host-b:orders:8081");
  await expect(view.getByRole("table")).not.toContainText("host-a:orders:8080");
  await view.getByRole("textbox", { name: "Search Eureka services" }).fill("");
  await addEnvironment(page, "Test", "http://127.0.0.1:32045");
  await expect(view.getByRole("table")).toContainText("TEST-ONLY");
  await view.getByRole("button", { name: "Edit Eureka Environment", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "Edit Eureka Environment" });
  await edit.getByRole("textbox", { name: "Server address" }).fill("http://127.0.0.1:32046");
  await edit.getByRole("button", { name: "Save", exact: true }).click();
  await expect(view.getByRole("table")).toContainText("STAGING");
  await view.getByRole("button", { name: "Eureka environment", exact: true }).click();
  await page.getByRole("option", { name: /Development/ }).click();
  await expect(view.getByRole("table")).toContainText("ORDERS");
  await page.reload();
  await expect(page.getByRole("tree", { name: "Project" })).toBeVisible();
  await configure(page);
  await expect(view.getByRole("table")).toContainText("ORDERS");
  await view.getByRole("button", { name: "Eureka environment", exact: true }).click();
  await page.getByRole("option", { name: /Test/ }).click();
  await expect(view.getByRole("table")).toContainText("STAGING");
  await expect(view.getByText("http://127.0.0.1:32046", { exact: true })).toBeVisible();
  await view.getByRole("button", { name: "Remove Eureka Environment" }).click();
  await page
    .getByRole("dialog", { name: "Remove Eureka Environment" })
    .getByRole("button", { name: "Remove", exact: true })
    .click();
  await expect(view.getByRole("button", { name: "Eureka environment", exact: true })).toHaveText("Development");
  expect(await page.evaluate(() => (window as unknown as { eurekaWrites: unknown[] }).eurekaWrites)).toEqual([]);
  await view.screenshot({ path: "/tmp/openidea-eureka-light.png", animations: "disabled" });
  await page.evaluate(async () => {
    const module = "/src/workbench/theme.ts";
    (await import(module)).useThemeOverride.setState({ theme: "dark" });
  });
  await view.screenshot({ path: "/tmp/openidea-eureka-dark.png", animations: "disabled" });
});

test("status changes target one instance and are confirmed by reloading its environment", async ({
  workbench: page,
}) => {
  const view = await configure(page);
  await addEnvironment(page, "Development", "http://127.0.0.1:32044");
  const row = view.getByRole("row").filter({ hasText: "host-a:orders:8080" });
  await row.getByRole("button", { name: "Set host-a:orders:8080 DOWN", exact: true }).click();
  await expect(row.getByRole("button")).toBeDisabled();
  await expect(row.getByText("UP", { exact: true })).toBeVisible();
  await expect(row.getByText("DOWN", { exact: true })).toBeVisible();
  await expect(row.getByRole("button", { name: "Set host-a:orders:8080 UP", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (window as unknown as { eurekaWrites: unknown[] }).eurekaWrites)).toEqual([
    { url: "http://127.0.0.1:32044", service: "ORDERS", instance: "host-a:orders:8080", status: "DOWN" },
  ]);
  await page.evaluate(async () => {
    const module = "/src/bindings.ts";
    (await import(module)).commands.eurekaSetStatus = async () => ({
      status: "error",
      error: { kind: "io", message: "Connection refused", data: null },
    });
  });
  await row.getByRole("button", { name: "Set host-a:orders:8080 UP", exact: true }).click();
  await expect(view.getByRole("alert")).toContainText("Connection refused");
  await expect(row.getByRole("button")).toBeEnabled();
  await expect(row.getByText("DOWN", { exact: true })).toBeVisible();
});
