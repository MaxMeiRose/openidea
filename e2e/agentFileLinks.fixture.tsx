import { createRoot } from "react-dom/client";
import { emitLocalIdeEvent } from "@/platform/ipc";
import { setInvokeRoute } from "@/platform/tauriCore";
import { provideEditorService, type EditorService } from "@/workbench/contributions";
import { Markdown } from "@/features/agents/Markdown";

const existing = new Set(["/tmp/报告 01.pdf", "/repo/reports/总结.md", "/tmp/report one.pdf"]);
const opened: Array<{ path: string; options: unknown }> = [];
const probes: string[] = [];
Object.assign(window, { agentFileFixture: { opened, probes } });
setInvokeRoute((cmd, args) => {
  if (cmd !== "fs_probe") return null;
  const path = (args as { path: string }).path;
  probes.push(path);
  return existing.has(path)
    ? Promise.resolve({ size: 0, binary: false, tooLarge: false })
    : Promise.reject({ kind: "notFound", message: "missing", data: null });
});
provideEditorService({
  openFile: async (path, options) => {
    opened.push({ path, options });
  },
  openInput: async () => {},
  activePath: () => null,
  activeCursor: () => null,
  saveAll: async () => {},
} satisfies EditorService);

const message = [
  "/tmp/报告 01.pdf",
  "",
  "项目文件：reports/总结.md:4:2",
  "",
  "`generated/new report.md`",
  "",
  "[本地链接](file:///tmp/report%20one.pdf)",
].join("\n");

function Fixture() {
  return (
    <>
      <Markdown text={message} cwd="/repo" />
      <button
        onClick={() => {
          const path = "/repo/generated/new report.md";
          existing.add(path);
          emitLocalIdeEvent({ type: "fsChanged", created: [path], modified: [], removed: [] });
        }}
      >
        Create generated file
      </button>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
