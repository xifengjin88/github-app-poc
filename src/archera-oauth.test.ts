import { describe, expect, it } from "vitest";
import { tokenIsFresh } from "./archera-oauth.js";

describe("tokenIsFresh", () => {
  const now = 1_000_000;

  it("treats tokens with no expiry as usable", () => {
    expect(tokenIsFresh(undefined, now)).toBe(true);
  });

  it("is fresh when comfortably before expiry", () => {
    expect(tokenIsFresh(now + 5 * 60_000, now)).toBe(true);
  });

  it("is stale within the 60s safety margin", () => {
    expect(tokenIsFresh(now + 30_000, now)).toBe(false);
    expect(tokenIsFresh(now - 1, now)).toBe(false);
  });
});
