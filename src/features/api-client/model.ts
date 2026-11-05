import type { HttpExchange, PreparedRequest } from "@/bindings";
import type { EndpointEntry } from "@/workbench/contributions";

export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
export interface ApiEndpointTarget {
  endpoint: EndpointEntry;
  /** Unsaved controller content, when invoked from its editor. */
  source?: string;
}
export interface Pair {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
}
export interface ApiEnvironment {
  id: string;
  name: string;
  baseUrl: string;
  headers: Pair[];
}
export interface RequestDraft {
  id: string;
  name: string;
  method: string;
  url: string;
  baseUrl: string;
  path: Pair[];
  query: Pair[];
  headers: Pair[];
  body: string;
  source?: EndpointEntry;
  endpointKey?: string;
  /** Each request keeps its target when another tab restores history or changes environments. */
  environmentId?: string | null;
}

export const pair = (key = "", value = ""): Pair => ({ id: crypto.randomUUID(), key, value, enabled: true });
export const endpointKey = (endpoint: EndpointEntry) =>
  JSON.stringify([endpoint.path, endpoint.controller, endpoint.methodName, endpoint.method, endpoint.url]);

/** Spring regex mappings can contain nested quantifier braces, e.g. {id:[0-9]{2}}. */
function pathTokens(url: string): Array<{ from: number; to: number; name: string }> {
  const tokens: Array<{ from: number; to: number; name: string }> = [];
  for (let from = 0; from < url.length; from++) {
    if (url[from] !== "{") continue;
    let depth = 1;
    let colon = -1;
    let characterClass = false;
    for (let to = from + 1; to < url.length; to++) {
      const char = url[to];
      if (char === "\\") {
        to++;
        continue;
      }
      if (char === ":" && colon < 0 && depth === 1) colon = to;
      if (colon >= 0) {
        if (char === "[") characterClass = true;
        if (char === "]") characterClass = false;
      }
      if (characterClass) continue;
      if (char === "{") depth++;
      if (char !== "}" || --depth !== 0) continue;
      const name = url.slice(from + 1, colon >= 0 ? colon : to).trim();
      if (name && !/[{}\s/]/.test(name)) tokens.push({ from, to: to + 1, name });
      from = to;
      break;
    }
  }
  return tokens;
}

export function pathParameters(url: string, previous: Pair[] = []): Pair[] {
  const names = pathTokens(url).map((token) => token.name);
  return [...new Set(names)].map((key) => previous.find((row) => row.key === key) ?? pair(key));
}

export function newDraft(): RequestDraft {
  return {
    id: crypto.randomUUID(),
    name: "New request",
    method: "GET",
    url: "/",
    baseUrl: "http://localhost:8080",
    path: [],
    query: [],
    headers: [],
    body: "",
  };
}

export function endpointDraft(endpoint: EndpointEntry): RequestDraft {
  return {
    ...newDraft(),
    name: `${endpoint.method} ${endpoint.url}`,
    method: endpoint.method === "ANY" ? "GET" : endpoint.method,
    url: endpoint.url,
    path: pathParameters(endpoint.url),
    source: endpoint,
    endpointKey: endpointKey(endpoint),
  };
}

export function baseAddress(value: string): string {
  const raw = value.trim();
  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `http://${raw}`);
  } catch {
    throw new Error("Enter a valid HTTP server address");
  }
  if (!/^https?:$/.test(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash)
    throw new Error("Use an HTTP or HTTPS base URL without credentials, query or fragment");
  return url.href.replace(/\/+$/, "");
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~\dA-Za-z-]+$/;
export function validateHeaders(rows: Pair[]): Pair[] {
  return rows
    .filter((row) => row.enabled && row.key.trim())
    .map((row) => {
      if (!HEADER_NAME.test(row.key.trim()) || /[\r\n]/.test(row.value))
        throw new Error("Header names and values must not contain line breaks or invalid characters");
      return { ...row, key: row.key.trim() };
    });
}

/** Environment headers are defaults; request rows override them case-insensitively. */
export function effectiveHeaders(request: Pair[], environment: Pair[] = []): Pair[] {
  const overridden = new Set(request.map((row) => row.key.trim().toLowerCase()).filter(Boolean));
  return validateHeaders([...environment.filter((row) => !overridden.has(row.key.trim().toLowerCase())), ...request]);
}

export function prepareRequest(draft: RequestDraft, environment: ApiEnvironment | undefined): PreparedRequest {
  if (!METHODS.includes(draft.method as (typeof METHODS)[number])) throw new Error("Choose a supported HTTP method");
  let address = draft.url.trim();
  if (!address || /[\r\n]/.test(address)) throw new Error("Enter a request URL or path");
  if (/^[a-z][a-z\d+.-]*:/i.test(address) && !/^https?:\/\//i.test(address))
    throw new Error("Only HTTP and HTTPS requests are supported");
  for (const token of pathTokens(address).reverse()) {
    const value = draft.path.find((row) => row.key === token.name)?.value;
    if (value === undefined || value === "") throw new Error("Fill in all path parameter values before sending");
    address = address.slice(0, token.from) + encodeURIComponent(value) + address.slice(token.to);
  }
  if (/[{}]/.test(address)) throw new Error("Check the path parameter syntax in the request URL");
  const absolute = /^https?:\/\//i.test(address);
  if (environment) {
    if (absolute) {
      let original: URL;
      try {
        original = new URL(address);
      } catch {
        throw new Error("Enter a valid HTTP request URL");
      }
      address = original.pathname + original.search;
    }
    address = `${baseAddress(environment.baseUrl)}/${address.replace(/^\/+/, "")}`;
  } else if (!absolute) address = `${baseAddress(draft.baseUrl)}/${address.replace(/^\/+/, "")}`;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new Error("Enter a valid HTTP request URL");
  }
  if (!/^https?:$/.test(url.protocol) || !url.hostname) throw new Error("Only HTTP and HTTPS requests are supported");
  if (url.hash) throw new Error("Request URLs must not contain a fragment");
  for (const row of draft.query) if (row.enabled && row.key.trim()) url.searchParams.append(row.key.trim(), row.value);
  const headers = effectiveHeaders(draft.headers, environment?.headers);
  return {
    url: url.href,
    name: draft.name.trim() || null,
    method: draft.method,
    headers: headers.map((row) => [row.key, row.value]),
    body: draft.body.length ? draft.body : null,
  };
}

export function environmentOf(env: ApiEnvironment): ApiEnvironment {
  if (!env.name.trim()) throw new Error("Enter an environment name");
  return { ...env, name: env.name.trim(), baseUrl: baseAddress(env.baseUrl), headers: validateHeaders(env.headers) };
}

export function headersFromText(text: string): Pair[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const colon = line.indexOf(":");
      if (colon <= 0) throw new Error("Write one header per line as Name: value");
      return pair(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
    });
}

export function draftFromExchange(exchange: HttpExchange): RequestDraft {
  const draft = newDraft();
  const request = exchange.request;
  const url = new URL(request.url);
  return {
    ...draft,
    name: request.name ?? `${request.method} ${url.pathname}`,
    method: request.method,
    url: url.pathname,
    baseUrl: url.origin,
    query: [...url.searchParams].map(([key, value]) => pair(key, value)),
    headers: request.headers.map(([key, value]) => pair(key, value)),
    body: request.body ?? "",
    environmentId: null,
  };
}

export interface SavedWorkspace {
  environments: ApiEnvironment[];
  selectedEnvironment: string | null;
  tabs: RequestDraft[];
  active: string | null;
}
export function savedWorkspace(raw: string | null): SavedWorkspace {
  const empty = { environments: [], selectedEnvironment: null, tabs: [], active: null };
  if (!raw) return empty;
  const data = JSON.parse(raw) as Partial<SavedWorkspace>;
  if (!data || !Array.isArray(data.environments) || !Array.isArray(data.tabs))
    throw new Error("Cannot restore the API Client workspace");
  const pairs = (rows: Pair[] | undefined) =>
    Array.isArray(rows)
      ? rows
          .filter(
            (row) => row && typeof row.id === "string" && typeof row.key === "string" && typeof row.value === "string",
          )
          .map((row) => ({ ...row, enabled: row.enabled !== false }))
      : [];
  const environments = data.environments
    .filter(
      (env) => env && typeof env.id === "string" && typeof env.name === "string" && typeof env.baseUrl === "string",
    )
    .map((env) => environmentOf({ ...env, headers: pairs(env.headers) }));
  const ids = new Set<string>();
  const tabs = data.tabs
    .filter((draft) => {
      if (
        !draft ||
        typeof draft.id !== "string" ||
        ids.has(draft.id) ||
        typeof draft.name !== "string" ||
        typeof draft.method !== "string" ||
        typeof draft.url !== "string" ||
        typeof draft.baseUrl !== "string" ||
        typeof draft.body !== "string"
      )
        return false;
      ids.add(draft.id);
      return true;
    })
    .map((draft) => ({ ...draft, path: pairs(draft.path), query: pairs(draft.query), headers: pairs(draft.headers) }));
  return {
    environments,
    selectedEnvironment: environments.some((env) => env.id === data.selectedEnvironment)
      ? data.selectedEnvironment!
      : null,
    tabs,
    active: tabs.some((tab) => tab.id === data.active) ? data.active! : (tabs[0]?.id ?? null),
  };
}
