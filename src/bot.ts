import { createGitHubAdapter, type GitHubRawMessage } from "@chat-adapter/github";
import { Chat, type Message, type Thread } from "chat";
import { githubPrivateKey, requireEnv } from "./env.js";
import type { PullRequestRef } from "./review.js";
import { runCostReview } from "./runner.js";
import { getState } from "./store.js";

const botUserName = process.env.GITHUB_BOT_USERNAME ?? "review-bot";

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
  state: getState(),
});

function refFromMessage(raw: GitHubRawMessage): PullRequestRef {
  return {
    owner: raw.repository.owner.login,
    repo: raw.repository.name,
    prNumber: raw.prNumber,
  };
}

/** Run the cost review for an @mention, using this thread's installation for Archera. */
async function runReview(thread: Thread, message: Message): Promise<void> {
  const raw = message.raw as GitHubRawMessage;
  // The GitHub adapter treats issues and PRs the same way; only review PRs.
  if (raw.type === "issue_comment" && raw.threadType === "issue") {
    await thread.post("I only review pull requests — mention me in a PR comment.");
    return;
  }

  const ref = refFromMessage(raw);
  const installationId = await github.getInstallationId(message.threadId).catch(() => undefined);

  try {
    // runCostReview posts its own in-progress status comment + the formal review
    // (inline comments) via Octokit; the adapter's thread.post can't anchor lines.
    const outcome = await runCostReview(github.octokit, ref, installationId ?? undefined);
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
  await runReview(thread, message);
});

// Once subscribed, every comment lands here. Only re-review on an explicit re-mention.
bot.onSubscribedMessage(async (thread, message) => {
  if (!message.isMention) return;
  await runReview(thread, message);
});
