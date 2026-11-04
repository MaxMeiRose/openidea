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
      // The minimap handles the press on its overlay first. Prevent the browser
      // from starting a text selection when that drag crosses into the editor.
      dom.addEventListener("mousedown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
      });
      return { dom };
    },
    displayText: "characters",
    showOverlay: "always",
  }),
  minimapTheme,
];
