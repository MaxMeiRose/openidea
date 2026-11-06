import { create } from "zustand";
import { call, commands, nextRequestId } from "@/platform/ipc";
import { tx, useI18n } from "@/platform/i18n";
import { effectiveCommitAiPrompt } from "@/platform/commitAiSettings";
import { workflowSettings } from "@/platform/workflowSettings";
import { checkOf, planCommit, renamedFromPath } from "./changes";
import { useChangelists, withListDefaults } from "./changelists";
import { useCommit } from "./commitStore";
import { currentHunkText, hunkKeys } from "./hunks";
import { effectiveKind, rootOf, stripSlash } from "./model";
import { readWorkingText } from "./ops";
import { currentRepoRoot, useVcs } from "./store";

export const useCommitAi = create<{ request: number | null; error: string | null }>(() => ({
  request: null,
  error: null,
}));
const CONTEXT_LIMIT = 96_000;
const FILE_LIMIT = 24_000;

/** Captures only the files and changed blocks that the commit will include. */
export async function commitAiContext() {
  const vcs = useVcs.getState();
  const commit = useCommit.getState();
  const repo = currentRepoRoot();
  if (!repo) throw new Error(tx("Select a Git repository first."));
  const roots = vcs.roots.length ? vcs.roots : [repo];
  const checks = withListDefaults(vcs.status, vcs.root ?? "", useChangelists.getState().state, commit.checks);
  const included = planCommit(vcs.status, checks).included;
  if (!included.length && !commit.amend) throw new Error(tx("Select changes to generate a commit message."));
  if (included.some((file) => rootOf(file.path, roots) !== repo))
    throw new Error(tx("AI generation supports one repository. Uncheck changes from other repositories."));
  const cfg = workflowSettings().vcs.commit;
  let remaining = CONTEXT_LIMIT;
  const take = (text: string) => {
    const value = text.slice(0, Math.max(0, Math.min(FILE_LIMIT, remaining)));
    remaining -= value.length;
    return { text: value, truncated: value.length < text.length };
  };
  const files = [];
  for (const file of included) {
    const path = stripSlash(file.path);
    const selection = checkOf(file, checks);
    const fileRepo = rootOf(path, roots) ?? repo;
    const renamed = renamedFromPath(file);
    const kind = selection === "staged" ? (file.staged ?? effectiveKind(file)) : effectiveKind(file);
    const base = { repository: fileRepo, path: file.relPath, kind, selection };
    const [before, after] = await Promise.all([
      call(commands.vcsFileAt(renamed ?? path, "HEAD")),
      selection === "staged" ? call(commands.vcsFileAt(path, ":0")) : readWorkingText(path),
    ]);
    if (after === null && kind !== "deleted") {
      files.push({ ...base, renamedFrom: file.renamedFrom, contentUnavailable: true });
      continue;
    }
    const hunks = await commands.vcsDiffHunks(before ?? "", after ?? "");
    const keys = hunkKeys(after ?? "", hunks);
    const excluded = commit.excludedHunks.get(path) ?? commit.excludedHunks.get(file.path);
    files.push({
      ...base,
      renamedFrom: file.renamedFrom,
      changes: hunks.flatMap((hunk, index) => {
        if (selection === "hunks" && excluded?.has(keys[index]!)) return [];
        return [
          {
            oldLine: hunk.oldStart + 1,
            newLine: hunk.start + 1,
            removed: take(hunk.oldText),
            added: take(currentHunkText(after ?? "", hunk)),
          },
        ];
      }),
    });
  }
  let previous = null;
  if (commit.amend) {
    const [head] = await call(
      commands.vcsLog(repo, { branch: "HEAD", path: null, author: null, text: null, range: null, skip: 0, limit: 1 }),
    );
    if (!head) throw new Error(tx("There is no commit to amend."));
    const files = await call(commands.vcsCommitFiles(repo, head.id));
    previous = { message: head.message.slice(0, FILE_LIMIT), files };
  }
  const context = JSON.stringify({
    instructions: effectiveCommitAiPrompt(cfg.aiPrompt),
    language: useI18n.getState().locale,
    amend: commit.amend,
    previousCommit: previous,
    files,
  });
  if (new TextEncoder().encode(context).length > 512 << 10)
    throw new Error(tx("Too many changes for AI generation. Select fewer files."));
  return { repo, context };
}

export function cancelCommitAi() {
  const request = useCommitAi.getState().request;
  useCommitAi.setState({ request: null });
  if (request !== null) void commands.cancelRequest(request).catch(() => undefined);
}

export async function generateCommitMessage() {
  if (useCommitAi.getState().request !== null) return;
  const request = nextRequestId();
  useCommitAi.setState({ request, error: null });
  const commit = useCommit.getState();
  const vcs = useVcs.getState();
  const lists = useChangelists.getState().state;
  const cfg = workflowSettings().vcs.commit;
  const unchanged = () => {
    const now = useCommit.getState();
    return (
      useCommitAi.getState().request === request &&
      now.message === commit.message &&
      now.amend === commit.amend &&
      now.checks === commit.checks &&
      now.excludedHunks === commit.excludedHunks &&
      useVcs.getState().root === vcs.root &&
      useVcs.getState().branch?.head === vcs.branch?.head &&
      useVcs.getState().branch?.headCommit === vcs.branch?.headCommit &&
      currentRepoRoot() === (vcs.repo ?? vcs.roots[0] ?? vcs.root) &&
      useChangelists.getState().state === lists
    );
  };
  const checkSnapshot = () => {
    if (useCommitAi.getState().request === request && !unchanged()) cancelCommitAi();
  };
  const disposers = [
    useCommit.subscribe(checkSnapshot),
    useVcs.subscribe(checkSnapshot),
    useChangelists.subscribe(checkSnapshot),
  ];
  try {
    const { repo, context } = await commitAiContext();
    if (!unchanged()) return;
    const model = cfg.aiProvider === "codex" ? cfg.aiCodexModel : cfg.aiClaudeModel;
    const message = await call(
      commands.agentGenerateCommitMessage(cfg.aiProvider, repo, model || null, context, request),
    );
    if (!unchanged()) return;
    const current = await commitAiContext();
    if (!unchanged()) return;
    if (current.context !== context) {
      useCommitAi.setState({ error: tx("Selected changes changed during generation. Generate the message again.") });
      return;
    }
    disposers.forEach((dispose) => dispose());
    useCommit.setState((state) => ({ message, focusTick: state.focusTick + 1 }));
  } catch (error) {
    if (useCommitAi.getState().request === request) useCommitAi.setState({ error: String(error) });
  } finally {
    disposers.forEach((dispose) => dispose());
    if (useCommitAi.getState().request === request) useCommitAi.setState({ request: null });
  }
}
