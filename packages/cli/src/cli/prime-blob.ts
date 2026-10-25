import { preCutoverInstructionBody } from "./preCutoverCommand.js";

/**
 * The operating manual. Bare prime carries it in its `manual` field and
 * `prime --guidance` prints it as text; this constant is the only copy, so
 * capability capsules do not repeat its recovery and discovery rules.
 */
export const PRIME_MANUAL = preCutoverInstructionBody(
  [
    "Agentera operating manual. Discovery grants no permission.",
    "",
    "Offers: `shared_skill.upgrade_offer`, `state_cutover.migration_offer` and the product-v1 reset each give a question, `blocking` and an `apply_command`. Show effects and loss, ask the question verbatim once, and run the unchanged `apply_command` only on explicit Yes. Ask one question per reply: a blocking offer before the next-step suggestion, a non-blocking offer only when nothing else is pending, at most once per session. On a `product_v1_eol` error, preview `npx -y agentera@next upgrade --reset-product-v1 --dry-run`; reset has no undo. Retry an interrupted apply unchanged. Done means exit 0 and `status` `success` or `noop` (reset: `complete`); else report the failure.",
    "",
    "Recovery: if the CLI is missing or fails, or output is malformed or incompatible, stop the affected workflow and report. Never fall back to checkout or installed companion reads, guess flags or use older guidance. Invalid selector or stale cursor: run the error's exact recovery command. Runtime failure: read `npx -y agentera@next <doctor|app-home|upgrade> --explain`; if that fails, ask the user to restore the CLI. Blocked or degraded startup: follow its recovery and `detail_command`.",
    "",
    "Discovery: `npx -y agentera@next schema [--protocol|--artifact <name>]`, `npx -y agentera@next <report|check|route> explain`, `npx -y agentera@next prime --context <capability> [--detail <kind>]`. Follow each `next_command` to the end. Use native tools for source code.",
    "",
    "State: write only through typed writers, which override any path-based advice. Read `npx -y agentera@next state <artifact> explain` first; preview with `--dry-run`. Never edit `.agentera/entities/`. Find artifacts with `npx -y agentera@next state query --list-artifacts`; read raw files only after the exact detail command fails. Only the user or owning capability changes vision or objective; only the user confirms satisfaction.",
    "",
    "Receipt: on `semantic_required`, send every receipt field, null when unused; copy both hashes unchanged; `remainder_span` ends at the request's UTF-8 byte length.",
    "",
    "Handoffs: `next_action` is a suggestion; start it once, only if the user accepts. Override it only on what the user said this session, and say why. `route`: the user named it, start it. `suggest`: recommend, then wait. `dispatch`: only inside a flow the current capability owns. `chain`: only inside authorized orchestration.",
    "",
    "Consent: install, update, migration, reset, cleanup and history acquisition each need their own explicit Yes. Commit only when authorized; push only on explicit instruction. Never commit secrets or expose private history or profile data.",
  ].join("\n"),
);
