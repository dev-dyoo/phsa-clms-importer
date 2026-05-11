#!/usr/bin/env node
// ============================================================
// 5-FillContractTypeId
// Description: Fetch contract types from Oracle LOV, match each
//              CONTRACT_TYPE value in LAST_BATCH_LOAD.csv against
//              the Name field, and write the ContractTypeId.
//              Overwrites input file in place.
//
// Match logic (case-insensitive, in order):
//   1. Full string match on Name
//   2. First 15 characters of both strings match (prefix fallback)
//
// Output:
//   - LAST_BATCH_LOAD.csv overwritten with ContractTypeId filled
//   - output/<timestamp>.csv — rows with no match
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

const LOV_URL = "/fscmRestApi/resources/11.13.18.05/contracts/300000006409761/lov/ContractTypeAllVA"
  + "?fields=ContractTypeId,Name&onlyData=true&limit=500";

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

function matchContractType(contractType, types) {
  const needle = contractType.trim().toLowerCase();
  // 1. Full match
  const full = types.find(t => t.Name.toLowerCase() === needle);
  if (full) return { type: full, matchKind: "full" };
  // 2. First-15 prefix match — compare up to min(15, needle.length) chars
  const prefixLen = Math.min(15, needle.length);
  const needle15 = needle.slice(0, prefixLen);
  const prefix = types.find(t => t.Name.toLowerCase().slice(0, prefixLen) === needle15);
  if (prefix) return { type: prefix, matchKind: "prefix15" };
  // 3. Contains — API name's first 10 chars appear anywhere in the load value
  const contains = types.find(t => needle.includes(t.Name.toLowerCase().slice(0, 10)));
  if (contains) return { type: contains, matchKind: "contains10" };
  return null;
}

async function main() {
  mkdirSync(LOG_DIR, { recursive: true });
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const settings = TOML.parse(readFileSync(SETTINGS_PATH, "utf-8"));
  const { baseUrl, username, password } = settings.server;
  const serverOrigin = /^https?:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`;

  const stamp = timestamp();
  const log = createLogger(LOG_DIR, { prefix: `fill-contract-type-id-${stamp}` });
  const client = await createClient(log, { username, password }, { baseUrl: serverOrigin });

  log.info("Script: 5-FillContractTypeId");
  log.info(`Server: ${serverOrigin}`);
  log.info(`Input: ${INPUT_CSV}`);
  log.info("");

  // Fetch contract types from LOV
  const res = await client.get(LOV_URL);
  if (!res.ok) {
    log.error(`LOV fetch failed HTTP ${res.status}`);
    process.exit(1);
  }
  const types = res.data.items || [];
  log.info(`Contract types from LOV (${types.length}):`);
  for (const t of types) log.info(`  ${t.ContractTypeId}  ${t.Name}`);
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
  const contractTypeKey    = findColKey(headers, "CONTRACT_TYPE");
  const contractTypeIdKey  = findColKey(headers, "ContractTypeId");
  const contractNumberKey  = findColKey(headers, "ContractNumber");
  const sourceKey          = findColKey(headers, "Source");

  if (!contractTypeKey)   { log.error("Column not found: CONTRACT_TYPE");  process.exit(1); }
  if (!contractTypeIdKey) { log.error("Column not found: ContractTypeId"); process.exit(1); }

  let matched = 0, unmatched = 0, blank = 0;
  const noMatch = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const contractType   = (row[contractTypeKey]   || "").trim();
    const contractNumber = (row[contractNumberKey] || "").trim();

    const source = sourceKey ? (row[sourceKey] || "").trim() : "";

    // CCR override — takes priority over API matching
    if (source === "CCR") {
      row[contractTypeIdKey] = "300000005684060";
      row[contractTypeKey]   = "Consultant SOW";
      log.info(`  [${i + 2}] CCR override → 300000005684060 "Consultant SOW"`);
      matched++;
      continue;
    }

    if (!contractType) { blank++; continue; }

    const result = matchContractType(contractType, types);
    if (result) {
      row[contractTypeIdKey] = String(result.type.ContractTypeId);
      log.info(`  [${i + 2}] "${contractType}" → ${result.type.ContractTypeId} "${result.type.Name}" [${result.matchKind}]`);
      matched++;
    } else {
      log.info(`  [${i + 2}] NO MATCH: "${contractType}"`);
      noMatch.push({ rowNum: i + 2, contractNumber, contractType });
      unmatched++;
    }
  }

  // Overwrite input CSV with filled ContractTypeId
  const outLines = [headers.join(",")];
  for (const row of rows) {
    outLines.push(headers.map(h => csvEscape(row[h] ?? "")).join(","));
  }
  writeFileSync(INPUT_CSV, outLines.join("\n") + "\n");
  log.info(`\nFilled CSV written: ${INPUT_CSV}`);

  // Write unmatched report
  const reportFile = resolve(OUTPUT_DIR, `fill-contract-type-id-${stamp}.csv`);
  const reportHeaders = ["RowNum", "ContractNumber", "CONTRACT_TYPE"];
  writeFileSync(reportFile, [
    reportHeaders.join(","),
    ...noMatch.map(r => [r.rowNum, r.contractNumber, r.contractType].map(csvEscape).join(",")),
  ].join("\n") + "\n");

  log.info("=".repeat(50));
  log.info(`Matched:   ${matched}`);
  log.info(`Unmatched: ${unmatched}`);
  log.info(`Blank:     ${blank}`);
  log.info(`Report:    ${reportFile}`);
  log.info("=".repeat(50));
  log.summary();

  console.log(`\nMatched: ${matched}  Unmatched: ${unmatched}  Blank: ${blank}`);
  if (unmatched > 0) console.log(`Unmatched report: ${reportFile}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
