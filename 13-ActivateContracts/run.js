#!/usr/bin/env node
// ============================================================
// 13-ActivateContracts
// Description: Sign the contracts that 12-SubmitContractsForApproval got
//              through Oracle's BPM approval workflow — POST
//              /contracts/<ContractId>/action/sign. Once a draft is
//              approved and signed, Oracle moves it to ACTIVE. There is
//              no separate "activate" call; signing is the last step.
//              Run this only AFTER the approvals kicked off by step 12
//              have had time to clear.
//
// Input:  default = the newest output/submit-for-approval-*.csv that
//         12-SubmitContractsForApproval wrote. Only rows whose
//         SubmitResult is "OK" (or whose Submitted column is truthy) are
//         signed — a contract that never submitted can't be signed.
//         Pass a different CSV as the first arg to sign a specific set;
//         a CSV with no SubmitResult column is treated as "sign every
//         row that has an OracleContractId". An optional Signed/Activated/
//         Done column skips rows that already have a truthy value.
//             node 13-ActivateContracts/run.js [input.csv]
//
// API: POST .../action/sign — Content-Type
//      application/vnd.oracle.adf.action+json (the ADF custom-action
//      media type, NOT application/json), no request body. Basic auth
//      + the shared client's retry (401/403 abort immediately).
//      Concurrency 5; the output CSV is re-saved after each batch.
//
// Set DRY_RUN=1 to log the POSTs without sending them.
//
// Output:
//   - output/activate-<ts>.csv — one row per distinct contract:
//       ContractNumber, OracleContractId, Activated, SignResult
//       (Activated=TRUE on a clean sign; SignResult = OK / FAIL - ... /
//       SKIP - ...). Feed this file back in to retry only the failures.
//   - log/activate-<ts>-*.log — run log
// ============================================================

import { mkdirSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { parse } from "csv-parse/sync";
import TOML from "@iarna/toml";
import { createClient } from "../lib/client.js";
import { createLogger } from "../lib/logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR = __dirname;
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const LOG_DIR = resolve(SCRIPT_DIR, "log");
const OUTPUT_DIR = resolve(SCRIPT_DIR, "output");
const SETTINGS_PATH = resolve(REPO_ROOT, "settings.toml");
const SUBMIT_OUTPUT_DIR = resolve(REPO_ROOT, "12-SubmitContractsForApproval", "output");

const CONTRACTS_ENDPOINT = "/fscmRestApi/resources/11.13.18.05/contracts";
const ADF_ACTION_CONTENT_TYPE = "application/vnd.oracle.adf.action+json";
const CONCURRENCY = 5;
const DRY_RUN = process.env.DRY_RUN === "1";
const TRUTHY = new Set(["true", "1", "yes", "y", "x", "done", "submitted", "signed", "activated", "active", "ok"]);

const pad = n => String(n).padStart(2, "0");
function timestamp() {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
function csvEscape(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function isBlank(v) {
  if (v === null || v === undefined) return true;
  const s = String(v).trim();
  return s === "" || s.toUpperCase() === "NULL";
}
function isTruthy(v) {
  return !isBlank(v) && TRUTHY.has(String(v).trim().toLowerCase());
}
function isOkResult(v) {
  return !isBlank(v) && /^ok\b/i.test(String(v).trim());
}
function findColumn(row, name) {
  const want = name.toLowerCase();
  return Object.keys(row).find(k => k.toLowerCase() === want);
}
function errDetail(status, data) {
  let d;
  if (typeof data === "string") d = data.slice(0, 300);
  else if (data && data.detail) d = data.detail;
  else if (data && data.message) d = data.message;
  else if (data && data.title) d = data.title;
  else d = JSON.stringify(data).slice(0, 300);
  return `HTTP ${status} - ${d}`;
}
function newestSubmitOutput() {
  let files;
  try { files = readdirSync(SUBMIT_OUTPUT_DIR); } catch { return null; }
  const matches = files.filter(f => /^submit-for-approval-.*\.csv$/i.test(f)).sort();
  return matches.length ? resolve(SUBMIT_OUTPUT_DIR, matches[matches.length - 1]) : null;
}

const OUT_HEADERS = ["ContractNumber", "OracleContractId", "Activated", "SignResult"];
function writeOut(stamp, results) {
  const lines = [OUT_HEADERS.join(",")];
  for (const r of results) {
    lines.push([csvEscape(r.contractNumber), csvEscape(r.oracleContractId), csvEscape(r.activated), csvEscape(r.signResult)].join(","));
  }
  const p = resolve(OUTPUT_DIR, `activate-${stamp}.csv`);
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

async function main() {
  const inputPath = process.argv[2] ? resolve(process.cwd(), process.argv[2]) : newestSubmitOutput();
  if (!inputPath) {
    console.error("No input given and no submit-for-approval-*.csv found in 12-SubmitContractsForApproval/output/.");
    console.error("Usage: node 13-ActivateContracts/run.js [input.csv]");
    process.exit(1);
  }

  mkdirSync(LOG_DIR, { recursive: true });
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const settings = TOML.parse(readFileSync(SETTINGS_PATH, "utf-8"));
  const { baseUrl, username, password } = settings.server;
  const serverOrigin = /^https?:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`;
  const maxRetries = (settings.retry && settings.retry.max_retries) ?? 3;

  const stamp = timestamp();
  const log = createLogger(LOG_DIR, { prefix: `activate-${stamp}` });
  const client = await createClient(log, { username, password }, { baseUrl: serverOrigin, maxRetries });

  log.info("Script: 13-ActivateContracts");
  log.info(`Server: ${serverOrigin}`);
  log.info(`Input:  ${inputPath}`);
  if (DRY_RUN) log.info("DRY_RUN=1 — no POST calls will be sent.");

  const rows = parse(readFileSync(inputPath, "utf-8"), {
    columns: true, skip_empty_lines: true, bom: true, relax_column_count: true, trim: true,
  });
  if (rows.length === 0) { log.error("Input CSV has no rows."); log.summary(); process.exit(1); }

  const cnCol = findColumn(rows[0], "ContractNumber");
  const oidCol = findColumn(rows[0], "OracleContractId") || findColumn(rows[0], "ContractId") || findColumn(rows[0], "FusionContractId");
  if (!oidCol) { log.error('Input CSV needs an "OracleContractId" (or "ContractId") column.'); log.summary(); process.exit(1); }
  const submitCol = findColumn(rows[0], "SubmitResult");
  const submittedCol = findColumn(rows[0], "Submitted");
  const doneCol = findColumn(rows[0], "Signed") || findColumn(rows[0], "Activated") || findColumn(rows[0], "Done");

  // de-dup, first-seen order
  const seen = new Map();
  for (const r of rows) {
    const oid = !isBlank(r[oidCol]) ? String(r[oidCol]).trim() : "";
    const cn = cnCol && !isBlank(r[cnCol]) ? String(r[cnCol]).trim() : "";
    const key = oid || cn;
    if (!key) continue;
    if (!seen.has(key)) {
      seen.set(key, {
        contractNumber: cn,
        oracleContractId: oid,
        submitResult: submitCol ? r[submitCol] : undefined,
        submittedFlag: submittedCol ? r[submittedCol] : undefined,
        doneFlag: doneCol ? r[doneCol] : undefined,
      });
    } else {
      const e = seen.get(key);
      if (!e.oracleContractId && oid) e.oracleContractId = oid;
      if (!e.contractNumber && cn) e.contractNumber = cn;
    }
  }
  const distinct = [...seen.values()];

  // decide which contracts to sign
  const results = [];
  for (const c of distinct) {
    if (isTruthy(c.doneFlag)) {
      results.push({ contractNumber: c.contractNumber, oracleContractId: c.oracleContractId, activated: "TRUE", signResult: "SKIP - already signed", _pending: false });
      continue;
    }
    if (!c.oracleContractId) {
      results.push({ contractNumber: c.contractNumber, oracleContractId: "", activated: "", signResult: "SKIP - no ContractId", _pending: false });
      continue;
    }
    // gate on submit status only when the input carries it
    if (submitCol !== undefined) {
      const eligible = isOkResult(c.submitResult) || isTruthy(c.submittedFlag);
      if (!eligible) {
        results.push({ contractNumber: c.contractNumber, oracleContractId: c.oracleContractId, activated: "", signResult: `SKIP - not submitted (${isBlank(c.submitResult) ? "no SubmitResult" : String(c.submitResult).trim()})`, _pending: false });
        continue;
      }
    }
    results.push({ contractNumber: c.contractNumber, oracleContractId: c.oracleContractId, activated: "", signResult: "", _pending: true });
  }
  const pending = results.filter(r => r._pending);
  log.info(`${distinct.length} distinct contracts | ${pending.length} to sign | ${results.length - pending.length} skipped`);
  log.info("");

  if (pending.length === 0) {
    log.info(`Output CSV: ${writeOut(stamp, results)}`);
    log.info("Nothing to sign.");
    log.summary();
    return;
  }

  let ok = 0, fail = 0;
  const batchTotal = Math.ceil(pending.length / CONCURRENCY);
  for (let s = 0; s < pending.length; s += CONCURRENCY) {
    const slice = pending.slice(s, s + CONCURRENCY);
    log.info(`[sign] batch ${Math.floor(s / CONCURRENCY) + 1}/${batchTotal} (${slice.length})`);
    await Promise.all(slice.map(async (r) => {
      const url = `${CONTRACTS_ENDPOINT}/${r.oracleContractId}/action/sign`;
      const label = r.contractNumber || r.oracleContractId;
      if (DRY_RUN) { log.info(`[sign] [DRY_RUN] Would POST ${url} (${label})`); r.signResult = "DRY_RUN"; return; }
      const res = await client.post(url, undefined, { "Content-Type": ADF_ACTION_CONTENT_TYPE });
      if (res.ok) { r.activated = "TRUE"; r.signResult = "OK"; log.info(`[sign] OK ${label} (ContractId=${r.oracleContractId})`); }
      else { r.signResult = `FAIL - ${errDetail(res.status, res.data)}`; log.error(`[sign] FAILED ${label} (ContractId=${r.oracleContractId}) - ${r.signResult}`); }
    }));
    for (const r of slice) { if (r.signResult === "OK") ok++; else if (r.signResult !== "DRY_RUN") fail++; }
    writeOut(stamp, results); // crash-safe intermediate save
  }

  const outPath = writeOut(stamp, results);
  log.info("");
  log.info(`Output CSV: ${outPath}`);
  log.info(`Done. signed/activated ${ok} / failed ${fail} / skipped ${results.length - pending.length}.`);
  log.summary();
}

main().catch(err => { console.error(err); process.exit(1); });
