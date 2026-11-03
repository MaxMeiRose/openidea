/** Git repositories and repository-specific actions for the project tree. */
import { executeAction, getAction, isActionEnabled } from "@/platform/actions";
import { shortcutLabel } from "@/platform/keymap";
import type { MenuItem } from "@/ui";
import { focusRepo, repoName, useVcs } from "@/features/vcs/store";
import type { ProjectNode } from "./model";
import { isSameOrInside } from "./paths";

/** The repository of a node, preferring its own root over an enclosing repository. */
export function repositoriesForNode(node: ProjectNode, roots: readonly string[]): string[] {
  if (roots.includes(node.path)) return [node.path];
  const containing = roots.filter((root) => isSameOrInside(node.path, root)).sort((a, b) => b.length - a.length)[0];
  return containing ? [containing] : [];
}

/** Every selected node must belong to a known repository. */
export function repositoriesForSelection(nodes: readonly ProjectNode[], roots: readonly string[]): string[] {
  if (!nodes.length) return [];
  const selected = nodes.map((node) => repositoriesForNode(node, roots));
  if (selected.some((repos) => !repos.length)) return [];
  return [...new Set(selected.flat())];
}

/**
 * Run repository operations against the selected repository, not the repository
 * last used in another project. A selection spanning several repositories
 * lets the user choose one before running an operation.
 */
export function repositoryAction(id: string, label: string, repos: readonly string[]): MenuItem | null {
  const action = getAction(id);
  if (!action || !repos.length) return null;
  const disabled = !isActionEnabled(action);
  const run = (repo: string) => () => {
    void focusRepo(repo).then(() => {
      // The repository may have disappeared during the refresh. Never fall back
      // to a different repository for a context-menu operation.
      if (useVcs.getState().repo === repo) void executeAction(id, { repo });
    });
  };
  if (repos.length === 1) {
    return { id, label, icon: action.icon, shortcut: shortcutLabel(id), disabled, run: run(repos[0]!) };
  }
  const names = repos.map(repoName);
  return {
    id,
    label,
    icon: action.icon,
    disabled,
    submenu: repos.map((repo, index) => ({
      id: `${id}:${repo}`,
      label: names.indexOf(names[index]!) === names.lastIndexOf(names[index]!) ? names[index]! : repo,
      verbatim: true,
      icon: "branch",
      run: run(repo),
    })),
  };
}
