import { useEffect, useMemo, useState } from "react";
import type { AgentConfigValue } from "@/bindings";
import { call, commands, nextRequestId } from "./ipc";
import type { CommitAiProvider } from "./commitAiSettings";

/** Model discovery is shared by the commit panel and the staged settings form. */
export function useCommitAiModels(provider: CommitAiProvider, repo: string | null) {
  const [revision, setRevision] = useState(0);
  const key = useMemo(() => ({ provider, repo, revision }), [provider, repo, revision]);
  const [result, setResult] = useState<{
    key: typeof key;
    models: AgentConfigValue[];
    error: string | null;
  } | null>(null);
  useEffect(() => {
    if (!key.repo) return;
    let live = true;
    const request = nextRequestId();
    void call(commands.agentModels(key.provider, key.repo, key.revision > 0, request))
      .then((models) => live && setResult({ key, models, error: null }))
      .catch((error) => live && setResult({ key, models: [], error: String(error) }));
    return () => {
      live = false;
      void commands.cancelRequest(request).catch(() => undefined);
    };
  }, [key]);
  return {
    models: result?.key === key ? result.models : [],
    error: result?.key === key ? result.error : null,
    loading: !!repo && result?.key !== key,
    refresh: () => setRevision((value) => value + 1),
  };
}

export function commitAiModelOptions(models: readonly AgentConfigValue[], selected: string) {
  const options = [
    { value: "", label: "CLI default" },
    ...models.map((model) => ({ value: model.value, label: model.name })),
  ];
  if (selected && !models.some((model) => model.value === selected)) options.push({ value: selected, label: selected });
  return options;
}
