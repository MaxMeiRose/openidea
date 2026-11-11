import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { AgentConfigOption, AgentProvider } from "@/bindings";

const discover = vi.fn();
vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  isTauri: () => true,
  commands: { agentConfiguration: (provider: string, model: string | null) => discover(provider, model) },
}));
import { useClaudeConfig } from "./useClaudeConfig";

const option = (current: string): AgentConfigOption => ({
  id: "model",
  name: "Model",
  category: "model",
  description: null,
  via: "option",
  current,
  values: [{ value: current, name: current, description: null }],
});
const provider: AgentProvider = {
  id: "claude",
  name: "Claude Code",
  command: "claude",
  program: "claude",
  args: [],
  defaultProgram: "claude",
  defaultArgs: [],
  loginHint: null,
  commandOverridden: false,
  commandEditable: true,
  commandReadOnlyReason: null,
  installed: true,
  env: {},
  config: [],
  commands: [],
  source: { kind: "builtin" },
};
beforeEach(() => discover.mockReset());

it("ignores a stale model discovery response after switching models", async () => {
  let first!: (value: unknown) => void;
  discover
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          first = resolve;
        }),
    )
    .mockResolvedValueOnce({ status: "ok", data: [option("opus")] });
  const { result, rerender } = renderHook(
    ({ model }: { model: string | undefined }) => useClaudeConfig(provider, model, "/project"),
    { initialProps: { model: undefined as string | undefined } },
  );
  expect(result.current.loading).toBe(true);
  rerender({ model: "opus" });
  await waitFor(() => expect(result.current.config[0]?.current).toBe("opus"));
  await act(async () => first({ status: "ok", data: [option("default")] }));
  expect(result.current.config[0]?.current).toBe("opus");
});

it("shows discovery failures and lets the user retry", async () => {
  discover
    .mockRejectedValueOnce(new Error("Claude unavailable"))
    .mockResolvedValueOnce({ status: "ok", data: [option("opus")] });
  const { result } = renderHook(() => useClaudeConfig(provider, undefined, "/project"));
  await waitFor(() => expect(result.current.error).toBe("Claude unavailable"));
  act(() => result.current.retry());
  expect(result.current.loading).toBe(true);
  await waitFor(() => expect(result.current.config[0]?.current).toBe("opus"));
  expect(result.current.error).toBeNull();
});

it("keeps other agents on their own advertised settings", () => {
  const config = [option("gpt-local")];
  const { result } = renderHook(() => useClaudeConfig({ ...provider, id: "codex", config }, undefined, "/project"));
  expect(result.current.config).toEqual(config);
  expect(result.current.loading).toBe(false);
  expect(discover).not.toHaveBeenCalled();
});
