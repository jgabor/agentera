export function parseReleaseFlags(values, options = {}) {
  const booleanFlags = new Set(options.boolean ?? []);
  const valueFlags = new Set(options.value ?? []);
  const flags = new Map();
  let separatorSeen = false;

  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index];
    if (flag === "--") {
      if (separatorSeen) throw new Error("unexpected duplicate pnpm argument separator '--'");
      separatorSeen = true;
      continue;
    }
    if (!booleanFlags.has(flag) && !valueFlags.has(flag)) {
      throw new Error(`unexpected argument '${flag}'`);
    }
    if (flags.has(flag)) throw new Error(`duplicate argument '${flag}'`);
    if (booleanFlags.has(flag)) {
      flags.set(flag, true);
      continue;
    }
    const value = values[index + 1];
    if (!value || value === "--" || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    flags.set(flag, value);
    index += 1;
  }
  return flags;
}
