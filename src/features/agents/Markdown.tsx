/**
 * Agent messages: Markdown → sanitized HTML (marked + DOMPurify). Fenced code is
 * highlighted and gets a Copy button; inline code naming a file of the task opens it.
 */
import { useLayoutEffect, useMemo, useRef } from "react";
import { Marked } from "marked";
import DOMPurify from "dompurify";
import { highlightInto } from "@/editor/lsp/markdown";
import { iconNode } from "@/editor/lsp/iconMarkup";
import { call, commands, onIdeEvent } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { openExternalUrl } from "@/platform/openUrl";
import { copyText } from "@/ui";
import { editorService } from "@/workbench/contributions";
import { fileHref, filePathTokens, localFileUriPath, pathLink, type PathLink } from "./conversation";
import styles from "./Session.module.css";

const marked = new Marked({ gfm: true, breaks: true });

export function markdownHtml(text: string): string {
  const html = marked.parse(text, { async: false }) as string;
  // DOMPurify removes file: URLs by default. Convert only local file links to
  // paths before sanitizing; every other protocol keeps the usual rules.
  const template = document.createElement("template");
  template.innerHTML = html;
  template.content.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((a) => {
    const href = a.getAttribute("href") ?? "";
    if (!/^file:/i.test(href)) return;
    const path = localFileUriPath(href);
    if (path === null) a.removeAttribute("href");
    else a.setAttribute("href", path);
  });
  const root = DOMPurify.sanitize(template.innerHTML, {
    USE_PROFILES: { html: true },
    RETURN_DOM: true,
  }) as HTMLElement;
  root.querySelectorAll("li").forEach(wrapLooseText);
  return root.innerHTML;
}

const BLOCK = new Set(["UL", "OL", "P", "PRE", "BLOCKQUOTE", "TABLE", "HR", "DIV", "H1", "H2", "H3", "H4", "H5", "H6"]);

/**
 * Puts the text of an item that also holds a nested list (or other blocks) in its own
 * block. Otherwise WebKit paints a stray sliver of selection from the end of that text
 * to the right edge when a selection ends there.
 */
function wrapLooseText(li: Element) {
  const nodes = [...li.childNodes];
  if (!nodes.some((n) => BLOCK.has(n.nodeName))) return;
  let run: ChildNode[] = [];
  const flush = () => {
    if (run.some((n) => n.nodeType !== Node.TEXT_NODE || n.textContent!.trim())) {
      const div = li.ownerDocument.createElement("div");
      run[0]!.before(div);
      div.append(...run);
    }
    run = [];
  };
  for (const n of nodes) {
    if (BLOCK.has(n.nodeName)) flush();
    else run.push(n);
  }
  flush();
}

/** Existing files are cached; a missing file is retried if it is created later. */
const existing = new Map<string, Promise<boolean>>();
const MAX_CACHED_FILES = 512;
function fileExists(path: string): Promise<boolean> {
  let known = existing.get(path);
  if (!known) {
    known = Promise.resolve()
      .then(() => call(commands.fsProbe(path)))
      .then(
        () => true,
        () => false,
      );
    if (existing.size >= MAX_CACHED_FILES) existing.delete(existing.keys().next().value!);
    existing.set(path, known);
    const pending = known;
    void pending.then((found) => {
      if (!found && existing.get(path) === pending) existing.delete(path);
    });
  }
  return known;
}

export function openPathLink(link: PathLink) {
  const selection = link.line === undefined ? undefined : { line: link.line, col: link.col ?? 0 };
  void editorService().openFile(link.path, { selection, focus: true });
}

/** Highlighting, Copy buttons and file links over freshly rendered `root`. */
function enhance(root: HTMLElement, cwd: string): () => void {
  let alive = true;
  type Candidate = { el: HTMLElement; link: PathLink; revision: number; timer?: ReturnType<typeof setTimeout> };
  const candidates = new Map<string, Candidate[]>();
  const update = (candidate: Candidate) => {
    const revision = ++candidate.revision;
    clearTimeout(candidate.timer);
    // While a response streams, wait briefly so partial paths do not each probe the disk.
    candidate.timer = setTimeout(() => {
      void fileExists(candidate.link.path).then((found) => {
        if (!alive || revision !== candidate.revision || !root.contains(candidate.el)) return;
        const el = candidate.el;
        el.classList.toggle(styles.fileLink!, found);
        if (found) {
          el.dataset.agentPath = candidate.link.path;
          if (candidate.link.line !== undefined) el.dataset.line = String(candidate.link.line);
          if (candidate.link.col !== undefined) el.dataset.col = String(candidate.link.col);
          el.setAttribute("role", "link");
          el.tabIndex = 0;
          el.title = candidate.link.path;
        } else {
          delete el.dataset.agentPath;
          delete el.dataset.line;
          delete el.dataset.col;
          el.removeAttribute("role");
          el.removeAttribute("tabindex");
          el.removeAttribute("title");
        }
      });
    }, 80);
  };
  const register = (el: HTMLElement, link: PathLink) => {
    const candidate = { el, link, revision: 0 };
    const list = candidates.get(link.path) ?? [];
    list.push(candidate);
    candidates.set(link.path, list);
    update(candidate);
  };
  root.querySelectorAll<HTMLElement>("pre > code").forEach((code) => {
    const pre = code.parentElement!;
    const lang = [...code.classList].find((c) => c.startsWith("language-"))?.slice("language-".length) ?? null;
    const text = (code.textContent ?? "").replace(/\n+$/, "");
    code.textContent = text;
    void highlightInto(code, text, lang);
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = styles.codeCopy!;
    const label = tx("Copy Code");
    copy.title = label;
    copy.setAttribute("aria-label", label);
    copy.appendChild(iconNode("copy", 14));
    copy.dataset.copy = text;
    pre.appendChild(copy);
    if (!text.includes("\n")) {
      const link = pathLink(text, cwd);
      if (link) register(code, link);
    }
  });
  root.querySelectorAll<HTMLElement>("code").forEach((code) => {
    if (code.parentElement?.tagName === "PRE" || code.closest("a")) return;
    const link = pathLink(code.textContent ?? "", cwd);
    if (link) register(code, link);
  });
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!node.parentElement?.closest("a, code, pre, button")) nodes.push(node);
  }
  let remaining = 128;
  for (const node of nodes) {
    if (!remaining) break;
    const tokens = filePathTokens(node.data, cwd).slice(0, remaining);
    if (!tokens.length) continue;
    const fragment = document.createDocumentFragment();
    let at = 0;
    for (const token of tokens) {
      fragment.append(document.createTextNode(node.data.slice(at, token.from)));
      const span = document.createElement("span");
      span.textContent = node.data.slice(token.from, token.to);
      register(span, token.link);
      fragment.append(span);
      at = token.to;
    }
    fragment.append(document.createTextNode(node.data.slice(at)));
    node.replaceWith(fragment);
    remaining -= tokens.length;
  }
  const off = candidates.size
    ? onIdeEvent("fsChanged", (event) => {
        const changed = [...event.created, ...event.modified, ...event.removed];
        for (const [path, list] of candidates) {
          if (!changed.some((item) => path === item || path.startsWith(item + "/"))) continue;
          existing.delete(path);
          list.forEach(update);
        }
      })
    : undefined;
  return () => {
    alive = false;
    off?.();
    for (const [path, list] of candidates) {
      existing.delete(path);
      for (const candidate of list) clearTimeout(candidate.timer);
    }
  };
}

function openFileElement(file: HTMLElement) {
  const line = file.dataset.line === undefined ? undefined : Number(file.dataset.line);
  const col = file.dataset.col === undefined ? undefined : Number(file.dataset.col);
  openPathLink({ path: file.dataset.agentPath!, line, col });
}

export function Markdown({ text, cwd }: { text: string; cwd: string }) {
  const html = useMemo(() => markdownHtml(text), [text]);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => (ref.current ? enhance(ref.current, cwd) : undefined), [html, cwd]);
  return (
    <div
      ref={ref}
      className={styles.markdown}
      onClick={(e) => {
        const target = e.target as HTMLElement;
        const copy = target.closest<HTMLElement>("button[data-copy]");
        if (copy) {
          void copyText(copy.dataset.copy ?? "");
          return;
        }
        const file = target.closest<HTMLElement>("[data-agent-path]");
        if (file) {
          if (!window.getSelection()?.toString()) openFileElement(file);
          return;
        }
        const a = target.closest("a");
        if (!a) return;
        e.preventDefault();
        const href = a.getAttribute("href") ?? "";
        if (/^https?:/i.test(href)) void openExternalUrl(href);
        else {
          const link = fileHref(href, cwd);
          if (link) openPathLink(link);
        }
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        const file = (e.target as HTMLElement).closest<HTMLElement>("[data-agent-path]");
        if (!file) return;
        e.preventDefault();
        openFileElement(file);
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
