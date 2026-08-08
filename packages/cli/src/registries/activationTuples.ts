import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

export interface ActivationCanonicalTuple {
  readonly class: string;
  readonly surface_id: string;
  readonly owner_path: string;
  readonly owner_symbol_or_selector: string;
  readonly owner_selector: string | null;
  readonly semantic_selector_if_any: string | null;
  readonly canonical_correction: string;
}

// This compressed literal is the immutable, code-owned tuple catalog. It expands
// only into exact tuple records; no production loader participates in authority.
const CATALOG = [
  "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",
  "wqD+t/8DfpAaejqfAQA=",
].join("");

// Emitted producers carry `reason`, while generated files carry
// `command_authority_reason`. This immutable patch catalog intentionally updates
// the M6 tuple payload without consulting the mutable package registry loader.
const EMITTED_REASON_CATALOG = "H4sIAAAAAAACA8VYXXPrJhD9K0ye6+v3+9Z8zPShHbfx7X1HsJaYYFAAqfZ0+t+7fEhCsRNbTiy/xAIUnbMLu3uWf+9gK5wD/r2m7IWWYJdMiqU1bMloTQshhRM4KRSH3Tdn777fPehtLcEB6V/Yk0JzfItQxYl11LimJkxvtzi2pKbWElcZ3ZQV/gKxFTXASW1gwRqnWzD4srLONMxpk76iG8NgmUgR3bi6ccQyquy3u18+II2/tRFbWBRSF28IIzUnGAnrpGwEp4pB4AdHGYpESmi1QAv3Oc1Ps6xA1pHfb/hEYEc9y/fdlfx5wIF11vkPJgroQwNv2XlaCvhJYltRGuptfobXRiB0ZPkHZZVQQAwwv2V7shEgcXt7PmgC4H7SQmbO1Urue2twxx/ihj9EY05y0UaAcoHNmEW2MAuRWlL1u9gA2zMJawSGMR/Zrc3Cxh9k+KvBXRizePVTww7VRlsYmNhrUHGa62egHOGtXYMEdrhZP1aPK2TlcM9aKq/uIQOlsB7MLqt9YQR/xqiAZ2AgaheZhRnvKD/VpyzauAoPltt/zmchLCtqSQEVbYU2aHNKDawC9nI6NwyZ9UErBzu3LECxakvNS0ppWertVmY5eUeYNUKmFHHvHz2+X7gRHSbxzKO3k5/S6Nak8NdQ5g42r1u4ES9oBcfjk3LZUxrd2FnaYJQgYJb1V/nUjenFchx5rVNpHjb0NpzcvgYbKf3AR042VMoC/5dw2NBGuvm9FFPqr2WJ2TjbyXWXalsqZOc0ny+5sF+nK1IGboHQRACmZuCkXjPTjgRvBJtVEfXEgoqNnP4MgrajwwUtlbaodL/Kicdl7lRPvg56JUiXnvCsbjO+8uci4Hpuu7j8YyzU1LEq77oe0xw2S/156756VYHXk+klbiTUq+GZ+YwDIO8QVgG+qxhDf5BozR+dOJReED8ph/li9baXidOjVuZ2VIOMewowqfXDgpvLOhOnvixOJhNEN20OfHjvZ2ftBguhljiBZc7QVHKxSc9AcMn3XlooR+qmkMKidiF8iN+0ya6i+MdQZYUTLcioBqlQFnlSw7Oev+M9vRAPDIelRS+gKKPcx+8CdrU2LgeOb2AHyRsG5rKWxdb6JWWL+zjIpVLCsGMfJI8duCBu6wU0shz6jhvCG9fyQhJCY/XTfdjfPG0LfxSPuADsxU44moWy2MkuMPJEGa4Vrk7KYhBsU+isw3MfER8D/oOtebgrnBoUPbK3b8k1S1r5EZ8W0ejzGHwWuoQUkE87bPoWODwTeLg8uRT6TRhEqzt73o2A+NqE8z8GRStcpxbsfLb6O6lkqr95uj5sU5cGM2nE/DsOzoZN4uli1J9gxGY/xm79nGAjUXE9Im3G4Od05MlR1dXS4Thn1fX9opbYnH+ae+kbdHvq//xjj3fEGjxBaEYwf9QcRvTzMQ/6uw8wuwvMqRh2qAOhJJzA6PPkhwg+hvKL1yccN5lk85NClQT6+VMHpDMPd64FdfKIDEnAJ/igskV/PRKvorEAMyzT0+LjMD/89z8hk4jWPxsAAA==";

const decodedCatalog = gunzipSync(Buffer.from(CATALOG, "base64")).toString("utf8");
const emittedReasons = JSON.parse(gunzipSync(Buffer.from(EMITTED_REASON_CATALOG, "base64")).toString("utf8")) as Record<string, string>;
const rawTuples = JSON.parse(decodedCatalog.slice(decodedCatalog.indexOf("[", 2)).replace(/,\s*]$/, "]")) as ActivationCanonicalTuple[];
const addedTuples: ActivationCanonicalTuple[] = [
  { class: "state", surface_id: "write:todo.activate", owner_path: "packages/cli/src/state/write/runtimeOperations.ts", owner_symbol_or_selector: "runtimeOperationSpecs", owner_selector: "todo.activate", semantic_selector_if_any: null, canonical_correction: "node packages/cli/dist/bin/agentera.js check validate state --format json" },
  { class: "state", surface_id: "write:todo.repair", owner_path: "packages/cli/src/state/write/runtimeOperations.ts", owner_symbol_or_selector: "runtimeOperationSpecs", owner_selector: "todo.repair", semantic_selector_if_any: null, canonical_correction: "node packages/cli/dist/bin/agentera.js check validate state --format json" },
  { class: "package", surface_id: "emitted:packages/cli/src/cli/commands/doctor.ts", owner_path: "packages/cli/src/registries/packageRegistry.ts", owner_symbol_or_selector: "loadRegistry", owner_selector: "packages/cli/src/cli/commands/doctor.ts", semantic_selector_if_any: JSON.stringify({ path: "packages/cli/src/cli/commands/doctor.ts", selector: null, format: null, classification: null, reason: "Doctor project-state signals publish bounded reconciliation preview and apply guidance." }), canonical_correction: "pnpm -C packages/cli run verify:package" },
  { class: "package", surface_id: "emitted:packages/cli/src/state/todoReconciliationInspection.ts", owner_path: "packages/cli/src/registries/packageRegistry.ts", owner_symbol_or_selector: "loadRegistry", owner_selector: "packages/cli/src/state/todoReconciliationInspection.ts", semantic_selector_if_any: JSON.stringify({ path: "packages/cli/src/state/todoReconciliationInspection.ts", selector: null, format: null, classification: null, reason: "TODO reconciliation inspection publishes bounded preview and effect-bound apply guidance." }), canonical_correction: "pnpm -C packages/cli run verify:package" },
];
const tuples = [...rawTuples, ...addedTuples].map((tuple): ActivationCanonicalTuple => {
  const reason = emittedReasons[tuple.surface_id];
  if (tuple.class !== "package" || reason === undefined || tuple.semantic_selector_if_any === null) return tuple;
  const semantic = JSON.parse(tuple.semantic_selector_if_any) as Record<string, unknown>;
  return { ...tuple, semantic_selector_if_any: JSON.stringify({ ...semantic, reason }) };
});
export const ACTIVATION_CANONICAL_TUPLES: readonly ActivationCanonicalTuple[] = Object.freeze(
  tuples.map((tuple) => Object.freeze(tuple)),
);
export const ACTIVATION_TUPLE_AUTHORITY = Object.freeze({
  algorithm: "sha256(sorted_canonical_json_tuples_joined_by_lf)" as const,
  classes: {
    cli: { count: 27, sha256: "9d0db6cafe592da30ea3469c91dc514bdd1b3b22e8229a0519e680cbcb01c2fa" },
    capability: { count: 12, sha256: "892e6e5e2a57b41064bc44fa2946453225f1b1195aff77aad05365fd0a1071c2" },
    runtime: { count: 81, sha256: "99b2abff3ebff889b54b1781c563ab4b32609a479c4e90d6aad854f48fba7edc" },
    reference: { count: 22, sha256: "243fd3c317553f8924c56a52c61af90ccf2793b7b0018af1373b73c69b6c3afb" },
    state: { count: 36, sha256: "c3366cd6d538a47b5554f2e142eb255ac371bfc77e89128aceb59dfd8376c20a" },
    package: { count: 66, sha256: "83e6971af7f7564e42369aaccc445b32a0793bfffade843d149b6abd4fd3dbbc" },
    bootstrap: { count: 34, sha256: "9a7dd7e27110d85cf5c08835fdd8f08119e75579858e63bc6d396c733961d0bc" },
  },
  total: { count: 278, sha256: "52a349aa3901626cba0bef4e06d380067722d73d3039fea95f2d806a8018fe54" },
});
export function canonicalTupleJson(value: ActivationCanonicalTuple): string { return JSON.stringify(value); }
export function digestCanonicalTuples(values: readonly ActivationCanonicalTuple[]): string {
  return createHash("sha256").update(values.map(canonicalTupleJson).sort().join("\n"), "utf8").digest("hex");
}
