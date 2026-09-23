// Run on the VPS from the tryvera folder:  node vps_hansal_report.mjs
// Uses node:sqlite (built into the Node the app already runs on), so nothing to install.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const db = new DatabaseSync("data/application_logs.db", { readOnly: true });
const rows = db.prepare("select created_at, data from applications where resume_profile = 'hansal_maniar'").all();

const week = (d) => {
  const dt = new Date(d.slice(0, 10) + "T00:00:00Z");
  const day = (dt.getUTCDay() + 6) % 7; // Monday = 0
  dt.setUTCDate(dt.getUTCDate() - day);
  return dt.toISOString().slice(0, 10);
};

// 1. Resumes generated per week
const gen = {};
for (const r of rows) gen[week(r.created_at)] = (gen[week(r.created_at)] ?? 0) + 1;
console.log("HANSAL RESUMES GENERATED ON VPS, BY WEEK");
for (const w of Object.keys(gen).sort()) console.log(`  ${w}  ${String(gen[w]).padStart(4)}`);
console.log(`  TOTAL ${rows.length}`);

// 2. Reasoning effort and cost actually used, from OpenRouter usage written into each verbose log
const logDir = "data/logs/verbose";
const eff = {};
if (fs.existsSync(logDir)) {
  for (const f of fs.readdirSync(logDir)) {
    if (!f.startsWith("app_") || !f.endsWith(".log")) continue;
    const t = fs.readFileSync(path.join(logDir, f), "utf8");
    const reas = [...t.matchAll(/"reasoning_tokens": (\d+)/g)].map((m) => +m[1]);
    const cost = [...t.matchAll(/\n  "cost": ([\d.]+)/g)].reduce((s, m) => s + +m[1], 0);
    eff[f.slice(0, -4)] = [reas.length ? Math.max(...reas) : 0, cost];
  }
}
const byWeek = {};
for (const r of rows) {
  const id = JSON.parse(r.data).id ?? "";
  if (!eff[id]) continue;
  const w = week(r.created_at);
  byWeek[w] ??= [0, 0, 0];
  byWeek[w][0] += 1; byWeek[w][1] += eff[id][0]; byWeek[w][2] += eff[id][1];
}
console.log("\nEFFORT AND COST BY WEEK (from OpenRouter usage in the logs)");
for (const w of Object.keys(byWeek).sort()) {
  const [n, reas, cost] = byWeek[w];
  const avg = reas / n;
  const level = avg < 200 ? "minimal" : avg < 3000 ? "low" : avg < 20000 ? "medium" : "high";
  console.log(`  ${w}  runs ${String(n).padStart(4)}  avg reasoning ${String(Math.round(avg)).padStart(6)} (${level})  cost $${cost.toFixed(2)}`);
}

// 3. Fingerprints so interview PDFs can be traced back to the day they were generated
const fp = {};
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name === "result.json") {
      try {
        const r = JSON.parse(fs.readFileSync(p, "utf8"));
        if (r.resume_profile !== "hansal_maniar") continue;
        const bl = (r.resume_markdown ?? "").split("\n").filter((l) => l.startsWith("- "))
          .map((l) => l.slice(2).replace(/\W+/g, "").slice(0, 80));
        if (bl.length) fp[`${(r.created_at ?? "").slice(0, 10)}|${(r.company_name ?? "?").slice(0, 30)}`] = bl;
      } catch { /* unreadable result.json, skip */ }
    }
  }
};
if (fs.existsSync("output")) walk("output");
fs.writeFileSync("hansal_fingerprints.json", JSON.stringify(fp));
console.log(`\nwrote hansal_fingerprints.json (${Object.keys(fp).length} resumes) - send this file back`);
