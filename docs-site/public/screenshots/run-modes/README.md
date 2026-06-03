# Run-mode screenshots

Screenshots referenced by `docs-site/src/content/docs/introduction/choosing-a-run-mode.md`. Drop the PNGs in this directory; the docs page links them with absolute `/screenshots/run-modes/<name>.png` paths.

## Required files

| Filename | Section in docs | Suggested framing |
|---|---|---|
| `01-split-button.png` | Bottom of the page | Sidebar in its expanded (uncollapsed) state. The **Run Pipeline** split-button is visible, with its chevron dropdown open to reveal **Run Fleet** and **Run Workspace**. Crop tight to the sidebar plus a sliver of the main content so the reader knows where the control lives. |

## Conventions

- **Format**: PNG.
- **Width**: target the docs-site reading column width (~700–800 px works for sidebar-focused shots; full-window shots can go to 1200–1600 px).
- **Background**: light mode. Dark-mode variants can land later under `<name>-dark.png`.
- **State hygiene**: dismiss the notification permission banner and hide the help-mode "Docs" edge tab before capturing — they're transient overlays that distract from the feature being illustrated.
