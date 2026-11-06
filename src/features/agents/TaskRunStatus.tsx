import type { AgentEntry, AgentTask } from "@/bindings";
import { tx } from "@/platform/i18n";
import { Icon, T } from "@/ui";
import { TaskStatusIcon } from "./AgentsView";
import { statusLabel } from "./model";
import styles from "./Session.module.css";

/** Kept outside the ellipsized model and workspace details. */
export function TaskRunStatus({ task, entries }: { task: AgentTask; entries: AgentEntry[] | null }) {
  const finished = task.status === "ready" && entries?.some((entry) => entry.type === "user" || entry.type === "agent");
  const label = finished ? "Run finished" : statusLabel(task.status);
  return (
    <span
      className={styles.runStatus}
      data-state={finished ? "finished" : task.status}
      role="status"
      aria-label={tx("Agent run status")}
      aria-live="polite"
      aria-atomic="true"
      title={tx(label)}
    >
      <span aria-hidden="true">
        {finished ? <Icon name="check" size={13} /> : <TaskStatusIcon status={task.status} />}
      </span>
      <span className={styles.runStatusLabel}>
        <T>{label}</T>
      </span>
    </span>
  );
}
