const DEVELOPMENT_VERSION = /^(\d+)\.(\d+)\.(\d+)-dev\.(0|[1-9]\d*)$/;
// publish.yml started after publish-next.yml had published dev.89. Its first run must be dev.90.
export const DEVELOPMENT_RUN_NUMBER_OFFSET = 89;

function parseDevelopmentVersion(version, label) {
  const match = typeof version === "string" ? DEVELOPMENT_VERSION.exec(version) : null;
  if (!match) throw new Error(`${label} must be a development version matching X.Y.Z-dev.N`);
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1;
  }
  return 0;
}

export function allocateDevelopmentVersion(manifestVersion, runNumber) {
  const [major, minor, patch] = parseDevelopmentVersion(manifestVersion, "package manifest version");
  const parsedRunNumber = typeof runNumber === "string" && /^(?:0|[1-9]\d*)$/.test(runNumber) ? Number(runNumber) : runNumber;
  if (!Number.isSafeInteger(parsedRunNumber) || parsedRunNumber <= 0) {
    throw new Error("GitHub run number must be a positive safe integer");
  }
  const ordinal = parsedRunNumber + DEVELOPMENT_RUN_NUMBER_OFFSET;
  if (!Number.isSafeInteger(ordinal)) throw new Error("allocated development ordinal is not a safe integer");
  return `${major}.${minor}.${patch}-dev.${ordinal}`;
}

export function classifyDevelopmentPublication({ version, integrity, source, currentNext, published }) {
  const order = compareVersions(parseDevelopmentVersion(version, "candidate package version"), parseDevelopmentVersion(currentNext, "npm @next version"));
  const exists = published?.integrity != null || published?.source != null;
  const matches = published?.integrity === integrity && published?.source === source;

  if (order === 0) {
    if (!matches) throw new Error("npm @next does not match the candidate version integrity and source");
    return "exact-replay";
  }
  if (order < 0) {
    if (!matches) throw new Error(`older version is ${exists ? "conflicting" : "absent"} on npm`);
    return "superseded-replay";
  }
  if (exists && !matches) throw new Error("forward version already exists with conflicting integrity or source");
  return exists ? "forward-retag" : "forward-publish";
}
