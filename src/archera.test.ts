import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { archeraConfigured, connectArchera } from "./archera.js";

describe("archeraConfigured", () => {
  const original = process.env.ARCHERA_MCP_TOKEN;
  beforeEach(() => {
    delete process.env.ARCHERA_MCP_TOKEN;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.ARCHERA_MCP_TOKEN;
    else process.env.ARCHERA_MCP_TOKEN = original;
  });

  it("is false without a token and true with one", () => {
    expect(archeraConfigured()).toBe(false);
    process.env.ARCHERA_MCP_TOKEN = "token";
    expect(archeraConfigured()).toBe(true);
  });

  it("connectArchera returns null when no token is configured", async () => {
    await expect(connectArchera()).resolves.toBeNull();
  });
});
