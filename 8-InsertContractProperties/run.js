#!/usr/bin/env node
// ============================================================
// 8-InsertContractProperties
// Description: POST ContractProperties_c for each row in
//              LAST_BATCH_LOAD.csv where OracleContractId is set.
//              Fetches all contracts to resolve internal Oracle Id,
//              skips rows whose Id already has a properties record.
//              Runs with CONCURRENCY=10.
//
// Prerequisites: 7-InsertContract must have run.
//
// Fields posted:
//   RecordName, ObjectId_c, MajorVersion_c, SourcingTrackerID_c, ParticipatingHA_c, Text02_c,
//   Number06-14_c, PDText01-03_c, Text11-13_c, Text18_c, Date01_c
//
// Output:
//   - output/<timestamp>.csv — per-row results
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
const PHSA_SCRIPTS_DIR = resolve(SCRIPT_DIR, "..");
const LOG_DIR = resolve(SCRIPT_DIR, "log");
const OUTPUT_DIR = resolve(SCRIPT_DIR, "output");
const SETTINGS_PATH = resolve(PHSA_SCRIPTS_DIR, "settings.toml");
const INPUT_CSV = resolve(PHSA_SCRIPTS_DIR, "input", "LAST_BATCH_LOAD.csv");

const CONTRACTS_ENDPOINT = "/fscmRestApi/resources/11.13.18.05/contracts";
const CONTRACT_PROPS_ENDPOINT = "/fscmRestApi/resources/11.13.18.05/ContractProperties_c";
const CONCURRENCY = 10;

const pad = n => String(n).padStart(2, "0");
function timestamp() {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function blank(v) {
  if (v === null || v === undefined) return true;
  const s = String(v).trim();
  return s === "" || s === "NULL";
}

function csvEscape(val) {
  if (val === null || val === undefined) return "";
  const s = String(val);
  return s.includes(",") || s.includes('"') || s.includes("\n")
    ? '"' + s.replace(/"/g, '""') + '"'
    : s;
}

function toNumber(v) {
  if (blank(v)) return undefined;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isNaN(n) ? undefined : n;
}

function toJsonArray(v) {
  if (blank(v)) return undefined;
  const items = v.split(",").map(s => s.trim()).filter(Boolean);
  return items.length > 0 ? JSON.stringify(items) : undefined;
}

function toDateIso(v) {
  if (blank(v)) return undefined;
  const s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return undefined;
}

function buildPayload(oracleId, majorVersion, contractNumber, row) {
  const payload = {
    RecordName: contractNumber,
    ObjectId_c: oracleId,
    MajorVersion_c: majorVersion,
  };

  const set = (key, val) => { if (val !== undefined && val !== null) payload[key] = val; };

  set("SourcingTrackerID_c", blank(row.SourcingTrackerNumber) ? undefined : row.SourcingTrackerNumber.trim());
  set("ParticipatingHA_c", toJsonArray(row.HealthOrganization));
  set("Text02_c", blank(row.OptionYearsAvailable) ? undefined : row.OptionYearsAvailable.trim());
  set("Number06_c", toNumber(row.BCEHS_Est_AnnualSpend));
  set("Number07_c", toNumber(row.FHA_Est_AnnualSpend));
  set("Number08_c", toNumber(row.FNHA_Est_AnnualSpend));
  set("Number09_c", toNumber(row.IHA_Est_AnnualSpend));
  set("Number10_c", toNumber(row.VIHA_Est_AnnualSpend));
  set("Number11_c", toNumber(row.NHA_Est_AnnualSpend));
  set("Number12_c", toNumber(row.PHC_Est_AnnualSpend));
  set("Number13_c", toNumber(row.PHSA_Est_AnnualSpend));
  set("Number14_c", toNumber(row.VCHA_Est_AnnualSpend));
  set("PDText01_c", toJsonArray(row.ContractTypeName));
  set("PDText02_c", blank(row.InitialProcurementStrategy) ? undefined : row.InitialProcurementStrategy.trim());
  set("PDText03_c", blank(row.ExpiryStrategy) ? undefined : row.ExpiryStrategy.trim());
  set("Text11_c", blank(row.RebateOrValueAdd) ? undefined : row.RebateOrValueAdd.trim());
  set("Text12_c", blank(row.RebateFrequencyName) ? undefined : row.RebateFrequencyName.trim());
  set("Text13_c", blank(row.RebateDescription) ? undefined : row.RebateDescription.trim());
  set("Text18_c", blank(row.AgencyOrDepartment) ? undefined : row.AgencyOrDepartment.trim());
  set("Date01_c", toDateIso(row.DateOfNextPriceIncrease));

  return payload;
}

async function main() {
  mkdirSync(LOG_DIR, { recursive: true });
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const settings = TOML.parse(readFileSync(SETTINGS_PATH, "utf-8"));
  const { baseUrl, username, password } = settings.server;
  const serverOrigin = /^https?:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`;

  const stamp = timestamp();
  const log = createLogger(LOG_DIR, { prefix: `insert-contract-properties-${stamp}` });
  const client = await createClient(log, { username, password }, { baseUrl: serverOrigin });

  log.info("Script: 8-InsertContractProperties");
  log.info(`Server: ${serverOrigin}`);
  log.info(`Input: ${INPUT_CSV}`);
  log.info("");

  // Parse input — only rows with OracleContractId
  const rows = parse(readFileSync(INPUT_CSV, "utf-8"), {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    relax_column_count: true,
    trim: true,
  });
  const workRows = rows.filter(r => !blank(r.OracleContractId));
  log.info(`Rows with OracleContractId: ${workRows.length} / ${rows.length}`);
  log.info("");

  if (workRows.length === 0) {
    log.info("Nothing to process — run 7-InsertContract first.");
    log.summary();
    return;
  }

  // Fetch all contracts → ContractNumber → { id, majorVersion }
  log.info("Fetching contracts from Oracle (Id + MajorVersion)...");
  const contractMap = new Map();
  let offset = 0, total = null;
  while (true) {
    const res = await client.get(
      `${CONTRACTS_ENDPOINT}?fields=Id,ContractId,ContractNumber,MajorVersion&onlyData=true&totalResults=true&limit=500&offset=${offset}`
    );
    if (!res.ok) { log.error(`Contract fetch failed: HTTP ${res.status}`); break; }
    const items = res.data.items || [];
    if (total === null) {
      total = res.data.totalResults || 0;
      log.info(`  Total in Oracle: ${total}`);
    }
    for (const c of items) {
      const cn = (c.ContractNumber || "").trim();
      if (cn) contractMap.set(cn, { id: String(c.Id), majorVersion: c.MajorVersion ?? 1 });
    }
    offset += items.length;
    if (items.length < 500 || offset >= total) break;
  }
  log.info(`  Contract map: ${contractMap.size} entries`);
  log.info("");

  // Fetch existing ContractProperties_c — ObjectId_c → record Id (for PATCH)
  log.info("Fetching existing ContractProperties_c...");
  const existingProps = new Map(); // ObjectId_c → record Id
  offset = 0;
  total = null;
  while (true) {
    const res = await client.get(
      `${CONTRACT_PROPS_ENDPOINT}?fields=Id,ObjectId_c&onlyData=true&totalResults=true&limit=500&offset=${offset}`
    );
    if (!res.ok) { log.error(`ContractProperties_c fetch failed: HTTP ${res.status}`); break; }
    const items = res.data.items || [];
    if (total === null) {
      total = res.data.totalResults || 0;
      log.info(`  Total existing: ${total}`);
    }
    for (const p of items) existingProps.set(String(p.ObjectId_c), String(p.Id));
    offset += items.length;
    if (items.length < 500 || offset >= total) break;
  }
  log.info(`  Existing ObjectId_c → Id entries: ${existingProps.size}`);
  log.info("");

  // Build work list — recordId set when existing (PATCH), null for new (POST)
  let noContractMap = 0;
  const workList = [];
  for (const row of workRows) {
    const contractEntry = contractMap.get((row.ContractNumber || "").trim());
    if (!contractEntry) { noContractMap++; continue; }
    const recordId = existingProps.get(contractEntry.id) || null;
    workList.push({ row, id: contractEntry.id, majorVersion: contractEntry.majorVersion, recordId });
  }
  const toPatch = workList.filter(w => w.recordId).length;
  const toPost = workList.length - toPatch;
  log.info(`Work list: ${workList.length} total (${toPatch} PATCH, ${toPost} POST)`);
  log.info(`  Not found in Oracle: ${noContractMap}`);
  log.info("");

  // POST or PATCH in concurrent batches
  let created = 0, patched = 0, failed = 0;
  const results = [];

  for (let batch = 0; batch < workList.length; batch += CONCURRENCY) {
    const slice = workList.slice(batch, batch + CONCURRENCY);

    const batchResults = await Promise.all(slice.map(async ({ row, id, majorVersion, recordId }) => {
      const contractNumber = (row.ContractNumber || "").trim();
      const payload = buildPayload(id, majorVersion, contractNumber, row);
      const res = recordId
        ? await client.patch(`${CONTRACT_PROPS_ENDPOINT}/${recordId}`, payload)
        : await client.post(CONTRACT_PROPS_ENDPOINT, payload);
      const verb = recordId ? "PATCHED" : "CREATED";

      if (res.ok) {
        log.info(`  ${verb} ${contractNumber} (Id=${id})`);
        return { contractNumber, result: verb };
      }
      const msg = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
      log.error(`  FAILED ${contractNumber}: HTTP ${res.status} — ${msg}`);
      log.error(`  Payload: ${JSON.stringify(payload)}`);
      return { contractNumber, result: `FAIL: HTTP ${res.status}` };
    }));

    for (const r of batchResults) {
      results.push(r);
      if (r.result === "CREATED") created++;
      else if (r.result === "PATCHED") patched++;
      else failed++;
    }

    const done = Math.min(batch + CONCURRENCY, workList.length);
    if (done % 100 === 0 || done === workList.length) {
      log.info(`Progress: ${done}/${workList.length}`);
    }
  }

  const outFile = resolve(OUTPUT_DIR, `insert-contract-properties-${stamp}.csv`);
  writeFileSync(outFile, [
    ["ContractNumber", "Result"].join(","),
    ...results.map(r => [r.contractNumber, r.result].map(csvEscape).join(",")),
  ].join("\n") + "\n");

  log.info("=".repeat(50));
  log.info(`Created:           ${created}`);
  log.info(`Patched:           ${patched}`);
  log.info(`Failed:            ${failed}`);
  log.info(`Not in Oracle map: ${noContractMap}`);
  log.info(`Report: ${outFile}`);
  log.info("=".repeat(50));
  log.summary();

  console.log(`\nCreated: ${created}  Patched: ${patched}  Failed: ${failed}`);
  console.log(`Report: ${outFile}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
