#!/usr/bin/env node
// ============================================================
// DeleteContractProperties
// Description: For each contract number in LAST_BATCH_LOAD.csv,
//              query ContractProperties_c?q=ContractNumber_c=<cn>,
//              dump all matches to output CSV, then DELETE them.
//              Runs with CONCURRENCY=10 for queries; deletes are
//              also CONCURRENCY=10.
//
// Output:
//   - output/<timestamp>-found.csv   — all matched records
//   - output/<timestamp>-deleted.csv — delete results
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

function extractError(data) {
  if (typeof data === "string") return data.slice(0, 300);
  if (data?.detail) return data.detail;
  if (data?.message) return data.message;
  if (data?.title) return data.title;
  return JSON.stringify(data).slice(0, 300);
}

async function queryProps(client, contractNumber) {
  const all = [];
  let offset = 0;
  while (true) {
    const res = await client.get(
      `${CONTRACT_PROPS_ENDPOINT}?q=ContractNumber_c=${encodeURIComponent(contractNumber)}&fields=Id,ContractNumber_c,ObjectId_c,RecordName,MajorVersion_c,CreationDate&onlyData=true&limit=500&offset=${offset}`
    );
    if (!res.ok) return { error: `HTTP ${res.status}: ${extractError(res.data)}`, items: [] };
    const items = res.data.items || [];
    all.push(...items);
    offset += items.length;
    if (items.length < 500) break;
  }
  return { error: null, items: all };
}

async function main() {
  mkdirSync(LOG_DIR, { recursive: true });
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const settings = TOML.parse(readFileSync(SETTINGS_PATH, "utf-8"));
  const { baseUrl, username, password } = settings.server;
  const serverOrigin = /^https?:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`;

  const stamp = timestamp();
  const log = createLogger(LOG_DIR, { prefix: `delete-contract-properties-${stamp}` });
  const client = await createClient(log, { username, password }, { baseUrl: serverOrigin });

  log.info("Script: DeleteContractProperties");
  log.info(`Server: ${serverOrigin}`);
  log.info(`Input: ${INPUT_CSV}`);
  log.info("");

  // Read all contract numbers from LAST_BATCH_LOAD
  const rows = parse(readFileSync(INPUT_CSV, "utf-8"), {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    relax_column_count: true,
    trim: true,
  });
  const contractNumbers = [...new Set(rows.map(r => (r.ContractNumber || "").trim()).filter(Boolean))];
  log.info(`Contract numbers to check: ${contractNumbers.length}`);
  log.info("");

  // Phase 1: Query ContractProperties_c for each contract (concurrent)
  log.info("Phase 1: Querying ContractProperties_c by ContractNumber_c...");
  const foundRecords = [];

  for (let batch = 0; batch < contractNumbers.length; batch += CONCURRENCY) {
    const slice = contractNumbers.slice(batch, batch + CONCURRENCY);
    const batchResults = await Promise.all(slice.map(async cn => {
      const { error, items } = await queryProps(client, cn);
      if (error) { log.error(`  ${cn}: query error — ${error}`); return []; }
      if (items.length > 0) log.info(`  ${cn}: ${items.length} record(s)`);
      return items.map(item => ({
        contractNumber: cn,
        Id: item.Id,
        ObjectId_c: item.ObjectId_c,
        RecordName: item.RecordName,
        MajorVersion_c: item.MajorVersion_c,
        CreationDate: item.CreationDate,
      }));
    }));

    for (const recs of batchResults) foundRecords.push(...recs);

    const done = Math.min(batch + CONCURRENCY, contractNumbers.length);
    if (done % 100 === 0 || done === contractNumbers.length) {
      log.info(`  Queried ${done}/${contractNumbers.length} — ${foundRecords.length} records found so far`);
    }
  }

  log.info(`Total records found: ${foundRecords.length}`);
  log.info("");

  // Write found records to CSV before deleting
  const foundFile = resolve(OUTPUT_DIR, `delete-contract-properties-${stamp}-found.csv`);
  writeFileSync(foundFile, [
    ["ContractNumber", "Id", "ObjectId_c", "RecordName", "MajorVersion_c", "CreationDate"].join(","),
    ...foundRecords.map(r => [r.contractNumber, r.Id, r.ObjectId_c, r.RecordName, r.MajorVersion_c, r.CreationDate].map(csvEscape).join(",")),
  ].join("\n") + "\n");
  log.info(`Found records written to: ${foundFile}`);
  log.info("");

  if (foundRecords.length === 0) {
    log.info("Nothing to delete.");
    log.summary();
    console.log("\nNothing to delete.");
    return;
  }

  // Phase 2: Delete all found records (concurrent)
  log.info("Phase 2: Deleting records...");
  let deleted = 0, deleteFailed = 0;
  const deleteResults = [];

  for (let batch = 0; batch < foundRecords.length; batch += CONCURRENCY) {
    const slice = foundRecords.slice(batch, batch + CONCURRENCY);

    const batchResults = await Promise.all(slice.map(async rec => {
      const res = await client.delete(`${CONTRACT_PROPS_ENDPOINT}/${rec.Id}`);
      if (res.ok) {
        log.info(`  DELETED ${rec.contractNumber} Id=${rec.Id} (${rec.RecordName})`);
        return { ...rec, result: "DELETED" };
      }
      const msg = extractError(res.data);
      log.error(`  FAILED ${rec.contractNumber} Id=${rec.Id}: HTTP ${res.status} — ${msg}`);
      return { ...rec, result: `FAIL: HTTP ${res.status}` };
    }));

    for (const r of batchResults) {
      deleteResults.push(r);
      if (r.result === "DELETED") deleted++;
      else deleteFailed++;
    }

    const done = Math.min(batch + CONCURRENCY, foundRecords.length);
    if (done % 100 === 0 || done === foundRecords.length) {
      log.info(`  Progress: ${done}/${foundRecords.length}`);
    }
  }

  // Write delete results
  const deletedFile = resolve(OUTPUT_DIR, `delete-contract-properties-${stamp}-deleted.csv`);
  writeFileSync(deletedFile, [
    ["ContractNumber", "Id", "ObjectId_c", "RecordName", "Result"].join(","),
    ...deleteResults.map(r => [r.contractNumber, r.Id, r.ObjectId_c, r.RecordName, r.result].map(csvEscape).join(",")),
  ].join("\n") + "\n");

  log.info("=".repeat(50));
  log.info(`Contracts checked:  ${contractNumbers.length}`);
  log.info(`Records found:      ${foundRecords.length}`);
  log.info(`Deleted:            ${deleted}`);
  log.info(`Failed:             ${deleteFailed}`);
  log.info(`Found report:   ${foundFile}`);
  log.info(`Deleted report: ${deletedFile}`);
  log.info("=".repeat(50));
  log.summary();

  console.log(`\nFound: ${foundRecords.length}  Deleted: ${deleted}  Failed: ${deleteFailed}`);
  console.log(`Reports: ${OUTPUT_DIR}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
