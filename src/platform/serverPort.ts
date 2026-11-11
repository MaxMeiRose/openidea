/** Confirmed web-server startup output; debugger endpoints and failed binds are excluded. */
const STARTED =
  /\b(?:Tomcat|Netty|Undertow|Jetty)\b.*?\bstarted on port(?:\(s\)|s)?:?\s*(\d{1,5}(?:\s*\([^)]*\))?(?:\s*,\s*\d{1,5}(?:\s*\([^)]*\))?)*)(?!\d)/i;
const DEBUGGER = /\b(?:debugger|debugpy|debug adapter|dap|inspector|dt_socket|delve|jdwp|pprof|profiler)\b/i;
const FAILED = /\b(?:error|failed|exception|EADDRINUSE|address already in use)\b/i;
const READY =
  /\b(?:listen(?:ing)?|serving|server (?:started|running)|running on|uvicorn running|development server at|has launched from)\b|\blocal:\s*https?:\/\//i;
const ADDRESS =
  /(?:https?:\/\/(?:\[[\da-f:]+\]|[\w.*-]+)|\[[\da-f:]+\]|(?:\d{1,3}\.){3}\d{1,3}|localhost|\*):(\d{1,5})(?!\d)/gi;
const valid = (port: number) => Number.isInteger(port) && port > 0 && port < 65536;

export function startedPorts(line: string): number[] {
  if (DEBUGGER.test(line) || FAILED.test(line)) return [];
  const spring = STARTED.exec(line);
  if (spring) return [...spring[1]!.matchAll(/(?:^|,)\s*(\d+)/g)].map((match) => Number(match[1])).filter(valid);
  if (!READY.test(line)) return [];
  const ports = [...line.matchAll(ADDRESS)].map((match) => Number(match[1]));
  const bare = /\b(?:on|at|listen(?:ing)?)\s*[:=]?\s*:(\d{1,5})(?!\d)/i.exec(line);
  if (bare) ports.push(Number(bare[1]));
  const named = /\bport\s*[:=]?\s*(\d{1,5})(?!\d)/i.exec(line);
  if (named) ports.push(Number(named[1]));
  const json = line.indexOf("{");
  if (json >= 0) {
    try {
      const data = JSON.parse(line.slice(json)) as Record<string, unknown>;
      if (typeof data.port === "number" || typeof data.port === "string") ports.push(Number(data.port));
      for (const key of ["addr", "address", "listen", "url"]) {
        const value = data[key];
        if (typeof value === "string") {
          const match = /:(\d{1,5})(?!\d)(?:\/|$)/.exec(value.trim());
          if (match) ports.push(Number(match[1]));
        }
      }
    } catch {
      /* normal text log */
    }
  }
  return [...new Set(ports.filter(valid))];
}

export function startedPort(line: string): number | null {
  return startedPorts(line)[0] ?? null;
}

export function mergePorts(previous: readonly number[] | undefined, next: readonly number[]): number[] {
  return [...new Set([...(previous ?? []), ...next].filter(valid))];
}
