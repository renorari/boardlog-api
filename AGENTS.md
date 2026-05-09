# Agent Working Rules (Backend)

## Documentation Sources

For tasks involving Express or Prisma, reference docs before implementing.
Use MCP if available; otherwise fetch the llms.txt as fallback.

| Library | llms.txt |
|---|---|
| Express | <https://expressjs.com/llms.txt> |
| Prisma | <https://prisma.io/llms.txt> |

Backend functional requirements are defined in `SPEC-JA.md` (Japanese).

If docs and implementation conflict, prioritize the fetched llms.txt and note the reason.

## AI Agent Rules

1. **Reference Tracking** — Include which llms.txt URL was used and the check date.
2. **Post-change Checklist** — Run Problems check for all edited files.

## Project Overview

- **Domain**: Backend for a whiteboard recording app.
- **Stack**: Express 5 + TypeScript (ESM) + Prisma + PostgreSQL (`@prisma/adapter-pg`) + Redis + log4js.
- **Runtime**: Node.js >= 24, `"type": "module"`.
- **Entry**: `main.ts`.

## Directory Structure

Keep files in the following locations:

| Directory | Purpose |
|---|---|
| `main.ts` | Application entry point. |
| `utils/` | Shared utilities (`db.ts`, `logger.ts`, `middlewares/`). |
| `prisma/` | Prisma schema and migrations. |
| `generated/prisma/` | **Generated** Prisma Client output. Import from here. Do not commit. |
| `eslint/` | Custom ESLint plugin rules. |
| `public/` | Static assets. |
| `logs/` | Runtime log output. Do not commit. |

## TypeScript Conventions

1. **ESM imports** — Always use `.ts` extensions in relative imports (e.g. `import x from "./utils/logger.ts"`).
2. **Type-only imports** — Use `import type` where possible (`verbatimModuleSyntax: true`).
3. **No decorators / emit-only syntax** — `erasableSyntaxOnly: true` prohibits non-erasable TypeScript constructs.
4. **Relative path rewriting** — `rewriteRelativeImportExtensions: true` handles extension mapping at compile time.

## Code Style

Style rules are enforced by the custom ESLint config (`eslint.config.mts`).
Run `npm run lint:fix` to auto-fix most formatting issues.

## Library Conventions

1. **DB Schema Changes** — Use Prisma Migrate, not raw `migration.sql`. Run `prisma generate` after applying.
2. **Prisma Client** — Import from `../generated/prisma/client.ts` (custom output). Use the `PrismaPg` adapter with a `pg.Pool`.
3. **Logging** — Use `log4js` via `utils/logger.ts`. Obtain loggers with `log.getLogger("name")`. Avoid `console.log` in production paths.
4. **Redis** — Use for temporary/cache data only. Do not use for persistent storage.
5. **Environment Variables** — Load with `import "dotenv/config"` in the entry point or any module that accesses `process.env` before it is used elsewhere.

## Security

1. **Middleware** — `helmet()` and `cors()` are applied globally in `main.ts`. Keep them before route handlers.
2. **Error Messages** — Never expose raw error details in API responses. Return structured error objects with appropriate HTTP status codes.
3. **Access Logs** — The `accessLogMiddleware` extracts real IPs via `CF-Connecting-IP` when behind Cloudflare.
4. **Secrets** — Never commit `.env` or any file containing secrets.

## Project Rules

1. **Routing** — Group routes by resource (e.g. `/users`, `/posts`). Keep route handlers thin; move logic to service layer.
2. **Validation** — Validate all incoming request data before processing.
3. **Async Handling** — Always use `try/catch` or a wrapper for async route handlers to prevent unhandled promise rejections.
