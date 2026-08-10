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

function normalizedPackedFiles(files) {
  if (!Array.isArray(files)) throw new Error("constructed package is missing files");
  const normalized = files.map((entry, index) => {
    const file = entry && typeof entry === "object" ? entry : {};
    const filePath = requireString(file.path, `files[${index}].path`);
    if (filePath.startsWith("/") || filePath.split("/").some((part) => part === "" || part === "." || part === "..")) {
      throw new Error(`constructed package has unsafe file path '${filePath}'`);
    }
    return {
      ...file,
      path: filePath,
      size: requireSize(file.size, `files[${index}].size`),
      mode: requireSize(file.mode, `files[${index}].mode`),
    };
  });
  const paths = normalized.map(({ path }) => path);
  if (new Set(paths).size !== paths.length) throw new Error("constructed package has duplicate file paths");
  const sourceMap = paths.find((file) => file.endsWith(".map"));
  if (sourceMap) throw new Error(`constructed package contains forbidden source map '${sourceMap}'`);
  const executable = normalized.find(({ path }) => path === "dist/bin/agentera.js");
  if (!executable) throw new Error("constructed package is missing executable dist/bin/agentera.js");
  if (executable.mode !== 0o755) {
    throw new Error(`constructed package executable dist/bin/agentera.js has mode ${executable.mode.toString(8)}; expected 755`);
  }
  return normalized;
}

export function normalizeConstruction(packed, options) {
  const name = requireString(packed?.name, "name");
  const version = requireString(packed?.version, "version");
  if (name !== options.expectedName || version !== options.expectedVersion) {
    throw new Error(
      `constructed package identity ${name}@${version} does not match committed metadata ${options.expectedName}@${options.expectedVersion}`,
    );
  }
  const files = normalizedPackedFiles(packed.files);

  return {
    ...packed,
    name,
    version,
    files,
    fileCount: files.length,
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

export function npmChildEnvironment(environment, userConfig, globalConfig) {
  const sanitized = Object.fromEntries(
    Object.entries(environment).filter(
      ([key]) => !/^(?:npm|pnpm)/i.test(key) && !["NPM_TOKEN", "NODE_AUTH_TOKEN"].includes(key),
    ),
  );
  return {
    ...sanitized,
    ...(userConfig ? { NPM_CONFIG_USERCONFIG: userConfig } : {}),
    ...(globalConfig ? { NPM_CONFIG_GLOBALCONFIG: globalConfig } : {}),
  };
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
