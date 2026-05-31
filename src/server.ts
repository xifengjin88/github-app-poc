import "dotenv/config";
import { serve } from "@hono/node-server";
import { type Context, Hono } from "hono";
import { finishConnect, startConnect } from "./archera-oauth.js";
import { bot } from "./bot.js";
import { getInstallationOctokit, verifyWebhookSignature } from "./github-app.js";
import type { PullRequestRef } from "./review.js";
import { runCostReview } from "./runner.js";

const app = new Hono();

app.get("/", (c) =>
  c.text("GitHub cloud-cost review bot is running. POST to /api/webhooks/github"),
);

/** Minimal HTML page (the connect flow is admin-facing, not an API). */
function page(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem;line-height:1.5"><h2>${title}</h2>${body}</body>`;
}

/**
 * GitHub App **Setup URL** target. After install, GitHub redirects here with
 * `installation_id`; we kick off the Archera OAuth flow so this installation's
 * cost data backs its reviews.
 */
app.get("/connect/archera", async (c) => {
  const installationId = Number(c.req.query("installation_id"));
  if (!installationId) {
    return c.html(page("Connect Archera", "<p>Missing <code>installation_id</code>.</p>"), 400);
  }
  try {
    return c.redirect(await startConnect(installationId));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[connect/archera]", error);
    return c.html(page("Connect Archera failed", `<p>${message}</p>`), 500);
  }
});

/** OAuth redirect target: exchange the code and store the installation's token. */
app.get("/oauth/archera/callback", async (c) => {
  const error = c.req.query("error");
  if (error) {
    return c.html(page("Archera connection cancelled", `<p>${error}</p>`), 400);
  }
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) {
    return c.html(page("Archera connection failed", "<p>Missing code or state.</p>"), 400);
  }
  try {
    const installationId = await finishConnect(code, state);
    return c.html(
      page(
        "Archera connected ✅",
        `<p>Installation <code>${installationId}</code> is connected. Cost reviews will now use your real Archera prices and savings. You can close this tab.</p>`,
      ),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[oauth/archera/callback]", err);
    return c.html(page("Archera connection failed", `<p>${message}</p>`), 500);
  }
});

// PR actions that warrant a (re-)review.
const REVIEWABLE_ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);

/**
 * Handle `pull_request` events ourselves (the Chat SDK adapter ignores them) so
 * the bot auto-reviews on open and on every new push.
 */
async function handlePullRequestEvent(c: Context): Promise<Response> {
  const rawBody = await c.req.text();
  if (!verifyWebhookSignature(rawBody, c.req.header("x-hub-signature-256") ?? null)) {
    return c.text("Invalid signature", 401);
  }

  const payload = JSON.parse(rawBody);
  if (!REVIEWABLE_ACTIONS.has(payload.action)) return c.text("ignored", 200);
  if (payload.pull_request?.draft) return c.text("draft ignored", 200);

  const installationId = payload.installation?.id;
  if (!installationId) return c.text("no installation in payload", 400);

  const ref: PullRequestRef = {
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    prNumber: payload.pull_request.number,
  };

  // Ack fast; review in the background. No infra changes → skip silently.
  void runCostReview(getInstallationOctokit(installationId), ref, installationId)
    .then((outcome) =>
      console.log(`[pull_request] ${ref.owner}/${ref.repo}#${ref.prNumber}: ${outcome}`),
    )
    .catch((error) => console.error("[pull_request task]", error));
  return c.text("ok", 200);
}

app.post("/api/webhooks/github", (c) => {
  // `pull_request` events go to our own handler; comment events go to the adapter.
  // We only read headers here, so the request body stays intact for the adapter.
  if (c.req.header("x-github-event") === "pull_request") {
    return handlePullRequestEvent(c);
  }
  return bot.webhooks.github(c.req.raw, {
    waitUntil: (task) => {
      void task.catch((error) => console.error("[webhook task]", error));
    },
  });
});

const port = Number(process.env.PORT ?? 3000);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`✅ Listening on http://localhost:${info.port}`);
  console.log(`   Webhook endpoint: POST http://localhost:${info.port}/api/webhooks/github`);
});
