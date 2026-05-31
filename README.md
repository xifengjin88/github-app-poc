# GitHub Cloud-Cost Review Bot

A GitHub bot that reviews pull requests for **cloud-cost impact** with Claude — a Greptile-style
reviewer focused on FinOps. Built on the [Chat SDK](https://chat-sdk.dev) (`chat` +
`@chat-adapter/github`).

**How it works:** when a PR is opened or updated (or when you `@your-app-slug` it), the bot fetches
the diff, runs it through Claude to assess cost impact, and posts a **single bundled GitHub review**:
inline comments on the cost-relevant lines (with `P1`/`P2`/`P3` severity and committable
`suggestion` fixes) plus a summary report (verdict, confidence, estimated monthly $ delta,
per-file cost notes, optional Mermaid diagram). Diff-only — no repo clone, no sandbox.

## Features

- **Infrastructure-only scope**: the bot filters the diff to infra files and reviews *only* those
  (no cost, no noise on app-only PRs). **Terraform** today (`.tf`/`.tf.json`/`.tfvars`); add more
  matchers (CloudFormation, Kubernetes, Pulumi…) in `src/infra.ts`. A PR with no infra changes is
  skipped silently (auto-review) or gets a short note (on `@mention`).
- **Cloud-cost analysis** of those changes (instance sizing, counts/autoscaling, storage class/IOPS,
  NAT/egress, managed-service tiers, retention…), with estimated monthly $ deltas.
- **Inline review comments** anchored to the exact changed lines, each with a severity badge.
- **Committable suggestions** (```suggestion blocks) when a cheaper drop-in exists.
- **Summary report** as the review body: verdict, confidence (1–5), estimated delta, changed-file
  table, and an optional Mermaid diagram.
- **Auto-review on PR open + every push** (`pull_request` `opened`/`synchronize`/`reopened`/
  `ready_for_review`), plus on-demand via `@mention`.
- **Real-price grounding via Archera** (optional): when connected, findings cite actual on-demand
  prices and reservation savings instead of model estimates.
- **In-progress status comment**: posts a `⏳ Reviewing…` placeholder immediately, then edits it in
  place into the final summary when done (CodeRabbit-style), so the PR shows activity right away.

## Stack

| Piece | Choice |
|-------|--------|
| Bot framework | Chat SDK (`chat`), GitHub adapter (`@chat-adapter/github`) |
| Auth | GitHub App (**multi-tenant**: installable on any org/repo, installation resolved per webhook) |
| State | Redis (`@chat-adapter/state-redis`) when `REDIS_URL` is set; in-memory fallback for local dev |
| AI | `@ai-sdk/anthropic` → Claude (`claude-sonnet-4-6` by default), structured output via `generateObject` + Zod |
| Server | Hono on `@hono/node-server` |
| Tests | Vitest · Lint: Biome |

## Project layout

```
src/
  bot.ts          # Chat instance, GitHub adapter, @mention handlers
  server.ts       # Hono server; routes pull_request events vs comment events
  runner.ts       # Shared pipeline: generate review -> post review
  review.ts       # Diff fetch + structured cost review (Zod schema + Claude)
  infra.ts        # Which files are "infra" (Terraform today) + filter diff to them
  archera.ts      # Archera MCP client → cost-grounding tools for the model
  archera-oauth.ts# Per-installation Archera OAuth + DCR; token storage/refresh
  store.ts        # Shared state instance (Redis/memory) for bot + tokens
  diff.ts         # Split by file, parse commentable lines, annotate with line numbers
  render.ts       # Markdown for the summary report and inline findings
  post.ts         # Post the bundled GitHub review (inline + summary), with fallback
  github-app.ts   # Installation-token Octokit + webhook signature verify (auto path)
  env.ts          # Required-env helpers
  *.test.ts       # Unit tests for the pure modules
.env.example      # Copy to .env and fill in
```

## Setup

### 1. Install

```bash
npm install
```

### 2. Create the GitHub App

GitHub → **Settings → Developer settings → GitHub Apps → New GitHub App**:

- **Webhook URL**: your public URL + `/api/webhooks/github` (your tunnel URL during local dev — see below)
- **Webhook secret**: generate a long random string (you'll put it in `.env`)
- **Permissions**:
  - Repository → **Pull requests**: Read & write (read the diff, post reviews)
  - Repository → **Issues**: Read & write (PR conversation comments use the issues API)
  - Repository → **Contents**: Read-only (needed to read the diff)
  - Repository → **Metadata**: Read-only
- **Subscribe to events**: **Pull request** (for auto-review on open/push), **Issue comment** and
  **Pull request review comment** (for `@mention` triggering)
- **Where can this app be installed?**: **Any account** (this is what makes it multi-tenant)
- Create the app, note the **App ID**, and **Generate a private key** (downloads a `.pem`).

Then **Install App** onto one or more repos/orgs. In multi-tenant mode you do **not** record an
installation ID — the adapter reads `installation.id` from each incoming webhook and caches a
per-installation client automatically, so one running app serves every account it's installed on.

> ⚠️ The GitHub App webhook content type must be **`application/json`** (the adapter rejects
> `application/x-www-form-urlencoded`). It defaults to JSON for App webhooks.

### 3. Configure `.env`

```bash
cp .env.example .env
```

Fill in `GITHUB_APP_ID`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_BOT_USERNAME` (the app slug), and
`ANTHROPIC_API_KEY`. Optionally set `REDIS_URL` for persistent state (omit it locally to use the
in-memory fallback).

For `GITHUB_PRIVATE_KEY`, paste the `.pem` contents as a single double-quoted line with `\n` between
lines (the app turns `\n` back into newlines at startup). Quick way to produce that:

```bash
awk 'BEGIN{ORS="\\n"} {print}' your-app.private-key.pem
```

### 4. Run locally + expose a tunnel

```bash
npm run dev
```

In another terminal, expose port 3000 publicly so GitHub can reach it:

```bash
cloudflared tunnel --url http://localhost:3000
# or: ngrok http 3000
```

Set the GitHub App's **Webhook URL** to `https://<tunnel-host>/api/webhooks/github`.

### 5. Try it

- **Auto-review:** open a PR (or push a new commit to one) on the installed repo. The bot posts a
  bundled cost review within a few seconds — no action needed.
- **On demand:** comment `@your-app-slug` on a PR. The bot acks `👀 Reviewing…`, then posts the review.
  Mention it again any time to re-review.

## Scripts

```bash
npm run dev         # watch-mode server (tsx)
npm run typecheck   # tsc --noEmit
npm run lint        # biome check
npm run lint:fix    # biome check --write
npm test            # vitest run
```

## Debugging — see how a review was produced

Set `REVIEW_DEBUG=1` (in `.env` or inline) to trace each review. For every reviewed PR the bot:
- prints a one-line summary to the console (`verdict`, `confidence`, `findings`, `grounded`), and
- writes a full JSON trace to `logs/<owner>-<repo>-pr<N>-<timestamp>.json` containing the exact
  infra diff sent to the model, the Archera tool calls + (truncated) results during grounding, token
  usage for both passes, and the final structured review object.

```bash
REVIEW_DEBUG=1 npm run dev
# then trigger a review → inspect logs/*.json
```

`logs/` is gitignored. Override the directory with `REVIEW_LOG_DIR`.

## Notes & next steps

- **Auto-review path**: the Chat SDK GitHub adapter handles comment events but ignores `pull_request`
  events, so `server.ts` routes those to its own handler (`github-app.ts`) which verifies the
  signature and mints an installation token. Comment/`@mention` events still go through the adapter.
- **Multi-tenant** means the App routes each installation correctly from one running process — it does
  **not** add per-tenant isolation, billing, or rate-limit fairness. Inside a handler, `github.octokit`
  resolves the current request's installation client via AsyncLocalStorage; the auto path resolves it
  from the webhook payload's `installation.id`.
- **State**: set `REDIS_URL` in production. The Redis adapter persists the repo→installation mapping,
  thread subscriptions, and distributed locks across restarts and multiple instances. Without it the
  in-memory fallback works (each webhook payload still carries its own installation), but loses that
  state on restart.
- **Cost grounding via Archera**: when an installation is connected, the review model looks up REAL
  on-demand prices and reservation savings through Archera's MCP server (`https://mcp.archera.ai/mcp`)
  before judging impact — the summary footer then reads "prices grounded in Archera". Otherwise it
  degrades to the model's own estimates (and the footer says so). See `src/archera.ts`.
  - **Per-installation OAuth + DCR (`src/archera-oauth.ts`):** each company connects its own Archera
    org at install time. GitHub's **Setup URL** (`<PUBLIC_URL>/connect/archera`) sends the admin to
    `startConnect()` → Archera OAuth (Authorization Code + PKCE; the OAuth client is registered via
    **Dynamic Client Registration**) → `/oauth/archera/callback` → `finishConnect()` stores the
    `{access, refresh}` tokens keyed by GitHub installation id (in the shared state, so Redis in
    production). At review time `getAccessToken(installationId)` returns a fresh bearer (auto-refresh)
    to connect to MCP as that tenant.
  - **Single-token fallback:** set `ARCHERA_MCP_TOKEN` to use one bearer for all reviews (handy for
    local testing without the OAuth dance).
  - Requires `PUBLIC_URL` (your externally-reachable base, e.g. the tunnel URL) for the OAuth redirect.
- **Diff-only context** is intentionally simple. To let the model read surrounding code, switch to the
  agentic + Vercel Sandbox approach from Vercel's
  [code-review bot guide](https://vercel.com/kb/guide/ship-a-github-code-review-bot-with-hono-and-redis).
- **Hardening for a real public app**: per-installation rate-limit handling, a queue so one busy org
  can't starve others, and a config/allowlist store.
- Large diffs are truncated to `MAX_DIFF_CHARS` (100k chars) before the model call. Inline comments
  whose line can't be matched to the diff fall back into the summary, so nothing is dropped.
