// Live World Model idempotency check: reads the demo catalogue rows through the gateway
// (Zetaris), ingests them, reads them again, ingests again, and expects no new event and
// the same canonical state. Usage (from agent/):
//   npx tsx src/world/liveIdempotency.ts [--dir <path>] [--fsa-since YYYY-MM-DD]
// The default directory is data/world (gitignored). Exit 0 when the second ingest is empty.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig, REPO_ROOT_URL } from "../config.ts";
import { GatewayClient } from "../zetaris/client.ts";
import { CatalogueWorld, WORLD_DIR, fetchCatalogue, type Market } from "./world.ts";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

async function main(): Promise<number> {
  const cfg = loadConfig();
  const dir = arg("--dir", WORLD_DIR);
  const fsaSince = arg("--fsa-since", "2026-09-01");
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("data/manifest/skus.json", REPO_ROOT_URL)), "utf8")) as {
    skus: { gtin: string; role: string; markets: Market[] }[];
  };
  const skus = manifest.skus.filter((s) => s.role === "demo").map((s) => ({ gtin: s.gtin, markets: s.markets }));
  const gateway = new GatewayClient({ baseUrl: cfg.gatewayUrl });
  await gateway.health();

  const world = new CatalogueWorld({ directory: dir });
  console.log(`world: ${dir} (${world.eventCount()} events on load)`);
  const read1 = await fetchCatalogue(gateway, { skus, fsaSince });
  console.log(`read 1: ${read1.batch.products.length} products, ${read1.batch.fsa.length} FSA alerts, ${read1.calls} template calls, ${read1.wallMs} ms; missing [${read1.missingProducts.join(", ")}]`);
  const d1 = await world.ingest(read1.batch);
  console.log(`ingest 1: appended ${d1.appended} events (${d1.eventsBefore} -> ${d1.eventsAfter}), state changed ${d1.changed}, writes ${JSON.stringify(d1.writes)}`);

  const read2 = await fetchCatalogue(gateway, { skus, fsaSince });
  console.log(`read 2: ${read2.batch.products.length} products, ${read2.batch.fsa.length} FSA alerts, ${read2.calls} template calls, ${read2.wallMs} ms`);
  const d2 = await world.ingest(read2.batch);
  console.log(`ingest 2: appended ${d2.appended} events, state changed ${d2.changed}, writes ${JSON.stringify(d2.writes)}`);

  const reloaded = new CatalogueWorld({ directory: dir });
  const d3 = await reloaded.ingest(read2.batch);
  console.log(`ingest 3 (fresh process state from disk): appended ${d3.appended} events, state changed ${d3.changed}`);

  const shape = world.shape();
  const byType: Record<string, number> = {};
  for (const e of shape.entities) byType[e.type] = (byType[e.type] ?? 0) + 1;
  const edgeTypes: Record<string, number> = {};
  for (const r of world.edges()) edgeTypes[r.type] = (edgeTypes[r.type] ?? 0) + 1;
  console.log(`entities ${JSON.stringify(byType)}`);
  console.log(`open edges ${JSON.stringify(edgeTypes)}`);
  console.log(`name matches: ${d2.nameMatches.map((m) => `${m.notice}->${m.gtin} ${m.brand.band} ${m.brand.similarity} ("${m.brand.window}" ~ "${m.brand.alias}")`).join("; ") || "none"}`);
  console.log(`merge queue: ${world.mergeQueue().map((p) => `${p.id} ${p.leftName} ~ ${p.rightName} ${p.similarity.toFixed(3)} ${p.status}`).join("; ") || "empty"}`);
  console.log(`state sha256 ${d2.stateAfter}`);
  const ok = d2.appended === 0 && !d2.changed && d3.appended === 0 && !d3.changed;
  console.log(ok ? "diff: empty" : "diff: NON-EMPTY");
  return ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(2);
  },
);
