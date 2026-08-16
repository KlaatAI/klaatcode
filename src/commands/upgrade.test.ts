import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  classifyUpgradeFailure,
  detectInstallChannelFromPath,
  normalizeExePath,
  repairPlanFor,
  spawnUpgradeCommand,
  upgradeCommandArgv,
  windowsPowerShellExe,
} from "./upgrade.js";

describe("normalizeExePath", () => {
  test("converts backslashes", () => {
    expect(normalizeExePath(String.raw`C:\Users\me\.klaatcode\bin\klaatcode.exe`))
      .toBe("C:/Users/me/.klaatcode/bin/klaatcode.exe");
  });
});

describe("detectInstallChannelFromPath", () => {
  const winHome = "C:/Users/me";
  const unixHome = "/Users/me";

  test("npm global binary in node_modules", () => {
    expect(detectInstallChannelFromPath(
      "C:/Users/me/AppData/Roaming/npm/node_modules/klaatcode-windows-x64/bin/klaatcode.exe",
      "win32",
      "",
      winHome,
    )).toBe("npm");
  });

  test("bun global install path", () => {
    expect(detectInstallChannelFromPath(
      "C:/Users/me/.bun/install/global/node_modules/klaatcode-windows-x64/bin/klaatcode.exe",
      "win32",
      "",
      winHome,
    )).toBe("npm");
  });

  test("Windows PowerShell installer layout", () => {
    expect(detectInstallChannelFromPath(
      "C:/Users/me/.klaatcode/bin/klaatcode.exe",
      "win32",
      "",
      winHome,
    )).toBe("installer-windows");
  });

  test("Unix curl installer layout", () => {
    expect(detectInstallChannelFromPath(
      "/Users/me/.klaatcode/bin/klaatcode",
      "darwin",
      "",
      unixHome,
    )).toBe("installer");
  });

  test("node running npm launcher script on Windows", () => {
    expect(detectInstallChannelFromPath(
      "C:/Program Files/nodejs/node.exe",
      "win32",
      "C:/Users/me/AppData/Roaming/npm/node_modules/klaatcode/bin/klaatcode",
      winHome,
    )).toBe("npm");
  });

  test("brew Cellar layout", () => {
    expect(detectInstallChannelFromPath(
      "/opt/homebrew/Cellar/klaatcode/2.3.4/bin/klaatcode",
      "darwin",
    )).toBe("brew");
  });

  test("bun dev checkout", () => {
    expect(detectInstallChannelFromPath(
      "/Users/me/.bun/bin/bun",
      "darwin",
      "/repo/KlaatAi.CLI/src/main.tsx",
    )).toBe("source");
  });

  test("unknown install location", () => {
    expect(detectInstallChannelFromPath("C:/Tools/klaatcode.exe", "win32")).toBe("unknown");
  });
});

describe("windowsPowerShellExe", () => {
  test("points under System32", () => {
    const p = windowsPowerShellExe().replace(/\\/g, "/");
    expect(p).toContain("/System32/WindowsPowerShell/v1.0/powershell.exe");
  });
});

describe("spawnUpgradeCommand", () => {
  test("Windows npm runs through cmd.exe", () => {
    if (process.platform !== "win32") return;
    const res = spawnUpgradeCommand(["npm", "--version"]);
    expect(res.error).toBeUndefined();
    expect(res.status).toBe(0);
  });
});

describe("upgradeCommandArgv", () => {
  test("wraps npm in cmd.exe on Windows (npm is a .cmd shim)", () => {
    expect(upgradeCommandArgv(["npm", "install", "-g", "klaatcode@latest"], "win32"))
      .toEqual(["cmd.exe", "/d", "/s", "/c", "npm", "install", "-g", "klaatcode@latest"]);
  });

  test("leaves non-npm commands alone", () => {
    expect(upgradeCommandArgv(["brew", "upgrade", "klaatcode"], "win32"))
      .toEqual(["brew", "upgrade", "klaatcode"]);
    expect(upgradeCommandArgv(["npm", "install"], "darwin"))
      .toEqual(["npm", "install"]);
  });
});

describe("classifyUpgradeFailure", () => {
  test("permission errors", () => {
    expect(classifyUpgradeFailure("npm ERR! code EACCES", 1)).toBe("permission");
    expect(classifyUpgradeFailure("Error: Access is denied.", 1)).toBe("permission");
  });

  test("network errors", () => {
    expect(classifyUpgradeFailure("npm ERR! network getaddrinfo ENOTFOUND registry.npmjs.org", 1))
      .toBe("network");
  });

  test("missing package manager", () => {
    expect(classifyUpgradeFailure("spawn npm ENOENT", null)).toBe("not-found");
    expect(classifyUpgradeFailure("'brew' is not recognized as an internal command", 1))
      .toBe("not-found");
  });

  test("anything else with an exit code is unknown", () => {
    expect(classifyUpgradeFailure("npm ERR! Unexpected end of JSON input", 1)).toBe("unknown");
  });

  test("no exit code at all means the command never ran", () => {
    expect(classifyUpgradeFailure("", null)).toBe("not-found");
  });
});

describe("repairPlanFor", () => {
  test("npm repair removes the retired klaatcode-ai package too", () => {
    const plan = repairPlanFor("npm")!;
    expect(plan.commands[0]).toEqual(["npm", "uninstall", "-g", "klaatcode", "klaatcode-ai"]);
    expect(plan.commands[plan.commands.length - 1]).toEqual(["npm", "install", "-g", "klaatcode@latest"]);
  });

  test("installer repair wipes the install dir first", () => {
    const plan = repairPlanFor("installer", "/Users/me")!;
    // join() so the expectation carries the platform separator, like the code.
    expect(plan.removeDirs).toEqual([join("/Users/me", ".klaatcode")]);
    expect(plan.commands).toHaveLength(1);
  });

  test("brew repair uninstalls then installs", () => {
    const plan = repairPlanFor("brew")!;
    expect(plan.commands[0]?.[1]).toBe("uninstall");
    expect(plan.commands[1]?.[1]).toBe("install");
  });

  test("no repair for source / windows-installer / unknown", () => {
    expect(repairPlanFor("source")).toBeNull();
    expect(repairPlanFor("installer-windows")).toBeNull();
    expect(repairPlanFor("unknown")).toBeNull();
  });
});
