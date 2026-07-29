import { describe, expect, test } from "bun:test";
import {
  detectInstallChannelFromPath,
  normalizeExePath,
  spawnUpgradeCommand,
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
