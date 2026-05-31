import { createGitHubAdapter, type GitHubRawMessage } from "@chat-adapter/github";
import { createMemoryState } from "@chat-adapter/state-memory";
import { createRedisState } from "@chat-adapter/state-redis";
import { Chat, type StateAdapter, type Thread } from "chat";
import { githubPrivateKey, requireEnv } from "./env.js";
import type { PullRequestRef } from "./review.js";
import { runCostReview } from "./runner.js";

const botUserName = process.env.GITHUB_BOT_USERNAME ?? "review-bot";

/**
 * Multi-tenant state.
 *
 * Multi-tenant mode persists a repo -> installation mapping in state so the bot
 * can resolve the right installation across restarts and for proactive sends.
 * Use Redis in production; fall back to in-memory for local dev (mapping is lost
 * on restart, which is fine since each webhook payload carries its installation).
 */
function createState(): StateAdapter {
  const url = process.env.REDIS_URL;
  if (url) return createRedisState({ url });
  console.warn(
    "[bot] REDIS_URL not set — using in-memory state. Fine for local dev; " +
      "set REDIS_URL before deploying a public multi-tenant app.",
  );
  return createMemoryState();
}

/**
 * GitHub adapter in multi-tenant GitHub App mode.
 *
 * No `installationId` is configured: the adapter extracts the installation from
 * each webhook payload and caches a per-installation Octokit client. Inside a
 * handler, `github.octokit` resolves to the current request's installation via
 * AsyncLocalStorage — so the same code serves every org/repo the App is installed on.
 */
export const github = createGitHubAdapter({
  appId: requireEnv("GITHUB_APP_ID"),
  privateKey: githubPrivateKey(),
  webhookSecret: requireEnv("GITHUB_WEBHOOK_SECRET"),
  userName: botUserName,
});

export const bot = new Chat({
  userName: botUserName,
  adapters: { github },
  state: createState(),
});

function refFromMessage(raw: GitHubRawMessage): PullRequestRef {
  return {
    owner: raw.repository.owner.login,
    repo: raw.repository.name,
    prNumber: raw.prNumber,
  };
}

/** Acknowledge the mention, run the cost review, and post it as a bundled review. */
async function runReview(thread: Thread, raw: GitHubRawMessage): Promise<void> {
  // The GitHub adapter treats issues and PRs the same way; only review PRs.
  if (raw.type === "issue_comment" && raw.threadType === "issue") {
    await thread.post("I only review pull requests — mention me in a PR comment.");
    return;
  }

  const ref = refFromMessage(raw);
  await thread.post(`👀 Reviewing PR #${ref.prNumber} for cloud-cost impact…`);

  try {
    // Post the formal review (inline comments + summary) via Octokit directly;
    // the adapter's thread.post can't create line-anchored review comments.
    const outcome = await runCostReview(github.octokit, ref);
    if (outcome === "no-infra") {
      await thread.post(
        "No infrastructure changes (e.g. Terraform) in this PR — nothing to cost-review.",
      );
    } else if (outcome === "empty") {
      await thread.post("This PR has no changes to review.");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await thread.post(`⚠️ Review failed: ${message}`);
  }
}

// First @mention in an unsubscribed PR thread → subscribe + review.
bot.onNewMention(async (thread, message) => {
  await thread.subscribe();
  await runReview(thread, message.raw as GitHubRawMessage);
});

// Once subscribed, every comment lands here. Only re-review on an explicit re-mention.
bot.onSubscribedMessage(async (thread, message) => {
  if (!message.isMention) return;
  await runReview(thread, message.raw as GitHubRawMessage);
});
