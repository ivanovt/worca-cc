# worca docs site

User documentation for worca, published at **https://docs.worca.dev**.

Built with [Starlight](https://starlight.astro.build) (Astro) and deployed on
**Cloudflare Workers Static Assets** via **Workers Builds** (Git-connected CI).
This app is self-contained — it has its own `package.json`/lockfile and does not
interact with the Python package or `worca-ui`.

## Local development

```bash
cd docs-site
npm install
npm run dev        # local dev server at http://localhost:4321
npm run build      # static build to ./dist
npm run preview    # serve ./dist locally before deploying
```

## Content

Pages live in `src/content/docs/` as `.md`/`.mdx`. The sidebar and site config
are in `astro.config.mjs`; brand theming is in `src/styles/worca.css`. Pages not
yet ready for the public site should set `draft: true` in their frontmatter —
they render in `npm run dev` but are excluded from production builds.

## Deploy model

Two Cloudflare Workers, both built from this `docs-site/` directory via Workers
Builds and both defined by `wrangler.jsonc`:

| Worker | Tracks branch | Domain | Deploy command |
|---|---|---|---|
| `worca-docs` | `docs-live` | https://docs.worca.dev | `npx wrangler deploy` |
| `worca-docs-staging` | `master` | https://staging.docs.worca.dev | `npx wrangler deploy -e staging` |

- **`docs.worca.dev` (production)** tracks `docs-live`. Nothing publishes there
  until `docs-live` is updated.
- **`staging.docs.worca.dev`** tracks `master` — every commit to `master`
  redeploys it. This is where you preview docs before promoting.
- **Promotion** = fast-forward `docs-live` to the commit you want live:
  `git push origin master:docs-live`. Wired into `/worca-release` so the
  published docs match each release.

`wrangler.jsonc` is account-agnostic — no `account_id`, no secrets. The top-level
config is the production Worker (`worca-docs`); `env.staging` is the staging
Worker (`worca-docs-staging`). Workers Builds resolves the account from the
connected repo.

## Analytics

Cloudflare Web Analytics, **production only**. The beacon is injected at build
time only when `PUBLIC_CF_BEACON_TOKEN` is set — a build variable on the
`worca-docs` Worker. Staging deliberately omits it, so `staging.docs.worca.dev`
carries no beacon and self/staging traffic stays out of the docs metrics. Local
builds also carry no analytics (the var is unset).

## One-time Cloudflare setup (dashboard)

Connecting a repo to Workers Builds is an OAuth step that can only be done in the
dashboard. Both Workers import the same repo (`SinishaDjukic/worca-cc`) with root
directory (Path) `docs-site` and build variable `NODE_VERSION = 22`.

**Production Worker — `worca-docs`:**
1. *Workers & Pages → Create → Workers → Import a repository* → `worca-cc`.
2. Build command `npm run build`; deploy command `npx wrangler deploy`.
3. *Settings → Build → Branch control* → production branch `docs-live`.
4. *Analytics & Logs → Web Analytics → Add a site* for `docs.worca.dev` in
   manual/JS-snippet mode → copy the token → add build variable
   `PUBLIC_CF_BEACON_TOKEN = <token>`.
5. *Settings → Domains & Routes → Add* → `docs.worca.dev`.

**Staging Worker — `worca-docs-staging`:**
1. Same import; project name `worca-docs-staging`.
2. Build command `npm run build`; deploy command `npx wrangler deploy -e staging`.
3. Branch control → production branch `master`; **uncheck** "Builds for
   non-production branches".
4. No analytics variable.
5. *Domains & Routes → Add* → `staging.docs.worca.dev`.

On the production Worker, "Builds for non-production branches" can be left off —
`master` is already covered by the staging Worker (enable it only if you want
per-PR preview URLs).

After this: pushes to `docs-live` publish to `docs.worca.dev`; pushes to `master`
publish to `staging.docs.worca.dev`.
