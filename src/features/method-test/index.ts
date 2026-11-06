import { activeEditor, registerEditorContribution } from "@/editor/api";
import { registerActions } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { projectLocation, useRemote } from "@/platform/remote";
import { lazyComponent } from "@/ui";
import { notifications, registerMenuGroup, registerToolWindow } from "@/workbench/contributions";
import { methodTestExtension } from "./editor";
import { javaMethods, type MethodTarget } from "./model";
import { METHOD_TEST_WINDOW, observeMethodRuns, openMethod, openProject } from "./store";

function atCaret() {
  const editor = activeEditor();
  if (!editor || editor.ctx.language !== "java") return null;
  const offset = editor.view.state.selection.main.head;
  return (
    javaMethods(editor.ctx.path, editor.view.state.doc.toString()).find(
      (method) => offset >= method.from && offset <= method.to,
    ) ?? null
  );
}
export function activate() {
  const synchronize = () => {
    const root = useProject.getState().project?.root ?? null;
    openProject(root, projectLocation(root));
  };
  synchronize();
  const disposers = [
    registerToolWindow({
      id: METHOD_TEST_WINDOW,
      title: "Method Test",
      icon: "toolwindow-method-test",
      anchor: "right",
      order: 20,
      component: lazyComponent(() => import("./MethodTestView").then((module) => module.MethodTestView)),
    }),
    registerEditorContribution({ id: "methodTest.gutter", order: 58, extensions: methodTestExtension }),
    registerActions([
      {
        id: "methodTest.open",
        title: "Test Java Method",
        icon: "toolwindow-method-test",
        when: "projectOpen",
        run: ({ arg }) => {
          const target = arg as MethodTarget | undefined;
          if (target?.path && target.methodName && Array.isArray(target.parameters)) openMethod(target);
        },
      },
      {
        id: "methodTest.atCaret",
        title: "Test Java Method",
        category: "Run",
        icon: "toolwindow-method-test",
        when: "editorLangId == java",
        run: () => {
          const method = atCaret();
          if (method) openMethod(method);
          else
            notifications().notify({
              level: "info",
              title: "Choose a public Java method",
              body: "Place the caret inside a method, or click its gutter icon.",
            });
        },
      },
    ]),
    registerMenuGroup({
      id: "methodTest.editor",
      menus: ["editor"],
      order: 41,
      items: () => {
        const method = atCaret();
        return method
          ? [
              {
                id: "methodTest",
                label: "Test Java Method",
                icon: "toolwindow-method-test",
                run: () => openMethod(method),
              },
            ]
          : [];
      },
    }),
    observeMethodRuns(),
    useProject.subscribe((state, previous) => {
      if (state.project?.root !== previous.project?.root) synchronize();
    }),
    useRemote.subscribe((state, previous) => {
      if (state.session !== previous.session) synchronize();
    }),
  ];
  return () => {
    disposers.reverse().forEach((dispose) => dispose());
    openProject(null);
  };
}
