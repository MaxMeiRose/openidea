/** A CodeGlance-style minimap in the editor's right gutter. */
import { EditorView } from "@codemirror/view";
import { showMinimap } from "@replit/codemirror-minimap";

const minimapTheme = EditorView.theme({
  ".cm-openidea-minimap": {
    backgroundColor: "var(--bg-editor, var(--bg-island, var(--bg-app)))",
    borderLeft: "1px solid var(--border)",
    cursor: "pointer",
  },
});

export const minimap = [
  showMinimap.of({
    create: () => {
      const dom = document.createElement("div");
      dom.className = "cm-openidea-minimap";
      dom.setAttribute("aria-label", "Code minimap");
      return { dom };
    },
    displayText: "characters",
    showOverlay: "always",
  }),
  minimapTheme,
];
