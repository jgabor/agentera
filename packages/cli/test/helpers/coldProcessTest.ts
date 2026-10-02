import type { TestContext } from "vite-plus/test";
import { ColdProcessScheduler, type ColdProcessScope, type ColdProcessSchedulerOptions } from "./coldProcessScheduler.js";

// A Vitest timeout stops awaiting the test, not its asynchronous work. Cancel
// children on that signal and drain the whole journey before fixture teardown.
export function coldProcessTest<T>(context: Pick<TestContext, "signal" | "onTestFinished">, callback: (scope: ColdProcessScope) => Promise<T>, options: ColdProcessSchedulerOptions): Promise<T> {
  const scheduler = new ColdProcessScheduler(options);
  const abort = () => {
    void scheduler.cancel(context.signal.reason);
  };
  context.signal.addEventListener("abort", abort, { once: true });
  if (context.signal.aborted) abort();
  const work = scheduler.own(callback);
  context.onTestFinished(async () => {
    context.signal.removeEventListener("abort", abort);
    await scheduler.cancel();
    await work.catch(() => undefined); // The test retains the original failure.
  });
  return work;
}
