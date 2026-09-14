#!/usr/bin/env node
import { isSchemaDetailQuery, runSchemaDetail } from "../cli/commands/schemaDetail.js";
import { emitInvalidInput } from "../cli/errors.js";
import { isServiceDetailQuery, serviceDetailArgs, type ServiceOwner } from "../cli/commands/serviceDetailQuery.js";

// Assigning exitCode lets Node drain piped stdout/stderr before the process
// terminates. Calling process.exit() here truncates large command payloads.
const args = process.argv.slice(2);
// Do not initialize operational registries for static contract discovery. Some
// validate runtime authorities at import time, before main can report a bounded
// selected-authority error (and unrelated authorities are not prerequisites).
const operationDetail = args[0] === "state" && args[2] === "explain" && args.slice(3).some((arg) => ["--section", "--limit", "--cursor"].includes(arg.split("=")[0])) && !args.includes("--help") && !args.includes("-h");
if (isServiceDetailQuery(args)) {
  try {
    process.exitCode = (await import("../cli/commands/serviceDetail.js")).runServiceDetail(args[0] as ServiceOwner, serviceDetailArgs(args), {});
  } catch {
    process.exitCode = emitInvalidInput(
      {},
      {
        format: "json",
        exitCode: 1,
        body: {
          class: "schema_violation",
          message: "Selected runtime authority is unavailable; no state was changed.",
          syntax: "agentera OWNER explain",
          example: "npx -y agentera@next report explain",
          recovery: "Restore the selected runtime authority and retry.",
        },
      },
    );
  }
} else if (args[0] === "prime" && args.slice(1).some((arg) => ["--detail", "--section", "--limit", "--cursor"].includes(arg.split("=")[0])) && !args.includes("--help") && !args.includes("-h")) {
  process.exitCode = (await import("../cli/commands/capabilityDetail.js")).runCapabilityDetail(args.slice(1), {});
} else if (args[0] === "route" && args[1] === "explain") {
  process.exitCode = (await import("../cli/commands/routeDetail.js")).runRouteDetail(args.slice(2), {});
} else if (operationDetail) {
  try {
    process.exitCode = (await import("../cli/commands/state/explainDetail.js")).runStateExplainDetail(args[1], args.slice(3), {});
  } catch (error) {
    emitInvalidInput(
      {},
      {
        format: "json",
        body: {
          class: "unsupported_target",
          message: `Operation authority unavailable: ${(error as Error).message}`,
          syntax: "agentera state ARTIFACT explain --verb VERB --section detail",
          example: "npx -y agentera@next state plan explain --verb create --section detail",
          recovery: "Restore the selected runtime authority and retry; no state was changed.",
        },
      },
    );
    process.exitCode = 1;
  }
} else process.exitCode = args[0] === "schema" && isSchemaDetailQuery(args.slice(1)) && !args.includes("--help") && !args.includes("-h") ? runSchemaDetail(args.slice(1), {}) : (await import("../cli/dispatch.js")).main(process.argv);
