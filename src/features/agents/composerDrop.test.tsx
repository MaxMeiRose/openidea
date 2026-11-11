import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { DragDropEvent } from "@tauri-apps/api/webview";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { FILES_DRAG, dragSession, registerDropTarget } from "@/ui";
import { usePlatform } from "@/platform/platformInfo";
import { useProject } from "@/platform/project";
import * as tauriCore from "@/platform/tauriCore";
import { Composer } from "./Composer";
import styles from "./Composer.module.css";
import { composerDraft, updateComposer, useAgents } from "./store";

const native = vi.hoisted(() => ({ listen: vi.fn() }));
vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  isTauri: () => true,
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: native.listen }),
}));

const originalHitTest = document.elementFromPoint;
let onNativeDrop: (event: { payload: DragDropEvent }) => void;

beforeEach(() => {
  useAgents.setState({ composers: new Map() });
  usePlatform.setState({ os: "macos" });
  useProject.setState({ settings: null });
  native.listen.mockReset().mockImplementation((listener) => {
    onNativeDrop = listener;
    return Promise.resolve(() => {});
  });
});

afterEach(() => {
  document.elementFromPoint = originalHitTest;
  vi.restoreAllMocks();
});

function setup(root = "/project", projectRoot = "/project") {
  const view = render(
    <div data-testid="editor">
      <Composer
        id="drop-test"
        root={root}
        projectRoot={projectRoot}
        placeholder="Message"
        commands={[]}
        history={[]}
        config={[]}
        onSubmit={() => {}}
      />
    </div>,
  );
  const input = screen.getByRole("textbox") as HTMLTextAreaElement;
  document.elementFromPoint = () => input;
  return {
    ...view,
    input,
    box: input.closest<HTMLElement>(`.${styles.composer}`)!,
    editor: screen.getByTestId("editor"),
  };
}

describe("Composer file drops", () => {
  it("takes Project view files before the surrounding editor, preserving the draft", async () => {
    const { input, editor, box } = setup();
    const openInEditor = vi.fn();
    const unregister = registerDropTarget(editor, {
      accepts: (type) => type === FILES_DRAG,
      over: () => {},
      leave: () => {},
      drop: openInEditor,
    });
    act(() => updateComposer("drop-test", { text: "Review this" }));
    const drag = dragSession({ type: FILES_DRAG, payload: "/project/src/main.ts\n/project/README.md" });
    try {
      act(() => {
        expect(drag.move(20, 20)).toBe(true);
      });
      expect(box.className).toMatch(/dropOver/);
      act(() => {
        expect(drag.drop(20, 20)).toBe(true);
      });
      expect(input).toHaveValue("Review this @src/main.ts @README.md ");
      expect(composerDraft("drop-test").files).toEqual([
        { path: "/project/src/main.ts", rel: "src/main.ts" },
        { path: "/project/README.md", rel: "README.md" },
      ]);
      expect(openInEditor).not.toHaveBeenCalled();
      expect(box.className).not.toMatch(/dropOver/);
      await waitFor(() => expect(input).toHaveFocus());
    } finally {
      unregister();
    }
  });

  it("cancels hover without adding a file", () => {
    const { box } = setup();
    const drag = dragSession({ type: FILES_DRAG, payload: "/project/README.md" });
    act(() => {
      drag.move(20, 20);
      drag.cancel();
    });
    expect(box.className).not.toMatch(/dropOver/);
    expect(composerDraft("drop-test").files).toEqual([]);
  });

  it("maps dropped project files into the task worktree and keeps other paths intact", () => {
    const { input } = setup("/worktrees/project", "/project");
    const drag = dragSession({ type: FILES_DRAG, payload: "/project/src/main.ts\n/other/notes.md" });
    act(() => {
      drag.move(20, 20);
      expect(drag.drop(20, 20)).toBe(true);
    });
    expect(input).toHaveValue("@src/main.ts @/other/notes.md ");
    expect(composerDraft("drop-test").files).toEqual([
      { path: "/worktrees/project/src/main.ts", rel: "src/main.ts" },
      { path: "/other/notes.md", rel: "/other/notes.md" },
    ]);
  });

  it("keeps project-tree images as file references and ignores virtual documents", () => {
    const { input } = setup();
    const drag = dragSession({ type: FILES_DRAG, payload: "/project/design.png\njdt://contents/Example.class" });
    act(() => {
      drag.move(20, 20);
      expect(drag.drop(20, 20)).toBe(true);
    });
    expect(input).toHaveValue("@design.png ");
    expect(composerDraft("drop-test").files).toEqual([{ path: "/project/design.png", rel: "design.png" }]);
    expect(composerDraft("drop-test").images).toEqual([]);
  });

  it("continues attaching images dropped from the operating system", async () => {
    const readImage = vi.spyOn(tauriCore, "invokeLocal").mockResolvedValue("data:image/png;base64,cG5n");
    const { box, input } = setup();
    vi.spyOn(box, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 10, 200, 100));
    await waitFor(() => expect(native.listen).toHaveBeenCalled());
    act(() =>
      onNativeDrop({
        payload: { type: "drop", paths: ["/project/design.png"], position: new PhysicalPosition(30, 20) },
      }),
    );
    await waitFor(() =>
      expect(composerDraft("drop-test").images).toEqual([{ mimeType: "image/png", data: "cG5n", name: "design.png" }]),
    );
    expect(readImage).toHaveBeenCalledWith("fs_read_image", { path: "/project/design.png" });
    expect(input).toHaveValue("");
    expect(composerDraft("drop-test").files).toEqual([]);
  });

  it("still accepts native file drops only within the prompt", async () => {
    const { box, input } = setup();
    vi.spyOn(box, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 10, 200, 100));
    await waitFor(() => expect(native.listen).toHaveBeenCalled());
    act(() =>
      onNativeDrop({
        payload: { type: "drop", paths: ["/project/outside.ts"], position: new PhysicalPosition(300, 20) },
      }),
    );
    expect(input).toHaveValue("");
    act(() =>
      onNativeDrop({
        payload: { type: "drop", paths: ["/project/inside.ts"], position: new PhysicalPosition(30, 20) },
      }),
    );
    expect(input).toHaveValue("@inside.ts ");
    expect(composerDraft("drop-test").files).toEqual([{ path: "/project/inside.ts", rel: "inside.ts" }]);
  });
});
