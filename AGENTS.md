# Repository Guidelines

## Project Structure & Module Organization

- `server.js` contains the Node.js HTTP server, relay routes, source and agent state, proxy handling, model probes, and runtime logging.
- `public/index.html` defines the single-page control console markup.
- `public/app.js` contains browser state management, navigation, API calls, and UI event handlers.
- `public/style.css` contains the complete visual system and responsive layout.
- `README.md` documents setup and relay endpoints. `logs/` is runtime-generated and should not be committed.

## Build, Test, and Development Commands

Install dependencies with `npm install`. Start the local server with `npm run dev` or `npm start`; it listens on port `4173` by default. Use `PORT=4174 npm run dev` to run a parallel instance without disturbing another process. Check syntax before submitting changes with `node --check server.js && node --check public/app.js`. There is currently no formal test runner or build step; verify API behavior with `curl` and manually exercise the affected console workflow.

## Coding Style & Naming Conventions

Use modern ECMAScript modules and two-space indentation. Prefer `const`, small focused helper functions, early returns, and existing native APIs. Use camelCase for JavaScript variables/functions, kebab-case for DOM classes and IDs, and descriptive endpoint names such as `/api/sources/:id/models/status`. Keep frontend changes dependency-free unless a dependency is necessary; update `package.json` and `package-lock.json` together when adding one. Keep comments short and explain only non-obvious behavior.

## Testing Guidelines

For server changes, run syntax checks and exercise success, validation, authentication, and upstream-error paths with `curl`. For UI changes, test desktop and narrow mobile layouts, navigation, forms, clipboard actions, and loading/error states. Do not include real API keys in tests, screenshots, logs, or commits.

## Commit & Pull Request Guidelines

No usable Git history is present in this checkout. Use concise imperative commit subjects, preferably Conventional Commit style (for example, `feat: add per-source proxy toggle`). Pull requests should describe behavior changes, configuration or migration impact, verification commands, and any security implications. Include screenshots or a short screen recording for visible UI changes.

## Security & Configuration Tips

API keys must remain server-side and masked in public responses. Do not log prompts, response bodies, authorization headers, proxy credentials, or full keys. Configure the per-server proxy in the web UI (or use `http_proxy` as fallback) and use `LOG_LEVEL`, `LOG_DIR`, `LOG_MAX_SIZE_MB`, `LOG_MAX_FILES`, and `LOG_RETENTION_DAYS` to control runtime log volume. Source credentials, routes, and Agent keys persist in the local `data/relay-hub-state.json`; keep that file private and never commit it.
