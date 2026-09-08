# Repository Guidelines

## Project Structure & Module Organization

The browser application lives in `gestao-academica.html`; keep its markup, styles, and client behavior together unless an architectural change is explicitly approved. `ObtemLogos 02.jpg` is a source asset. `dist/` is generated output and must not be edited manually. Node utilities live in `scripts/`: `build.mjs`, `check.mjs`, and `bootstrap-admin.mjs`.

Supabase configuration lives in `supabase/`. Add ordered database changes to `supabase/migrations/` as `YYYYMMDDHHMM_description.sql`, shared Edge Function code to `supabase/functions/_shared/`, and function entry points to `supabase/functions/<kebab-case-name>/index.ts`. `.openai/hosting.json` stores Sites deployment metadata.

## Build, Test, and Development Commands

- `pnpm install`: install pinned dependencies with Node.js 20 or newer.
- `pnpm build`: generate the production site in `dist/`.
- `pnpm check`: validate the build, closed authentication, RLS policies, and Supabase functions.
- `pnpm supabase <command>`: run the repository-local Supabase CLI.
- `npx serve dist`: preview a completed production build locally.

There is no separate unit-test framework or coverage threshold. Future tests belong in `tests/` with descriptive names such as `login-by-identifier.test.ts`.

## Coding Style & Naming Conventions

Use two-space indentation in HTML, JavaScript, TypeScript, JSON, and SQL. Use `camelCase` for JavaScript/TypeScript values, `PascalCase` for types, `snake_case` for PostgreSQL identifiers, and lowercase SQL keywords. Reuse `_shared` helpers. Keep UI text in Brazilian Portuguese and preserve established IPE terminology.

## Baseline and Change Safety

Before executable work, the primary agent must record the Git status and pre-existing diff, inspect affected architecture, contracts, dependencies, and visible behavior, and run `pnpm check` plus `pnpm build` when feasible. Baseline failures must be reported separately from new regressions.

Preserve user changes and implement the smallest coherent change. Do not move files, replace dependencies, refactor unrelated code, change public contracts, or alter architecture without an impact analysis and explicit user authorization. Any visible change—including layout, copy, colors, typography, components, or navigation—requires prior authorization. If a fix requires a protected change, stop and ask.

## Mandatory Validation Workflow

For features, fixes, database, security, and executable configuration changes:

1. The primary agent establishes the baseline, assesses risk, and implements within the existing architecture.
2. A testing subagent validates the complete affected flow, adjacent regressions, `pnpm check`, and `pnpm build`.
3. The primary agent audits the evidence, scope, diff, architectural integrity, and security.
4. Failures are corrected and the entire validation cycle repeats.
5. The primary agent normally owns fixes. The testing subagent may edit only after an explicit, bounded delegation; its changes require independent revalidation.
6. If the testing subagent is unavailable, the work must not be declared ready and no PR may be proposed.
7. After every gate passes, report changes, risks, evidence, and a proposed PR title and description.

Documentation-only changes receive proportional review and do not require the complete subagent cycle.

## Security, Commits, and Pull Requests

Every executable change requires a reviewed diff for hardcoded secrets, tokens, credentials, personal data, tracked `.env` files, Supabase keys, and authorization flaws. When relevant, verify authentication, permissions, RLS, tenant isolation, storage access, and Edge Function boundaries. If the security review cannot be evidenced, block completion.

Use Conventional Commits, such as `feat: integrate Supabase backend and access control`. Obtain separate explicit user authorization before each commit, push, and PR creation. Approval of code or a previous Git operation never authorizes the next operation.

## Proactive Engineering

Anticipate regressions and challenge unsafe, redundant, structurally weak, or inefficient requests with concrete evidence and a safer alternative. Ask before decisions affecting architecture, layout, security, data, scope, or meaningful trade-offs. Proceed autonomously only with safe, local implementation decisions inside the approved scope.
