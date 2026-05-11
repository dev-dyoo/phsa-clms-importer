#!/usr/bin/env node
// ============================================================
// 2-TransformHeadings
// Description: Transform LAST_BATCH_LOAD.csv headers to match
//              batch-3 format. Overwrites the input file in place.
//
// Changes applied:
//   - Prepend 3 blank ID columns: OracleContractId, ContractTypeId, PrimaryPartyId
//   - Move CONTRACT_TYPE to 4th column
//   - Rename VendorMasterDescrip_REFERENCE2    → master vendor descrip
//   - Rename DistributorMasterDescrip_REFERENCE → master vendor distributor desc
//   - Rename Distributor_VendorMasterID         → Distributor_VendorMasterId
//   - Strip non-breaking spaces from all header names
//   - Trim all cell values
// ============================================================

import { readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { parse } from "csv-parse/sync";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PHSA_SCRIPTS_DIR = resolve(__dirname, "..");
const INPUT_CSV = resolve(PHSA_SCRIPTS_DIR, "input", "LAST_BATCH_LOAD.csv");

const RENAMES = {
  "VendorMasterDescrip_REFERENCE2":     "master vendor descrip",
  "DistributorMasterDescrip_REFERENCE": "master vendor distributor desc",
  "Distributor_VendorMasterID":          "Distributor_VendorMasterId",
};

const NEW_PREFIX = ["OracleContractId", "ContractTypeId", "PrimaryPartyId", "CONTRACT_TYPE"];

function cleanKey(k) {
  return k.replace(/[ \s]+/g, "").trim();
}

function csvEscape(val) {
  if (val === null || val === undefined) return "";
  const s = String(val).trim();
  return s.includes(",") || s.includes('"') || s.includes("\n")
    ? '"' + s.replace(/"/g, '""') + '"'
    : s;
}

const raw = readFileSync(INPUT_CSV, "utf-8");
const rows = parse(raw, { columns: true, skip_empty_lines: true, bom: true, relax_column_count: true });

if (rows.length === 0) {
  console.error("Input CSV is empty.");
  process.exit(1);
}

const rawKeys = Object.keys(rows[0]);
const keyMap = {};
for (const rawK of rawKeys) {
  const clean = cleanKey(rawK);
  const renamed = RENAMES[clean] || clean;
  keyMap[renamed] = rawK;
}

const originalRenamed = rawKeys.map(k => {
  const clean = cleanKey(k);
  return RENAMES[clean] || clean;
});
const rest = originalRenamed.filter(h => !NEW_PREFIX.includes(h));
const finalHeaders = [...NEW_PREFIX, ...rest];

const lines = [finalHeaders.join(",")];
for (const row of rows) {
  const cells = finalHeaders.map(h => {
    if (h === "OracleContractId" || h === "ContractTypeId" || h === "PrimaryPartyId") return "";
    const rawK = keyMap[h];
    return csvEscape(rawK ? row[rawK] : "");
  });
  lines.push(cells.join(","));
}

writeFileSync(INPUT_CSV, lines.join("\n") + "\n");

console.log(`Transformed ${rows.length} rows.`);
console.log(`Headers (${finalHeaders.length}): ${finalHeaders.join(", ")}`);
console.log(`Output: ${INPUT_CSV}`);
