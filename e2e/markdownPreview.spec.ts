import type { Locator, Page } from "@playwright/test";
import { expect, openFromTree, test } from "./fixtures";

const width = (node: Locator) => node.evaluate((el) => el.getBoundingClientRect().width);

async function open(page: Page) {
  const editor = await openFromTree(page, "README.md");
  await page.getByRole("button", { name: "Editor and Preview", exact: true }).click();
  const divider = page.getByRole("separator", { name: "Resize Markdown editor and preview" });
  await expect(divider).toBeVisible();
  return { editor, divider, preview: page.getByRole("document", { name: "Markdown preview" }) };
}

async function drag(page: Page, divider: Locator, delta: number) {
  const box = (await divider.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + delta, y, { steps: 12 });
  await page.mouse.up();
}

test("Markdown divider resizes both panes and keeps them usable at the edges", async ({ workbench: page }) => {
  const { editor, divider, preview } = await open(page);
  const initial = await width(editor);
  const previewInitial = await width(preview);
  await drag(page, divider, 150);
  await expect.poll(() => width(editor)).toBeCloseTo(initial + 150, 0);
  await expect.poll(() => width(preview)).toBeCloseTo(previewInitial - 150, 0);
  await drag(page, divider, -220);
  await expect.poll(() => width(editor)).toBeCloseTo(initial - 70, 0);

  await drag(page, divider, -2000);
  await expect.poll(() => width(editor)).toBeGreaterThanOrEqual(119);
  await expect.poll(() => width(editor)).toBeLessThan(121);
  await drag(page, divider, 2000);
  await expect.poll(() => width(preview)).toBeGreaterThanOrEqual(119);
  await expect.poll(() => width(preview)).toBeLessThan(121);
});

test("Markdown layouts preserve edits, the editor instance and the chosen split ratio", async ({ workbench: page }) => {
  const { editor, divider, preview } = await open(page);
  const content = editor.locator(".cm-content");
  await content.click();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Markdown resize regression");
  await expect(preview).toContainText("Markdown resize regression");
  const source = await editor.elementHandle();
  await drag(page, divider, 130);
  const splitWidth = await width(editor);
  const totalWidth = splitWidth + (await width(preview)) + 1;

  await page.getByRole("button", { name: "Preview Only", exact: true }).click();
  await expect(editor).toBeHidden();
  await expect(divider).toBeHidden();
  await expect.poll(() => width(preview)).toBeCloseTo(totalWidth, 0);

  await page.getByRole("button", { name: "Editor Only", exact: true }).click();
  await expect(preview).toHaveCount(0);
  await expect(divider).toBeHidden();
  await expect.poll(() => width(editor)).toBeCloseTo(totalWidth, 0);
  await expect(content).toContainText("Markdown resize regression");
  expect(await source!.evaluate((el) => el.isConnected)).toBe(true);

  await page.getByRole("button", { name: "Editor and Preview", exact: true }).click();
  await expect(divider).toBeVisible();
  await expect.poll(() => width(editor)).toBeCloseTo(splitWidth, 0);
  await divider.focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => width(editor)).toBeLessThan(splitWidth);
});
