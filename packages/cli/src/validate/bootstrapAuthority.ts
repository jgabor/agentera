/** Production authority for the source/package bootstrap evidence matrix. */
export const BOOTSTRAP_RUNTIME_IDS = Object.freeze(["source", "package"] as const);
export const BOOTSTRAP_PROJECT_STATE_IDS = Object.freeze(["clean", "v2", "partial", "v3"] as const);

export type BootstrapProjectState = (typeof BOOTSTRAP_PROJECT_STATE_IDS)[number];

export interface BootstrapSpec {
  readonly id: string;
  readonly states: readonly BootstrapProjectState[];
  readonly classification: "accepted" | "wrong_channel" | "not_exact" | "malformed";
  readonly candidate?: string;
}

const spec = (
  id: string,
  states: readonly BootstrapProjectState[],
  classification: BootstrapSpec["classification"],
  candidate?: string,
): BootstrapSpec => Object.freeze({ id, states: Object.freeze([...states]), classification, ...(candidate ? { candidate } : {}) });

export const BOOTSTRAP_ACCEPTED_SPECS = Object.freeze([
  spec("prime-quoted-lf", ["clean"], "accepted"),
  spec("prime-quoted-cr", ["v2"], "accepted"),
  spec("prime", ["partial", "v3"], "accepted"),
  spec("recommended-startup", BOOTSTRAP_PROJECT_STATE_IDS, "accepted"),
  spec("doctor-quoted-lf", ["clean"], "accepted"),
  spec("doctor-quoted-cr", ["v2"], "accepted"),
  spec("doctor", ["partial", "v3"], "accepted"),
  spec("recovery-0", ["clean", "v2", "partial"], "accepted"),
]);

export const BOOTSTRAP_REJECTION_SPECS = Object.freeze([
  spec("reject-bare", BOOTSTRAP_PROJECT_STATE_IDS, "wrong_channel", "agentera prime --context status --format json"),
  spec("reject-bare-next", BOOTSTRAP_PROJECT_STATE_IDS, "wrong_channel", "agentera@next prime --context status --format json"),
  spec("reject-stable", BOOTSTRAP_PROJECT_STATE_IDS, "wrong_channel", "npx -y agentera@latest prime --context status --format json"),
  spec("reject-stable-bare", BOOTSTRAP_PROJECT_STATE_IDS, "wrong_channel", "agentera@latest prime --context status --format json"),
  spec("reject-npx-no-y", BOOTSTRAP_PROJECT_STATE_IDS, "wrong_channel", "npx agentera@next prime --context status --format json"),
  spec("reject-split-selector", BOOTSTRAP_PROJECT_STATE_IDS, "wrong_channel", "npx -y agentera @next prime --context status --format json"),
  spec("reject-missing-format", BOOTSTRAP_PROJECT_STATE_IDS, "not_exact", "npx -y agentera@next prime --context status"),
  spec("reject-reordered", BOOTSTRAP_PROJECT_STATE_IDS, "not_exact", "npx -y agentera@next prime --format json --context status"),
  spec("reject-env-wrapper", BOOTSTRAP_PROJECT_STATE_IDS, "wrong_channel", "env npx -y agentera@next prime --context status --format json"),
  spec("reject-time-wrapper", BOOTSTRAP_PROJECT_STATE_IDS, "wrong_channel", "time npx -y agentera@next prime --context status --format json"),
  spec("reject-eval-wrapper", BOOTSTRAP_PROJECT_STATE_IDS, "wrong_channel", "eval 'npx -y agentera@next prime --context status --format json'"),
  spec("reject-bash-wrapper", BOOTSTRAP_PROJECT_STATE_IDS, "wrong_channel", "bash -c 'npx -y agentera@next prime --context status --format json'"),
  spec("reject-alias", BOOTSTRAP_PROJECT_STATE_IDS, "wrong_channel", "a prime --context status --format json"),
  spec("reject-function", BOOTSTRAP_PROJECT_STATE_IDS, "malformed", "agentera() { :; }; agentera prime --context status --format json"),
  spec("reject-nested", BOOTSTRAP_PROJECT_STATE_IDS, "not_exact", "npx -y agentera@next prime --context 'bash -c whoami' --format json"),
  spec("reject-composition", BOOTSTRAP_PROJECT_STATE_IDS, "malformed", "npx -y agentera@next prime --context status --format json && whoami"),
  spec("reject-multiple", BOOTSTRAP_PROJECT_STATE_IDS, "malformed", "npx -y agentera@next prime --context status --format json; npx -y agentera@next doctor"),
  spec("reject-substitution", BOOTSTRAP_PROJECT_STATE_IDS, "malformed", "npx -y agentera@next prime --context $(whoami) --format json"),
  spec("reject-malformed-quote", BOOTSTRAP_PROJECT_STATE_IDS, "malformed", "npx -y agentera@next prime --context 'status --format json"),
  spec("reject-malformed-channel", BOOTSTRAP_PROJECT_STATE_IDS, "wrong_channel", "npx -y agentera@next@latest prime --context status --format json"),
]);

export function bootstrapMatrixAuthority() {
  return {
    runtimeIds: [...BOOTSTRAP_RUNTIME_IDS],
    stateIds: [...BOOTSTRAP_PROJECT_STATE_IDS],
    accepted: BOOTSTRAP_ACCEPTED_SPECS.map((entry) => ({ ...entry, states: [...entry.states] })),
    rejections: BOOTSTRAP_REJECTION_SPECS.map((entry) => ({ ...entry, states: [...entry.states] })),
  };
}
