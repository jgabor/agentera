import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { observeLifecyclePath } from "../runtime/lifecyclePublication.js";
import { diagnoseRetiredResources } from "./retiredResourceDiagnostics.js";

/** Bind one focused cleanup offer to its selected paths, bytes, identities and roots. */
export function cleanupOfferAuthorization(
  resourceId: string,
  roots: {
    home: string;
    project: string;
    installRoot: string;
    sourceRoot: string;
    env?: Record<string, string | undefined>;
  },
): string | null {
  const diagnosis = diagnoseRetiredResources({ ...roots, resourceId });
  const resource = diagnosis.resources[0];
  if (!resource || resource.id !== resourceId || resource.evidence.observation !== "path_present" || resource.evidence.paths.length === 0) return null;
  const paths = resource.evidence.paths.map((destination) => {
    const observed = observeLifecyclePath(destination, [roots.home, roots.project, roots.installRoot]);
    if (observed.unsafeReason || observed.kind !== "file" || !observed.identity || fs.lstatSync(destination).nlink !== 1 || !observed.fingerprint) return null;
    return {
      destination: path.resolve(destination),
      identity: observed.identity,
      fingerprint: observed.fingerprint,
    };
  });
  if (paths.some((value) => value === null)) return null;
  return `cleanup-sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        resourceId,
        home: path.resolve(roots.home),
        project: path.resolve(roots.project),
        installRoot: path.resolve(roots.installRoot),
        sourceRoot: path.resolve(roots.sourceRoot),
        paths,
      }),
    )
    .digest("hex")}`;
}
