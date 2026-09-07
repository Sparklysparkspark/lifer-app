import { execSync } from "node:child_process";

const groups = [
  ["squamata-dev", "src/build/build-seed-squamata.ts"],
  ["testudines-dev", "src/build/build-seed-testudines.ts"],
  // crocodylia-dev already run manually as a smoke test — skipped here.
  ["amphibians-dev", "src/build/build-seed-amphibians.ts"],
  ["corals-dev", "src/build/build-seed-corals.ts"],
  ["jellies-anemones-dev", "src/build/build-seed-jellies-anemones.ts"],
  ["echinoderms-dev", "src/build/build-seed-echinoderms.ts"],
  ["nudibranchs-dev", "src/build/build-seed-nudibranchs.ts"],
  ["collector-shells-dev", "src/build/build-seed-collector-shells.ts"],
  ["marine-mollusks-dev", "src/build/build-seed-marine-mollusks.ts"],
  ["cephalopoda-dev", "src/build/build-seed-cephalopods.ts"],
  ["crustacea-dev", "src/build/build-seed-crustaceans.ts"],
  ["sponges-tunicates-dev", "src/build/build-seed-sponges-tunicates.ts"],
];

for (const [buildId, script] of groups) {
  console.log(`\n=== [${buildId}] building ===`);
  try {
    execSync(`npx tsx ${script}`, { stdio: "inherit", env: { ...process.env, LIFER_BUILD_ID: buildId } });
  } catch (err) {
    console.error(`[${buildId}] BUILD FAILED:`, err.message);
    continue;
  }
  console.log(`=== [${buildId}] loading into DB ===`);
  try {
    execSync(`npx tsx src/build/load-seed.ts`, { stdio: "inherit", env: { ...process.env, LIFER_BUILD_ID: buildId } });
  } catch (err) {
    console.error(`[${buildId}] LOAD FAILED:`, err.message);
  }
}
console.log("\n=== all groups done ===");
