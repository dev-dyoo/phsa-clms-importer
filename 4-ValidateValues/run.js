#!/usr/bin/env node
// ============================================================
// 4-ValidateValues
// Description: Fetch valid Oracle lookup/valueSet codes for each
//              field, collect unique values from LAST_BATCH_LOAD.csv
//              and PROD batch CSVs, and write a comparison report.
//              Invalid LAST_BATCH_LOAD values are struck through in
//              the markdown output.
//
// Fields compared:
//   CMTeam                     → valueSet  PHSA_CM_TEAMS
//   ExpiryStrategy             → lookup    PHSA_EXPIRY_STRATEGY
//   InitialProcurementStrategy → lookup    PHSA_INITIAL_PRC_STRATEGY
//   OptionYearsAvailable       → lookup    PHSA_OPTION_YEARS_AVAILABLE
//   ContractTypeName           → lookup    PHSA_WB_CONTRACT_TYPE
//
// Output:
//   doc/column-value-comparison.csv
//   doc/column-value-comparison.md  (invalid values ~~struck~~)
// ============================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { parse } from "csv-parse/sync";
import TOML from "@iarna/toml";
import { createClient } from "../lib/client.js";
import { createLogger } from "../lib/logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR = __dirname;
const PHSA_SCRIPTS_DIR = resolve(SCRIPT_DIR, "..");
const ROOT = resolve(SCRIPT_DIR, "..");
const LOG_DIR = resolve(SCRIPT_DIR, "log");
const DOC_DIR = resolve(PHSA_SCRIPTS_DIR, "doc");
const SETTINGS_PATH = resolve(PHSA_SCRIPTS_DIR, "settings.toml");

// Excluded: RebateOrValueAdd, RebateFrequencyName, RebateDescription, AgencyOrDepartment
const FIELD_CONFIG = [
  { col: "CMTeam",                     type: "valueSet", resourceCode: "PHSA_CM_TEAMS",              valueField: "Value" },
  { col: "ExpiryStrategy",             type: "lookup",   resourceCode: "PHSA_EXPIRY_STRATEGY",        valueField: "LookupCode" },
  { col: "InitialProcurementStrategy", type: "lookup",   resourceCode: "PHSA_INITIAL_PRC_STRATEGY",   valueField: "LookupCode" },
  { col: "OptionYearsAvailable",       type: "lookup",   resourceCode: "PHSA_OPTION_YEARS_AVAILABLE", valueField: "LookupCode" },
  { col: "ContractTypeName",           type: "lookup",   resourceCode: "PHSA_WB_CONTRACT_TYPE",       valueField: "LookupCode", splitOn: "," },
];

const BASE = "/fscmRestApi/resources/11.13.18.05";

function loadCsv(path) {
  return parse(readFileSync(path, "utf-8"), {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    relax_column_count: true,
    trim: true,
  });
}

function findCol(row, fieldName) {
  const lower = fieldName.toLowerCase();
  return Object.keys(row).find(k => k.trim().toLowerCase() === lower) || null;
}

function collectValues(rows, fieldName, splitOn = null) {
  const set = new Set();
  for (const row of rows) {
    const col = findCol(row, fieldName);
    if (!col) continue;
    const raw = (row[col] || "").trim();
    if (!raw || raw === "NULL") continue;
    const parts = splitOn ? raw.split(splitOn).map(p => p.trim()).filter(Boolean) : [raw];
    for (const p of parts) set.add(p);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

async function fetchAllValues(client, url, valueField) {
  const values = new Set();
  let offset = 0;
  const limit = 500;
  while (true) {
    const sep = url.includes("?") ? "&" : "?";
    const res = await client.get(`${url}${sep}limit=${limit}&offset=${offset}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const items = res.data.items || [];
    for (const item of items) {
      const v = String(item[valueField] ?? "").trim();
      if (v) values.add(v);
    }
    if (items.length < limit) break;
    offset += limit;
  }
  return values;
}

async function fetchValidCodes(client, cfg) {
  if (cfg.type === "valueSet") {
    const url = `${BASE}/valueSets/${encodeURIComponent(cfg.resourceCode)}/child/values?fields=${cfg.valueField}&onlyData=true`;
    return fetchAllValues(client, url, cfg.valueField);
  }
  const q = encodeURIComponent("EnabledFlag=Y");
  const url = `${BASE}/standardLookups/${encodeURIComponent(cfg.resourceCode)}/child/lookupCodes?fields=${cfg.valueField}&q=${q}&onlyData=true`;
  return fetchAllValues(client, url, cfg.valueField);
}

function csvCell(val) {
  const escaped = (val || "").replace(/"/g, '""');
  return `"${escaped}"`;
}

async function main() {
  mkdirSync(LOG_DIR, { recursive: true });
  mkdirSync(DOC_DIR, { recursive: true });

  const settings = TOML.parse(readFileSync(SETTINGS_PATH, "utf-8"));
  const { baseUrl, username, password } = settings.server;
  const serverOrigin = /^https?:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`;
  const log = createLogger(LOG_DIR, { prefix: "validate-values" });
  const client = await createClient(log, { username, password }, { baseUrl: serverOrigin });

  log.info("Script: 4-ValidateValues");
  log.info(`Server: ${serverOrigin}`);
  log.info("");

  const validCodes = {};
  for (const cfg of FIELD_CONFIG) {
    process.stdout.write(`Fetching ${cfg.col}... `);
    try {
      validCodes[cfg.col] = await fetchValidCodes(client, cfg);
      console.log(`${validCodes[cfg.col].size} codes`);
      log.info(`${cfg.col}: ${validCodes[cfg.col].size} codes`);
    } catch (err) {
      console.log(`FAILED (${err.message}) — skipping validation`);
      log.error(`${cfg.col}: ${err.message}`);
      validCodes[cfg.col] = new Set();
    }
  }

  const batchFiles = [
    resolve(ROOT, "metadata/PROD-contracts-suppliers-batch-1.csv"),
    resolve(ROOT, "metadata/PROD-contracts-suppliers-batch-2.csv"),
    resolve(ROOT, "metadata/PROD-contracts-suppliers-batch-3.csv"),
  ].filter(f => {
    if (existsSync(f)) return true;
    console.log(`PROD batch file not present, skipping: ${f}`);
    log.info(`PROD batch file not present, skipping: ${f}`);
    return false;
  });
  const loadFile = resolve(PHSA_SCRIPTS_DIR, "input/LAST_BATCH_LOAD.csv");
  const batchRows = batchFiles.flatMap(f => loadCsv(f));
  const loadRows = loadCsv(loadFile);

  const csvLines = ["Field,PROD values (batch 1+2+3),LAST_BATCH_LOAD values"];
  const mdSections = ["# Column Value Comparison\n"];

  for (const cfg of FIELD_CONFIG) {
    const { col } = cfg;
    const valid = validCodes[col];
    const prodVals = collectValues(batchRows, col, cfg.splitOn);
    const loadVals = collectValues(loadRows, col, cfg.splitOn);

    csvLines.push([
      csvCell(col),
      csvCell(prodVals.join("\n")),
      csvCell(loadVals.join("\n")),
    ].join(","));

    const prodList = prodVals.length ? prodVals.map(v => `- ${v}`).join("\n") : "- *(none)*";
    const loadList = loadVals.length
      ? loadVals.map(v => {
          const invalid = valid.size > 0 && !valid.has(v);
          return invalid ? `- ~~${v}~~` : `- ${v}`;
        }).join("\n")
      : "- *(none)*";

    mdSections.push(`## ${col}\n\n**PROD (batch 1+2+3)**\n${prodList}\n\n**LAST_BATCH_LOAD**\n${loadList}`);
  }

  const csvPath = resolve(DOC_DIR, "column-value-comparison.csv");
  writeFileSync(csvPath, csvLines.join("\n") + "\n");
  console.log(`\nWritten: ${csvPath}`);

  const mdPath = resolve(DOC_DIR, "column-value-comparison.md");
  writeFileSync(mdPath, mdSections.join("\n\n---\n\n") + "\n");
  console.log(`Written: ${mdPath}`);

  log.summary();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
