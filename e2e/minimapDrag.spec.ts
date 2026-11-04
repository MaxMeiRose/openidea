import { expect, openFromTree, test } from "./fixtures";

test("dragging the minimap scrolls without changing the editor selection", async ({ workbench: page }) => {
  const editor = await openFromTree(page, "build.gradle.kts");
  await editor.locator(".cm-content").click();
  await page.keyboard.press("Meta+a");
  await page.keyboard.insertText(Array.from({ length: 400 }, (_, i) => `val minimapLine${i} = ${i}`).join("\n"));

  const selection = () =>
    page.evaluate(async () => {
      const module = "/src/editor/api.ts";
      const { activeEditor } = await import(module);
      const { anchor, head } = activeEditor()!.view.state.selection.main;
      return { anchor, head };
    });
  await page.evaluate(async () => {
    const module = "/src/editor/api.ts";
    const { activeEditor } = await import(module);
    activeEditor()!.view.dispatch({ selection: { anchor: 2, head: 10 } });
    activeEditor()!.view.scrollDOM.scrollTop = 0;
  });

  const scroller = editor.locator(".cm-scroller");
  const overlay = editor.locator(".cm-minimap-overlay");
  await expect(overlay).toBeVisible();
  const thumb = (await overlay.boundingBox())!;
  await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + Math.min(thumb.height / 2, 8));
  await page.mouse.down();
  await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + 80, { steps: 10 });
  await page.mouse.up();
  expect(await scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(await selection()).toEqual({ anchor: 2, head: 10 });

  const movedThumb = (await overlay.boundingBox())!;
  const content = (await editor.locator(".cm-content").boundingBox())!;
  const beforeCrossing = await scroller.evaluate((element) => element.scrollTop);
  await page.mouse.move(movedThumb.x + movedThumb.width / 2, movedThumb.y + Math.min(movedThumb.height / 2, 8));
  await page.mouse.down();
  // Keep dragging after the pointer leaves the minimap and crosses the editor.
  await page.mouse.move(content.x + content.width / 2, movedThumb.y + 140, { steps: 10 });
  await page.mouse.up();
  expect(await scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(beforeCrossing);
  expect(await selection()).toEqual({ anchor: 2, head: 10 });

  await scroller.evaluate((element) => {
    element.scrollTop = 0;
  });
  const track = (await editor.locator(".cm-minimap-overlay-container").boundingBox())!;
  await page.mouse.click(track.x + track.width / 2, track.y + track.height * 0.8);
  expect(await scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(await selection()).toEqual({ anchor: 2, head: 10 });

  // Ordinary editor dragging must still select text.
  await scroller.evaluate((element) => {
    element.scrollTop = 0;
  });
  const firstLine = (await editor.locator(".cm-line").first().boundingBox())!;
  await page.mouse.move(firstLine.x + 12, firstLine.y + firstLine.height / 2);
  await page.mouse.down();
  await page.mouse.move(firstLine.x + 100, firstLine.y + firstLine.height / 2, { steps: 5 });
  await page.mouse.up();
  const result = await selection();
  expect(result.anchor).not.toBe(result.head);
});
