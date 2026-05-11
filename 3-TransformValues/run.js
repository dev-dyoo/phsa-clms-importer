#!/usr/bin/env node
// ============================================================
// 3-TransformValues
// Description: Normalize field values in LAST_BATCH_LOAD.csv
//              against Oracle-fetched valid lookup/valueSet codes.
//              Overwrites input file in place.
//
// Fields processed:
//   CMTeam                     → valueSet  PHSA_CM_TEAMS              (field: Value)
//   ExpiryStrategy             → lookup    PHSA_EXPIRY_STRATEGY        (field: LookupCode)
//   InitialProcurementStrategy → lookup    PHSA_INITIAL_PRC_STRATEGY   (field: LookupCode)
//   OptionYearsAvailable       → lookup    PHSA_OPTION_YEARS_AVAILABLE (field: LookupCode)
//   ContractTypeName           → lookup    PHSA_WB_CONTRACT_TYPE       (field: LookupCode)
//
// Normalize transform (applied in order):
//   1. Strip from first '(' to end of string (drop parenthetical annotations)
//   2. Trim leading/trailing whitespace
//   3. Collapse runs of 2+ spaces to a single space
//   4. Replace each space, slash, or hyphen with underscore
//
// Output:
//   - LAST_BATCH_LOAD.csv overwritten with normalized values
//   - output/<timestamp>.csv  — rows where normalized value is not a known valid code
// ============================================================

import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { parse } from "csv-parse/sync";
// import TOML from "@iarna/toml";
// import { createClient } from "../lib/client.js";
import { createLogger } from "../lib/logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR = __dirname;
const PHSA_SCRIPTS_DIR = resolve(SCRIPT_DIR, "..");
const LOG_DIR = resolve(SCRIPT_DIR, "log");
const OUTPUT_DIR = resolve(SCRIPT_DIR, "output");
const SETTINGS_PATH = resolve(PHSA_SCRIPTS_DIR, "settings.toml");
const INPUT_CSV = resolve(PHSA_SCRIPTS_DIR, "input", "LAST_BATCH_LOAD.csv");

const BASE = "/fscmRestApi/resources/11.13.18.05";

const FIELD_CONFIG = [
  {
    col: "CMTeam",
    type: "valueSet",
    resourceCode: "PHSA_CM_TEAMS",
    valueField: "Value",
  },
  {
    col: "ExpiryStrategy",
    type: "lookup",
    resourceCode: "PHSA_EXPIRY_STRATEGY",
    valueField: "LookupCode",
  },
  {
    col: "InitialProcurementStrategy",
    type: "lookup",
    resourceCode: "PHSA_INITIAL_PRC_STRATEGY",
    valueField: "LookupCode",
  },
  {
    col: "OptionYearsAvailable",
    type: "lookup",
    resourceCode: "PHSA_OPTION_YEARS_AVAILABLE",
    valueField: "LookupCode",
    // Remove spaces, then remove underscores adjacent to digits.
    // Handles fresh data ("1 X 1 Month" → "1X1MONTH") and already-normalized
    // data ("1_X_1_MONTH" → "1X1MONTH") without breaking "UNLIMITED_RENEWAL".
    preprocess: v => v.replace(/ /g, "").replace(/(\d)_/g, "$1").replace(/_(\d)/g, "$1"),
  },
  {
    col: "ContractTypeName",
    type: "lookup",
    resourceCode: "PHSA_WB_CONTRACT_TYPE",
    valueField: "LookupCode",
  },
];

// Normalize a raw CSV value to match Oracle lookup code format.
function normalize(val) {
  return (val || "")
    .replace(/\(.*$/, "")    // strip from first '(' onwards
    .trim()
    .replace(/ {2,}/g, " ")  // collapse multiple spaces to one
    .replace(/[ /\-]/g, "_") // space / slash / hyphen → underscore
    .toUpperCase()
    .replace(/,_/g, ",");    // remove underscore immediately after comma
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

const pad = n => String(n).padStart(2, "0");
function timestamp() {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// async function fetchAllValues(client, url, valueField) {
//   const values = new Set();
//   let offset = 0;
//   const limit = 500;
//   while (true) {
//     const sep = url.includes("?") ? "&" : "?";
//     const paged = `${url}${sep}limit=${limit}&offset=${offset}`;
//     const res = await client.get(paged);
//     if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`);
//     const items = res.data.items || [];
//     for (const item of items) {
//       const v = String(item[valueField] ?? "").trim();
//       if (v) values.add(v);
//     }
//     if (items.length < limit) break;
//     offset += limit;
//   }
//   return values;
// }
//
// async function fetchValidCodes(client, cfg) {
//   if (cfg.type === "valueSet") {
//     const url = `${BASE}/valueSets/${encodeURIComponent(cfg.resourceCode)}/child/values?fields=${cfg.valueField}&onlyData=true`;
//     return fetchAllValues(client, url, cfg.valueField);
//   }
//   const q = encodeURIComponent("EnabledFlag=Y");
//   const url = `${BASE}/standardLookups/${encodeURIComponent(cfg.resourceCode)}/child/lookupCodes?fields=${cfg.valueField}&q=${q}&onlyData=true`;
//   return fetchAllValues(client, url, cfg.valueField);
// }

async function main() {
  mkdirSync(LOG_DIR, { recursive: true });
  mkdirSync(OUTPUT_DIR, { recursive: true });

  // const settings = TOML.parse(readFileSync(SETTINGS_PATH, "utf-8"));
  // const { baseUrl, username, password } = settings.server;
  // const serverOrigin = /^https?:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`;

  const stamp = timestamp();
  const log = createLogger(LOG_DIR, { prefix: `transform-values-${stamp}` });
  // const client = await createClient(log, { username, password }, { baseUrl: serverOrigin });

  log.info("Script: 3-TransformValues");
  log.info(`Input: ${INPUT_CSV}`);
  log.info("");

  // API validation disabled — all fields treated as unchecked
  const validCodes = {};
  for (const cfg of FIELD_CONFIG) validCodes[cfg.col] = new Set();
  // for (const cfg of FIELD_CONFIG) {
  //   log.info(`Fetching ${cfg.col} — ${cfg.type} ${cfg.resourceCode}`);
  //   try {
  //     validCodes[cfg.col] = await fetchValidCodes(client, cfg);
  //     log.info(`  valid codes (${validCodes[cfg.col].size}): ${[...validCodes[cfg.col]].join(", ")}`);
  //   } catch (err) {
  //     log.error(`  FAILED: ${err.message}`);
  //     validCodes[cfg.col] = new Set();
  //   }
  // }
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

  if (rows.length === 0) {
    log.error("Input CSV is empty.");
    process.exit(1);
  }
  log.info(`Rows: ${rows.length}`);

  const headers = Object.keys(rows[0]);
  const colKeys = {};
  for (const cfg of FIELD_CONFIG) {
    colKeys[cfg.col] = findColKey(headers, cfg.col);
    if (!colKeys[cfg.col]) log.info(`  WARNING: column not found — ${cfg.col}`);
  }
  const contractNumKey = findColKey(headers, "ContractNumber");

  const stats = {};
  for (const cfg of FIELD_CONFIG) stats[cfg.col] = { valid: 0, invalid: 0, blank: 0, unchecked: 0 };

  const issues = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const contractNum = contractNumKey ? (row[contractNumKey] || "").trim() : String(i + 2);

    for (const cfg of FIELD_CONFIG) {
      const key = colKeys[cfg.col];
      if (!key) continue;

      const original = (row[key] || "").trim();
      const preprocessed = cfg.preprocess ? cfg.preprocess(original) : original;
      const transformed = normalize(preprocessed);

      let status;
      if (!original) {
        status = "BLANK";
        stats[cfg.col].blank++;
      } else if (validCodes[cfg.col].size === 0) {
        status = "UNCHECKED";
        stats[cfg.col].unchecked++;
      } else if (validCodes[cfg.col].has(transformed)) {
        status = "VALID";
        stats[cfg.col].valid++;
      } else {
        status = "INVALID";
        stats[cfg.col].invalid++;
        issues.push({ rowNum: i + 2, contractNum, field: cfg.col, original, transformed, status });
      }

      row[key] = transformed;
    }
  }

  // Overwrite input CSV with normalized values
  const outLines = [headers.join(",")];
  for (const row of rows) {
    outLines.push(headers.map(h => csvEscape(row[h] ?? "")).join(","));
  }
  writeFileSync(INPUT_CSV, outLines.join("\n") + "\n");
  log.info(`Normalized CSV written: ${INPUT_CSV}`);
  log.info("");

  // Write validation report (invalid rows only)
  const reportFile = resolve(OUTPUT_DIR, `transform-values-${stamp}.csv`);
  const reportHeaders = ["RowNum", "ContractNumber", "Field", "OriginalValue", "TransformedValue", "STATUS"];
  const reportLines = [
    reportHeaders.join(","),
    ...issues.map(r =>
      [r.rowNum, r.contractNum, r.field, r.original, r.transformed, r.status]
        .map(csvEscape)
        .join(",")
    ),
  ];
  writeFileSync(reportFile, reportLines.join("\n") + "\n");

  log.info("=".repeat(50));
  for (const cfg of FIELD_CONFIG) {
    const s = stats[cfg.col];
    const parts = [`valid=${s.valid}`, `invalid=${s.invalid}`, `blank=${s.blank}`];
    if (s.unchecked) parts.push(`unchecked=${s.unchecked}`);
    log.info(`${cfg.col}: ${parts.join(", ")}`);
  }
  log.info(`Total invalid: ${issues.length}`);
  log.info(`Report: ${reportFile}`);
  log.info("=".repeat(50));
  log.summary();

  console.log(`\nTotal invalid: ${issues.length}`);
  console.log(`Report: ${reportFile}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
