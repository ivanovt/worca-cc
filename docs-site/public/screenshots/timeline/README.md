# Timeline view screenshots

Screenshots referenced by `docs-site/src/content/docs/running-pipelines/timeline-view.md`. Drop the PNGs in this directory; the docs page links them with absolute `/screenshots/timeline/<name>.png` paths.

Use the demo mock run (`20260603-160000-001-beadmock` on the worca-cc-master project) for consistent framing — it has the right shape: a successful run with one Implement-loopback after Test iter 1 failed, plus three distinct beads across the four Implement iterations.

## Required files

| Filename | Section in docs | Suggested framing |
|---|---|---|
| `01-timeline-button.png` | "Opening the timeline" | Run-detail page, scrolled so the **pipeline timing bar** is centered. Hover or focus the **Timeline** button so its hover state is visible (callout arrow optional). |
| `02-overview.png` | "What you're looking at" | The whole timeline at fit-to-run zoom. All seven stages visible. Include the one loopback arrow between Test iter 1 and Implement iter 2. |
| `03-tooltip-bead.png` | "Hover for the iteration's vital stats" | Hover state on **Implement iteration 2** (the loopback retry). The tooltip should show the bead sub-header `bd-auth-001  Add JWT token issuer with HS256 signing` plus Duration / Started / Ended / Model / Status / Cost rows. |
| `04-drawer-bead.png` | "Click for the full drawer" | Drawer open on **Implement iteration 3** (different bead so the screenshot isn't a duplicate of #03). Status pill + Duration / Cost / Model / Agent / **Bead** / Effort rows visible. Raw JSON details collapsed. |
| `05-zoom-toolbar.png` | "Zooming and panning" | Timeline zoomed in roughly 4× so bar labels are readable inline. Top-right corner of the chart should clearly show the `−` / `⟲` / `+` toolbar; the axis at the bottom should show its denser tick interval. |

## Conventions

- **Format**: PNG, 2× pixel density when feasible (Retina-quality).
- **Width**: target the docs-site reading column width — somewhere around 1200–1600 px works well.
- **Background**: capture in light mode first; dark-mode variants can land later under `<name>-dark.png` and be wired with a Starlight light/dark image swap if we add one.
- **PII**: the mock run is intentionally synthetic. If you capture a real run, redact bead titles that name internal customers or unreleased features.
