/** Read a required environment variable, throwing a clear error if it's missing. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

/** The GitHub App private key, with escaped newlines from .env restored to real ones. */
export function githubPrivateKey(): string {
  return requireEnv("GITHUB_PRIVATE_KEY").replace(/\\n/g, "\n");
}
