/** Agents tool window: tasks pinned above the user's groups, then by what they need from the user. */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import clsx from "clsx";
import type { AgentStatus as Status, AgentTask } from "@/bindings";
import { EDITOR_TAB_MIME, maybeEditorService, type EditorInput } from "@/workbench/contributions";
import {
  EmptyState,
  Button,
  FILES_DRAG,
  Icon,
  IconButton,
  HighlightedText,
  SearchField,
  Spinner,
  T,
  Tabs,
  Tree,
  registerDropTarget,
  showContextMenu,
  startPointerDrag,
  type IconName,
  type TabItem,
  type TreeHandle,
} from "@/ui";
import {
  HOME_KIND,
  SESSION_KIND,
  TASK_DRAG,
  age,
  branchLabel,
  groupStatus,
  groupTasks,
  providerIcon,
  sessionKey,
  type TaskGroup,
} from "./model";
import {
  HOME,
  closeDockedTab,
  externalKey,
  importExternalSession,
  moveTasksToGroup,
  pinTasks,
  isRelocatingAgentTab,
  openHome,
  refreshExternalSessions,
  selectDockedTab,
  setSessionLocation,
  showImportSessions,
  useAgents,
} from "./store";
import { sendPaths } from "./references";
import { groupMenu, taskMenu } from "./taskActions";
import { groupMembers, pinnedMembers, ungroupedMembers, type OrganizeGroup } from "./organize";
import { matchTask } from "./taskSearch";
import { SessionEditor } from "./SessionEditor";
import { HomeEditor } from "./HomeEditor";
import styles from "./Agents.module.css";
import { basename, useProject } from "@/platform/project";
import { useTx } from "@/platform/i18n";
import { executeAction } from "@/platform/actions";
import { openLayer, trapTab } from "@/ui/popupState";

export function AgentsHeaderActions() {
  const open = useAgents((s) => s.sessionsOpen || (!s.docked && !s.homeOpen));
  const waiting = useAgents((s) => [...s.tasks.values()].some((task) => task.status === "needsInput"));
  return (
    <>
      <IconButton
        icon="history"
        title="Agent sessions"
        size="small"
        className={styles.historyAction}
        data-attention={waiting || undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => useAgents.setState((s) => ({ sessionsOpen: !s.sessionsOpen }))}
      />
      <IconButton icon="plus" action="agents.newTask" size="small" />
      <IconButton icon="settings" action="agents.mcpServers" size="small" />
    </>
  );
}

export function AgentsLocationActions() {
  const location = useAgents((s) => s.sessionLocation);
  const tx = useTx();
  return (
    <div role="group" aria-label={tx("Conversation location")} className={styles.location}>
      <IconButton
        icon="open-in-tool-window"
        action="agents.useToolWindow"
        pressed={location === "toolWindow"}
        size="small"
      />
    </div>
  );
}

/** Key of the pinned section, above the groups. */
const PINNED_KEY = "pinned";
/** Key of a group the user made. */
const customKey = (group: string) => `ug:${group}`;

type Node =
  | { kind: "pinned"; tasks: AgentTask[] }
  | { kind: "custom"; group: OrganizeGroup; tasks: AgentTask[] }
  | { kind: "group"; group: TaskGroup }
  | { kind: "task"; task: AgentTask };

function nodeKey(n: Node): string {
  switch (n.kind) {
    case "pinned":
      return PINNED_KEY;
    case "custom":
      return customKey(n.group.id);
    case "group":
      return `g:${n.group.status}`;
    case "task":
      return n.task.id;
  }
}

/** Where a task shows: the pinned section first, else its group, else its status group. */
function keysOf(task: AgentTask): string[] {
  const organize = useAgents.getState().organize;
  if (organize.pinned.includes(task.id)) return [PINNED_KEY];
  const group = organize.groupOf[task.id];
  if (group && organize.groups.some((g) => g.id === group)) return [customKey(group)];
  return [`g:${groupStatus(task.status)}`];
}

/** A group header; tasks dropped on it go into the group (or into the pinned section). */
function GroupRow({
  label,
  count,
  icon,
  onDropTask,
}: {
  label: ReactNode;
  count: number;
  icon?: IconName;
  onDropTask?: (task: string) => void;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [over, setOver] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || !onDropTask) return;
    return registerDropTarget(el, {
      accepts: (type) => type === TASK_DRAG,
      over: () => setOver(true),
      leave: () => setOver(false),
      drop: (data) => {
        setOver(false);
        onDropTask(data.payload);
      },
    });
  }, [onDropTask]);
  return (
    <span ref={ref} className={clsx(styles.row, over && styles.dropOver)}>
      {icon && <Icon name={icon} size={12} />}
      <span className={styles.groupLabel}>{label}</span>
      <span className={styles.count}>{count}</span>
    </span>
  );
}

const sessionTask = (input: EditorInput | null | undefined) =>
  input?.kind === SESSION_KIND ? (input.data as { task?: string } | undefined)?.task : undefined;

/** The input of an editor tab drag payload, null for an invalid or closed tab. */
const payloadInput = (payload: string): EditorInput | null => {
  try {
    const p = JSON.parse(payload) as { paneId?: unknown; tabId?: unknown };
    if (typeof p.paneId !== "string" || typeof p.tabId !== "string") return null;
    const input = maybeEditorService()?.tabInput?.(p.paneId, p.tabId);
    return input ?? null;
  } catch {
    return null;
  }
};

export function TaskStatusIcon({ status }: { status: Status }) {
  switch (status) {
    case "needsInput":
      return <Icon name="warning" size={13} label="Needs input" />;
    case "running":
    case "starting":
      return <Spinner size={11} />;
    case "ready":
      return <Icon name="check" size={13} className={styles.ready} label="Ready" />;
    case "failed":
      return <Icon name="close" size={13} className={styles.failed} label="Failed" />;
    case "limited":
      return <Icon name="clock" size={13} className={styles.failed} label="Usage limit" />;
    case "archived":
      return <Icon name="minus" size={13} className={styles.archived} label="Archived" />;
  }
}

export function AgentsView() {
  const project = useProject((s) => s.project);
  const tx = useTx();
  const loaded = useAgents((s) => s.loaded);
  const error = useAgents((s) => s.error);
  const tasks = useAgents((s) => s.tasks);
  const unread = useAgents((s) => s.unread);
  const providers = useAgents((s) => s.providers);
  const docked = useAgents((s) => s.docked);
  const dockedTabs = useAgents((s) => s.dockedTabs);
  const homeOpen = useAgents((s) => s.homeOpen);
  const inline = docked !== null || homeOpen;
  const historyOpen = useAgents((s) => s.sessionsOpen);
  const drawerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "needsInput" | "running" | "archived">("all");
  const external = useAgents((s) => s.external);
  const externalError = useAgents((s) => s.externalError);
  const importing = useAgents((s) => s.importing);
  // Sessions started elsewhere (a terminal, another editor) list on demand (#312).
  useEffect(() => {
    if (historyOpen) void refreshExternalSessions();
  }, [historyOpen]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(["g:archived"]));
  const [selected, setSelected] = useState<Set<string>>(() => {
    const task = docked ?? sessionTask(maybeEditorService()?.activeInput?.());
    return new Set(task ? [task] : []);
  });
  const [selectionTask, setSelectionTask] = useState(docked);
  if (selectionTask !== docked) {
    setSelectionTask(docked);
    setSelected(new Set(docked ? [docked] : []));
  }
  // Follow (and, in tool-window mode, move) session tabs restored by the editor.
  useEffect(() => {
    const editor = maybeEditorService();
    const onActive = (input: EditorInput | null) => {
      if (input && isRelocatingAgentTab(input.key)) return;
      if (input?.kind === HOME_KIND && useAgents.getState().sessionLocation === "toolWindow") {
        openHome();
        return;
      }
      const task = sessionTask(input);
      if (!task) return;
      if (useAgents.getState().sessionLocation === "toolWindow" && useAgents.getState().tasks.has(task)) {
        void executeAction("agents.dockTask", task);
        return;
      }
      setSelected((current) => (current.has(task) ? current : new Set([task])));
      const known = useAgents.getState().tasks.get(task);
      const keys = known ? keysOf(known) : [];
      if (keys.length)
        setCollapsed((c) =>
          keys.some((key) => c.has(key)) ? new Set([...c].filter((key) => !keys.includes(key))) : c,
        );
    };
    const dispose = editor?.onActiveInputChange?.(onActive);
    if (loaded) onActive(editor?.activeInput?.() ?? null);
    return dispose;
  }, [loaded]);
  useEffect(() => {
    if (!historyOpen || !loaded) return;
    const previous = document.activeElement as HTMLElement | null;
    searchRef.current?.focus();
    if (!inline) return;
    const drawer = drawerRef.current;
    const layer = openLayer(() => drawer);
    const onKey = (event: KeyboardEvent) => {
      if (!layer.isTop()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        useAgents.setState({ sessionsOpen: false });
      } else if (event.key === "Tab" && drawer) trapTab(event, drawer);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      layer.release();
      const active = document.activeElement;
      if (previous?.isConnected && (!active || active === document.body || drawer?.contains(active)))
        previous.focus({ preventScroll: true });
    };
  }, [historyOpen, loaded, inline, docked]);
  const organize = useAgents((s) => s.organize);
  const treeRef = useRef<TreeHandle>(null);
  // While searching: the matching tasks of every section, collapsed ones included; empty sections go.
  const matches = useMemo(() => {
    if (!query.trim()) return null;
    const found = new Map<string, number[]>();
    for (const task of tasks.values()) {
      const hit = matchTask(task, query);
      if (hit) found.set(task.id, hit);
    }
    return found;
  }, [tasks, query]);
  const roots = useMemo<Node[]>(() => {
    const all = [...tasks.values()].filter(
      (t) =>
        (!matches || matches.has(t.id)) &&
        (filter === "all" ||
          (filter === "running" ? t.status === "running" || t.status === "starting" : t.status === filter)),
    );
    const pinned = pinnedMembers(all, organize);
    return [
      ...(pinned.length ? [{ kind: "pinned", tasks: pinned } as Node] : []),
      ...organize.groups.flatMap((group): Node[] => {
        const members = groupMembers(all, organize, group.id);
        return matches && !members.length ? [] : [{ kind: "custom", group, tasks: members }];
      }),
      ...groupTasks(ungroupedMembers(all, organize)).map((group): Node => ({ kind: "group", group })),
    ];
  }, [tasks, organize, matches, filter]);
  const expanded = useMemo(
    () => new Set(roots.map(nodeKey).filter((k) => matches || filter !== "all" || !collapsed.has(k))),
    [roots, collapsed, matches, filter],
  );
  // Dropping a session editor tab anywhere on the tool window docks it.
  const viewRef = useRef<HTMLDivElement>(null);
  const [tabOver, setTabOver] = useState(false);
  useEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    return registerDropTarget(el, {
      accepts: (type) => type === EDITOR_TAB_MIME || type === FILES_DRAG,
      over: (data) => {
        const input = data.type === EDITOR_TAB_MIME ? payloadInput(data.payload) : null;
        setTabOver(data.type === FILES_DRAG || !!sessionTask(input) || !!input?.path);
      },
      leave: () => setTabOver(false),
      drop: (data) => {
        setTabOver(false);
        if (data.type === FILES_DRAG) {
          sendPaths(data.payload.split("\n"));
          return;
        }
        const input = payloadInput(data.payload);
        const task = sessionTask(input);
        if (task) void executeAction("agents.dockTask", task);
        else if (input?.path) sendPaths([input.path]);
      },
    });
  }, [loaded, error]);
  if (!loaded)
    return (
      <div className={styles.loading}>
        <Spinner />
      </div>
    );
  if (error) return <EmptyState title="Cannot load agent tasks">{error}</EmptyState>;
  const providerName = (id: string) => providers.find((p) => p.id === id)?.name ?? id;
  // Opening any session follows the global placement preference.
  const showTask = (task: string) => {
    useAgents.setState({ sessionsOpen: false });
    if (useAgents.getState().sessionLocation !== "toolWindow") setSessionLocation("toolWindow");
    void executeAction("agents.openTask", task);
  };
  const activeTab = homeOpen ? HOME : docked;
  const openTabs = activeTab && !dockedTabs.includes(activeTab) ? [...dockedTabs, activeTab] : dockedTabs;
  const dragTask = (e: ReactPointerEvent<HTMLSpanElement>, task: string) =>
    startPointerDrag(e, e.currentTarget, { type: TASK_DRAG, payload: task });

  const taskList = (
    <div className={styles.tasks}>
      <div className={styles.historySearch}>
        <SearchField
          ref={searchRef}
          value={query}
          onChange={setQuery}
          placeholder="Search sessions…"
          aria-label="Search sessions"
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              treeRef.current?.moveSelection(event.key === "ArrowDown" ? 1 : -1);
            } else if (event.key === "Enter") {
              const lead = treeRef.current?.leadKey();
              if (lead && tasks.has(lead)) {
                event.preventDefault();
                showTask(lead);
              }
            } else if (event.key === "Escape" && query) {
              event.preventDefault();
              event.stopPropagation();
              setQuery("");
            }
          }}
        />
        <div className={styles.filters} role="group" aria-label={tx("Filter sessions")}>
          {(
            [
              ["all", "All"],
              ["needsInput", "Needs input"],
              ["running", "Running"],
              ["archived", "Archived"],
            ] as const
          ).map(([id, label]) => (
            <Button key={id} variant="ghost" size="small" aria-pressed={filter === id} onClick={() => setFilter(id)}>
              {label}
            </Button>
          ))}
        </div>
      </div>
      <Tree<Node>
        aria-label="Agent tasks"
        rowHeight={44}
        handleRef={treeRef}
        roots={roots}
        getKey={nodeKey}
        getLabel={(n) =>
          n.kind === "task"
            ? n.task.title
            : n.kind === "pinned"
              ? "Pinned"
              : n.kind === "custom"
                ? n.group.name
                : n.group.label
        }
        getChildren={(n) =>
          n.kind === "task"
            ? undefined
            : (n.kind === "group" ? n.group.tasks : n.tasks).map((task) => ({ kind: "task", task }) as Node)
        }
        isExpandable={(n) => n.kind !== "task"}
        expanded={expanded}
        onExpandedChange={(_next, node, open) =>
          setCollapsed((c) => {
            const s = new Set(c);
            if (open) s.delete(nodeKey(node));
            else s.add(nodeKey(node));
            return s;
          })
        }
        selected={selected}
        onSelectionChange={(sel, lead) => {
          setSelected(sel);
          if (!inline && sel.size === 1 && lead?.kind === "task" && sel.has(lead.task.id)) showTask(lead.task.id);
        }}
        onActivate={(n) => n.kind === "task" && showTask(n.task.id)}
        onContextMenu={(n, sel, e) => {
          if (!n) return;
          if (n.kind === "custom") {
            showContextMenu(e, groupMenu(n.group));
            return;
          }
          if (n.kind !== "task") return;
          const selection = [...sel].flatMap((id) => {
            const task = tasks.get(id);
            return task ? [task] : [];
          });
          showContextMenu(e, taskMenu(selection));
        }}
        renderNode={(n) => {
          switch (n.kind) {
            case "pinned":
              return (
                <GroupRow
                  icon="pin"
                  label={<T>Pinned</T>}
                  count={n.tasks.length}
                  onDropTask={(task) => pinTasks([task], true)}
                />
              );
            case "custom":
              return (
                <GroupRow
                  label={n.group.name}
                  count={n.tasks.length}
                  onDropTask={(task) => moveTasksToGroup([task], n.group.id)}
                />
              );
            case "group":
              return <GroupRow label={<T>{n.group.label}</T>} count={n.group.tasks.length} />;
            case "task":
              return (
                <span
                  className={styles.row}
                  title={n.task.error ?? n.task.title}
                  onPointerDown={(e) => dragTask(e, n.task.id)}
                  onClick={(e) => {
                    if (inline && !e.metaKey && !e.ctrlKey && !e.shiftKey) showTask(n.task.id);
                  }}
                >
                  <TaskStatusIcon status={n.task.status} />
                  <span className={styles.taskSummary}>
                    <span className={styles.title} data-unread={unread.has(n.task.id) || undefined}>
                      {matches?.get(n.task.id)?.length ? (
                        <HighlightedText text={n.task.title} indices={matches.get(n.task.id)!} />
                      ) : (
                        n.task.title
                      )}
                    </span>
                    <span className={styles.detail}>
                      {providerName(n.task.provider)}
                      {n.task.model ? ` · ${n.task.model}` : ""}
                      {n.task.isolation === "worktree" ? ` · ${branchLabel(n.task.branch)}` : ""}
                      {project?.workspace ? ` · ${basename(n.task.projectRoot ?? project.root)}` : ""}
                    </span>
                  </span>
                  {unread.has(n.task.id) && (
                    <span className={styles.unreadDot} role="img" aria-label={tx("Unread")} title={tx("Unread")} />
                  )}
                  <span className={styles.age}>{age(n.task.updatedMs ?? 0)}</span>
                </span>
              );
          }
        }}
        empty={
          <div className={styles.empty}>
            <T>{tasks.size ? "No matching sessions" : "No agent tasks yet"}</T>
            <button
              type="button"
              className={styles.link}
              onClick={() => {
                if (tasks.size) {
                  setQuery("");
                  setFilter("all");
                } else openHome();
              }}
            >
              <T>{tasks.size ? "Clear filters" : "New Task…"}</T>
            </button>
            {!inline && !tasks.size && (
              <button type="button" className={styles.link} onClick={showImportSessions}>
                <T>Import Sessions…</T>
              </button>
            )}
          </div>
        }
      />
    </div>
  );

  return (
    <div ref={viewRef} className={clsx(styles.view, tabOver && styles.dropTarget)}>
      <div className={styles.content}>
        {inline && (
          <div className={styles.docked}>
            <Tabs
              aria-label={tx("Open Agent Sessions")}
              variant="compact"
              items={openTabs.flatMap<TabItem>((id) => {
                if (id === HOME) return [{ id, label: tx("New Agent Task"), closable: true }];
                const task = tasks.get(id);
                return task
                  ? [
                      {
                        id,
                        label: (
                          <span title={task.title} onPointerDown={(e) => dragTask(e, task.id)}>
                            {task.title}
                          </span>
                        ),
                        text: task.title,
                        tooltip: task.title,
                        closable: true,
                        trailing:
                          task.status === "needsInput" ? (
                            <span className={styles.attentionDot} aria-hidden />
                          ) : undefined,
                      },
                    ]
                  : [];
              })}
              activeId={activeTab}
              onSelect={selectDockedTab}
              onClose={closeDockedTab}
            />
            <div className={styles.dockedSession}>
              {homeOpen ? (
                <HomeEditor docked />
              ) : (
                docked && (
                  <SessionEditor
                    docked
                    input={{
                      kind: SESSION_KIND,
                      key: sessionKey(docked),
                      data: { task: docked, title: tasks.get(docked)?.title },
                    }}
                  />
                )
              )}
            </div>
          </div>
        )}
        {!inline && taskList}
        {inline && historyOpen && (
          <div className={styles.historyOverlay}>
            <button
              type="button"
              className={styles.historyBackdrop}
              tabIndex={-1}
              aria-hidden
              onClick={() => useAgents.setState({ sessionsOpen: false })}
            />
            <div ref={drawerRef} role="dialog" aria-label={tx("Agent sessions")} className={styles.history}>
              <div className={styles.historyTitle}>
                <T>Agent sessions</T>
                <IconButton
                  icon="close"
                  title="Close session history"
                  size="small"
                  onClick={() => useAgents.setState({ sessionsOpen: false })}
                />
              </div>
              {taskList}
              {(external.length > 0 || externalError) && (
                <>
                  <div className={styles.historyTitle}>
                    <T>Sessions from other apps</T>
                  </div>
                  {externalError ? (
                    <div className={styles.empty}>{externalError}</div>
                  ) : (
                    <div className={styles.external}>
                      {external.map((s) => {
                        const key = externalKey(s.provider, s.sessionId);
                        return (
                          <div key={key} className={styles.row} title={s.cwd ?? s.sessionId}>
                            <Icon name={providerIcon(s.provider)} size={16} label={providerName(s.provider)} />
                            <span className={styles.title}>{s.title}</span>
                            <span className={styles.age}>{age(s.updatedMs ?? 0)}</span>
                            <button
                              type="button"
                              className={styles.link}
                              disabled={importing.has(key)}
                              onClick={() => void importExternalSession(s.provider, s.sessionId).catch(() => {})}
                            >
                              <T>Import</T>
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
