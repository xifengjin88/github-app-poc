import "dotenv/config";
import { serve } from "@hono/node-server";
import { type Context, Hono } from "hono";
import { bot } from "./bot.js";
import { getInstallationOctokit, verifyWebhookSignature } from "./github-app.js";
import type { PullRequestRef } from "./review.js";
import { runCostReview } from "./runner.js";

const app = new Hono();

app.get("/", (c) =>
  c.text("GitHub cloud-cost review bot is running. POST to /api/webhooks/github"),
);

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
  void runCostReview(getInstallationOctokit(installationId), ref)
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
