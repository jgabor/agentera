#!/usr/bin/env node
import { main } from "../cli/dispatch.js";

// Assigning exitCode lets Node drain piped stdout/stderr before the process
// terminates. Calling process.exit() here truncates large command payloads.
process.exitCode = main(process.argv);
