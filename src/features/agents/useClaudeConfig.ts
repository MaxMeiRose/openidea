/** Discover Claude's settings before sending a task, including effort for the selected model. */
import { useEffect, useState } from "react";
import type { AgentConfigOption, AgentProvider } from "@/bindings";
import { call, commands, isTauri } from "@/platform/ipc";
import { useAgents } from "./store";

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
      .then((config) => {
        if (!live) return;
        setFound({ key, config, error: null });
        if (options.task || !config.length) return;
        const selectedModel = model ?? config.find((option) => option.category === "model")?.current;
        useAgents.setState((state) => ({
          providers: state.providers.map((entry) =>
            entry.id !== provider.id
              ? entry
              : {
                  ...entry,
                  config: model === undefined || !entry.config.length ? config : entry.config,
                  thoughtLevels: selectedModel
                    ? {
                        ...entry.thoughtLevels,
                        [selectedModel]: config.filter((option) => option.category === "thought_level"),
                      }
                    : entry.thoughtLevels,
                },
          ),
        }));
      })
      .catch(
        (error: unknown) =>
          live && setFound({ key, config: [], error: error instanceof Error ? error.message : String(error) }),
      );
    return () => {
      live = false;
    };
  }, [enabled, key, model, options.task, provider?.id]);

  const current = enabled && found?.key === key ? found : null;
  return {
    config: current?.config.length ? current.config : (provider?.config ?? []),
    loading: !!enabled && !current,
    error: current?.error ?? null,
    retry: () => setRevision((v) => v + 1),
  };
}
