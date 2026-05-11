#!/usr/bin/env node
// ============================================================
// 6-FillPrimaryPartyId
// Description: Page all Oracle suppliers, build a
//              VendorMasterId→SupplierPartyId reference table,
//              and write each row's PrimaryPartyId in
//              LAST_BATCH_LOAD.csv from the VendorMasterId column.
//              Overwrites input file in place.
//
// Output:
//   - LAST_BATCH_LOAD.csv overwritten with PrimaryPartyId filled
//   - output/<timestamp>-reference.csv  — full supplier reference
//   - output/<timestamp>-unmatched.csv  — rows with no match
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

const SUPPLIERS_URL = "/fscmRestApi/resources/11.13.18.05/suppliers"
  + "?fields=SupplierId,SupplierPartyId,Supplier,DFF&expand=all&onlyData=true&totalResults=true&limit=500";

const pad = n => String(n).padStart(2, "0");
function timestamp() {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function csvEscape(val) {
  if (val === null || val === undefined) return "";
  const s = String(val);
  return s.includes(",") || s.includes('"') || s.includes("\n")
    ? '"' + s.replace(/"/g, '""') + '"'
    : s;
}

function findColKey(headers, fieldName) {
  const lower = fieldName.toLowerCase();
  return headers.find(h => h.trim().toLowerCase() === lower) || null;
}

async function fetchAllSuppliers(client, log) {
  const suppliers = [];
  let offset = 0;
  const limit = 500;
  let total = null;

  while (true) {
    const url = `${SUPPLIERS_URL}&offset=${offset}`;
    const res = await client.get(url);
    if (!res.ok) {
      log.error(`Suppliers fetch failed HTTP ${res.status} at offset ${offset}`);
      process.exit(1);
    }
    if (total === null && res.data.totalResults != null) {
      total = res.data.totalResults;
      log.info(`Total suppliers reported: ${total}`);
    }
    const items = res.data.items || [];
    suppliers.push(...items);
    log.info(`  Fetched offset=${offset}: ${items.length} items (running total: ${suppliers.length})`);
    if (items.length < limit) break;
    offset += limit;
  }
  return suppliers;
}

async function main() {
  mkdirSync(LOG_DIR, { recursive: true });
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const settings = TOML.parse(readFileSync(SETTINGS_PATH, "utf-8"));
  const { baseUrl, username, password } = settings.server;
  const serverOrigin = /^https?:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`;

  const stamp = timestamp();
  const log = createLogger(LOG_DIR, { prefix: `fill-primary-party-id-${stamp}` });
  const client = await createClient(log, { username, password }, { baseUrl: serverOrigin });

  log.info("Script: 6-FillPrimaryPartyId");
  log.info(`Server: ${serverOrigin}`);
  log.info(`Input: ${INPUT_CSV}`);
  log.info("");

  // Fetch all suppliers and build lookup
  log.info("Fetching suppliers...");
  const suppliers = await fetchAllSuppliers(client, log);
  log.info(`Total fetched: ${suppliers.length}`);
  log.info("");

  const lookup = new Map(); // String(vendorMasterId) → String(SupplierPartyId)
  const refRows = [];       // for reference CSV

  for (const item of suppliers) {
    const dff = Array.isArray(item.DFF) ? item.DFF[0] : null;
    const vendorMasterId = dff?.vendorMasterId != null ? String(dff.vendorMasterId).trim() : null;
    const supplierPartyId = item.SupplierPartyId != null ? String(item.SupplierPartyId) : null;
    const supplierName = item.Supplier || "";

    if (vendorMasterId && supplierPartyId) {
      if (!lookup.has(vendorMasterId)) {
        lookup.set(vendorMasterId, supplierPartyId);
      }
    }
    refRows.push({ vendorMasterId: vendorMasterId ?? "", supplierPartyId: supplierPartyId ?? "", supplier: supplierName });
  }
  log.info(`Lookup entries (unique VendorMasterId): ${lookup.size}`);

  // Write reference CSV
  const refFile = resolve(OUTPUT_DIR, `fill-primary-party-id-${stamp}-reference.csv`);
  const refHeaders = ["VendorMasterId", "SupplierPartyId", "Supplier"];
  writeFileSync(refFile, [
    refHeaders.join(","),
    ...refRows.map(r => [r.vendorMasterId, r.supplierPartyId, r.supplier].map(csvEscape).join(",")),
  ].join("\n") + "\n");
  log.info(`Reference CSV written: ${refFile}`);
  log.info("");

  // Parse input CSV
  const raw = readFileSync(INPUT_CSV, "utf-8");
  const rows = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    relax_column_count: true,
    trim: true,
  });
  log.info(`Rows: ${rows.length}`);

  const headers = Object.keys(rows[0]);
  const vendorMasterIdKey  = findColKey(headers, "VendorMasterId");
  const primaryPartyIdKey  = findColKey(headers, "PrimaryPartyId");
  const contractNumberKey  = findColKey(headers, "ContractNumber");

  if (!vendorMasterIdKey)  { log.error("Column not found: VendorMasterId");  process.exit(1); }
  if (!primaryPartyIdKey)  { log.error("Column not found: PrimaryPartyId");  process.exit(1); }

  let matched = 0, unmatched = 0, blank = 0;
  const noMatch = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const vendorMasterId   = (row[vendorMasterIdKey]  || "").trim();
    const contractNumber   = contractNumberKey ? (row[contractNumberKey] || "").trim() : String(i + 2);

    if (!vendorMasterId) {
      blank++;
      continue;
    }

    const supplierPartyId = lookup.get(vendorMasterId);
    if (supplierPartyId) {
      row[primaryPartyIdKey] = supplierPartyId;
      log.info(`  [${i + 2}] VendorMasterId=${vendorMasterId} → SupplierPartyId=${supplierPartyId}`);
      matched++;
    } else {
      log.info(`  [${i + 2}] NO MATCH: VendorMasterId="${vendorMasterId}"`);
      noMatch.push({ rowNum: i + 2, contractNumber, vendorMasterId });
      unmatched++;
    }
  }

  // Overwrite input CSV with filled PrimaryPartyId
  const outLines = [headers.join(",")];
  for (const row of rows) {
    outLines.push(headers.map(h => csvEscape(row[h] ?? "")).join(","));
  }
  writeFileSync(INPUT_CSV, outLines.join("\n") + "\n");
  log.info(`\nFilled CSV written: ${INPUT_CSV}`);

  // Write unmatched report
  const unmatchedFile = resolve(OUTPUT_DIR, `fill-primary-party-id-${stamp}-unmatched.csv`);
  writeFileSync(unmatchedFile, [
    ["RowNum", "ContractNumber", "VendorMasterId"].join(","),
    ...noMatch.map(r => [r.rowNum, r.contractNumber, r.vendorMasterId].map(csvEscape).join(",")),
  ].join("\n") + "\n");

  log.info("=".repeat(50));
  log.info(`Matched:   ${matched}`);
  log.info(`Unmatched: ${unmatched}`);
  log.info(`Blank:     ${blank}`);
  log.info(`Reference: ${refFile}`);
  log.info(`Unmatched: ${unmatchedFile}`);
  log.info("=".repeat(50));
  log.summary();

  console.log(`\nMatched: ${matched}  Unmatched: ${unmatched}  Blank: ${blank}`);
  if (unmatched > 0) console.log(`Unmatched report: ${unmatchedFile}`);
  console.log(`Reference table: ${refFile}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
