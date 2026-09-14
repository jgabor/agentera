import path from "node:path";
import { CAPABILITY_INSTRUCTIONS, capabilityInstructionModulePath } from "../../capabilities/index.js";
import type { JsonObject } from "../../core/jsonValue.js";
import { loadEvaluatorHandoffContract } from "../../registries/evaluatorHandoffContract.js";
import { guidanceQuote, type GuidanceSection } from "../guidanceDetail.js";

/** Projections of existing compiled obligations, not a worker/host registry. */
export function workerSections(capability: string, root: string, read: (relative: string) => JsonObject): GuidanceSection[] {
  const content = CAPABILITY_INSTRUCTIONS[capability];
  if (!content) throw new Error("Missing compiled worker instructions.");
  // Keep the entire body: qualifications also live in startup, safety,
  // verification, exit and cross-capability sections. Headings are navigation,
  // never a substitute execution model or a fabricated role definition.
  const execution = Object.fromEntries(content.split(/(?=^## )/m).map((body, i) => [`${i + 1}: ${body.split("\n")[0].replace(/^#+\s*/, "")}`, body]));
  const flows = Object.entries(execution).filter(([, body]) => /host['’]s worker|host-provided worker|subagents?|sub-agent|adversarial review/i.test(body));
  const authority = capabilityInstructionModulePath(capability);
  const base = `npx -y agentera@next prime --context ${capability} --detail worker`;
  const sections: GuidanceSection[] = [
    {
      name: "handoff",
      authority,
      classification: "worker_contract_navigation_not_execution_permission",
      content: {
        status: flows.length ? "defined" : "not_applicable",
        reason: flows.length
          ? "Read the full execution contract, shared protocol and related validation/exit details; role labels alone do not define a handoff."
          : "This capability defines no worker-spawn flow. It may be a delegated target; its complete execution contract still governs. No worker executor or host registration is implied.",
        flows: flows.map(([name]) => ({
          name,
          command: `${base} --section ${guidanceQuote(`execution.${encodeURIComponent(name).replaceAll(".", "%2E")}`)}`,
        })),
        execution_command: `${base} --section execution`,
        validation_command: `npx -y agentera@next prime --context ${capability} --detail validation`,
        exit_command: `npx -y agentera@next prime --context ${capability} --detail exit`,
      },
    },
    {
      name: "execution",
      content: execution,
      authority,
      classification: "complete_compiled_worker_and_execution_obligations",
    },
  ];
  if (capability === "audit" || capability === "orchestrate") {
    const relative = "references/cli/capability-instruction-contract.yaml";
    const mapping = read(relative);
    if (mapping.schema_version !== "agentera.capability_instruction_contract.v1" || mapping.status !== "active_authority") throw new Error("Incompatible evaluator authority.");
    const evaluator = mapping.evaluator_handoff as JsonObject;
    const row = evaluator?.row_schema as JsonObject;
    const formats = row?.citation_formats as JsonObject;
    const fileLine = formats?.file_line as JsonObject;
    const notApplicable = formats?.not_applicable as JsonObject;
    const warn = row?.warn_verify_command as JsonObject;
    const output = (evaluator?.orchestration_context_fields as JsonObject)?.output_requirements as JsonObject;
    if (
      evaluator?.status !== "implemented" ||
      evaluator.report_schema_version !== "agentera.inspekteraEvaluationReport.v1" ||
      typeof evaluator.evidence_policy !== "string" ||
      !evaluator.evidence_policy.trim() ||
      !Array.isArray(row?.required_fields) ||
      !["criterion", "status", "evidence"].every((field) => (row.required_fields as unknown[]).includes(field)) ||
      !Array.isArray(row.status_values) ||
      !["PASS", "WARN", "FAIL"].every((value) => (row.status_values as unknown[]).includes(value)) ||
      !Array.isArray(row.citation_required_for) ||
      !["WARN", "FAIL"].every((value) => (row.citation_required_for as unknown[]).includes(value)) ||
      typeof fileLine?.pattern !== "string" ||
      !fileLine.pattern.trim() ||
      typeof notApplicable?.prefix !== "string" ||
      !notApplicable.prefix.trim() ||
      typeof notApplicable.min_reason_length !== "number" ||
      !Number.isSafeInteger(notApplicable.min_reason_length) ||
      notApplicable.min_reason_length < 1 ||
      warn?.required_when !== "file_line_citation" ||
      !Array.isArray(warn.allowed_prefixes) ||
      !warn.allowed_prefixes.length ||
      warn.allowed_prefixes.some((prefix) => typeof prefix !== "string" || !prefix.trim()) ||
      !output ||
      output.warn_verify_command_required !== true ||
      JSON.stringify(output.citation_required_for) !== JSON.stringify(row.citation_required_for) ||
      output.schema_authority !== `${relative}#evaluator_handoff`
    )
      throw new Error("Invalid evaluator handoff structure.");
    loadEvaluatorHandoffContract(path.join(root, relative));
    sections.push({
      name: "evaluator",
      content: evaluator,
      authority: `${relative}#evaluator_handoff`,
      classification: "governing_evaluator_input_output_evidence_contract",
    });
  }
  return sections;
}
