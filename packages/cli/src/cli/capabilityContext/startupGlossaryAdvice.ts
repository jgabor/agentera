import type { AcquiredGlossaryInputs } from "../../analytics/glossaryInputAcquisition.js";
import { resolveGlossaryAdvice, type GlossaryAdvice } from "../../analytics/glossaryAdviceResolution.js";

const STARTUP_ADVICE_CAPABILITIES = new Set(["discuss", "plan", "build"]);

export function resolveStartupGlossaryAdvice(
  capability: string,
  selectedTerm: string,
  acquired: AcquiredGlossaryInputs,
): GlossaryAdvice {
  if (!STARTUP_ADVICE_CAPABILITIES.has(capability)) throw new Error("unsupported startup advice capability");
  return resolveGlossaryAdvice(selectedTerm, acquired);
}
