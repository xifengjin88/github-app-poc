import { afterEach, describe, expect, it } from "vitest";
import { reviewDebugEnabled, trunc } from "./log.js";

describe("reviewDebugEnabled", () => {
  const original = process.env.REVIEW_DEBUG;
  afterEach(() => {
    if (original === undefined) delete process.env.REVIEW_DEBUG;
    else process.env.REVIEW_DEBUG = original;
  });

  it("is off by default and for falsy values", () => {
    delete process.env.REVIEW_DEBUG;
    expect(reviewDebugEnabled()).toBe(false);
    process.env.REVIEW_DEBUG = "0";
    expect(reviewDebugEnabled()).toBe(false);
    process.env.REVIEW_DEBUG = "false";
    expect(reviewDebugEnabled()).toBe(false);
  });

  it("is on for truthy values", () => {
    process.env.REVIEW_DEBUG = "1";
    expect(reviewDebugEnabled()).toBe(true);
  });
});

describe("trunc", () => {
  it("leaves short strings and cuts long ones", () => {
    expect(trunc("abc", 10)).toBe("abc");
    expect(trunc("abcdef", 3)).toBe("abc…[truncated]");
  });
});
