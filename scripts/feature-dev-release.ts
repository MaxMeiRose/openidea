import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseVersion } from "./release-prepare.ts";

export const FEATURE_DEV_ENDPOINT =
  "https://github.com/MaxMeiRose/openidea/releases/download/feature-dev-latest/latest.json";

export function featureDevVersion(current: string, run: string, attempt: string): string {
  for (const value of [run, attempt]) {
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
      throw new Error("expected positive run and attempt numbers");
  }
  return `${parseVersion(current)}-feature-dev.${run}.${attempt}`;
}

interface BuildInfo {
  version: string;
  tag: string;
  installerName: string;
}

export function updateManifest(build: BuildInfo, signature: string, notes: string, date: string) {
  if (
    !/^\d+\.\d+\.\d+-feature-dev\.[1-9]\d*\.[1-9]\d*$/.test(build.version) ||
    !/^feature-dev-[a-f0-9]{12}-[0-9]+-[0-9]+$/.test(build.tag) ||
    build.installerName !== `OpenIDEA_${build.version}_x64-setup.exe` ||
    !signature.trim()
  )
    throw new Error("expected a signed feature-dev Windows installer");
  const platform = {
    signature: signature.trim(),
    url: `https://github.com/MaxMeiRose/openidea/releases/download/${build.tag}/${encodeURIComponent(build.installerName)}`,
  };
  return {
    version: build.version,
    notes: notes.trim(),
    pub_date: date,
    platforms: { "windows-x86_64": platform, "windows-x86_64-nsis": platform },
  };
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "prepare" && args.length === 5) {
    const [basePath, channelPath, outputPath, run, attempt] = args as [string, string, string, string, string];
    const base = JSON.parse(readFileSync(basePath, "utf8"));
    const channel = JSON.parse(readFileSync(channelPath, "utf8"));
    channel.version = featureDevVersion(base.version, run, attempt);
    writeFileSync(outputPath, `${JSON.stringify(channel, null, 2)}\n`);
    console.log(channel.version);
  } else if (command === "manifest" && args.length === 4) {
    const [buildPath, signaturePath, notesPath, outputPath] = args as [string, string, string, string];
    const build: BuildInfo = JSON.parse(readFileSync(buildPath, "utf8"));
    const manifest = updateManifest(
      build,
      readFileSync(signaturePath, "utf8"),
      readFileSync(notesPath, "utf8"),
      new Date().toISOString(),
    );
    writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  } else {
    throw new Error(
      "expected prepare <base> <channel> <output> <run> <attempt> or manifest <build> <signature> <notes> <output>",
    );
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(`feature-dev-release: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
