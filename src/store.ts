import { createMemoryState } from "@chat-adapter/state-memory";
import { createRedisState } from "@chat-adapter/state-redis";
import type { StateAdapter } from "chat";

/**
 * One shared state instance for the whole app — used by the Chat bot (thread
 * subscriptions, locks) and by Archera token storage. Redis when REDIS_URL is
 * set, otherwise in-memory (fine for local dev; tokens are lost on restart).
 */
let instance: StateAdapter | null = null;

export function getState(): StateAdapter {
  if (instance) return instance;
  const url = process.env.REDIS_URL;
  if (url) {
    instance = createRedisState({ url });
  } else {
    console.warn(
      "[state] REDIS_URL not set — using in-memory state. Fine for local dev; " +
        "Archera connections and subscriptions are lost on restart.",
    );
    instance = createMemoryState();
  }
  return instance;
}

let connectPromise: Promise<void> | null = null;

/**
 * Get the shared state, ensuring it's connected first. The Chat bot connects
 * the adapter lazily on its first webhook, but our own callers (e.g. the OAuth
 * routes) may touch state before then — so connect once, here.
 */
export async function getConnectedState(): Promise<StateAdapter> {
  const state = getState();
  if (!connectPromise) connectPromise = state.connect();
  await connectPromise;
  return state;
}
