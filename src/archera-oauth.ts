import { randomUUID } from "node:crypto";
import {
  discoverAuthorizationServerMetadata,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { requireEnv } from "./env.js";
import { getConnectedState } from "./store.js";

/**
 * Per-installation Archera OAuth, using Dynamic Client Registration (DCR).
 *
 * Flow: at GitHub App install time, the Setup URL sends the admin to
 * /connect/archera → startConnect() → Archera login → /oauth/archera/callback →
 * finishConnect() stores tokens keyed by the GitHub installation id. At review
 * time getAccessToken(installationId) returns a fresh bearer (refreshing as
 * needed) to authenticate the MCP connection as that tenant.
 */

const AUTH_SERVER = "https://api.archera.ai";
const MCP_RESOURCE = new URL(process.env.ARCHERA_MCP_URL ?? "https://mcp.archera.ai/mcp");
const SCOPE = process.env.ARCHERA_SCOPE ?? "archera:read";

const CLIENT_KEY = "archera:oauth:client";
const tokensKey = (installationId: number) => `archera:oauth:tokens:${installationId}`;
const flowKey = (state: string) => `archera:oauth:flow:${state}`;
const FLOW_TTL_MS = 10 * 60 * 1000;

interface StoredClient {
  redirectUri: string;
  info: OAuthClientInformationFull;
}
interface StoredTokens {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
}
interface StoredFlow {
  installationId: number;
  codeVerifier: string;
}

/** Our OAuth redirect URI, derived from the externally-reachable PUBLIC_URL. */
function redirectUri(): string {
  return `${requireEnv("PUBLIC_URL").replace(/\/$/, "")}/oauth/archera/callback`;
}

let metadataCache: AuthorizationServerMetadata | undefined;
async function getMetadata(): Promise<AuthorizationServerMetadata | undefined> {
  if (!metadataCache) metadataCache = await discoverAuthorizationServerMetadata(AUTH_SERVER);
  return metadataCache;
}

/** Register (or reuse) our OAuth client via DCR. Re-registers if the redirect URI changed. */
async function getClient(): Promise<OAuthClientInformationFull> {
  const uri = redirectUri();
  const state = await getConnectedState();
  const stored = await state.get<StoredClient>(CLIENT_KEY);
  if (stored && stored.redirectUri === uri) return stored.info;

  const info = await registerClient(AUTH_SERVER, {
    metadata: await getMetadata(),
    clientMetadata: {
      client_name: "GitHub Cloud-Cost Review Bot",
      redirect_uris: [uri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: SCOPE,
    },
    scope: SCOPE,
  });
  await state.set(CLIENT_KEY, { redirectUri: uri, info });
  return info;
}

/** Begin connecting an installation; returns the Archera authorization URL to redirect to. */
export async function startConnect(installationId: number): Promise<string> {
  const stateValue = randomUUID();
  const { authorizationUrl, codeVerifier } = await startAuthorization(AUTH_SERVER, {
    metadata: await getMetadata(),
    clientInformation: await getClient(),
    redirectUrl: redirectUri(),
    scope: SCOPE,
    state: stateValue,
    resource: MCP_RESOURCE,
  });

  await (await getConnectedState()).set<StoredFlow>(
    flowKey(stateValue),
    { installationId, codeVerifier },
    FLOW_TTL_MS,
  );
  return authorizationUrl.toString();
}

function toStored(tokens: OAuthTokens): StoredTokens {
  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
  };
}

/** Finish the OAuth callback: exchange the code and persist tokens for the installation. */
export async function finishConnect(code: string, stateValue: string): Promise<number> {
  const state = await getConnectedState();
  const flow = await state.get<StoredFlow>(flowKey(stateValue));
  if (!flow) throw new Error("Unknown or expired OAuth state");

  const tokens = await exchangeAuthorization(AUTH_SERVER, {
    metadata: await getMetadata(),
    clientInformation: await getClient(),
    authorizationCode: code,
    codeVerifier: flow.codeVerifier,
    redirectUri: redirectUri(),
    resource: MCP_RESOURCE,
  });

  await state.set<StoredTokens>(tokensKey(flow.installationId), toStored(tokens));
  await state.delete(flowKey(stateValue));
  return flow.installationId;
}

/** True if the access token is still usable (with a 60s safety margin). */
export function tokenIsFresh(expiresAt: number | undefined, now: number): boolean {
  if (expiresAt === undefined) return true; // no expiry info; assume usable
  return expiresAt - 60_000 > now;
}

/** A usable access token for an installation, refreshing if needed. Null if not connected. */
export async function getAccessToken(installationId: number): Promise<string | null> {
  const state = await getConnectedState();
  const stored = await state.get<StoredTokens>(tokensKey(installationId));
  if (!stored) return null;
  if (tokenIsFresh(stored.expires_at, Date.now())) return stored.access_token;
  if (!stored.refresh_token) return null;

  try {
    const refreshed = await refreshAuthorization(AUTH_SERVER, {
      metadata: await getMetadata(),
      clientInformation: await getClient(),
      refreshToken: stored.refresh_token,
    });
    const updated = toStored(refreshed);
    if (!updated.refresh_token) updated.refresh_token = stored.refresh_token; // preserve if not rotated
    await state.set<StoredTokens>(tokensKey(installationId), updated);
    return updated.access_token;
  } catch (error) {
    console.error("[archera-oauth] token refresh failed", error);
    return null;
  }
}

/** Whether an installation has connected Archera. */
export async function isConnected(installationId: number): Promise<boolean> {
  return Boolean(await (await getConnectedState()).get<StoredTokens>(tokensKey(installationId)));
}
