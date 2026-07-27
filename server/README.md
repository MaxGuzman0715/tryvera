# Enpply — Server

Express API for the pre-apply document generator: profile storage (JSON files), application generation (LLM + PDF), prompt configuration, and application logs.

## Prerequisites

- Node.js 20+ (recommended)
- An API key in the **repository root** `.env`: **`OPENROUTER_API_KEY`** (preferred) or **`OPENAI_API_KEY`** — see below.

## Environment

The server loads `.env` from the **monorepo root** (`../.env`), not from `server/`.

If **`OPENROUTER_API_KEY`** is set, all chat calls use [OpenRouter](https://openrouter.ai/) (OpenAI-compatible API at `https://openrouter.ai/api/v1`). Otherwise the app uses the OpenAI API directly.

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENROUTER_API_KEY` | One of these for generation | Preferred; when set, OpenRouter is used first |
| `OPENAI_API_KEY` | | Used only when `OPENROUTER_API_KEY` is unset |
| `OPENROUTER_MODEL` | No | Model id on OpenRouter (default `qwen/qwen3.6-plus:free` if unset) |
| `OPENROUTER_BASE_URL` | No | Override API base (default `https://openrouter.ai/api/v1`) |
| `OPENROUTER_HTTP_REFERER` | No | Optional `HTTP-Referer` for OpenRouter rankings |
| `OPENROUTER_APP_TITLE` | No | Optional `X-Title` (default `Enpply`) |
| `PORT` | No | HTTP port (default `3001`) |
| `OPENAI_MODEL` | No | Chat model for **direct OpenAI** (default `gpt-4o-mini`); also fallback for `OPENROUTER_MODEL` when using OpenRouter |
| `DATA_DIR` | No | Data directory (default repo `./data`) |
| `OUTPUT_ROOT` | No | Unused by code paths today; output path comes from **app settings** `default_output_path` (resolved under repo root) |

## Scripts

Run from the **monorepo root** with `-w server`, or `cd server` first.

| Command | Description |
|---------|-------------|
| `npm run dev -w server` | Dev server with `tsx watch` (reload on change) |
| `npm run build -w server` | Compile TypeScript to `dist/` |
| `npm run start -w server` | Run `node dist/index.js` (build first) |

## API (summary)

- **Profiles:** `GET/POST /api/profiles`, `GET/PUT/DELETE /api/profiles/:id`
- **Applications:** `POST /api/applications/generate`, `GET /api/applications`, `GET /api/applications/:id` (full `result.json`)
- **Config:** `GET/PUT /api/config/settings`, `GET /api/config/themes` (résumé/CV PDF themes from `templates/registry.json`), `GET /api/preview/resume/:theme` (HTML sample preview for the theme picker), `GET/PUT /api/config/prompts`, `GET /api/config/prompt-defaults`, `POST /api/config/prompts/:key/reset`
- **Health:** `GET /api/health`

## Data layout

Paths are under the repo root unless `DATA_DIR` is absolute.

- `data/profiles/*.json` — user profiles  
- `data/application_logs.json` — generation log index  
- `server/prompt-defaults/<key>/<variant>.txt` + `active.json` — editable LLM prompts, git-tracked (UI edits show in `git diff`; override location with `PROMPTS_DIR`)  
- `data/app_settings.json` — default output path, theme, per-profile theme map, **LLM provider + model id** (keys stay in `.env` only)  

Generated runs write under the configured output directory (default `./output`), each folder containing `resume.pdf`, `cv.pdf`, `answers.*`, `metadata.json`, `result.json`.

## PDF HTML templates (Chromium path)

Résumé and CV shells live under **`templates/`**. **`templates/registry.json`** lists theme ids, labels, and which HTML file to use for each (`resume` / `cv` keys). Add new HTML files and register them there — no code edits required (restart the server to reload the registry). See **`templates/README.md`** for placeholders and authoring rules.

## Production

After `npm run build -w server` and `npm run build -w client`, the server serves the built SPA from `client/dist` and serves `index.html` for non-API GET routes (SPA fallback).

On startup the server logs `[enpply] project root:` and `[enpply] data dir:`. If the profile list in the UI is empty but files exist under `data/profiles/`, confirm those paths match your repo (wrong root was a common cause; resolution now walks up from both `paths.ts` and `process.cwd()`).

## Source layout

```
server/
  src/
    index.ts          # Express app and routes
    generation.ts     # OpenAI + artifact pipeline
    pdf.ts            # Markdown → PDF (PDFKit)
    profileStore.ts   # Profile JSON files
    logStore.ts       # application_logs.json
    promptStore.ts    # Prompt text files
    appSettings.ts    # app_settings.json
    paths.ts          # DATA_DIR, project root
    types.ts          # Shared types + Zod schemas
    defaultPrompts.ts # Default prompt text
```
