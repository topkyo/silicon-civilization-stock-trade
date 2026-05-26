// Refresh web/data/universe.json via DeepSeek + pyserver validation.
// Usage: cd web && npx tsx scripts/refresh-universe.ts
import fs from "node:fs";
import path from "node:path";

(() => {
  const envPath = path.resolve(__dirname, "..", ".env.local");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, raw] = m;
    if (process.env[k]) continue;
    process.env[k] = raw.replace(/^["']|["']$/g, "");
  }
})();

async function main() {
  const { readUniverse } = await import("../lib/universe");
  const { refreshUniverse } = await import("../lib/universe-refresh");

  const before = readUniverse();
  console.log(`== universe refresh == (${before.entries.length} symbols)`);

  const result = await refreshUniverse({
    onValidate: (symbol, ok) => {
      process.stdout.write(`  ${ok ? "✓" : "✗"} ${symbol}\n`);
    },
  });

  console.log("proposal:", result.proposal.rationale);
  console.log(
    `applied: +${result.applied.added.length} -${result.applied.removed.length} ` +
      `reclass ${result.applied.reclassified.length} rejected ${result.applied.rejected.length}`,
  );
  console.log(`final count: ${result.finalCount}`);
  if (result.applied.added.length) {
    console.log("added:", result.applied.added.map((a) => `${a.symbol} ${a.name}`).join(", "));
  }
  if (result.applied.removed.length) {
    console.log("removed:", result.applied.removed.join(", "));
  }
  console.log("done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
