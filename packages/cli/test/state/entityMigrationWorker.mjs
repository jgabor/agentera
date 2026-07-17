import { applyEntityMigration, rollbackEntityMigration } from "../../dist/state/entityMigrationApply.js";

if (process.env.AGENTERA_ENTITY_MIGRATION_WORKER_OPERATION === "rollback") {
  rollbackEntityMigration(process.env.AGENTERA_ENTITY_MIGRATION_CRASH_PROJECT, process.env.AGENTERA_ENTITY_MIGRATION_CRASH_SOURCE_ROOT, process.env.AGENTERA_ENTITY_MIGRATION_ID);
} else {
  applyEntityMigration(process.env.AGENTERA_ENTITY_MIGRATION_CRASH_PROJECT, process.env.AGENTERA_ENTITY_MIGRATION_CRASH_SOURCE_ROOT, process.env.AGENTERA_ENTITY_MIGRATION_CRASH_FINGERPRINT, process.env.AGENTERA_ENTITY_MIGRATION_CRASH_DIGEST);
}
