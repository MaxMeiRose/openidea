import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { useTx } from "@/platform/i18n";
import { Button, Dialog, EmptyState, Icon, IconButton, Input, SearchField, Select, Spinner, T } from "@/ui";
import { confirm } from "@/workbench/messages";
import { filterServices, instanceKey, type EurekaEnvironment, type StatusFilter } from "./model";
import {
  cancelRefresh,
  refreshEureka,
  removeEnvironment,
  saveEnvironment,
  selectEnvironment,
  updateInstance,
  useEureka,
} from "./store";
import styles from "./Eureka.module.css";

function EnvironmentDialog({ environment, onClose }: { environment: EurekaEnvironment | null; onClose: () => void }) {
  const tx = useTx();
  const [name, setName] = useState(environment?.name ?? "");
  const [url, setUrl] = useState(environment?.url ?? "");
  const [error, setError] = useState<string | null>(null);
  const save = () => {
    try {
      saveEnvironment({ id: environment?.id ?? crypto.randomUUID(), name, url });
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <Dialog
      open
      title={environment ? "Edit Eureka Environment" : "Add Eureka Environment"}
      width={460}
      onClose={onClose}
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
          <T>Server address</T>
          <Input
            aria-label="Server address"
            mono
            value={url}
            placeholder="http://IP:32044"
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
        <p className={styles.hint}>
          <T>The management server's IP or hostname, with an optional port and gateway prefix.</T>
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

export function EurekaView() {
  const tx = useTx();
  const state = useEureka();
  const { environments, selected, services, refreshing, loaded, error, settingsError, notice, pending, lastUpdated } =
    state;
  const environment = environments.find((env) => env.id === selected);
  const [dialog, setDialog] = useState<{ environment: EurekaEnvironment | null } | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [localError, setLocalError] = useState<string | null>(null);
  const filtered = useMemo(() => filterServices(services, query, status), [services, query, status]);
  const total = services.reduce((sum, service) => sum + service.instance.length, 0);
  const visible = filtered.reduce((sum, service) => sum + service.instance.length, 0);
  const up = services.reduce((sum, service) => sum + service.instance.filter((i) => i.status === "UP").length, 0);
  useEffect(() => {
    void refreshEureka();
    return cancelRefresh;
  }, [environment?.id, environment?.url]);

  const attempt = (action: () => void) => {
    try {
      action();
      setLocalError(null);
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : String(e));
    }
  };
  const remove = async () => {
    if (!environment) return;
    if (
      await confirm({
        title: "Remove Eureka Environment",
        message: tx`Remove ${environment.name} from the saved environments? Service instances will not be changed.`,
        ok: "Remove",
      })
    ) {
      attempt(() => removeEnvironment(environment.id));
    }
  };

  return (
    <div className={styles.view}>
      <div className={styles.toolbar}>
        <Select
          aria-label="Eureka environment"
          className={styles.environment}
          value={selected}
          placeholder="Choose an environment"
          searchable
          options={environments.map((env) => ({ value: env.id, label: env.name, detail: env.url }))}
          disabled={!environments.length}
          onChange={(id) => attempt(() => selectEnvironment(id))}
        />
        <IconButton icon="plus" title="Add Eureka Environment" onClick={() => setDialog({ environment: null })} />
        <IconButton
          icon="edit"
          title="Edit Eureka Environment"
          disabled={!environment}
          onClick={() => environment && setDialog({ environment })}
        />
        <IconButton
          icon="trash"
          title="Remove Eureka Environment"
          disabled={!environment}
          onClick={() => void remove()}
        />
        <span className={styles.address} title={environment?.url}>
          {environment?.url}
        </span>
        <IconButton
          icon="refresh"
          title="Refresh Eureka"
          disabled={!environment || refreshing}
          onClick={() => void refreshEureka()}
        />
      </div>
      {environment && (
        <div className={styles.filters}>
          <SearchField
            aria-label="Search Eureka services"
            placeholder="Search service or instance"
            value={query}
            onChange={setQuery}
            className={styles.search}
          />
          <Select
            aria-label="Instance status"
            value={status}
            onChange={setStatus}
            options={[
              { value: "all", label: "All statuses" },
              { value: "UP", label: "UP" },
              { value: "DOWN", label: "DOWN" },
              { value: "other", label: "Other statuses" },
            ]}
          />
          {refreshing && (
            <span role="status" className={styles.loading}>
              <Spinner size={12} />
              <T>Refreshing…</T>
            </span>
          )}
        </div>
      )}
      {(localError || settingsError || error) && (
        <div role="alert" className={styles.errorBar}>
          <Icon name="warning" size={14} />
          <span>{tx(localError || settingsError || error || "")}</span>
        </div>
      )}
      {notice && (
        <div role="status" className={clsx(styles.notice, notice.kind === "warning" && styles.warning)}>
          <Icon name={notice.kind === "success" ? "check" : "warning"} size={14} />
          <span>{tx(notice.text)}</span>
        </div>
      )}
      <div className={styles.content} aria-busy={refreshing}>
        {!environment ? (
          <EmptyState
            title="No Eureka environments"
            actions={
              <Button icon="plus" onClick={() => setDialog({ environment: null })}>
                Add Eureka Environment
              </Button>
            }
          >
            <T>Add a development or test environment to manage its service instances.</T>
          </EmptyState>
        ) : !loaded && refreshing ? (
          <EmptyState title="Loading Eureka services…" />
        ) : !loaded && error ? (
          <EmptyState
            title="Cannot load Eureka services"
            actions={<Button onClick={() => void refreshEureka()}>Retry</Button>}
          >
            <T>Check the environment address and network connection.</T>
          </EmptyState>
        ) : !filtered.length ? (
          <EmptyState title={services.length ? "No matching service instances" : "No registered service instances"} />
        ) : (
          <table className={styles.table} aria-label={tx("Eureka service instances")}>
            <thead>
              <tr>
                <th>
                  <T>Service / Instance</T>
                </th>
                <th>
                  <T>Status</T>
                </th>
                <th>
                  <T>Actions</T>
                </th>
              </tr>
            </thead>
            {filtered.map((service) => (
              <tbody key={service.name}>
                <tr className={styles.service}>
                  <th colSpan={3} scope="rowgroup">
                    <span>
                      <Icon name="toolwindow-services" size={14} />
                      {service.name}
                      <span className={styles.count}>{service.instance.length}</span>
                    </span>
                  </th>
                </tr>
                {service.instance.map((instance) => {
                  const key = instanceKey(environment, service.name, instance.instanceId);
                  const busy = pending.has(key);
                  const target = instance.status === "UP" ? "DOWN" : "UP";
                  return (
                    <tr key={instance.instanceId}>
                      <td className={styles.instance}>{instance.instanceId}</td>
                      <td>
                        <span
                          className={clsx(
                            styles.badge,
                            instance.status === "UP"
                              ? styles.up
                              : instance.status === "DOWN"
                                ? styles.down
                                : styles.unknown,
                          )}
                        >
                          {instance.status}
                        </span>
                      </td>
                      <td>
                        <Button
                          size="small"
                          disabled={busy || refreshing}
                          aria-label={tx`Set ${instance.instanceId} ${target}`}
                          onClick={() => void updateInstance(environment, service.name, instance.instanceId, target)}
                        >
                          {busy && <Spinner size={11} />}
                          {busy ? tx("Updating…") : tx(instance.status === "UP" ? "Set DOWN" : "Set UP")}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            ))}
          </table>
        )}
      </div>
      {environment && (
        <div className={styles.footer}>
          <span>{tx`${services.length} services · ${visible} / ${total} instances · ${up} UP`}</span>
          {lastUpdated && <span>{tx`Updated ${new Date(lastUpdated).toLocaleTimeString()}`}</span>}
          <span className={styles.explanation}>
            <T>Changes registration status; does not start or stop the service process.</T>
          </span>
        </div>
      )}
      {dialog && <EnvironmentDialog environment={dialog.environment} onClose={() => setDialog(null)} />}
    </div>
  );
}
