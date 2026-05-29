import { describe, expect, it } from "vitest";

import {
  checkAbstraction,
  checkFiller,
  checkVerbosity,
} from "../../src/validate/selfAudit.js";

describe("checkVerbosity", () => {
  it("passes within the per-entry budget", () => {
    const [passed, detail] = checkVerbosity("Cycle summary with a few words", "PROGRESS.md");
    expect(passed).toBe(true);
    expect(detail).toBe("");
  });

  it("fails when over the per-entry budget", () => {
    const [passed, detail] = checkVerbosity("word ".repeat(600), "PROGRESS.md");
    expect(passed).toBe(false);
    expect(detail).toContain("verbosity mismatch");
    expect(detail).toContain("600");
    expect(detail).toContain("500");
  });

  it("uses the 500-word fallback for unknown artifacts", () => {
    const [passed, detail] = checkVerbosity("word ".repeat(100), "UNKNOWN.md");
    expect(passed).toBe(true);
    expect(detail).toBe("");
  });
});

describe("checkAbstraction", () => {
  it("finds a file path anchor", () => {
    const [passed, detail] = checkAbstraction("Fixed bug in src/auth.py where login failed.");
    expect(passed).toBe(true);
    expect(detail).toContain("src/auth.py");
  });

  it("finds a line-number anchor", () => {
    const [passed, detail] = checkAbstraction("Null check added at :42 in the handler.");
    expect(passed).toBe(true);
    expect(detail).toContain(":42");
  });

  it("finds a commit-hash anchor", () => {
    const [passed, detail] = checkAbstraction("Introduced in commit abc1234def during refactor.");
    expect(passed).toBe(true);
    expect(detail).toContain("abc1234def");
  });

  it("finds a metric-value anchor", () => {
    const [passed, detail] = checkAbstraction("Response time dropped from 120ms to 45ms.");
    expect(passed).toBe(true);
    expect(detail).toContain("120ms");
  });

  it("finds a backtick identifier anchor", () => {
    const [passed, detail] = checkAbstraction("The `handle_login` function was refactored.");
    expect(passed).toBe(true);
    expect(detail).toContain("handle_login");
  });

  it("finds a quoted-text anchor", () => {
    const [passed, detail] = checkAbstraction('Error said "connection refused" repeatedly.');
    expect(passed).toBe(true);
    expect(detail).toContain("connection refused");
  });

  it("reports abstraction creep when no anchor is found", () => {
    const [passed, detail] = checkAbstraction(
      "We made improvements to the system and it is better now.",
    );
    expect(passed).toBe(false);
    expect(detail).toContain("abstraction creep");
  });
});

describe("checkFiller", () => {
  it("passes clean text", () => {
    const [passed, detail] = checkFiller(
      "The test passed all benchmarks with a 15ms response time.",
    );
    expect(passed).toBe(true);
    expect(detail).toBe("");
  });

  it("detects a banned pattern", () => {
    const [passed, detail] = checkFiller("Here is the updated plan with new tasks.");
    expect(passed).toBe(false);
    expect(detail).toContain("filler");
    expect(detail).toContain("meta-commentary about writing");
  });

  it("detects multiple banned patterns", () => {
    const [passed, detail] = checkFiller(
      "Here is the updated plan. In summary, we fixed three bugs. Overall the system is better.",
    );
    expect(passed).toBe(false);
    expect(detail).toContain("meta-commentary about writing");
    expect(detail).toContain("summary preambles");
  });

  it("treats empty text as clean", () => {
    const [passed, detail] = checkFiller("");
    expect(passed).toBe(true);
    expect(detail).toBe("");
  });

  it("detects all seven banned categories", () => {
    const text =
      "Here is the updated analysis. It seems like the system is slower. " +
      "Moving on to the next section, now let's look at the data. " +
      "I am now checking the results. Based on my analysis, this is significant. " +
      "After careful consideration, we proceed. In summary, to recap, overall, " +
      "I chose this approach because it seemed optimal.";
    const [passed, detail] = checkFiller(text);
    expect(passed).toBe(false);
    for (const category of [
      "meta-commentary about writing",
      "hedging qualifiers",
      "redundant transitions",
      "self-referential process narration",
      "filler introductions",
      "summary preambles",
      "excessive justification",
    ]) {
      expect(detail).toContain(category);
    }
  });

  it("does not let clean content cancel a violation", () => {
    const text =
      "Fixed the null pointer in src/auth.py:42. " +
      "In summary, this resolves the critical issue. " +
      "Added unit tests for `handle_login` with 95% coverage.";
    const [passed, detail] = checkFiller(text);
    expect(passed).toBe(false);
    expect(detail).toContain("summary preambles");
    expect(detail).not.toContain("meta-commentary about writing");
  });
});
