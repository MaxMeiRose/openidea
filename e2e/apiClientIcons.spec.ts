import type { Locator } from "@playwright/test";
import { expect, test } from "./fixtures";

async function colors(button: Locator, variable: string) {
  return button.evaluate((element, variable) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${variable})`;
    probe.style.backgroundColor = "var(--bg-button-primary)";
    element.append(probe);
    const expected = getComputedStyle(probe).color;
    const primaryBackground = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return {
      expected,
      primaryBackground,
      foreground: getComputedStyle(element).color,
      background: getComputedStyle(element).backgroundColor,
      strokes: [...element.querySelectorAll("svg [stroke]")].map((shape) => getComputedStyle(shape).stroke),
    };
  }, variable);
}

for (const theme of ["light", "dark"]) {
  test(`API and Eureka sidebar icons inherit ${theme} selection colors`, async ({ workbench: page }) => {
    await page.evaluate(async (theme) => {
      const module = "/src/workbench/theme.ts";
      (await import(module)).useThemeOverride.setState({ theme });
    }, theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const stripe = page.getByRole("toolbar", { name: "Right tool windows", exact: true });
    const api = stripe.locator('[data-stripe-button="apiClient"]');
    const eureka = stripe.locator('[data-stripe-button="eureka"]');
    await expect(api).toBeVisible();
    await expect(eureka).toBeVisible();
    const order = await stripe
      .locator("[data-stripe-button]")
      .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("data-stripe-button")));
    expect(order[order.indexOf("apiClient") + 1]).toBe("eureka");

    for (const [button, name] of [
      [api, "API Client"],
      [eureka, "Eureka"],
    ] as const) {
      await page.mouse.move(700, 300);
      await expect(button).toHaveAttribute("aria-pressed", "false");
      await expect
        .poll(async () => {
          const result = await colors(button, "--fg-icon");
          return result.strokes.length > 0 && result.strokes.every((stroke) => stroke === result.expected);
        })
        .toBe(true);

      await button.click();
      await expect(page.getByRole("region", { name, exact: true })).toBeVisible();
      await expect(button).toHaveAttribute("aria-pressed", "true");
      await page.mouse.move(700, 300);
      await expect
        .poll(async () => {
          const result = await colors(button, "--fg-button-primary");
          return (
            result.foreground === "rgb(255, 255, 255)" && result.strokes.every((stroke) => stroke === result.expected)
          );
        })
        .toBe(true);
      const selected = await colors(button, "--fg-button-primary");
      expect(selected.background).toBe(selected.primaryBackground);
      await stripe.screenshot({
        path: `/tmp/openidea-${name === "API Client" ? "api" : "eureka"}-icon-selected-${theme}.png`,
        animations: "disabled",
      });

      await page.getByRole("tree", { name: "Project", exact: true }).click();
      await page.mouse.move(700, 300);
      await expect(button).toHaveAttribute("aria-pressed", "true");
      await expect
        .poll(async () => {
          const result = await colors(button, "--fg-icon");
          return (
            result.strokes.every((stroke) => stroke === result.expected) && result.background !== selected.background
          );
        })
        .toBe(true);

      await button.click();
      await page.mouse.move(700, 300);
      await expect(button).toHaveAttribute("aria-pressed", "false");
      await expect
        .poll(async () => {
          const result = await colors(button, "--fg-icon");
          return result.strokes.every((stroke) => stroke === result.expected);
        })
        .toBe(true);
    }
    await stripe.screenshot({ path: `/tmp/openidea-api-eureka-icons-${theme}.png`, animations: "disabled" });
  });
}
