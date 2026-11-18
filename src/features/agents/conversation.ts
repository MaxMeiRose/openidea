/** Reading an agent conversation: quoting, file links, turn times and finding text. */
import type { AgentEntry } from "@/bindings";

export type ToolCall = Extract<AgentEntry, { type: "tool" }>;
export type ConversationItem =
  | { type: "entry"; index: number; entry: AgentEntry }
  | { type: "tools"; index: number; name: string; calls: ToolCall[] };

const LEGACY_TOOL_PREFIXES: Array<[string, string, string]> = [
  ["read", "Read ", "Read"],
  ["read", "View ", "View image"],
  ["edit", "Edit ", "Edit"],
  ["edit", "Write ", "Write"],
  ["edit", "Create ", "Create"],
  ["search", "Find ", "Glob"],
  ["search", 'grep "', "Grep"],
  ["search", "List ", "List"],
  ["search", "Search ", "Search"],
  ["fetch", "Fetch ", "WebFetch"],
  ["fetch", 'Search "', "WebSearch"],
];

/** Some older saved calls have no tool name; infer only the recognizable titles. */
function toolName(call: ToolCall, provider?: string): string {
  if (call.name) return call.name;
  // Older native Codex transcripts did not store the tool name. Its command
  // descriptions still identify reads, searches and terminal executions.
  if (provider === "codex") {
    if (call.kind === "execute") return "codex:commandExecution";
    if (call.kind === "read" && call.title.startsWith("Read ")) return "codex:commandExecution";
    if (call.kind === "search" && /^(?:Search|List)(?:\s|$)/.test(call.title)) return "codex:commandExecution";
  }
  return (
    LEGACY_TOOL_PREFIXES.find(([kind, prefix]) => kind === call.kind && call.title.startsWith(prefix))?.[2] ??
    call.title
  );
}

/**
 * Collect calls of the same tool in a thought. Other entries remain separate;
 * a new thought or incoming user/parent message starts a new group.
 */
export function groupToolCalls(entries: AgentEntry[], provider?: string): ConversationItem[] {
  const out: ConversationItem[] = [];
  let groups = new Map<string, Extract<ConversationItem, { type: "tools" }>>();
  entries.forEach((entry, index) => {
    if (entry.type !== "tool") {
      if (entry.type === "thought" || entry.type === "user" || (entry.type === "message" && entry.incoming)) {
        groups = new Map();
      }
      out.push({ type: "entry", index, entry });
      return;
    }
    const name = toolName(entry, provider);
    const identified = !!entry.name || name === "codex:commandExecution";
    // An unnamed call without a title cannot safely be identified as the same tool.
    const key = name
      ? identified
        ? `name:${name}${name === "codex:commandExecution" ? `:${entry.kind}` : ""}`
        : `legacy:${entry.kind}:${name}`
      : `id:${entry.id}`;
    let group = groups.get(key);
    if (!group) {
      group = { type: "tools", index, name, calls: [] };
      groups.set(key, group);
      out.push(group);
    }
    group.calls.push(entry);
  });
  return out;
}

const TOOL_LABELS: Record<string, string> = {
  "codex:commandExecution": "Terminal",
  "codex:fileChange": "File changes",
  "codex:webSearch": "Web search",
  "codex:imageView": "View image",
  "codex:contextCompaction": "Compact conversation",
  "codex:sleep": "Wait",
  "codex:imageGeneration": "Generate an image",
};

/** A readable label for the provider's stable tool identifier. */
export function toolGroupLabel(name: string, kind?: string): string {
  if (name === "codex:commandExecution") {
    if (kind === "read") return "Read";
    if (kind === "search") return "Search";
  }
  if (TOOL_LABELS[name]) return TOOL_LABELS[name];
  if (name.startsWith("mcp__")) return name.slice(5).replace("__", ": ");
  for (const prefix of ["codex:dynamicToolCall:", "codex:collabAgentToolCall:"]) {
    if (name.startsWith(prefix)) return name.slice(prefix.length);
  }
  if (name.startsWith("codex:")) return name.split(":").at(-1) || name;
  return name;
}

import type { SymbolKind } from "@/platform/ipc";
import { opensOtherShare } from "@/platform/paths";

/** Display a structured async answer as the question and answer, keeping its wire ids out of the UI. */
export function userMessageText(text: string): string {
  const start = "<send_user_message_question_reply>";
  const end = "</send_user_message_question_reply>";
  if (!text.startsWith(start) || !text.endsWith(end)) return text;
  try {
    const replies: unknown = JSON.parse(text.slice(start.length, -end.length));
    if (
      !Array.isArray(replies) ||
      !replies.length ||
      !replies.every(
        (reply) =>
          reply &&
          typeof reply.questionItemId === "string" &&
          typeof reply.question === "string" &&
          typeof reply.answer === "string",
      )
    )
      return text;
    return replies.map((reply) => `${reply.question}\n${reply.answer}`).join("\n\n");
  } catch {
    return text;
  }
}

/** `text` as a Markdown quote for the composer, followed by an empty line to type in. */
export function quoteText(text: string): string {
  const lines = text.replace(/\s+$/, "").split("\n");
  return `${lines.map((l) => (l ? `> ${l}` : ">")).join("\n")}\n\n`;
}

/** Appends a quote to a draft, on its own paragraph. */
export function withQuote(draft: string, text: string): string {
  if (!draft.trim()) return quoteText(text);
  return `${draft.replace(/\s+$/, "")}\n\n${quoteText(text)}`;
}

export interface PathLink {
  /** Absolute path. */
  path: string;
  /** 0-based line and column, when the text names them. */
  line?: number;
  col?: number;
}

/** Local file URLs can name files but must not name a remote host. */
export function localFileUriPath(href: string): string | null {
  try {
    const url = new URL(href);
    if (url.protocol !== "file:" || (url.hostname && url.hostname !== "localhost") || url.search) return null;
    const path = /^\/[a-z]:\//i.test(url.pathname) ? url.pathname.slice(1) : url.pathname;
    return path + url.hash;
  } catch {
    return null;
  }
}

/** Normalize a local path against the agent's working directory. */
function absolutePath(value: string, cwd: string): string {
  const windows = /^[a-z]:[\\/]/i.test(value) || /^[a-z]:[\\/]/i.test(cwd);
  const path = windows ? value.replace(/\\/g, "/") : value;
  const base = windows ? cwd.replace(/\\/g, "/") : cwd;
  const joined = path.startsWith("/") || /^[a-z]:\//i.test(path) ? path : base.replace(/\/+$/, "") + "/" + path;
  let prefix = joined.startsWith("/") ? "/" : (/^[a-z]:\//i.exec(joined)?.[0] ?? "");
  if (joined.startsWith("//")) prefix = "//";
  const parts: string[] = [];
  for (const part of joined.slice(prefix.length).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length && parts.at(-1) !== "..") parts.pop();
      else if (!prefix) parts.push(part);
    } else {
      parts.push(part);
    }
  }
  return prefix + parts.join("/");
}

function parseFilePath(value: string, cwd: string): PathLink | null {
  value = value.replace(/^\/(?=[a-z]:[\\/])/i, "");
  if (!value || value.startsWith("//") || [...value].some((c) => c.charCodeAt(0) < 32)) return null;
  if (!/^[a-z]:[\\/]/i.test(value) && /^[a-z][a-z\d+.-]*:/i.test(value)) return null;
  const match = /^(.*?)(?::(\d+)(?::(\d+))?|#L(\d+))?$/.exec(value);
  if (!match?.[1]) return null;
  const path = absolutePath(match[1], cwd);
  if (opensOtherShare(path, match[1], cwd)) return null;
  const link: PathLink = { path };
  const line = match[2] ?? match[4];
  if (line) link.line = Math.max(0, Number(line) - 1);
  if (match[3]) link.col = Math.max(0, Number(match[3]) - 1);
  return link;
}

/** Resolve a Markdown link to a local file, including local file URLs. */
export function fileHref(href: string, cwd: string): PathLink | null {
  if (!href || href.startsWith("#") || href.startsWith("//")) return null;
  let value = href;
  if (/^file:/i.test(value)) {
    const local = localFileUriPath(value);
    if (local === null) return null;
    value = local;
  }
  try {
    return parseFilePath(decodeURIComponent(value), cwd);
  } catch {
    return null;
  }
}

/** A code span naming a local file; file existence is checked separately. */
export function pathLink(text: string, cwd: string): PathLink | null {
  const value = text.trim();
  if (!value || value.length > 4096 || /[\r\n]/.test(value)) return null;
  if (/^file:/i.test(value)) return fileHref(value, cwd);
  if (
    value.startsWith("//") ||
    value.startsWith("~/") ||
    (!/^[a-z]:[\\/]/i.test(value) && /^[a-z][a-z\d+.-]*:/i.test(value))
  )
    return null;
  const path = value.replace(/(?::\d+(?::\d+)?|#L\d+)$/, "");
  const name = path.split(/[\\/]/).at(-1) ?? "";
  if (!name || name === "." || name === "..") return null;
  const extension = /\.[\p{L}][\p{L}\p{N}_-]{0,30}$/u.test(name);
  const dotfile = /^\.[\p{L}\p{N}_-]+$/u.test(name);
  if (!extension && !dotfile && !/[\\/]/.test(path)) return null;
  return parseFilePath(value, cwd);
}

export interface FilePathToken {
  from: number;
  to: number;
  link: PathLink;
}

// Bare paths are restricted to complete path-like tokens. Existing files are
// checked before they become links, so prose that resembles a filename stays text.
const PLAIN_PATH =
  /(^|[\s([{"'“‘：])((?:(?:file:\/\/(?:localhost)?\/|[A-Za-z]:[\\/]|\/|\.\.?\/|[\p{L}\p{N}_.@-]+\/)[\p{L}\p{N}\p{M}_@.%+/\\-]+|[\p{L}\p{N}\p{M}_@-][\p{L}\p{N}\p{M}_@.-]*\.[\p{L}][\p{L}\p{N}_-]*)(?::\d+(?::\d+)?|#L\d+)?)/gmu;
const QUOTED_PATH = /(["'])([^"'\r\n]+)\1/gu;
const LINE_PATH =
  /(?:^|\n)[ \t]*((?:[A-Za-z]:[\\/]|\/|\.\.?\/|[\p{L}\p{N}_.@-]+\/)[^\r\n"'<>]*?\.[\p{L}][\p{L}\p{N}_-]*(?::\d+(?::\d+)?|#L\d+)?)[.,;!?。，；！？]?[ \t]*(?=$|\n)/gu;

/** Paths in prose, with offsets so their visible text can become clickable. */
export function filePathTokens(text: string, cwd: string): FilePathToken[] {
  const candidates: FilePathToken[] = [];
  const add = (value: string, from: number) => {
    const trimmed = value.replace(/[.,;!?。，；！？）)\]}]+$/u, "");
    const link = pathLink(trimmed, cwd);
    if (link) candidates.push({ from, to: from + trimmed.length, link });
  };
  for (const match of text.matchAll(LINE_PATH)) add(match[1]!, match.index + match[0].indexOf(match[1]!));
  for (const match of text.matchAll(QUOTED_PATH)) add(match[2]!, match.index + 1);
  for (const match of text.matchAll(PLAIN_PATH)) add(match[2]!, match.index + match[1]!.length);
  candidates.sort((a, b) => a.from - b.from || b.to - a.to);
  const out: FilePathToken[] = [];
  for (const candidate of candidates) {
    if (out.length && candidate.from < out.at(-1)!.to) continue;
    out.push(candidate);
    if (out.length === 128) break;
  }
  return out;
}

/** A symbol an inline code span names: `name`, inside `container` or `file` when the text says so. */
export interface SymbolRef {
  name: string;
  container?: string;
  /** The tail of the defining file's path (`lib.rs`, `src/a.ts`). */
  file?: string;
  kinds: readonly SymbolKind[];
}

const IDENT = "[A-Za-z_$][\\w$]*";
const CALL = "(\\([^()]*\\))?";
const SYMBOL = new RegExp(`^(?:(${IDENT})(?:\\.|#|::))?(${IDENT})${CALL}$`);
const FILE_SYMBOL = new RegExp(`^((?:[\\w.@-]+\\/)*[\\w@-]+\\.[A-Za-z]\\w*)(?:#|::)(${IDENT})${CALL}$`);
const TYPE_KINDS: readonly SymbolKind[] = ["class", "interface", "struct", "enum", "trait", "typeAlias", "function"];
const CALLABLE_KINDS: readonly SymbolKind[] = ["function", "method", "constructor"];
const MEMBER_KINDS: readonly SymbolKind[] = [...CALLABLE_KINDS, "field", "property", "constant", "enumMember"];
const ANY_KINDS: readonly SymbolKind[] = [...new Set<SymbolKind>([...TYPE_KINDS, ...MEMBER_KINDS, "variable"])];
/** Capitalized keywords and literals that read like a type name. */
const LITERALS = new Set(["None", "True", "False", "Self", "Some", "Ok", "Err", "Null", "Nil", "NaN", "Infinity"]);

/**
 * The symbol inline code names (`FooView`, `load()`, `has_header`, `Config.load`,
 * `lib.rs::has_header`, `a.ts#load`); null for words, keywords, literals and anything
 * with spaces or shell syntax (`cargo test`, `true`, `None`, `x = 1`).
 */
export function symbolRef(text: string): SymbolRef | null {
  const trimmed = text.trim();
  const inFile = FILE_SYMBOL.exec(trimmed);
  if (inFile) return { name: inFile[2]!, file: inFile[1]!, kinds: ANY_KINDS };
  const match = SYMBOL.exec(trimmed);
  if (!match) return null;
  const [, container, name, call] = match;
  if (LITERALS.has(container ?? name!)) return null;
  if (container) return { name: name!, container, kinds: MEMBER_KINDS };
  if (call) return { name: name!, kinds: CALLABLE_KINDS };
  if (/^[A-Z]\w*[a-z]/.test(name!)) return { name: name!, kinds: TYPE_KINDS };
  if (/^[a-z]\w*[a-z\d][A-Z]/.test(name!) || /^[a-z][a-z\d]*(?:_[a-z\d]+)+$/.test(name!)) {
    return { name: name!, kinds: CALLABLE_KINDS };
  }
  return null;
}

/** `850ms`, `12s`, `1m 05s`, `2h 03m`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Clock time of a message: `14:03` today, else with the date. */
export function formatSentAt(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return new Date(now).toDateString() === d.toDateString()
    ? time
    : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}

/** Start offsets of `query` in `text`, ignoring case; empty for an empty query. */
export function findAll(text: string, query: string): number[] {
  if (!query) return [];
  const hay = text.toLowerCase();
  const needle = query.toLowerCase();
  const out: number[] = [];
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) out.push(i);
  return out;
}

const SKIP_FIND_TAGS = new Set(["STYLE", "SCRIPT", "NOSCRIPT", "SVG", "BUTTON"]);

function isUnselectable(el: Element): boolean {
  const style = getComputedStyle(el);
  return style.userSelect === "none" || style.webkitUserSelect === "none";
}

/**
 * DOM ranges of `query` in the selectable text under `root` (matches within one text node).
 * Skips `user-select: none` chrome (`.thought summary`, `.processSummary`, `.messageTime`,
 * `.role`…): WebKit's `CSS.highlights` skips unselectable text renderers and paints the
 * highlight over the next selectable text node instead.
 */
export function findRanges(root: Node, query: string): Range[] {
  const out: Range[] = [];
  if (!query) return out;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as Element;
        const tag = el.tagName.toUpperCase();
        if (SKIP_FIND_TAGS.has(tag)) return NodeFilter.FILTER_REJECT;
        if (tag === "PRE" && el.parentElement?.getAttribute("data-mermaid-state") === "ok")
          return NodeFilter.FILTER_REJECT;
        if (isUnselectable(el)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_SKIP;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    for (const at of findAll(node.textContent ?? "", query)) {
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + query.length);
      out.push(range);
    }
  }
  return out;
}

/**
 * True when `range` is rendered on screen and not inside a collapsed `<details>` or
 * `user-select: none` subtree. WebKit hides closed `<details>` bodies with
 * `content-visibility: hidden` (where `getClientRects()` stays non-empty once opened)
 * and forwards unrendered or unselectable `CSS.highlights` ranges onto adjacent rows.
 */
export function isFindRangeShown(range: Range, root: Node): boolean {
  for (let el = range.startContainer.parentElement; el && el !== root; el = el.parentElement) {
    if (isUnselectable(el)) return false;
    if (el instanceof HTMLDetailsElement && !el.open) {
      const summary = el.querySelector(":scope > summary");
      if (!summary?.contains(range.startContainer)) return false;
    }
  }
  return range.getClientRects().length > 0;
}
