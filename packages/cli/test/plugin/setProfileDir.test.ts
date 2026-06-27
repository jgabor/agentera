// Tests for the OpenCode plugin's setProfileDir(): the AGENTERA_PROFILE_DIR writer
// with its deprecated PROFILERA_PROFILE_DIR alias fallback (migration bridge for
// v2 installs that haven't run `agentera upgrade` yet).
import path from "node:path";

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
    vi.restoreAllMocks();
  });

  describe("precedence regression (#24)", () => {
    it("canonical-wins: respects AGENTERA_PROFILE_DIR and does not overwrite or warn", () => {
      process.env.AGENTERA_PROFILE_DIR = "/canonical/profile";
      process.env.PROFILERA_PROFILE_DIR = "/legacy/profile";

      setProfileDir();

      expect(process.env.AGENTERA_PROFILE_DIR).toBe("/canonical/profile");
      expect(process.env.PROFILERA_PROFILE_DIR).toBe("/legacy/profile");
      expect(writeSpy).not.toHaveBeenCalled();
    });

    it("legacy-adopted: copies PROFILERA_PROFILE_DIR into AGENTERA_PROFILE_DIR, warns once, and never creates PROFILERA_PROFILE_DIR", () => {
      process.env.PROFILERA_PROFILE_DIR = "/legacy/profile";

      setProfileDir();

      expect(process.env.AGENTERA_PROFILE_DIR).toBe("/legacy/profile");
      expect(process.env.PROFILERA_PROFILE_DIR).toBe("/legacy/profile");
      expect(writeSpy).toHaveBeenCalledTimes(1);
      expect(writeSpy.mock.calls[0][0]).toContain("PROFILERA_PROFILE_DIR is deprecated");
      expect(writeSpy.mock.calls[0][0]).toContain("agentera upgrade");
    });

    it("default-seeded: seeds AGENTERA_PROFILE_DIR from the platform data-home default without touching PROFILERA_PROFILE_DIR", () => {
      delete process.env.AGENTERA_PROFILE_DIR;
      delete process.env.PROFILERA_PROFILE_DIR;

      setProfileDir();

      const expected =
        process.platform === "darwin"
          ? path.join(process.env.HOME!, "Library", "Application Support", "agentera")
          : process.platform === "win32"
            ? path.join(
                process.env.APPDATA ||
                  path.join(process.env.USERPROFILE!, "AppData", "Roaming"),
                "agentera",
              )
            : path.join(
                process.env.XDG_DATA_HOME ||
                  path.join(process.env.HOME!, ".local", "share"),
                "agentera",
              );

      expect(process.env.AGENTERA_PROFILE_DIR).toBe(expected);
      expect(process.env.PROFILERA_PROFILE_DIR).toBeUndefined();
      expect(writeSpy).not.toHaveBeenCalled();
    });

    it.each([
      {
        platform: "darwin" as const,
        home: "/Users/tester",
        expected: path.join("/Users/tester", "Library", "Application Support", "agentera"),
      },
      {
        platform: "win32" as const,
        home: "C:\\Users\\tester",
        appdata: "C:\\Users\\tester\\AppData\\Roaming",
        expected: path.join("C:\\Users\\tester\\AppData\\Roaming", "agentera"),
      },
      {
        platform: "linux" as const,
        home: "/home/tester",
        expected: path.join("/home/tester", ".local", "share", "agentera"),
      },
    ])(
      "default-seeded on $platform uses AGENTERA_PROFILE_DIR only",
      ({ platform, home, appdata, expected }) => {
        vi.spyOn(process, "platform", "get").mockReturnValue(platform);
        process.env.HOME = home;
        if (appdata !== undefined) process.env.APPDATA = appdata;
        if (platform === "win32") process.env.USERPROFILE = home;
        delete process.env.XDG_DATA_HOME;
        delete process.env.AGENTERA_PROFILE_DIR;
        delete process.env.PROFILERA_PROFILE_DIR;

        setProfileDir();

        expect(process.env.AGENTERA_PROFILE_DIR).toBe(expected);
        expect(process.env.PROFILERA_PROFILE_DIR).toBeUndefined();
        expect(writeSpy).not.toHaveBeenCalled();
      },
    );
  });

  it("emits the deprecation warning only once per process", () => {
    process.env.PROFILERA_PROFILE_DIR = "/legacy/profile";

    setProfileDir();
    setProfileDir();

    expect(process.env.AGENTERA_PROFILE_DIR).toBe("/legacy/profile");
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });
});
