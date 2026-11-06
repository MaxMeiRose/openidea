import { useEffect } from "react";
import { executeAction } from "@/platform/actions";
import { COMMIT_AI_PROVIDERS, commitAiModelKey } from "@/platform/commitAiSettings";
import { commitAiModelOptions, useCommitAiModels } from "@/platform/commitAiModels";
import { call, commands } from "@/platform/ipc";
import { loadSettings } from "@/platform/project";
import { useWorkflowSettings } from "@/platform/workflowSettings";
import { tx } from "@/platform/i18n";
import { Button, IconButton, Select, T } from "@/ui";
import { cancelCommitAi, useCommitAi } from "./commitAi";
import { useCommit } from "./commitStore";
import { useVcs } from "./store";
import styles from "./CommitView.module.css";

export function CommitAiControls({ included, busy }: { included: number; busy: boolean }) {
  const cfg = useWorkflowSettings((settings) => settings.vcs.commit);
  const repo = useVcs((state) => state.repo ?? state.roots[0] ?? state.root);
  const catalog = useCommitAiModels(cfg.aiProvider, repo);
  const request = useCommitAi((state) => state.request);
  const error = useCommitAi((state) => state.error);
  const model = cfg.aiProvider === "codex" ? cfg.aiCodexModel : cfg.aiClaudeModel;
  const generating = request !== null;
  const amend = useCommit((state) => state.amend);
  useEffect(() => cancelCommitAi, []);
  async function setOption(key: string, value: string) {
    try {
      await call(commands.settingsSet("project", key, JSON.stringify(value)));
      await loadSettings();
    } catch (error) {
      useCommitAi.setState({ error: String(error) });
    }
  }
  return (
    <>
      <div className={styles.aiBar}>
        <Select
          aria-label={tx("Commit AI provider")}
          value={cfg.aiProvider}
          options={COMMIT_AI_PROVIDERS}
          disabled={generating || busy}
          onChange={(provider) => void setOption("vcs.commit.aiProvider", provider)}
        />
        <Select
          className={styles.aiModel}
          aria-label={tx("Commit AI model")}
          value={model}
          options={commitAiModelOptions(catalog.models, model)}
          searchable
          disabled={generating || busy}
          onChange={(value) => void setOption(commitAiModelKey(cfg.aiProvider), value)}
        />
        <IconButton
          icon="refresh"
          size="small"
          title="Refresh AI models"
          disabled={catalog.loading || generating || busy}
          onClick={catalog.refresh}
        />
        <IconButton
          icon="settings"
          size="small"
          title="AI Commit Message Settings"
          onClick={() => void executeAction("file.settings", "vcs.commit")}
        />
      </div>
      <div className={styles.aiGenerate}>
        <Button
          disabled={busy || (!generating && !included && !amend)}
          onClick={() => void executeAction(generating ? "vcs.cancelCommitMessage" : "vcs.generateCommitMessage")}
          title="Generate Commit Message with AI"
        >
          <T>{generating ? "Cancel generation" : "Generate with AI"}</T>
        </Button>
        <span className={styles.aiHint}>
          <T>
            {generating ? "Generating commit message…" : catalog.loading ? "Loading models…" : "Selected changes only"}
          </T>
        </span>
      </div>
      {(error || catalog.error) && (
        <div className={`${styles.inspections} ${styles.aiError}`} role="alert">
          {error || catalog.error}
        </div>
      )}
    </>
  );
}
