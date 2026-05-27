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
are in `astro.config.mjs`; brand theming is in `src/styles/worca.css`.

## Deploy model

- **Build & deploy** are driven by **Workers Builds** — Cloudflare watches this
  repo, runs `npm run build`, then `npx wrangler deploy` (serving `./dist` as an
  assets-only Worker per `wrangler.jsonc`).
- **Production branch is `docs-live`**, not `master`. Pushing to `master` and
  opening PRs produces **preview** deployments only; nothing reaches the public
  domain until `docs-live` is updated.
- **Promotion** = fast-forward `docs-live` to the commit you want live. This is
  wired into the `/worca-release` ritual so the published docs always match the
  released product.

`wrangler.jsonc` is intentionally **account-agnostic** — no `account_id`, no
secrets. Workers Builds resolves the account from the connected repo.

## Analytics

Cloudflare Web Analytics is injected only when `PUBLIC_CF_BEACON_TOKEN` is set at
build time (configured as a Workers Builds environment variable). Absent the
token the beacon is omitted, so local builds carry no analytics.

## One-time Cloudflare setup (dashboard)

Connecting a repo to Workers Builds is an OAuth step that can only be done in the
dashboard. Do this once:

1. **Create the Worker:** *Workers & Pages → Create → Workers → Import a
   repository* → select `SinishaDjukic/worca-cc`.
2. **Build settings:**
   - Root directory: `docs-site`
   - Build command: `npm run build`
   - Deploy command: `npx wrangler deploy`
   - Production branch: `docs-live`
   - Environment variable: `NODE_VERSION = 22`
3. **Analytics:** *Analytics & Logs → Web Analytics → Add a site* → copy the
   beacon token → add it as a Workers Builds env var
   `PUBLIC_CF_BEACON_TOKEN` (Production **and** Preview).
4. **Custom domain:** on the Worker → *Settings → Domains & Routes → Add* →
   `docs.worca.dev` (auto-creates the CNAME; DNS is already in this account).

After this, every push to `docs-live` publishes to `docs.worca.dev`; every PR /
`master` push gets a preview URL.
