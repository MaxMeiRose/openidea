/** Discover Claude's settings before sending a task, including effort for the selected model. */
import { useEffect, useState } from "react";
import type { AgentConfigOption, AgentProvider } from "@/bindings";
import { call, commands, isTauri } from "@/platform/ipc";

export function useClaudeConfig(
  provider: AgentProvider | undefined,
  model: string | undefined,
  root: string,
  options: { task?: string; active?: boolean } = {},
) {
  const [revision, setRevision] = useState(0);
  const [found, setFound] = useState<{ key: string; config: AgentConfigOption[]; error: string | null } | null>(null);
  const enabled = options.active !== false && provider?.id === "claude" && provider.installed && isTauri();
  const key = JSON.stringify([provider?.id, provider?.command, model, root, options.task, revision]);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    call(commands.agentConfiguration("claude", model ?? null, options.task ?? null))
      .then((config) => live && setFound({ key, config, error: null }))
      .catch(
        (error: unknown) =>
          live && setFound({ key, config: [], error: error instanceof Error ? error.message : String(error) }),
      );
    return () => {
      live = false;
    };
  }, [enabled, key, model, options.task]);

  const current = enabled && found?.key === key ? found : null;
  return {
    config: current?.config.length ? current.config : (provider?.config ?? []),
    loading: !!enabled && !current,
    error: current?.error ?? null,
    retry: () => setRevision((v) => v + 1),
  };
}
