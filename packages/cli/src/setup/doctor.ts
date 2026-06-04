/**
 * Setup diagnosis and confirmed installation for an Agentera suite bundle.
 * Faithful TS port of scripts/setup_doctor.py. Implementation is split across
 * `setup/doctor/` by responsibility; this file preserves the original import path.
 */

export * from "./doctor/core.js";
export * from "./doctor/opencode.js";
export * from "./doctor/diagnostics.js";
export * from "./doctor/report.js";
