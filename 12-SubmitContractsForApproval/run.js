#!/usr/bin/env node
// ============================================================
// 12-SubmitContractsForApproval
// Description: POST /contracts/<ContractId>/action/submitForApproval for
//              every distinct draft contract that 7-InsertContract
//              created. Submission kicks off Oracle's BPM approval
//              workflow, which takes a while to clear — wait for the
//              approvals to finish before running 13-ActivateContracts
//              (which signs them, moving DRAFT → ... → ACTIVE).
//
// Input:  default = input/LAST_BATCH_LOAD.csv (7-InsertContract writes
//         OracleContractId back into it). Every distinct row with a
//         non-blank OracleContractId is submitted. Pass a different CSV
//         as the first arg to submit a subset:
//             node 12-SubmitContractsForApproval/run.js [input.csv]
//         Required column (case-insensitive): OracleContractId — or
//         ContractNumber (then resolved via a lookup). Optional
//         Submitted/Done column: rows with a truthy value are skipped.
//
// API: POST .../action/submitForApproval — Content-Type
//      application/vnd.oracle.adf.action+json (the ADF custom-action
//      media type, NOT application/json), no request body. Basic auth
//      + the shared client's retry (401/403 abort immediately).
//      Concurrency 5; the output CSV is re-saved after each batch.
//
// Set DRY_RUN=1 to log the POSTs without sending them.
//
// Output:
//   - output/submit-for-approval-<ts>.csv — one row per distinct
//       contract: ContractNumber, OracleContractId, Submitted,
//       SubmitResult  (Submitted=TRUE on a clean submit; SubmitResult =
//       OK / FAIL - ... / SKIP - ...). 13-ActivateContracts reads this.
//   - log/submit-for-approval-<ts>-*.log — run log
// ============================================================

import { mkdirSync, readFileSync, writeFileSync } from "fs";
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
const DEFAULT_INPUT = resolve(REPO_ROOT, "input", "LAST_BATCH_LOAD.csv");

const CONTRACTS_ENDPOINT = "/fscmRestApi/resources/11.13.18.05/contracts";
const ADF_ACTION_CONTENT_TYPE = "application/vnd.oracle.adf.action+json";
const CONCURRENCY = 5;
const DRY_RUN = process.env.DRY_RUN === "1";
const SKIP_TRUTHY = new Set(["true", "1", "yes", "y", "x", "done", "submitted", "ok"]);

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
function isSkip(v) {
  return !isBlank(v) && SKIP_TRUTHY.has(String(v).trim().toLowerCase());
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

const OUT_HEADERS = ["ContractNumber", "OracleContractId", "Submitted", "SubmitResult"];
function writeOut(stamp, results) {
  const lines = [OUT_HEADERS.join(",")];
  for (const r of results) {
    lines.push([csvEscape(r.contractNumber), csvEscape(r.oracleContractId), csvEscape(r.submitted), csvEscape(r.submitResult)].join(","));
  }
  const p = resolve(OUTPUT_DIR, `submit-for-approval-${stamp}.csv`);
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

async function main() {
  const inputPath = process.argv[2] ? resolve(process.cwd(), process.argv[2]) : DEFAULT_INPUT;
  mkdirSync(LOG_DIR, { recursive: true });
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const settings = TOML.parse(readFileSync(SETTINGS_PATH, "utf-8"));
  const { baseUrl, username, password } = settings.server;
  const serverOrigin = /^https?:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`;
  const maxRetries = (settings.retry && settings.retry.max_retries) ?? 3;

  const stamp = timestamp();
  const log = createLogger(LOG_DIR, { prefix: `submit-for-approval-${stamp}` });
  const client = await createClient(log, { username, password }, { baseUrl: serverOrigin, maxRetries });

  log.info("Script: 12-SubmitContractsForApproval");
  log.info(`Server: ${serverOrigin}`);
  log.info(`Input:  ${inputPath}`);
  if (DRY_RUN) log.info("DRY_RUN=1 — no POST calls will be sent.");

  const rows = parse(readFileSync(inputPath, "utf-8"), {
    columns: true, skip_empty_lines: true, bom: true, relax_column_count: true, trim: true,
  });
  if (rows.length === 0) { log.error("Input CSV has no rows."); log.summary(); process.exit(1); }

  const cnCol = findColumn(rows[0], "ContractNumber");
  const oidCol = findColumn(rows[0], "OracleContractId") || findColumn(rows[0], "ContractId") || findColumn(rows[0], "FusionContractId");
  if (!oidCol && !cnCol) { log.error('Input CSV needs an "OracleContractId" or a "ContractNumber" column.'); log.summary(); process.exit(1); }
  const skipCol = findColumn(rows[0], "Submitted") || findColumn(rows[0], "Done");

  // de-dup, first-seen order, keyed by ContractNumber when available else by id
  const seen = new Map();
  for (const r of rows) {
    const oid = oidCol && !isBlank(r[oidCol]) ? String(r[oidCol]).trim() : "";
    const cn = cnCol && !isBlank(r[cnCol]) ? String(r[cnCol]).trim() : "";
    const key = cn || oid;
    if (!key) continue;
    if (!seen.has(key)) seen.set(key, { contractNumber: cn, oracleContractId: oid, skip: skipCol ? r[skipCol] : "", lookupErr: "" });
    else { const e = seen.get(key); if (!e.oracleContractId && oid) e.oracleContractId = oid; if (!e.contractNumber && cn) e.contractNumber = cn; }
  }
  const distinct = [...seen.values()];

  // resolve ids for entries that have a ContractNumber but no id
  const needLookup = distinct.filter(c => !c.oracleContractId && c.contractNumber && !isSkip(c.skip));
  if (needLookup.length) {
    log.info(`Looking up ${needLookup.length} ContractNumber(s) without an OracleContractId...`);
    for (let s = 0; s < needLookup.length; s += CONCURRENCY) {
      await Promise.all(needLookup.slice(s, s + CONCURRENCY).map(async (c) => {
        const q = encodeURIComponent(`ContractNumber='${c.contractNumber}'`);
        const res = await client.get(`${CONTRACTS_ENDPOINT}?q=${q}&fields=ContractId&onlyData=true`);
        if (!res.ok) { c.lookupErr = errDetail(res.status, res.data); return; }
        const items = (res.data && res.data.items) || [];
        if (items.length === 1) c.oracleContractId = String(items[0].ContractId);
        else c.lookupErr = items.length === 0 ? "not found in Fusion" : `multiple matches (${items.length})`;
      }));
    }
  }

  // build the results list
  const results = [];
  for (const c of distinct) {
    if (isSkip(c.skip)) {
      results.push({ contractNumber: c.contractNumber, oracleContractId: c.oracleContractId, submitted: "TRUE", submitResult: "SKIP - already submitted", _pending: false });
    } else if (!c.oracleContractId) {
      results.push({ contractNumber: c.contractNumber, oracleContractId: "", submitted: "", submitResult: `SKIP - no ContractId${c.lookupErr ? ` (${c.lookupErr})` : ""}`, _pending: false });
    } else {
      results.push({ contractNumber: c.contractNumber, oracleContractId: c.oracleContractId, submitted: "", submitResult: "", _pending: true });
    }
  }
  const pending = results.filter(r => r._pending);
  log.info(`${distinct.length} distinct contracts | ${pending.length} to submit | ${results.length - pending.length} skipped`);
  log.info("");

  if (pending.length === 0) {
    log.info(`Output CSV: ${writeOut(stamp, results)}`);
    log.info("Nothing to submit.");
    log.summary();
    return;
  }

  let ok = 0, fail = 0;
  const batchTotal = Math.ceil(pending.length / CONCURRENCY);
  for (let s = 0; s < pending.length; s += CONCURRENCY) {
    const slice = pending.slice(s, s + CONCURRENCY);
    log.info(`[submitForApproval] batch ${Math.floor(s / CONCURRENCY) + 1}/${batchTotal} (${slice.length})`);
    await Promise.all(slice.map(async (r) => {
      const url = `${CONTRACTS_ENDPOINT}/${r.oracleContractId}/action/submitForApproval`;
      const label = r.contractNumber || r.oracleContractId;
      if (DRY_RUN) { log.info(`[submitForApproval] [DRY_RUN] Would POST ${url} (${label})`); r.submitted = ""; r.submitResult = "DRY_RUN"; return; }
      const res = await client.post(url, undefined, { "Content-Type": ADF_ACTION_CONTENT_TYPE });
      if (res.ok) { r.submitted = "TRUE"; r.submitResult = "OK"; log.info(`[submitForApproval] OK ${label} (ContractId=${r.oracleContractId})`); }
      else { r.submitResult = `FAIL - ${errDetail(res.status, res.data)}`; log.error(`[submitForApproval] FAILED ${label} (ContractId=${r.oracleContractId}) - ${r.submitResult}`); }
    }));
    for (const r of slice) { if (r.submitResult === "OK") ok++; else if (r.submitResult !== "DRY_RUN") fail++; }
    writeOut(stamp, results); // crash-safe intermediate save
  }

  const outPath = writeOut(stamp, results);
  log.info("");
  log.info(`Output CSV: ${outPath}`);
  log.info(`Done. submitted ${ok} / failed ${fail} / skipped ${results.length - pending.length}.`);
  log.info("Oracle BPM needs time to process the approvals — wait, then run 13-ActivateContracts.");
  log.summary();
}

main().catch(err => { console.error(err); process.exit(1); });
