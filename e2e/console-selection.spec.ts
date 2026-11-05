import { expect, test, type Page } from "@playwright/test";

/** Mount the real console with enough output to recycle rows while selecting. */
async function consoleOutput(page: Page, follow = false, debug = false, interactive = false) {
  await page.goto("/");
  await expect(page.locator("#splash")).toBeHidden();
  await expect(page.getByRole("tree", { name: "Project", exact: true })).toBeVisible();
  await page.evaluate(
    async ({ follow, debug, interactive }) => {
      const reactPath = "/node_modules/.vite/deps/react.js";
      const domPath = "/node_modules/.vite/deps/react-dom_client.js";
      const viewPath = "/src/features/run/ConsoleView.tsx";
      const modelPath = "/src/features/run/console.ts";
      const react = await import(reactPath);
      const dom = await import(domPath);
      const { createElement, useEffect, useState } = react.default ?? react;
      const { createRoot } = dom.default ?? dom;
      const text = Array.from({ length: 500 }, (_, i) => `output ${i}`).join("\n");
      const host = document.createElement("div");
      host.style.cssText = "position:fixed;inset:0;z-index:99999;display:flex;height:300px;background:white";
      document.body.append(host);
      if (debug) {
        const debugPath = "/src/features/debugger/ui/DebugConsole.tsx";
        const statePath = "/src/features/debugger/state.ts";
        const { DebugConsole, DebugServiceConsole } = await import(debugPath);
        const { adoptSession, appendConsole } = await import(statePath);
        const session = adoptSession(1234, { name: "test-debug-console" });
        appendConsole(1234, "stdout", text);
        (window as unknown as { appendTestOutput: (text: string) => void }).appendTestOutput = (text) =>
          appendConsole(1234, "stdout", text);
        createRoot(host).render(
          interactive
            ? createElement(DebugConsole, { session })
            : createElement(DebugServiceConsole, { sessionId: 1234 }),
        );
        return;
      }
      const { ConsoleView } = await import(viewPath);
      const { ConsoleModel } = await import(modelPath);
      const model = new ConsoleModel();
      model.append({ kind: "stdout", text });
      function Console() {
        const [following, setFollowing] = useState(follow);
        const [version, setVersion] = useState(1);
        useEffect(() => {
          (window as unknown as { appendTestOutput: (text: string) => void }).appendTestOutput = (text) => {
            model.append({ kind: "stdout", text });
            setVersion((version: number) => version + 1);
          };
        }, []);
        return createElement(ConsoleView, {
          model,
          version,
          softWrap: false,
          follow: following,
          onFollowChange: setFollowing,
          cwd: "/",
        });
      }
      createRoot(host).render(createElement(Console));
    },
    { follow, debug, interactive },
  );
  const log = page.getByRole("log", { name: debug ? "Debug console" : "Console", exact: true });
  await expect(log.locator("[data-index]").first()).toBeVisible();
  return log;
}

for (const debug of [false, true]) {
  test(`${debug ? "Debug REPL" : "Run find"} input keeps its own Select All`, async ({ page }) => {
    const log = await consoleOutput(page, false, debug, debug);
    await log.focus();
    await page.keyboard.press("Control+A");
    if (!debug) await page.keyboard.press("Meta+F");
    const input = page.getByRole("textbox", { name: debug ? "Debug console input" : "Find in console", exact: true });
    await input.fill("editable field");
    await input.press("Meta+A");
    expect(await input.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([
      0,
      "editable field".length,
    ]);
    await input.press("x");
    await expect(input).toHaveValue("x");
  });
}

test("keeps a console selection intact when scrolling beyond the virtual window", async ({ page }) => {
  const log = await consoleOutput(page);
  await log.evaluate((el) => {
    el.scrollTop = 200 * 20;
  });
  const start = log.locator('[data-index="205"]');
  await expect(start).toBeVisible();
  await start.evaluate((el) => {
    const selection = window.getSelection()!;
    selection.setBaseAndExtent(el.firstChild!.firstChild!, 2, el.nextElementSibling!.firstChild!.firstChild!, 5);
  });
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe("tput 205\noutpu");
  await log.evaluate((el) => {
    el.scrollTop = 350 * 20;
  });
  await expect(log.locator('[data-index="350"]')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe("tput 205\noutpu");
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await expect(start).toHaveCount(0);
});

test("preserves all lines in a drag selection across virtual windows", async ({ page }) => {
  const log = await consoleOutput(page);
  await log.evaluate((el) => {
    el.scrollTop = 200 * 20;
  });
  const start = log.locator('[data-index="205"]');
  await expect(start).toBeVisible();
  const box = (await start.boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + 30, { steps: 5 });
  await log.evaluate((el) => {
    el.scrollTop = 280 * 20;
  });
  const end = log.locator('[data-index="285"]');
  await expect(end).toBeVisible();
  const endBox = (await end.boundingBox())!;
  await page.mouse.move(endBox.x + 60, endBox.y + 10, { steps: 5 });
  await page.mouse.up();
  const text = await page.evaluate(() => window.getSelection()?.toString());
  expect(text).toContain("output 206\noutput 207");
  expect(text).toContain("output 250\noutput 251");
  expect(text).toContain("output 284");
});

for (const debug of [false, true])
  for (const modifier of ["Control", "Meta"]) {
    test(`${debug ? "Debug" : "Run"} ${modifier}+A copies the whole buffer, not just the mounted rows`, async ({
      page,
    }) => {
      const log = await consoleOutput(page, false, debug);
      await page.evaluate(() => {
        (window as unknown as { copied: string[] }).copied = [];
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: async (text: string) => (window as unknown as { copied: string[] }).copied.push(text) },
        });
      });
      await log.focus();
      // Only a small virtual window is rendered even when the entire buffer is selected.
      expect(await log.locator("[data-index]").count()).toBeLessThan(500);
      await page.keyboard.press(`${modifier}+A`);
      // Selection stays inside the console: nothing from the workbench behind it is selected.
      const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
      expect(selected).not.toBe("");
      expect(selected).not.toContain("Project");
      await page.keyboard.press(`${modifier}+C`);
      const [copied] = await page.evaluate(() => (window as unknown as { copied: string[] }).copied);
      expect(copied?.split("\n")).toHaveLength(500);
      expect(copied).toContain("output 0\n");
      expect(copied).toMatch(/output 499$/);
    });
  }

for (const debug of [false, true]) {
  test(`${debug ? "Debug" : "Run"} Select All survives scrolling and incoming output`, async ({ page }) => {
    const log = await consoleOutput(page, false, debug);
    await log.focus();
    await page.keyboard.press("Control+A");
    await log.evaluate(
      (el, height) => {
        el.scrollTop = 200 * height;
      },
      debug ? 18 : 20,
    );
    await expect(log.locator('[data-index="205"]')).toBeVisible();
    await page.evaluate(() =>
      (window as unknown as { appendTestOutput: (text: string) => void }).appendTestOutput("\noutput 500"),
    );
    const copied = await log.evaluate((el) => {
      let text = "";
      const event = new Event("copy", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", {
        value: {
          setData: (_format: string, value: string) => {
            text = value;
          },
        },
      });
      el.dispatchEvent(event);
      return text;
    });
    expect(copied.split("\n")).toHaveLength(501);
    expect(copied).toContain("output 0\n");
    expect(copied).toMatch(/output 500$/);
    expect(await log.locator("[data-index]").count()).toBeLessThan(501);
    await page.evaluate(() => {
      (window as unknown as { copied: string[] }).copied = [];
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (text: string) => (window as unknown as { copied: string[] }).copied.push(text) },
      });
    });
    await expect(log).toBeFocused();
    await page.keyboard.press("Control+C");
    expect(await page.evaluate(() => (window as unknown as { copied: string[] }).copied)).toEqual([copied]);
  });
}
