import type { EntityPublicationContext } from "./entityPublicationContext.js";
import { acquireWriterLock } from "./write/lock.js";

const heldEntityWriterLocks = new Set<string>();

export function withEntityWriterLock<T>(context: EntityPublicationContext, run: () => T): T {
  context.assertValid();
  const root = context.pinnedPath();
  if (heldEntityWriterLocks.has(root)) return run();
  const lock = acquireWriterLock(root, 2000);
  try {
    heldEntityWriterLocks.add(root);
    context.assertValid();
    return run();
  } finally {
    heldEntityWriterLocks.delete(root);
    lock.release();
  }
}
