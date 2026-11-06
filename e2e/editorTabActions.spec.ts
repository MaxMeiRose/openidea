import { expect, openFromTree, test } from "./fixtures";

test("tab actions stay at the right edge when tabs scroll", async ({ workbench: page }, testInfo) => {
  await openFromTree(page, "build.gradle.kts");
  const pane = page.getByRole("region", { name: "Editor", exact: true }).first();
  const actions = pane.getByRole("button", { name: "Tab Actions", exact: true });
  const rightGap = async () => {
    const [editor, button] = await Promise.all([pane.boundingBox(), actions.boundingBox()]);
    return editor!.x + editor!.width - button!.x - button!.width;
  };
  await page.screenshot({ path: testInfo.outputPath("tabs.png"), animations: "disabled" });
  expect(await rightGap()).toBeGreaterThanOrEqual(0);
  expect(await rightGap()).toBeLessThanOrEqual(1);

  await openFromTree(page, "settings.gradle.kts");
  await openFromTree(page, "README.md");
  await openFromTree(page, ".gitignore");
  await page.setViewportSize({ width: 800, height: 900 });
  const tabs = pane.getByRole("tablist", { name: "Editor tabs" });
  await expect.poll(() => tabs.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await tabs.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  await expect.poll(() => tabs.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await expect(actions).toBeVisible();
  expect(await rightGap()).toBeGreaterThanOrEqual(0);
  expect(await rightGap()).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath("tabs-overflow.png"), animations: "disabled" });
  await actions.click();
  await expect(page.getByRole("menu", { name: "Tab actions" })).toBeVisible();
});
