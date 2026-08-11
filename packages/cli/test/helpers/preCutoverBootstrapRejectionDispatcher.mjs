import path from "node:path";
import { pathToFileURL } from "node:url";

const [runtimeRoot, requestsJson] = process.argv.slice(2);

try {
  const requests = JSON.parse(requestsJson);
  if (!Array.isArray(requests)) throw new Error("rejection batch requires an array");
  const authority = await import(pathToFileURL(path.join(runtimeRoot, "dist/core/developmentInvocation.js")).href);
  const results = requests.map(({ id, identity, candidate }) => {
    try {
      authority.bindDevelopmentInvocation(identity, candidate);
      return { id, classification: "accepted" };
    } catch (error) {
      return {
        id,
        classification: error && typeof error === "object" && "classification" in error
          ? error.classification
          : "invalid_authority",
      };
    }
  });
  process.stdout.write(`${JSON.stringify(results)}\n`);
  process.exit(results.some(({ classification }) => classification === "accepted") ? 65 : 0);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ diagnostic: String(error?.message ?? error) })}\n`);
  process.exit(64);
}
