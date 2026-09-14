import { afterEach, describe, expect, it, vi } from "vitest";

import { createOverlapProgressForwarder, createVerificationProgress } from "../../scripts/verification-progress.mjs";

const checkpoint = "AGENTERA_VERIFICATION_PROGRESS scope=overlap owner=package status=running elapsedMs=30000\n";

describe("verification progress diagnostics", () => {
  afterEach(() => vi.useRealTimers());

  it("emits immediate start, a thirty-second heartbeat, and one completion", () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    let elapsed = 0;
    const progress = createVerificationProgress("overlap", "package", {
      write: (line: string) => {
        lines.push(line);
        return true;
      },
      now: () => elapsed,
    });
    expect(lines).toEqual(["AGENTERA_VERIFICATION_PROGRESS scope=overlap owner=package status=started elapsedMs=0\n"]);
    elapsed = 30_000;
    vi.advanceTimersByTime(30_000);
    expect(lines.at(-1)).toBe(checkpoint);
    elapsed = 31_000;
    progress.complete("passed");
    progress.complete("failed");
    vi.advanceTimersByTime(60_000);
    expect(lines).toHaveLength(3);
    expect(lines.at(-1)).toBe("AGENTERA_VERIFICATION_PROGRESS scope=overlap owner=package status=passed elapsedMs=31000\n");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["failed", "cancelled"])("stops the heartbeat after %s", (status) => {
    vi.useFakeTimers();
    const write = vi.fn();
    const progress = createVerificationProgress("qualification", "generated-overlap", { write });
    progress.complete(status);
    vi.advanceTimersByTime(60_000);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1][0]).toContain(`status=${status}`);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("forwards only complete whitelisted overlap records across chunk boundaries", () => {
    const lines: string[] = [];
    const forwarder = createOverlapProgressForwarder((line: string) => {
      lines.push(line);
      return true;
    });
    forwarder.feed(checkpoint.slice(0, 37));
    expect(lines).toEqual([]);
    forwarder.feed(checkpoint.slice(37));
    forwarder.feed("private reporter output NPM_TOKEN=secret\n");
    forwarder.feed(checkpoint.replace("owner=package", "owner=/private/path"));
    forwarder.feed(checkpoint.replace("status=running", "status=unknown"));
    forwarder.feed(checkpoint.replace("scope=overlap", "scope=qualification"));
    forwarder.feed(checkpoint.replace("elapsedMs=30000", "elapsedMs=-1"));
    forwarder.feed(`prefix ${checkpoint}`);
    expect(lines).toEqual([checkpoint]);
  });

  it("discards an oversized line until its newline and resumes with the next record", () => {
    const lines: string[] = [];
    const forwarder = createOverlapProgressForwarder((line: string) => {
      lines.push(line);
      return true;
    });
    forwarder.feed("x".repeat(1000));
    forwarder.feed(checkpoint);
    forwarder.feed(checkpoint);
    expect(lines).toEqual([checkpoint]);
  });

  it("rejects owner labels before creating a timer or emitting output", () => {
    vi.useFakeTimers();
    const write = vi.fn();
    expect(() => createVerificationProgress("overlap", "/private/secret", { write })).toThrow("unknown verification progress owner");
    expect(write).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
