# Agentera Website

Astro 6 + Starlight + Cloudflare site for the Agentera marketing landing page
and published documentation.

## Development

From the repository root (use `vp` as the Node toolchain entrypoint):

```bash
vp install
vp run web:dev      # http://localhost:4321
vp run web:check    # lint + fmt + types (Vite Plus)
vp run web:build
vp run web:deploy   # requires wrangler auth
```

Or from this directory:

```bash
vp run dev
vp run check
vp run build
```

Install git hooks once: `lefthook install` (runs `vp staged` on web file changes).

## Content authority

| Layer                            | Role                                                                     |
| -------------------------------- | ------------------------------------------------------------------------ |
| `packages/web/src/content/docs/` | **Published** documentation (Starlight)                                  |
| `references/` and `skills/`      | Protocol authority — source of truth for schemas and capability behavior |
| Root `docs/`                     | Non-authoritative scratch space                                          |
| Root `README.md`                 | Contributor-facing overview; landing page ports key sections             |

Starlight pages are the published layer. When protocol docs change, update
`references/` or `skills/` first, then migrate content to Starlight incrementally.
Do not duplicate long-term — link back to repository sources where appropriate.

## Stack

- **Astro 6** with `@astrojs/starlight` for docs at `/docs`
- **@astrojs/cloudflare** adapter for Workers deployment
- **Tailwind CSS 4** for the marketing landing page only
- **Vite Plus** (`vp lint`, `vp fmt`, `vp check`) for lint/format/type tooling
- **Wrangler** for Cloudflare deploy

## Deploy

Build output goes to `dist/`. Deploy with:

```bash
vp run deploy
```

Requires Cloudflare authentication via `wrangler login` or `CLOUDFLARE_API_TOKEN`.

Site URL placeholder: `https://agentera.dev` (set in `astro.config.mjs`).
