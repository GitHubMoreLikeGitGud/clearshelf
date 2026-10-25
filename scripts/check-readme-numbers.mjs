#!/usr/bin/env node
/**
 * Recompute README headline numbers from docs/eval/*.json and fail if the
 * README no longer contains the formatted phrases those numbers produce.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

function loadJson(repoRelative) {
  const abs = join(root, repoRelative);
  return JSON.parse(readFileSync(abs, "utf8"));
}

function median(nums) {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[mid];
}

function sec1(ms) {
  return (Math.round((ms / 1000) * 10) / 10).toFixed(1);
}

function pctWhole(fraction) {
  return String(Math.round(fraction * 100));
}

function twoDec(n) {
  return Number(n).toFixed(2);
}

function withCommas(n) {
  return Number(n).toLocaleString("en-US");
}

function parseArgs(argv) {
  let readmePath = join(root, "README.md");
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--readme" && argv[i + 1]) {
      readmePath = resolve(argv[++i]);
    }
  }
  return { readmePath };
}

/**
 * One table of checks: id, README phrase builder, JSON file, and field label.
 * Each `expected` / `match` path recomputes from JSON; never from the README.
 */
const CHECKS = [
  {
    id: "watch-median",
    file: "docs/eval/watch-polls-2026-10-23.json",
    field: "runs[].wall_ms",
    expected(data) {
      const walls = data.runs.map((r) => r.wall_ms);
      const med = sec1(median(walls));
      const min = sec1(Math.min(...walls));
      const max = sec1(Math.max(...walls));
      const n = walls.length;
      return `median ${med} s over ${n} runs (${min} to ${max} s`;
    },
  },
  {
    id: "re-run-citations",
    file: "docs/eval/eval-2026-10-25-aeb5b92.json",
    field: "evidence_quality.e_replay.cited_rows_all_present / records_rerun",
    expected(data) {
      const { cited_rows_all_present: ok, records_rerun: n } = data.evidence_quality.e_replay;
      return `${ok} of ${n} cited records re-ran`;
    },
  },
  {
    id: "evidence-completeness",
    file: "docs/eval/eval-2026-10-25-aeb5b92.json",
    field: "evidence_quality.e_complete + e_replay",
    expected(data) {
      const c = data.evidence_quality.e_complete;
      const r = data.evidence_quality.e_replay;
      return `${c.complete}/${c.records} complete, ${r.cited_rows_all_present}/${r.records_rerun} re-run`;
    },
  },
  {
    id: "planner-validity",
    file: "docs/eval/eval-2026-10-25-aeb5b92.json",
    field: "planner_8_real_investigations.totals.valid_first_try / planner_calls",
    expected(data) {
      const t = data.planner_8_real_investigations.totals;
      return `planner validity (${t.valid_first_try}/${t.planner_calls})`;
    },
  },
  {
    id: "scenarios",
    file: "docs/eval/eval-2026-10-25-aeb5b92.json",
    field: "scenarios.passed / scenarios.total",
    // Accept either "N/N" or "N of N" next to "scenarios" (README uses both styles elsewhere).
    match(readme, data) {
      const p = data.scenarios.passed;
      const t = data.scenarios.total;
      const forms = [`${p}/${t}`, `${p} of ${t}`];
      const lines = readme.split(/\r?\n/);
      const claims = [];
      for (const line of lines) {
        if (!/scenario/i.test(line)) continue;
        for (const form of forms) {
          if (line.includes(form)) claims.push(form);
        }
        for (const m of line.matchAll(/(\d+)\s*\/\s*(\d+)/g)) {
          const a = Number(m[1]);
          const b = Number(m[2]);
          // Pass-ratio style near "scenarios" (e.g. 10/10), not "the 10 scenarios," alone.
          if (b === t || (a === p && b === t)) {
            if (a !== p || b !== t) {
              return {
                ok: false,
                expected: forms.join(" or "),
                detail: `found ${a}/${b} next to scenarios`,
              };
            }
          }
        }
        for (const m of line.matchAll(/(\d+)\s+of\s+(\d+)/gi)) {
          const a = Number(m[1]);
          const b = Number(m[2]);
          if (b === t || (a === p && b === t)) {
            if (a !== p || b !== t) {
              return {
                ok: false,
                expected: forms.join(" or "),
                detail: `found ${a} of ${b} next to scenarios`,
              };
            }
          }
        }
      }
      if (claims.length === 0) {
        return { ok: false, expected: forms.join(" or "), detail: "missing from README" };
      }
      return { ok: true, expected: forms.join(" or ") };
    },
  },
  {
    id: "full-history-tokens",
    file: "docs/eval/full-history-2026-10-25.json",
    field: "runs[].chunks[last].full_history_prompt_tokens",
    expected(data) {
      const tokens = data.runs.map((run) => {
        const last = run.chunks[run.chunks.length - 1];
        return last.full_history_prompt_tokens;
      });
      return `${withCommas(tokens[0])} and ${withCommas(tokens[1])} tokens`;
    },
  },
  {
    id: "full-history-saving",
    file: "docs/eval/full-history-2026-10-25.json",
    field: "runs[].totals.saving_measured",
    expected(data) {
      const pcts = data.runs.map((run) => pctWhole(run.totals.saving_measured));
      return `${pcts[0]}% and ${pcts[1]}% fewer prompt tokens`;
    },
  },
  {
    id: "model-alone",
    file: "docs/eval/extraction-q4-2026-10-25.json",
    field: "systems.N.micro + trap_false_alarm",
    expected(data) {
      const n = data.systems.N;
      const prec = twoDec(n.micro.precision);
      const rec = twoDec(n.micro.recall);
      const { alarms, pairs } = n.trap_false_alarm;
      return `precision ${prec} and recall ${rec} with ${alarms} of ${pairs} trap false alarms`;
    },
  },
  {
    id: "keyword-rule",
    file: "docs/eval/extraction-q4-2026-10-25.json",
    field: "systems.K.micro + trap_false_alarm",
    expected(data) {
      const k = data.systems.K;
      const prec = twoDec(k.micro.precision);
      const rec = twoDec(k.micro.recall);
      const { alarms, pairs } = k.trap_false_alarm;
      return `keyword rule ${prec} / ${rec}, ${alarms} of ${pairs}`;
    },
  },
  {
    id: "lexicon-alone",
    file: "docs/eval/extraction-q4-2026-10-25.json",
    field: "systems.L.micro",
    expected(data) {
      const l = data.systems.L;
      return `the lexicon alone scores ${twoDec(l.micro.precision)} / ${twoDec(l.micro.recall)}`;
    },
  },
  {
    id: "q8-model-alone",
    file: "docs/eval/extraction-q8-2026-10-25.json",
    field: "systems.N.micro",
    match(readme, data) {
      const n = data.systems.N;
      const prec = twoDec(n.micro.precision);
      const rec = twoDec(n.micro.recall);
      const spaced = `${prec} / ${rec}`;
      const tight = `${prec}/${rec}`;
      if (readme.includes(spaced) || readme.includes(tight)) {
        return { ok: true, expected: `${spaced} or ${tight}` };
      }
      return {
        ok: false,
        expected: `${spaced} or ${tight}`,
        detail: "missing from README",
      };
    },
  },
  {
    id: "notices-upc-recall",
    file: "docs/eval/notices-2026-10-26.json",
    field: "upc.scan.recall / upc.model_after_host_check.recall",
    expected(data) {
      const { scan, model_after_host_check: model } = data.upc;
      return `recall ${scan.recall.toFixed(3)} against ${model.recall.toFixed(3)}`;
    },
  },
  {
    id: "notices-allergens",
    file: "docs/eval/notices-2026-10-26.json",
    field: "allergens.exact_group_match + hand_check_{lexicon,model}_exactly_right",
    expected(data) {
      const a = data.allergens;
      const lexicon = a.exact_group_match + a.hand_check_lexicon_exactly_right;
      const model = a.exact_group_match + a.hand_check_model_exactly_right;
      return `${lexicon} against ${model} notices exactly right`;
    },
  },
  {
    id: "notices-either-reader",
    file: "docs/eval/notices-2026-10-26.json",
    field: "upc.agreed_by_both + single_reader_true / true_in_pool",
    expected(data) {
      const u = data.upc;
      const either = u.agreed_by_both + u.single_reader_true.scan_only + u.single_reader_true.model_only;
      return `${either} of ${u.true_in_pool} pooled recall barcodes`;
    },
  },
  {
    id: "planner-off-walls",
    file: "docs/eval/planner-ablation-2026-10-26.json",
    field: "arms[].real_8.wall_s_sum",
    expected(data) {
      const sums = (planner) =>
        data.arms.filter((a) => a.planner === planner).map((a) => a.real_8.wall_s_sum.toFixed(1));
      const off = sums("off");
      const model = sums("model");
      return `${off[0]} s and ${off[1]} s for the 8 against ${model[0]} s and ${model[1]} s`;
    },
  },
  {
    id: "planner-off-same",
    file: "docs/eval/planner-ablation-2026-10-26.json",
    field: "comparisons_against_first_model_arm[].cases (without the synthetic E8)",
    expected(data) {
      let same = Infinity;
      let total = 0;
      for (const cmp of data.comparisons_against_first_model_arm) {
        const real = cmp.cases.filter((c) => c.id !== "E8");
        const n = real.filter(
          (c) => c.same_status && c.same_rules && c.same_contradiction_kinds && c.same_statement,
        ).length;
        same = Math.min(same, n);
        total = real.length;
      }
      return `statement in ${same} of ${total}`;
    },
  },
  {
    id: "intake-holds",
    file: "docs/eval/intake-holds-2026-10-23.json",
    field: "listings[].hold_block_rules (listings with an intake decision row)",
    expected(data) {
      const held = data.listings.filter((l) => l.decision_row_status);
      const has = (l, r) => l.hold_block_rules.includes(r);
      const r1 = held.filter((l) => has(l, "R1")).length;
      const r3 = held.filter((l) => !has(l, "R1") && has(l, "R3")).length;
      const rest = held.filter((l) => !has(l, "R1") && !has(l, "R3")).length;
      return `${r1} cite a recall of the listing's barcode (R1), ${r3} more a failed Zetaris data-quality rule (R3: no ingredient list, or a label not in English), and ${rest} hold only on unresolved contradictions`;
    },
  },
];

function runCheck(check, readme) {
  const data = loadJson(check.file);
  if (typeof check.match === "function") {
    const result = check.match(readme, data);
    return {
      id: check.id,
      ok: result.ok,
      expected: result.expected,
      field: check.field,
      file: check.file,
      detail: result.detail,
    };
  }
  const expected = check.expected(data);
  const ok = readme.includes(expected);
  return {
    id: check.id,
    ok,
    expected,
    field: check.field,
    file: check.file,
    detail: ok ? undefined : "missing from README",
  };
}

function main() {
  const { readmePath } = parseArgs(process.argv.slice(2));
  const readme = readFileSync(readmePath, "utf8");
  const results = CHECKS.map((c) => runCheck(c, readme));
  let passed = 0;
  for (const r of results) {
    if (r.ok) {
      passed += 1;
      console.log(`PASS ${r.id}`);
    } else {
      const why = r.detail ?? "mismatch";
      console.log(
        `FAIL ${r.id}: expected ${JSON.stringify(r.expected)} from ${r.file} (${r.field}); ${why}`,
      );
    }
  }
  console.log(`${passed} of ${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main();
