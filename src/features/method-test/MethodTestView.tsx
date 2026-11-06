import { useState } from "react";
import { editorService, revealRunConsole } from "@/workbench/contributions";
import { IconButton, Input, Select, Spinner, Tabs, T, copyText } from "@/ui";
import { useTx } from "@/platform/i18n";
import {
  busy,
  loadCase,
  newCase,
  removeCase,
  runMethod,
  saveCase,
  stopMethod,
  updateDraft,
  useMethodTest,
} from "./store";
import { methodKey, methodLabel } from "./model";
import styles from "./MethodTest.module.css";

const DEPENDENCY_EXAMPLE = JSON.stringify(
  {
    repository: { kind: "mock", stubs: [{ method: "findById", args: [1], returns: { id: 1, name: "Example" } }] },
    otherService: { kind: "instance", className: "com.example.OtherService" },
    limit: { kind: "value", value: 10 },
  },
  null,
  2,
);
const pretty = (value: string) => {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
};

export function MethodTestView() {
  const tx = useTx();
  const state = useMethodTest();
  const { draft, result } = state;
  const [tab, setTab] = useState("arguments");
  const [caseName, setCaseName] = useState("");
  const [seenResult, setSeenResult] = useState(result);
  const [seenTarget, setSeenTarget] = useState(draft ? methodKey(draft.target) : null);
  const targetKey = draft ? methodKey(draft.target) : null;
  if (seenTarget !== targetKey) {
    setSeenTarget(targetKey);
    setTab("arguments");
    setCaseName("");
  }
  if (seenResult !== result) {
    setSeenResult(result);
    if (result) setTab("result");
  }
  const running = busy(state.status);
  if (!draft)
    return (
      <div className={styles.empty}>
        <T>Choose a public Service method from its gutter icon or use Test Java Method at the caret.</T>
      </div>
    );
  const update =
    (field: "argumentsJson" | "dependenciesJson" | "propertiesJson" | "environmentJson") => (value: string) =>
      updateDraft({ [field]: value });
  const jsonEditor = (label: string, value: string, onChange: (value: string) => void) => (
    <textarea
      className={styles.json}
      aria-label={tx(label)}
      spellCheck={false}
      value={value}
      disabled={running}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key.toLowerCase() === "a" && (event.metaKey || event.ctrlKey)) event.stopPropagation();
      }}
    />
  );
  const status = {
    idle: "Ready",
    preparing: "Preparing",
    running: "Running",
    stopping: "Stopping",
    done: "Completed",
    failed: "Failed",
    stopped: "Stopped",
  }[state.status];
  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <Select
          aria-label="Execution mode"
          disabled={running}
          value={draft.mode}
          options={[
            { value: "object", label: "Object · no Spring" },
            { value: "spring", label: "Spring · selected beans" },
          ]}
          onChange={(mode) => updateDraft({ mode })}
        />
        <span className={styles.spacer} />
        <IconButton icon="run" title="Run method" disabled={running} onClick={() => void runMethod()} />
        <IconButton icon="debug" title="Debug method" disabled={running} onClick={() => void runMethod(true)} />
        <IconButton
          icon="stop"
          title="Stop method"
          disabled={!running || state.status === "stopping"}
          onClick={() => void stopMethod()}
        />
        <IconButton
          icon="toolwindow-services"
          title="Show method Console"
          disabled={!state.config}
          onClick={() => state.config && revealRunConsole(state.config, true)}
        />
        <IconButton
          icon="open-in-tool-window"
          title="Go to method source"
          onClick={() =>
            void editorService().openFile(draft.target.path, {
              selection: { line: draft.target.line, col: 0 },
              focus: true,
            })
          }
        />
      </div>
      <div className={styles.target} title={methodLabel(draft.target)}>
        <span>{draft.target.className}</span>
        <strong>
          {draft.target.methodName}({draft.target.parameters.map((p) => `${p.type} ${p.name}`).join(", ")})
        </strong>
      </div>
      <label className={styles.field}>
        <T>Implementation class</T>
        <Input
          aria-label="Implementation class"
          mono
          disabled={running}
          value={draft.implementationClass}
          placeholder="com.example.OrderServiceImpl"
          onChange={(event) => updateDraft({ implementationClass: event.target.value })}
        />
      </label>
      <div className={styles.cases}>
        <Select
          aria-label="Saved method cases"
          placeholder="Saved cases"
          value={state.caseId}
          disabled={running || !state.cases.length}
          options={state.cases.map((entry) => ({
            value: entry.id,
            label: entry.name,
            detail: entry.draft.target.methodName,
          }))}
          onChange={(id) => {
            loadCase(id);
            setCaseName(state.cases.find((entry) => entry.id === id)?.name ?? "");
          }}
        />
        <Input
          aria-label="Method case name"
          placeholder="Case name"
          value={caseName}
          disabled={running}
          onChange={(event) => setCaseName(event.target.value)}
        />
        <IconButton
          icon="plus"
          title="New method case"
          disabled={running}
          onClick={() => {
            newCase();
            setCaseName(state.cases.find((entry) => entry.id === state.caseId)?.name ?? "");
          }}
        />
        <IconButton
          icon="check"
          title="Save method case"
          disabled={running || !caseName.trim()}
          onClick={() => saveCase(caseName)}
        />
        <IconButton icon="trash" title="Delete method case" disabled={running || !state.caseId} onClick={removeCase} />
      </div>
      <Tabs
        variant="compact"
        aria-label="Method test data"
        activeId={tab}
        onSelect={setTab}
        items={[
          { id: "arguments", label: tx("Arguments") },
          { id: "dependencies", label: tx("Dependencies") },
          { id: "spring", label: "Spring" },
          { id: "environment", label: tx("Environment") },
          { id: "result", label: tx("Result") },
        ]}
      />
      <div className={styles.content}>
        {tab === "arguments" && (
          <>
            <p className={styles.hint}>
              <T>JSON array, in parameter order. Objects and collections are converted to the declared Java types.</T>
            </p>
            {jsonEditor("Method arguments", draft.argumentsJson, update("argumentsJson"))}
          </>
        )}
        {tab === "dependencies" && (
          <>
            <p className={styles.hint}>
              <T>
                Use field names as keys. Choose mock, instance or value; provide className when the field is declared on
                an implementation.
              </T>
            </p>
            {!!draft.target.fields.length && (
              <div className={styles.dependencies}>
                {draft.target.fields.map((field) => (
                  <code key={field.name}>
                    {field.name}: {field.type}
                  </code>
                ))}
              </div>
            )}
            {jsonEditor("Method dependencies", draft.dependenciesJson, update("dependenciesJson"))}
            <details className={styles.help}>
              <summary>
                <T>Dependency examples</T>
              </summary>
              <pre>{DEPENDENCY_EXAMPLE}</pre>
              <p>
                <T>
                  Omit args to match any arguments. Add parameterTypes for overloaded mock methods. Unconfigured mock
                  calls fail explicitly. Class mocks require the project's Mockito dependency.
                </T>
              </p>
            </details>
          </>
        )}
        {tab === "spring" && (
          <>
            <p className={styles.hint}>
              <T>
                Spring mode registers the target and these classes. Configuration classes can load additional beans,
                properties and infrastructure.
              </T>
            </p>
            <label className={styles.field}>
              <T>Configuration classes</T>
              <Input
                aria-label="Spring configuration classes"
                mono
                disabled={running}
                value={draft.configurationClasses}
                placeholder="com.example.MethodTestConfig"
                onChange={(event) => updateDraft({ configurationClasses: event.target.value })}
              />
            </label>
            <label className={styles.field}>
              <T>Spring profiles</T>
              <Input
                aria-label="Method Spring profiles"
                value={draft.profiles}
                disabled={running}
                placeholder="dev,test"
                onChange={(event) => updateDraft({ profiles: event.target.value })}
              />
            </label>
            <label className={styles.field}>
              <T>Properties · JSON object</T>
            </label>
            {jsonEditor("Method Spring properties", draft.propertiesJson, update("propertiesJson"))}
            <p className={styles.hint}>
              <T>
                Transactions and other proxies require their configuration. Real dependencies use the configured
                services.
              </T>
            </p>
          </>
        )}
        {tab === "environment" && (
          <>
            <label className={styles.field}>
              <T>Maven profiles</T>
              <Input
                aria-label="Method Maven profiles"
                value={draft.mavenProfiles}
                disabled={running}
                onChange={(event) => updateDraft({ mavenProfiles: event.target.value })}
              />
            </label>
            <div className={styles.settings}>
              <label className={styles.field}>
                <T>Heap limit · MB</T>
                <Input
                  aria-label="Method heap limit"
                  type="number"
                  min={64}
                  max={4096}
                  value={draft.heapMb}
                  disabled={running}
                  onChange={(event) => updateDraft({ heapMb: Number(event.target.value) })}
                />
              </label>
              <label className={styles.field}>
                <T>Timeout · seconds</T>
                <Input
                  aria-label="Method timeout"
                  type="number"
                  min={1}
                  max={3600}
                  value={draft.timeoutSeconds}
                  disabled={running}
                  onChange={(event) => updateDraft({ timeoutSeconds: Number(event.target.value) })}
                />
              </label>
            </div>
            <label className={styles.field}>
              <T>Environment variables · JSON string values</T>
            </label>
            {jsonEditor("Method environment variables", draft.environmentJson, update("environmentJson"))}
          </>
        )}
        {tab === "result" && (
          <>
            {result ? (
              <>
                <div className={styles.resultHeading}>
                  <strong className={result.success ? styles.success : styles.error}>
                    {result.success ? tx("Completed") : tx("Failed")}
                  </strong>
                  <span>{(result.durationMs ?? 0).toFixed(1)} ms</span>
                  <span className={styles.spacer} />
                  <IconButton
                    icon="copy"
                    title="Copy method result"
                    onClick={() => void copyText(result.valueJson ?? result.stackTrace ?? result.error ?? "")}
                  />
                </div>
                <div className={styles.resultTarget}>{state.resultLabel}</div>
                {result.error && (
                  <div role="alert" className={styles.error}>
                    {result.error}
                  </div>
                )}
                {result.valueJson !== null && (
                  <pre className={styles.output} aria-label={tx("Method return value")}>
                    {pretty(result.valueJson)}
                  </pre>
                )}
                {result.stackTrace && (
                  <details open className={styles.help}>
                    <summary>
                      <T>Stack trace · source links in Console</T>
                    </summary>
                    <pre>{result.stackTrace}</pre>
                  </details>
                )}
                {result.mockCallsJson !== "[]" && (
                  <details className={styles.help}>
                    <summary>
                      <T>Mock calls</T>
                    </summary>
                    <pre>{pretty(result.mockCallsJson)}</pre>
                  </details>
                )}
              </>
            ) : (
              <p className={styles.hint}>
                <T>Run a method to see its return value, duration and exceptions.</T>
              </p>
            )}
          </>
        )}
        {state.error && (
          <div role="alert" className={styles.error}>
            {state.error}
          </div>
        )}
        {state.storageError && (
          <div role="alert" className={styles.error}>
            {tx("Cannot save method cases")}: {state.storageError}
          </div>
        )}
      </div>
      <div className={styles.status} role="status">
        {running && <Spinner size={12} />}
        <T>{status}</T>
        <span className={styles.spacer} />
        <span>Maven · Java</span>
      </div>
    </div>
  );
}
