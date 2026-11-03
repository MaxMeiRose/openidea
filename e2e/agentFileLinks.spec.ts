import { expect, test } from "@playwright/test";

test("agent messages open local paths and recognize files created after the message", async ({ page }) => {
  await page.goto("/e2e/agentFileLinks.html");
  const state = () =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            agentFileFixture: { opened: Array<{ path: string; options: unknown }>; probes: string[] };
          }
        ).agentFileFixture,
    );

  await page.getByRole("link", { name: "/tmp/报告 01.pdf" }).click();
  await page.getByRole("link", { name: "reports/总结.md:4:2" }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("link", { name: "本地链接" }).click();
  await expect
    .poll(async () => (await state()).opened)
    .toEqual([
      { path: "/tmp/报告 01.pdf", options: { focus: true } },
      { path: "/repo/reports/总结.md", options: { focus: true, selection: { line: 3, col: 1 } } },
      { path: "/tmp/report one.pdf", options: { focus: true } },
    ]);

  await expect.poll(async () => (await state()).probes).toContain("/repo/generated/new report.md");
  await expect(page.getByRole("link", { name: "generated/new report.md" })).toHaveCount(0);
  await page.getByRole("button", { name: "Create generated file" }).click();
  await page.getByRole("link", { name: "generated/new report.md" }).click();
  await expect.poll(async () => (await state()).opened.at(-1)?.path).toBe("/repo/generated/new report.md");
});
