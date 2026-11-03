import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  localStorage.removeItem("openidea.agents.sessionLocation.v1");
});

it("starts agent conversations in the tool window even when old editor mode was saved", async () => {
  localStorage.setItem("openidea.agents.sessionLocation.v1", JSON.stringify("editor"));
  vi.resetModules();
  const { useAgents } = await import("./store");
  expect(useAgents.getState().sessionLocation).toBe("toolWindow");
});
