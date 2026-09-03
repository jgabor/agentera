import { MAJOR_BOUNDARY_ITEM_TAG, type CrossMajorPlanItem, type UpgradePreviewV2 } from "../../../src/upgrade/compatibility.js";

export function collectV3MigrationOperations(preview: UpgradePreviewV2): CrossMajorPlanItem[] {
  const out: CrossMajorPlanItem[] = [];
  for (const phase of preview.phases) {
    for (const item of phase.items) {
      if (item.verb === "migrate" && item.tag === MAJOR_BOUNDARY_ITEM_TAG) {
        out.push(item);
      }
    }
  }
  return out;
}
