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
    const visibleVariant = (shape: Element) => {
      for (let node: Element | null = shape; node && node !== element; node = node.parentElement) {
        if (getComputedStyle(node).display === "none") return false;
      }
      return true;
    };
    return {
      expected,
      primaryBackground,
      foreground: getComputedStyle(element).color,
      background: getComputedStyle(element).backgroundColor,
      strokes: [...element.querySelectorAll("svg [stroke]")]
        .filter(visibleVariant)
        .map((shape) => getComputedStyle(shape).stroke),
      fills: [...element.querySelectorAll("svg > g > path[fill]")]
        .filter(visibleVariant)
        .map((shape) => getComputedStyle(shape).fill),
    };
  }, variable);
}

for (const theme of ["light", "dark"]) {
  test(`API and Eureka sidebar icons remain legible in ${theme} selection states`, async ({ workbench: page }) => {
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
      const idleColors = (result: Awaited<ReturnType<typeof colors>>) => {
        if (name === "Eureka") {
          return result.strokes.length > 0 && result.strokes.every((stroke) => stroke === result.expected);
        }
        const [globe, play] =
          theme === "light" ? ["rgb(53, 116, 240)", "rgb(54, 150, 80)"] : ["rgb(84, 138, 247)", "rgb(87, 150, 92)"];
        return result.strokes.join("|") === `${globe}|${play}` && result.fills.join("|") === play;
      };
      await page.mouse.move(700, 300);
      await expect(button).toHaveAttribute("aria-pressed", "false");
      await expect
        .poll(async () => {
          const result = await colors(button, "--fg-icon");
          return idleColors(result);
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
            result.foreground === "rgb(255, 255, 255)" &&
            result.strokes.every((stroke) => stroke === result.expected) &&
            result.fills.every((fill) => fill === result.expected)
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
          return idleColors(result) && result.background !== selected.background;
        })
        .toBe(true);

      await button.click();
      await page.mouse.move(700, 300);
      await expect(button).toHaveAttribute("aria-pressed", "false");
      await expect
        .poll(async () => {
          const result = await colors(button, "--fg-icon");
          return idleColors(result);
        })
        .toBe(true);
    }
    await stripe.screenshot({ path: `/tmp/openidea-api-eureka-icons-${theme}.png`, animations: "disabled" });
  });
}
