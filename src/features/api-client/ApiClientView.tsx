import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { useTx } from "@/platform/i18n";
import { onIdeEvent } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { projectLocation, useRemote } from "@/platform/remote";
import { editorService } from "@/workbench/contributions";
import { bodyKind, formatMs, formatSize, prettyBody } from "@/features/http-client/format";
import { isRouteSource } from "@/features/http-client/spring/routeIndex";
import {
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  Icon,
  IconButton,
  Input,
  SearchField,
  Select,
  Spinner,
  SplitGroup,
  SplitHandle,
  SplitPanel,
  Tabs,
  Tree,
  T,
  copyText,
  selectableText,
  showContextMenu,
} from "@/ui";
import { copySelectionOnKeyDown } from "@/ui/selectableText";
import { confirm } from "@/workbench/messages";
import { METHODS, headersFromText, pair, type ApiEnvironment, type Pair, type RequestDraft } from "./model";
import {
  cancelRequest,
  closeTab,
  newRequest,
  openEndpoint,
  openProject,
  refreshEndpoints,
  refreshHistory,
  removeEnvironment,
  restoreHistory,
  saveEnvironment,
  selectEnvironment,
  selectTab,
  sendRequest,
  updateDraft,
  useApiClient,
} from "./store";
import styles from "./ApiClient.module.css";
import {
  apiNodeKey,
  branchKeys,
  endpointGroups,
  endpointTitle,
  type ApiNode,
  type EndpointDisplay,
} from "./navigation";

const DISPLAY_KEY = "openidea.apiClient.endpointDisplay";

function PairEditor({
  label,
  rows,
  onChange,
  fixed = false,
}: {
  label: string;
  rows: Pair[];
  onChange: (rows: Pair[]) => void;
  fixed?: boolean;
}) {
  const tx = useTx();
  const update = (id: string, patch: Partial<Pair>) =>
    onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  return (
    <div className={styles.pairs} role="group" aria-label={tx(label)}>
      <div className={styles.pairHeading}>
        <span>
          <T>{label}</T>
        </span>
        {!fixed && (
          <IconButton icon="plus" title="Add parameter" size="small" onClick={() => onChange([...rows, pair()])} />
        )}
      </div>
      {!rows.length && (
        <span className={styles.hint}>
          <T>No entries</T>
        </span>
      )}
      {rows.map((row, index) => (
        <div className={styles.pair} key={row.id}>
          {!fixed && (
            <Checkbox
              aria-label={tx`Enable entry ${index + 1}`}
              checked={row.enabled}
              onChange={(enabled) => update(row.id, { enabled })}
            />
          )}
          <Input
            aria-label={tx`${label} name ${index + 1}`}
            placeholder="Name"
            mono
            value={row.key}
            readOnly={fixed}
            onChange={(e) => update(row.id, { key: e.target.value })}
          />
          <Input
            aria-label={tx`${label} value ${index + 1}`}
            placeholder="Value"
            mono
            value={row.value}
            onChange={(e) => update(row.id, { value: e.target.value })}
          />
          {!fixed && (
            <IconButton
              icon="close"
              title="Remove entry"
              size="small"
              onClick={() => onChange(rows.filter((item) => item.id !== row.id))}
            />
          )}
        </div>
      ))}
    </div>
  );
}

function EnvironmentDialog({ environment, onClose }: { environment: ApiEnvironment | null; onClose: () => void }) {
  const tx = useTx();
  const [name, setName] = useState(environment?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(environment?.baseUrl ?? "");
  const [headers, setHeaders] = useState(
    (environment?.headers ?? []).map((row) => `${row.key}: ${row.value}`).join("\n"),
  );
  const [error, setError] = useState<string | null>(null);
  const save = () => {
    try {
      saveEnvironment({ id: environment?.id ?? crypto.randomUUID(), name, baseUrl, headers: headersFromText(headers) });
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <Dialog
      open
      title={environment ? "Edit API Environment" : "Add API Environment"}
      onClose={onClose}
      width={500}
      buttons={[
        { label: "Cancel", role: "cancel" },
        { label: "Save", role: "default", onClick: save },
      ]}
    >
      <div className={styles.form}>
        <label>
          <T>Environment name</T>
          <Input
            aria-label="Environment name"
            value={name}
            placeholder="Development / Test"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          <T>Base URL</T>
          <Input
            mono
            aria-label="Base URL"
            value={baseUrl}
            placeholder="http://localhost:8080"
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </label>
        <label>
          <T>Default request headers</T>
          <textarea
            className={styles.textarea}
            aria-label={tx("Default request headers")}
            value={headers}
            placeholder="Accept: application/json"
            spellCheck={false}
            onChange={(e) => setHeaders(e.target.value)}
          />
        </label>
        <p className={styles.hint}>
          <T>Write one header per line as Name: value. Request headers override environment defaults.</T>
        </p>
        {error && (
          <p role="alert" className={styles.error}>
            {tx(error)}
          </p>
        )}
      </div>
    </Dialog>
  );
}

function Navigation() {
  const tx = useTx();
  const { endpoints, loading, indexError, history, historyLoading, historyError, tabs, active } = useApiClient();
  const projectName = useProject((state) => state.project?.name ?? tx("Project"));
  const [tab, setTab] = useState("endpoints");
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selection, setSelection] = useState<{ activeKey?: string; keys: Set<string> }>({ keys: new Set() });
  const [display, setDisplay] = useState<EndpointDisplay>(() => {
    try {
      return localStorage.getItem(DISPLAY_KEY) === "summary" ? "summary" : "path";
    } catch {
      return "path";
    }
  });
  const groups = useMemo(() => endpointGroups(endpoints, query, projectName), [endpoints, query, projectName]);
  const branches = useMemo(() => branchKeys(groups), [groups]);
  const source = tabs.find((draft) => draft.id === active)?.source;
  const activeKey = source && apiNodeKey(source);
  const selected = selection.activeKey === activeKey ? selection.keys : new Set(activeKey ? [activeKey] : []);
  useEffect(() => {
    if (tab === "history") void refreshHistory();
  }, [tab]);
  return (
    <div className={styles.navigation}>
      <Tabs
        aria-label="API browser"
        variant="compact"
        activeId={tab}
        onSelect={setTab}
        items={[
          { id: "endpoints", label: "Endpoints" },
          { id: "history", label: "History" },
        ]}
        trailing={
          <span className={styles.navigationActions}>
            {tab === "endpoints" && (
              <>
                <IconButton
                  icon="expand-all"
                  title="Expand All"
                  size="small"
                  disabled={!branches.length}
                  onClick={() => setCollapsed(new Set())}
                />
                <IconButton
                  icon="collapse-all"
                  title="Collapse All"
                  size="small"
                  disabled={!branches.length || !!query}
                  onClick={() => setCollapsed(new Set(branches))}
                />
                <IconButton
                  icon="more"
                  title="API display options"
                  size="small"
                  onClick={(event) =>
                    showContextMenu(event, [
                      {
                        label: "Path and summary",
                        checked: display === "path",
                        run: () => {
                          setDisplay("path");
                          try {
                            localStorage.setItem(DISPLAY_KEY, "path");
                          } catch {
                            /* preference only */
                          }
                        },
                      },
                      {
                        label: "Summary only",
                        checked: display === "summary",
                        run: () => {
                          setDisplay("summary");
                          try {
                            localStorage.setItem(DISPLAY_KEY, "summary");
                          } catch {
                            /* preference only */
                          }
                        },
                      },
                    ])
                  }
                />
              </>
            )}
            <IconButton
              icon="refresh"
              title={tab === "endpoints" ? "Refresh API endpoints" : "Refresh request history"}
              size="small"
              disabled={tab === "endpoints" ? loading : historyLoading}
              onClick={() => void (tab === "endpoints" ? refreshEndpoints() : refreshHistory())}
            />
          </span>
        }
      />
      <div className={styles.search}>
        <SearchField
          aria-label="Search API requests"
          value={query}
          onChange={setQuery}
          placeholder="Search name, path or controller"
        />
      </div>
      {(tab === "endpoints" ? indexError : historyError) && (
        <p role="alert" className={styles.error}>
          {tab === "endpoints" ? indexError : historyError}
        </p>
      )}
      {tab === "endpoints" ? (
        <>
          {loading && (
            <div className={styles.loading} role="status">
              <Spinner size={12} />
              <T>Scanning API endpoints…</T>
            </div>
          )}
          <Tree<ApiNode>
            roots={groups}
            getKey={(node) => node.id}
            getLabel={(node) => node.label}
            getChildren={(node) => ("children" in node ? node.children : undefined)}
            isExpandable={(node) => "children" in node}
            expanded={new Set(branches.filter((key) => query || !collapsed.has(key)))}
            onExpandedChange={(_next, node, isExpanded) =>
              setCollapsed((current) => {
                const next = new Set(current);
                if (isExpanded) next.delete(node.id);
                else next.add(node.id);
                return next;
              })
            }
            selected={selected}
            onSelectionChange={(keys, node) => {
              setSelection({ activeKey, keys });
              if (node && "endpoint" in node) void openEndpoint(node.endpoint);
            }}
            onActivate={(node) => {
              if ("endpoint" in node)
                void editorService().openFile(node.endpoint.path, {
                  focus: true,
                  selection: { line: node.endpoint.line, col: node.endpoint.col },
                });
            }}
            renderNode={(node, row) =>
              "endpoint" in node ? (
                <span
                  className={clsx(styles.endpoint, row.selected && styles.selectedEndpoint)}
                  title={`${node.endpoint.method} ${node.endpoint.url}\n${node.endpoint.summary ?? node.endpoint.methodName}\n${node.endpoint.rel}`}
                >
                  <span className={clsx(styles.methodBadge, styles[`method-${node.endpoint.method.toLowerCase()}`])}>
                    {node.endpoint.method}
                  </span>
                  <span className={styles.endpointPath}>{endpointTitle(node.endpoint, display)}</span>
                  {display === "path" && node.endpoint.summary && (
                    <span className={styles.nodeDescription}>{node.endpoint.summary}</span>
                  )}
                </span>
              ) : (
                <span className={styles.controller} title={[node.label, node.detail].filter(Boolean).join(" · ")}>
                  <Icon name={node.kind === "module" ? "module" : "class"} size={14} />
                  <span className={styles.nodeLabel}>{node.label}</span>
                  {node.kind === "controller" && node.detail && (
                    <span className={styles.nodeDescription}>{node.detail}</span>
                  )}
                  <span className={styles.count}>{node.count}</span>
                </span>
              )
            }
            aria-label="API endpoints"
            className={styles.endpointTree}
            rowHeight={28}
            indent={14}
            horizontalScroll
            multiSelect={false}
            empty={
              !loading ? (
                <span className={styles.hint}>
                  <T>No matching API endpoints. You can create a request manually.</T>
                </span>
              ) : undefined
            }
          />
        </>
      ) : (
        <div className={styles.history} aria-label={tx("Request history")}>
          {!history.length && !historyLoading && <EmptyState title="No request history" />}
          {history
            .filter((entry) =>
              `${entry.name ?? ""} ${entry.method} ${entry.url}`.toLowerCase().includes(query.toLowerCase()),
            )
            .map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={styles.historyEntry}
                onClick={() => void restoreHistory(entry.id)}
                title={entry.url}
              >
                <span className={styles.historyTop}>
                  <span className={styles.methodBadge}>{entry.method}</span>
                  <span className={entry.status && entry.status < 400 ? styles.success : styles.error}>
                    {entry.status ?? "ERR"}
                  </span>
                  <span className={styles.count}>{new Date(entry.timeMs ?? 0).toLocaleTimeString()}</span>
                </span>
                <span className={styles.historyUrl}>{entry.name ?? entry.url}</span>
                <span className={styles.historyUrl}>{entry.url}</span>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

function RequestEditor({ draft }: { draft: RequestDraft }) {
  const tx = useTx();
  const defaultEnvironment = useApiClient((state) => state.selectedEnvironment);
  const selectedEnvironment = draft.environmentId === undefined ? defaultEnvironment : draft.environmentId;
  const running = useApiClient((state) => state.running[draft.id] !== undefined);
  const error = useApiClient((state) => state.errors[draft.id]);
  const [tab, setTab] = useState("params");
  const patch = (value: Partial<RequestDraft>) => updateDraft(draft.id, value);
  const formatBody = () => {
    try {
      patch({ body: JSON.stringify(JSON.parse(draft.body), null, 2) });
    } catch {
      useApiClient.setState((state) => ({
        errors: { ...state.errors, [draft.id]: "The request body is not valid JSON" },
      }));
    }
  };
  return (
    <div className={styles.request}>
      <div className={styles.requestTitle}>
        <Input aria-label="Request name" value={draft.name} onChange={(e) => patch({ name: e.target.value })} />
        {draft.source && (
          <IconButton
            icon="edit-source"
            title="Go to API source"
            onClick={() =>
              void editorService().openFile(draft.source!.path, {
                focus: true,
                selection: { line: draft.source!.line, col: draft.source!.col },
              })
            }
          />
        )}
      </div>
      <div className={styles.urlBar}>
        <Select
          aria-label="HTTP method"
          value={draft.method}
          options={METHODS.map((method) => ({ value: method, label: method }))}
          onChange={(method) => patch({ method })}
        />
        <Input
          mono
          className={styles.url}
          aria-label="Request URL"
          value={draft.url}
          placeholder="/api/example"
          onChange={(e) => patch({ url: e.target.value })}
        />
        {running ? (
          <Button icon="stop" onClick={() => cancelRequest(draft.id)}>
            Cancel
          </Button>
        ) : (
          <Button icon="run" variant="primary" onClick={() => void sendRequest(draft.id)}>
            Send
          </Button>
        )}
      </div>
      {!selectedEnvironment && (
        <div className={styles.baseRow}>
          <label>
            <T>Base URL</T>
          </label>
          <Input
            mono
            aria-label="Request base URL"
            value={draft.baseUrl}
            onChange={(e) => patch({ baseUrl: e.target.value })}
          />
        </div>
      )}
      {selectedEnvironment && (
        <p className={styles.environmentHint}>
          <T>The selected environment supplies the base URL and default headers.</T>
        </p>
      )}
      {error && (
        <div role="alert" className={styles.errorBar}>
          {tx(error)}
        </div>
      )}
      <Tabs
        aria-label="Request data"
        variant="compact"
        activeId={tab}
        onSelect={setTab}
        items={[
          { id: "params", label: "Parameters" },
          { id: "headers", label: "Headers" },
          { id: "body", label: "Body" },
        ]}
        trailing={
          tab === "body" ? (
            <IconButton
              icon="file-json"
              title="Format JSON"
              size="small"
              disabled={!draft.body.trim()}
              onClick={formatBody}
            />
          ) : undefined
        }
      />
      <div className={styles.requestData}>
        {tab === "params" && (
          <>
            {draft.path.length > 0 && (
              <PairEditor label="Path parameters" rows={draft.path} fixed onChange={(path) => patch({ path })} />
            )}
            <PairEditor label="Query parameters" rows={draft.query} onChange={(query) => patch({ query })} />
          </>
        )}
        {tab === "headers" && (
          <PairEditor label="Request headers" rows={draft.headers} onChange={(headers) => patch({ headers })} />
        )}
        {tab === "body" && (
          <textarea
            className={styles.body}
            aria-label={tx("Request body")}
            value={draft.body}
            placeholder={tx("Request body")}
            spellCheck={false}
            onChange={(e) => patch({ body: e.target.value })}
          />
        )}
      </div>
    </div>
  );
}

function ResponseView({ id }: { id: string }) {
  const tx = useTx();
  const exchange = useApiClient((state) => state.responses[id]);
  const running = useApiClient((state) => state.running[id] !== undefined);
  const [tab, setTab] = useState("body");
  const [raw, setRaw] = useState(false);
  const response = exchange?.response;
  const body = response?.body ?? "";
  const rendered = raw ? body : prettyBody(bodyKind(response?.contentType, body), body);
  return (
    <div className={styles.response}>
      <div className={styles.responseSummary}>
        <span>
          <T>Response</T>
        </span>
        {running && (
          <span role="status" className={styles.loading}>
            <Spinner size={12} />
            <T>Sending…</T>
          </span>
        )}
        {response && (
          <>
            <span className={clsx(styles.responseStatus, response.status < 400 ? styles.success : styles.error)}>
              {response.status} {response.statusText}
            </span>
            <span className={styles.count}>
              {formatMs(response.totalMs)} · {formatSize(response.size)}
            </span>
          </>
        )}
      </div>
      {!exchange ? (
        <EmptyState title={running ? "Waiting for response…" : "Send a request to see its response"} />
      ) : (
        <>
          {exchange.entry.error && (
            <div role="alert" className={styles.errorBar}>
              {exchange.entry.error}
            </div>
          )}
          <Tabs
            aria-label="Response data"
            variant="compact"
            activeId={tab}
            onSelect={setTab}
            items={[
              { id: "body", label: "Body" },
              { id: "headers", label: "Headers" },
              { id: "request", label: "Sent request" },
            ]}
            trailing={
              <>
                {tab === "body" && (
                  <IconButton
                    icon="soft-wrap"
                    title={raw ? "Show Formatted" : "Show Raw"}
                    size="small"
                    pressed={raw}
                    onClick={() => setRaw((value) => !value)}
                  />
                )}
                <IconButton
                  icon="copy"
                  title="Copy response"
                  size="small"
                  disabled={!body}
                  onClick={() => void copyText(rendered)}
                />
              </>
            }
          />
          <div className={clsx(styles.responseBody, selectableText)} onKeyDown={copySelectionOnKeyDown}>
            {tab === "body" &&
              (response?.body == null ? (
                <EmptyState title={response ? "Binary response" : "No response body"} />
              ) : (
                <pre aria-label={tx("Response body")}>
                  {rendered}
                  {response.truncated && <span className={styles.hint}>{`\n${tx("Response truncated")}`}</span>}
                </pre>
              ))}
            {tab === "headers" && (
              <table className={styles.headers}>
                <tbody>
                  {response?.headers.map(([key, value], index) => (
                    <tr key={index}>
                      <th>{key}</th>
                      <td>{value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {tab === "request" && (
              <pre
                aria-label={tx("Sent request")}
              >{`${exchange.request.method} ${exchange.request.url}\n${exchange.request.headers.map(([key, value]) => `${key}: ${value}`).join("\n")}\n\n${exchange.request.body ?? ""}`}</pre>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export function ApiClientView() {
  const tx = useTx();
  const root = useProject((state) => state.project?.root ?? null);
  useRemote((state) => state.session);
  const location = projectLocation(root);
  const state = useApiClient();
  const [dialog, setDialog] = useState<{ environment: ApiEnvironment | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const view = useRef<HTMLDivElement>(null);
  const [stacked, setStacked] = useState(false);
  useEffect(() => {
    const element = view.current;
    if (!element) return;
    const measure = () => setStacked(element.clientWidth < 700);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const draft = state.tabs.find((item) => item.id === state.active);
  const environmentId = draft?.environmentId === undefined ? state.selectedEnvironment : draft.environmentId;
  const environment = state.environments.find((item) => item.id === environmentId);
  useEffect(() => {
    openProject(root, location);
    void refreshEndpoints();
  }, [root, location]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const dispose = onIdeEvent("fsChanged", (event) => {
      if ([...event.created, ...event.modified, ...event.removed].some((path) => isRouteSource(path))) {
        clearTimeout(timer);
        timer = setTimeout(() => void refreshEndpoints(), 400);
      }
    });
    return () => {
      clearTimeout(timer);
      dispose();
    };
  }, []);
  const remove = async () => {
    if (
      environment &&
      (await confirm({
        title: "Remove API Environment",
        message: tx`Remove ${environment.name} from the API environments?`,
        ok: "Remove",
      }))
    ) {
      try {
        removeEnvironment(environment.id);
        setError(null);
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error));
      }
    }
  };
  return (
    <div ref={view} className={styles.view}>
      <div className={styles.toolbar}>
        <Select
          aria-label="API environment"
          className={styles.environment}
          value={environmentId ?? ""}
          onChange={(id) => selectEnvironment(id || null)}
          options={[
            { value: "", label: "Local / exact URL" },
            ...state.environments.map((item) => ({ value: item.id, label: item.name, detail: item.baseUrl })),
          ]}
        />
        <IconButton icon="plus" title="Add API Environment" onClick={() => setDialog({ environment: null })} />
        <IconButton
          icon="edit"
          title="Edit API Environment"
          disabled={!environment}
          onClick={() => environment && setDialog({ environment })}
        />
        <IconButton icon="trash" title="Remove API Environment" disabled={!environment} onClick={() => void remove()} />
        <span className={styles.toolbarSpacer} />
        <IconButton icon="file-http" title="New API request" onClick={() => newRequest()} />
      </div>
      {(state.storageError || error) && (
        <div role="alert" className={styles.errorBar}>
          {state.storageError || error}
        </div>
      )}
      <SplitGroup
        orientation={stacked ? "vertical" : "horizontal"}
        id="api-client-navigation"
        className={styles.workspace}
      >
        <SplitPanel
          defaultSize={stacked ? "180px" : "300px"}
          minSize={stacked ? "120px" : "220px"}
          maxSize={stacked ? "55%" : "65%"}
        >
          <Navigation />
        </SplitPanel>
        <SplitHandle aria-label="Resize API endpoint list" />
        <SplitPanel minSize={stacked ? "180px" : "300px"}>
          <div className={styles.editor}>
            {state.tabs.length > 0 && (
              <Tabs
                aria-label="API request tabs"
                variant="compact"
                activeId={state.active ?? ""}
                onSelect={selectTab}
                onClose={closeTab}
                items={state.tabs.map((item) => ({
                  id: item.id,
                  label: item.name,
                  text: item.name,
                  icon: "file-http",
                  closable: true,
                  modified: state.running[item.id] !== undefined,
                }))}
              />
            )}
            {draft ? (
              <SplitGroup orientation="vertical" id="api-client-request-response" className={styles.requestResponse}>
                <SplitPanel defaultSize="50%" minSize="180px">
                  <RequestEditor key={draft.id} draft={draft} />
                </SplitPanel>
                <SplitHandle />
                <SplitPanel minSize="110px">
                  <ResponseView key={draft.id} id={draft.id} />
                </SplitPanel>
              </SplitGroup>
            ) : (
              <EmptyState
                title="Choose an endpoint or create a request"
                actions={
                  <Button icon="plus" onClick={() => newRequest()}>
                    New API request
                  </Button>
                }
              >
                <T>Browse Spring APIs, switch environments, and inspect HTTP responses here.</T>
              </EmptyState>
            )}
          </div>
        </SplitPanel>
      </SplitGroup>
      {dialog && <EnvironmentDialog environment={dialog.environment} onClose={() => setDialog(null)} />}
    </div>
  );
}
