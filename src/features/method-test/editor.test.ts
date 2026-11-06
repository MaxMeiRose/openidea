import { afterEach, expect, it } from "vitest";
import { waitFor } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { registerActions } from "@/platform/actions";
import { methodTestExtension } from "./editor";
import type { MethodTarget } from "./model";
const views: EditorView[] = [];
afterEach(() => views.splice(0).forEach((view) => view.destroy()));
it("opens a Service method from its gutter without selecting code and removes stale markers", async () => {
  const opened: MethodTarget[] = [];
  const dispose = registerActions([
    {
      id: "methodTest.open",
      title: "Test Java Method",
      run: ({ arg }) => {
        opened.push(arg as MethodTarget);
      },
    },
  ]);
  const source = "@Service public class UserService { public String find(int id) { return null; } }";
  const view = new EditorView({
    state: EditorState.create({
      doc: source,
      extensions: [
        methodTestExtension({
          path: "/project/UserService.java",
          doc: 1,
          language: "java",
          uiMode: null,
          readOnly: false,
        }),
      ],
    }),
    parent: document.body,
  });
  views.push(view);
  const button = () => view.dom.querySelector<HTMLButtonElement>(".cm-openidea-gutter-method-test button");
  try {
    await waitFor(() => expect(button()).not.toBeNull());
    const mouse = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    button()!.dispatchEvent(mouse);
    expect(mouse.defaultPrevented).toBe(true);
    button()!.click();
    expect(opened).toMatchObject([{ className: "UserService", methodName: "find", parameterTypes: ["int"] }]);
    expect(view.state.selection.main.empty).toBe(true);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "class Replacement {}" } });
    expect(button()).toBeNull();
  } finally {
    dispose();
  }
});
it("adds no method-test gutter to virtual or non-Java editors", () => {
  const ctx = { path: "/project/Service.java", doc: 1, language: "java", uiMode: null, readOnly: false };
  expect(methodTestExtension({ ...ctx, virtual: true })).toEqual([]);
  expect(methodTestExtension({ ...ctx, language: "kotlin" })).toEqual([]);
});
