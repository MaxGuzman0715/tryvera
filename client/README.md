# Tryvera — Client

React (Vite) SPA for the pre-apply document generator: profile editor, job apply form, result viewer, application logs, and config (paths + LLM prompts).

## Prerequisites

- Node.js 20+ (recommended)

The UI talks to the **API during development** via the Vite dev proxy (`/api` → `http://localhost:5001`). Start the server separately or use the root script `npm run dev` from the monorepo.

## Scripts

Run from the **monorepo root** with `-w client`, or `cd client` first.

| Command | Description |
|---------|-------------|
| `npm run dev -w client` | Vite dev server (default **http://localhost:5273**) |
| `npm run build -w client` | Production build to `client/dist` |
| `npm run preview -w client` | Serve the production build locally (for smoke checks) |

## Development

1. Start the API (e.g. `npm run dev -w server` on port `5001`).
2. Start the client (`npm run dev -w client`).
3. Open the URL printed by Vite (e.g. 5273).

`vite.config.ts` proxies `/api` to `http://localhost:5001`, so the browser uses relative URLs like `/api/health` with no CORS config needed in dev.

## Production

Build the client, then run the server from the repo root so it can serve `client/dist`:

```bash
npm run build -w client
npm run build -w server
npm run start -w server
```

The server listens on `PORT` (default `5001`) and serves the SPA for non-API routes.

## Source layout

```
client/
  index.html
  vite.config.ts
  src/
    main.tsx           # Entry + React root + router
    App.tsx            # Routes + nav shell
    api.ts             # fetch wrappers for REST API
    types.ts           # Client-side types
    styles.css         # Global styles
    pages/
      Profiles.tsx     # Profile CRUD
      Apply.tsx        # Generate All
      Result.tsx       # Single application result
      Logs.tsx         # Log list + search
      Config.tsx       # Settings + prompts
```

## Tech stack

- React 19, React Router 7  
- Vite 6, TypeScript  
- No component library beyond global CSS (see `styles.css`)
