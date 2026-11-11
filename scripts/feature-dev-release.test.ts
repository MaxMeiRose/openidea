// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FEATURE_DEV_ENDPOINT, featureDevVersion, updateManifest } from "./feature-dev-release.ts";

describe("feature-dev update channel", () => {
  it("numbers every build and retry without changing the upstream version", () => {
    expect(featureDevVersion("0.1.41", "9", "1")).toBe("0.1.41-feature-dev.9.1");
    expect(featureDevVersion("0.1.41", "10", "2")).toBe("0.1.41-feature-dev.10.2");
    expect(featureDevVersion("0.1.42", "11", "1")).toBe("0.1.42-feature-dev.11.1");
  });

  it.each(["", "0", "01", "-1", "1.2", "9007199254740992"])("rejects an invalid build number %s", (value) => {
    expect(() => featureDevVersion("0.1.41", value, "1")).toThrow("positive run");
    expect(() => featureDevVersion("0.1.41", "1", value)).toThrow("positive run");
  });

  it("keeps the installed identity and uses a separate signed update source", () => {
    const channel = JSON.parse(readFileSync("src-tauri/tauri.feature-dev.conf.json", "utf8"));
    const upstream = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
    expect(channel.productName).toBeUndefined();
    expect(channel.identifier).toBeUndefined();
    expect(channel.plugins.updater.endpoints).toEqual([FEATURE_DEV_ENDPOINT]);
    expect(channel.plugins.updater.pubkey).not.toBe(upstream.plugins.updater.pubkey);
    expect(channel.plugins.updater.requireSignedVersion).toBe(true);
    expect(channel.bundle.createUpdaterArtifacts).toBe(true);
    expect(channel.bundle.windows.nsis.installMode).toBe("currentUser");
  });

  it("prepares a numbered fork config without changing upstream metadata", () => {
    const directory = mkdtempSync(join(tmpdir(), "openidea-feature-dev-"));
    const base = join(directory, "base.json");
    const channel = join(directory, "channel.json");
    const output = join(directory, "output.json");
    writeFileSync(base, '{"version":"0.1.41"}');
    writeFileSync(channel, readFileSync("src-tauri/tauri.feature-dev.conf.json", "utf8"));
    try {
      const version = execFileSync(
        process.execPath,
        [
          fileURLToPath(new URL("./feature-dev-release.ts", import.meta.url)),
          "prepare",
          base,
          channel,
          output,
          "10",
          "1",
        ],
        { encoding: "utf8" },
      ).trim();
      expect(version).toBe("0.1.41-feature-dev.10.1");
      expect(JSON.parse(readFileSync(output, "utf8")).version).toBe(version);
      expect(JSON.parse(readFileSync(base, "utf8")).version).toBe("0.1.41");
      expect(JSON.parse(readFileSync(channel, "utf8")).version).toBeUndefined();
    } finally {
      expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
      rmSync(directory, { recursive: true, force: true });
    }
  });

  const build = {
    version: "0.1.41-feature-dev.10.1",
    tag: "feature-dev-0123456789ab-12345-1",
    installerName: "OpenIDEA_0.1.41-feature-dev.10.1_x64-setup.exe",
  };

  it("points both Windows updater targets at the exact published installer and signature", () => {
    const manifest = updateManifest(build, " signed bundle\n", " Feature changes\n", "2026-11-11T10:00:00Z");
    expect(manifest.version).toBe(build.version);
    expect(manifest.notes).toBe("Feature changes");
    expect(manifest.platforms["windows-x86_64"]).toEqual({
      signature: "signed bundle",
      url: `https://github.com/MaxMeiRose/openidea/releases/download/${build.tag}/${build.installerName}`,
    });
    expect(manifest.platforms["windows-x86_64-nsis"]).toEqual(manifest.platforms["windows-x86_64"]);
  });

  it("rejects a missing signature, a stale installer and another release channel", () => {
    expect(() => updateManifest(build, " ", "", "")).toThrow("signed feature-dev");
    expect(() => updateManifest({ ...build, installerName: "OpenIDEA_0.1.37_x64-setup.exe" }, "sig", "", "")).toThrow();
    expect(() => updateManifest({ ...build, tag: "nightly" }, "sig", "", "")).toThrow();
    expect(() => updateManifest({ ...build, version: "0.1.42" }, "sig", "", "")).toThrow();
  });
});
