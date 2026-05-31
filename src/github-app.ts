import { createHmac, timingSafeEqual } from "node:crypto";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { githubPrivateKey, requireEnv } from "./env.js";

/**
 * The Chat SDK GitHub adapter handles comment events (issue_comment,
 * pull_request_review_comment) but ignores `pull_request` events. To auto-review
 * on PR open/update we handle those ourselves, which means minting our own
 * installation-scoped Octokit and verifying the webhook signature here.
 */

const clients = new Map<number, Octokit>();

/** Get (and cache) an Octokit authenticated as a specific App installation. */
export function getInstallationOctokit(installationId: number): Octokit {
  const cached = clients.get(installationId);
  if (cached) return cached;

  const octokit = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: requireEnv("GITHUB_APP_ID"),
      privateKey: githubPrivateKey(),
      installationId,
    },
  });
  clients.set(installationId, octokit);
  return octokit;
}

/** Verify a GitHub webhook's HMAC-SHA256 signature (the `x-hub-signature-256` header). */
export function verifyWebhookSignature(rawBody: string, signature: string | null): boolean {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret || !signature) return false;

  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
