function requireString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`constructed package is missing ${field}`);
  }
  return value;
}

function requireSize(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`constructed package has invalid ${field}`);
  }
  return value;
}

export function normalizeConstruction(packed, options) {
  const name = requireString(packed?.name, "name");
  const version = requireString(packed?.version, "version");
  if (name !== options.expectedName || version !== options.expectedVersion) {
    throw new Error(
      `constructed package identity ${name}@${version} does not match committed metadata ${options.expectedName}@${options.expectedVersion}`,
    );
  }
  if (!Array.isArray(packed.files)) throw new Error("constructed package is missing files");

  return {
    ...packed,
    name,
    version,
    fileCount: packed.files.length,
    packedSize: requireSize(packed.size, "packed size"),
    unpackedSize: requireSize(packed.unpackedSize, "unpacked size"),
    shasum: requireString(packed.shasum, "shasum"),
    integrity: requireString(packed.integrity, "integrity"),
    expectedTag: requireString(options.expectedTag, "expected tag"),
    artifact: options.artifact ?? null,
    warnings: Array.isArray(options.warnings)
      ? options.warnings.filter((warning) => typeof warning === "string" && warning.length > 0)
      : [],
  };
}

export function npmChildEnvironment(environment, userConfig) {
  const sanitized = Object.fromEntries(
    Object.entries(environment).filter(
      ([key]) => !/^(?:npm|pnpm)/i.test(key) && !["NPM_TOKEN", "NODE_AUTH_TOKEN"].includes(key),
    ),
  );
  return userConfig ? { ...sanitized, NPM_CONFIG_USERCONFIG: userConfig } : sanitized;
}

export function projectConstruction(construction, includeFiles = false) {
  if (includeFiles) return construction;
  const { files: _files, ...bounded } = construction;
  return bounded;
}

export function formatConstruction(construction, mode = "default") {
  if (mode === "json") return JSON.stringify(construction);
  if (mode === "verbose") return JSON.stringify(construction, null, 2);
  const warningCount = construction.warnings.length;
  return [
    `${construction.name}@${construction.version}`,
    `tag ${construction.expectedTag}`,
    `${construction.fileCount} files`,
    `${construction.packedSize} B packed`,
    `${construction.unpackedSize} B unpacked`,
    `shasum ${construction.shasum}`,
    `integrity ${construction.integrity}`,
    `artifact ${construction.artifact ?? "not created (dry run)"}`,
    `warnings ${warningCount === 0 ? "none" : warningCount}`,
  ].join("; ");
}
