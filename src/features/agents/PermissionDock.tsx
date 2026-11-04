import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AgentEntry, AgentTask } from "@/bindings";
import { Button, Icon, IconButton, MenuList, Popup, Spinner, T } from "@/ui";
import { useTx } from "@/platform/i18n";
import { respond } from "./store";
import styles from "./PermissionDock.module.css";

type Permission = Extract<AgentEntry, { type: "permission" }>;
type AnswerState = { busy: boolean; error?: string };

/** Pending requests stay beside the composer, including while reviewing changes or a subagent. */
export function PermissionDock({ task, entries }: { task: AgentTask; entries: AgentEntry[] | null }) {
  const pending =
    entries?.filter((entry): entry is Permission => entry.type === "permission" && entry.chosen === null) ?? [];
  const [selected, setSelected] = useState<number | null>(null);
  const [answers, setAnswers] = useState<Map<number, AnswerState>>(new Map());
  const [choices, setChoices] = useState<Map<number, string>>(new Map());
  const locked = useRef(new Set<number>());
  useEffect(() => {
    const ids = new Set(
      (entries ?? []).flatMap((entry) => (entry.type === "permission" && entry.chosen === null ? [entry.id] : [])),
    );
    for (const id of locked.current) if (!ids.has(id)) locked.current.delete(id);
  }, [entries]);
  if (!pending.length) return null;
  const index = Math.max(
    0,
    pending.findIndex((entry) => entry.id === selected),
  );
  const entry = pending[index]!;
  const answer = async (option: string | null) => {
    if (locked.current.has(entry.id)) return;
    locked.current.add(entry.id);
    setAnswers((current) => new Map(current).set(entry.id, { busy: true }));
    try {
      await respond(task.id, entry.id, option);
      // Keep this request disabled until its acknowledged entry arrives.
    } catch (error) {
      locked.current.delete(entry.id);
      setAnswers((current) => new Map(current).set(entry.id, { busy: false, error: String(error) }));
    }
  };
  return (
    <div className={styles.dock} data-agent-permission-dock>
      <PermissionCard
        key={entry.id}
        entry={entry}
        state={answers.get(entry.id)}
        busy={answers.get(entry.id)?.busy ?? false}
        onAnswer={answer}
        choice={choices.get(entry.id) ?? null}
        onChoice={(option) => setChoices((current) => new Map(current).set(entry.id, option))}
        navigation={
          pending.length > 1 && (
            <span className={styles.navigation}>
              <IconButton
                icon="chevron-left"
                title="Previous request"
                size="small"
                disabled={index === 0}
                onClick={() => setSelected(pending[index - 1]!.id)}
              />
              <span>
                {index + 1} / {pending.length}
              </span>
              <IconButton
                icon="chevron-right"
                title="Next request"
                size="small"
                disabled={index === pending.length - 1}
                onClick={() => setSelected(pending[index + 1]!.id)}
              />
            </span>
          )
        }
      />
    </div>
  );
}

function PermissionCard({
  entry,
  state,
  busy,
  onAnswer,
  choice,
  onChoice,
  navigation,
}: {
  entry: Permission;
  state: AnswerState | undefined;
  busy: boolean;
  onAnswer: (option: string | null) => Promise<void>;
  choice: string | null;
  onChoice: (option: string) => void;
  navigation: ReactNode;
}) {
  const translate = useTx();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  // Native Claude questions use these stable answer ids. Unknown provider choices
  // keep their original names and values instead of being rewritten as approvals.
  const question = entry.options.some((option) => /^answer-\d+$/.test(option.id));
  const positive = entry.options.find((option) => option.kind === "allow_once");
  const negative = entry.options.find((option) => option.kind === "reject_once");
  const extra = entry.options.filter((option) => option !== positive && option !== negative);
  const detailed = entry.title.length > 180 || entry.title.includes("\n");
  return (
    <section className={styles.card} role="alert" aria-label={entry.title}>
      <div className={styles.header}>
        <Icon name={question ? "info" : "warning"} size={15} />
        <strong>
          <T>{question ? "Question from the agent" : "Approval required"}</T>
        </strong>
        {navigation}
      </div>
      <div className={styles.content}>
        <p className={styles.title}>{detailed ? `${entry.title.slice(0, 180).trim()}…` : entry.title}</p>
        {detailed && (
          <details className={styles.details}>
            <summary>
              <T>Request details</T>
            </summary>
            <pre>{entry.title}</pre>
          </details>
        )}
        {question && (
          <fieldset className={styles.choices} disabled={busy}>
            <legend>
              <T>Choose an answer</T>
            </legend>
            {entry.options
              .filter((option) => /^answer-\d+$/.test(option.id))
              .map((option) => (
                <label key={option.id} className={styles.choice}>
                  <input
                    type="radio"
                    name={`permission-${entry.id}`}
                    checked={choice === option.id}
                    onChange={() => onChoice(option.id)}
                  />
                  <span>{option.name}</span>
                </label>
              ))}
          </fieldset>
        )}
        {state?.error && (
          <p className={styles.error}>
            <T>Couldn't send the answer</T>: {state.error}
          </p>
        )}
      </div>
      <div className={styles.actions}>
        {busy && (
          <span className={styles.sending}>
            <Spinner size={12} />
            <T>Sending answer…</T>
          </span>
        )}
        {negative && (
          <Button size="small" disabled={busy} onClick={() => void onAnswer(negative.id)}>
            {negative.name}
          </Button>
        )}
        {!question && extra.length > 0 && (
          <>
            <Button
              ref={moreRef}
              variant="ghost"
              size="small"
              disabled={busy}
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen(!moreOpen)}
            >
              More options
            </Button>
            <Popup
              open={moreOpen}
              onClose={() => setMoreOpen(false)}
              anchor={moreRef}
              autoFocus={false}
              role="presentation"
              className={styles.optionsMenu}
            >
              <MenuList
                aria-label={translate("Approval options")}
                onDone={() => setMoreOpen(false)}
                items={extra.map((option) => ({
                  id: option.id,
                  label: option.name,
                  run: () => void onAnswer(option.id),
                }))}
              />
            </Popup>
          </>
        )}
        {question ? (
          <Button
            size="small"
            variant="primary"
            disabled={busy || choice === null}
            onClick={() => choice && void onAnswer(choice)}
          >
            Submit answer
          </Button>
        ) : positive ? (
          <Button size="small" variant="primary" disabled={busy} onClick={() => void onAnswer(positive.id)}>
            {positive.name}
          </Button>
        ) : !entry.options.length ? (
          <Button size="small" disabled={busy} onClick={() => void onAnswer(null)}>
            Cancel request
          </Button>
        ) : null}
      </div>
    </section>
  );
}
