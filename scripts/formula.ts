const formulaPath = "Formula/smart-router.rb";
const releaseUrlBase =
  "https://github.com/aschi-marksetai/smart-router/releases/download";
const darwinArm64AssetName = "smart-router-darwin-arm64";
const darwinX64AssetName = "smart-router-darwin-x64";
const linuxX64AssetName = "smart-router-linux-x64";
const linuxArm64AssetName = "smart-router-linux-arm64";
const assets = [
  [darwinArm64AssetName, "REPLACE_SHA256_DARWIN_ARM64"],
  [darwinX64AssetName, "REPLACE_SHA256_DARWIN_X64"],
  [linuxX64AssetName, "REPLACE_SHA256_LINUX_X64"],
  [linuxArm64AssetName, "REPLACE_SHA256_LINUX_ARM64"],
] as const;

const versionTag = process.argv[2];

if (!versionTag) throw new Error("Usage: bun run formula <version-tag>");

let formula = await Bun.file(formulaPath).text();
formula = formula.replace(
  /^  version ".*"$/m,
  `  version "${versionTag.replace(/^v/, "")}"`,
);

for (const [assetName, placeholder] of assets) {
  const response = await fetch(
    `${releaseUrlBase}/${versionTag}/${assetName}.sha256`,
  );
  if (!response.ok) throw new Error(`Could not download ${assetName}.sha256`);
  const checksum = (await response.text()).split(/\s+/)[0];
  formula = formula.replace(placeholder, checksum);
}

process.stdout.write(formula);
