// Tests for the OpenCode plugin's setProfileDir(): the AGENTERA_PROFILE_DIR writer
// with its deprecated PROFILERA_PROFILE_DIR alias fallback (migration bridge for
// v2 installs that haven't run `agentera upgrade` yet).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Agentera } from "../../../../.opencode/plugins/agentera.js";

const { setProfileDir, profileraDeprecation } = Agentera.__test;

describe("setProfileDir", () => {
  let prevAgentera: string | undefined;
  let prevProfilera: string | undefined;
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    prevAgentera = process.env.AGENTERA_PROFILE_DIR;
    prevProfilera = process.env.PROFILERA_PROFILE_DIR;
    delete process.env.AGENTERA_PROFILE_DIR;
    delete process.env.PROFILERA_PROFILE_DIR;
    profileraDeprecation.warned = false;
    writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    if (prevAgentera === undefined) delete process.env.AGENTERA_PROFILE_DIR;
    else process.env.AGENTERA_PROFILE_DIR = prevAgentera;
    if (prevProfilera === undefined) delete process.env.PROFILERA_PROFILE_DIR;
    else process.env.PROFILERA_PROFILE_DIR = prevProfilera;
    writeSpy.mockRestore();
  });

  it("adopts the legacy PROFILERA_PROFILE_DIR value and warns on stderr when AGENTERA_PROFILE_DIR is absent", () => {
    process.env.PROFILERA_PROFILE_DIR = "/legacy/profile";

    setProfileDir();

    expect(process.env.AGENTERA_PROFILE_DIR).toBe("/legacy/profile");
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy.mock.calls[0][0]).toContain("PROFILERA_PROFILE_DIR is deprecated");
    expect(writeSpy.mock.calls[0][0]).toContain("agentera upgrade");
  });

  it("emits the deprecation warning only once per process", () => {
    process.env.PROFILERA_PROFILE_DIR = "/legacy/profile";

    setProfileDir();
    setProfileDir();

    expect(process.env.AGENTERA_PROFILE_DIR).toBe("/legacy/profile");
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });

  it("respects an already-set AGENTERA_PROFILE_DIR without warning", () => {
    process.env.AGENTERA_PROFILE_DIR = "/canonical/profile";
    process.env.PROFILERA_PROFILE_DIR = "/legacy/profile";

    setProfileDir();

    expect(process.env.AGENTERA_PROFILE_DIR).toBe("/canonical/profile");
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("seeds AGENTERA_PROFILE_DIR from the platform default when neither var is set", () => {
    delete process.env.AGENTERA_PROFILE_DIR;
    delete process.env.PROFILERA_PROFILE_DIR;

    setProfileDir();

    expect(process.env.AGENTERA_PROFILE_DIR).toBeTruthy();
    expect(process.env.AGENTERA_PROFILE_DIR).toContain("agentera");
    expect(writeSpy).not.toHaveBeenCalled();
  });
});
