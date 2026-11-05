import type { EurekaService } from "@/bindings";

export interface EurekaEnvironment {
  id: string;
  name: string;
  url: string;
}

export interface EurekaSettings {
  environments: EurekaEnvironment[];
  selected: string | null;
}

export function serverAddress(value: string): string {
  const text = value.trim();
  if (!text) throw new Error("Enter a server address");
  let url: URL;
  try {
    url = new URL(text.includes("://") ? text : `http://${text}`);
  } catch {
    throw new Error("Enter a valid server IP or hostname, with an optional port");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.href.includes("?") ||
    url.href.includes("#")
  ) {
    throw new Error("Use an HTTP or HTTPS address without credentials, query or fragment");
  }
  return url.href.replace(/\/+$/, "");
}

export function readSettings(raw: string | null): EurekaSettings {
  if (raw === null) return { environments: [], selected: null };
  const data = JSON.parse(raw) as Partial<EurekaSettings> | null;
  if (!data || !Array.isArray(data.environments)) throw new Error("Cannot read saved Eureka environments");
  const ids = new Set<string>();
  const environments = data.environments.map((env) => {
    if (
      !env ||
      typeof env.id !== "string" ||
      !env.id ||
      ids.has(env.id) ||
      typeof env.name !== "string" ||
      !env.name.trim() ||
      typeof env.url !== "string"
    ) {
      throw new Error("Cannot read saved Eureka environments");
    }
    ids.add(env.id);
    return { id: env.id, name: env.name.trim(), url: serverAddress(env.url) };
  });
  return {
    environments,
    selected: environments.find((e) => e.id === data.selected)?.id ?? environments[0]?.id ?? null,
  };
}

export type StatusFilter = "all" | "UP" | "DOWN" | "other";

export function filterServices(services: EurekaService[], query: string, status: StatusFilter): EurekaService[] {
  const tokens = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return services.flatMap((service) => {
    const instance = service.instance.filter((item) => {
      const text = `${service.name} ${item.instanceId} ${item.status}`.toLocaleLowerCase();
      return (
        tokens.every((token) => text.includes(token)) &&
        (status === "all" || (status === "other" ? !["UP", "DOWN"].includes(item.status) : item.status === status))
      );
    });
    return instance.length ? [{ ...service, instance }] : [];
  });
}

export const instanceKey = (env: EurekaEnvironment, service: string, instance: string) =>
  JSON.stringify([env.id, env.url, service, instance]);
