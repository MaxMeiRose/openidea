/** Agents tool window: tasks grouped by what they need from the user. */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import clsx from "clsx";
import type { AgentStatus as Status, AgentTask } from "@/bindings";
import { EDITOR_TAB_MIME, maybeEditorService, type EditorInput } from "@/workbench/contributions";
import {
  EmptyState,
  Button,
  FILES_DRAG,
  Icon,
  IconButton,
  SearchField,
  Spinner,
  T,
  Tabs,
  Tree,
  registerDropTarget,
  showContextMenu,
  startPointerDrag,
  type TabItem,
} from "@/ui";
import { HOME_KIND, SESSION_KIND, TASK_DRAG, age, branchLabel, groupTasks, sessionKey, type TaskGroup } from "./model";
import {
  HOME,
  closeDockedTab,
  isRelocatingAgentTab,
  openHome,
  selectDockedTab,
  setSessionLocation,
  useAgents,
} from "./store";
import { sendPaths } from "./references";
import { taskMenu } from "./taskActions";
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

type Node = { kind: "group"; group: TaskGroup } | { kind: "task"; task: AgentTask };

const nodeKey = (n: Node) => (n.kind === "group" ? `g:${n.group.status}` : n.task.id);

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
      const group = groupTasks(useAgents.getState().tasks.values()).find((g) => g.tasks.some((t) => t.id === task));
      const key = group && `g:${group.status}`;
      if (key) setCollapsed((c) => (c.has(key) ? new Set([...c].filter((k) => k !== key)) : c));
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
  const roots = useMemo<Node[]>(() => {
    const needle = query.trim().toLocaleLowerCase();
    const matching = [...tasks.values()].filter((task) => {
      if (filter === "running" && task.status !== "running" && task.status !== "starting") return false;
      if (filter !== "all" && filter !== "running" && task.status !== filter) return false;
      return (
        !needle ||
        [task.title, task.provider, task.model, task.branch, task.projectRoot, task.cwd].some((value) =>
          value?.toLocaleLowerCase().includes(needle),
        )
      );
    });
    return groupTasks(matching).map((group) => ({ kind: "group", group }));
  }, [tasks, query, filter]);
  const expanded = useMemo(
    () => new Set(roots.map(nodeKey).filter((k) => query.trim() || filter !== "all" || !collapsed.has(k))),
    [roots, collapsed, query, filter],
  );
  // A session tab docks here; a code tab or project file becomes a reference.
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
        roots={roots}
        getKey={nodeKey}
        getLabel={(n) => (n.kind === "group" ? n.group.label : n.task.title)}
        getChildren={(n) =>
          n.kind === "group" ? n.group.tasks.map((task) => ({ kind: "task", task }) as Node) : undefined
        }
        isExpandable={(n) => n.kind === "group"}
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
          if (n?.kind !== "task") return;
          const selection = [...sel].flatMap((id) => {
            const task = tasks.get(id);
            return task ? [task] : [];
          });
          showContextMenu(e, taskMenu(selection));
        }}
        renderNode={(n) =>
          n.kind === "group" ? (
            <span className={styles.row}>
              <span className={styles.groupLabel}>
                <T>{n.group.label}</T>
              </span>
              <span className={styles.count}>{n.group.tasks.length}</span>
            </span>
          ) : (
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
                  {n.task.title}
                </span>
                <span className={styles.detail}>
                  {providerName(n.task.provider)}
                  {n.task.model ? ` · ${n.task.model}` : ""}
                  {n.task.isolation === "worktree" ? ` · ${branchLabel(n.task.branch)}` : ""}
                  {project?.workspace ? ` · ${basename(n.task.projectRoot ?? project.root)}` : ""}
                </span>
              </span>
              {/* Ready tasks say so by their group; the others show what they're doing. */}
              {n.task.status !== "ready" && <TaskStatusIcon status={n.task.status} />}
              {unread.has(n.task.id) && (
                <span className={styles.unreadDot} role="img" aria-label={tx("Unread")} title={tx("Unread")} />
              )}
              <span className={styles.age}>{age(n.task.updatedMs ?? 0)}</span>
            </span>
          )
        }
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
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
