#!/usr/bin/env node
// ============================================================
// 7-InsertContract
// Description: POST each row in LAST_BATCH_LOAD.csv to
//              /contracts. Skips rows where OracleContractId
//              is already filled. Writes OracleContractId back
//              to LAST_BATCH_LOAD.csv after each successful POST
//              (crash-safe intermediate saves every 10 rows).
//
// Prerequisites: scripts 3, 5, 6 must have run.
//
// Output:
//   - LAST_BATCH_LOAD.csv overwritten with OracleContractId filled
//   - output/<timestamp>-failed.csv — rows that failed
// ============================================================

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
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
const REF_DIR = resolve(PHSA_SCRIPTS_DIR, "6-FillPrimaryPartyId", "output");

const CONTRACTS_ENDPOINT = "/fscmRestApi/resources/11.13.18.05/contracts";
const SUPPLIERS_ENDPOINT = "/fscmRestApi/resources/11.13.18.05/suppliers";

const STATIC_PAYLOAD = {
  EnableElectronicSignFlag: false,
  TemplateFlag: false,
  BuyOrSell: "B",
  AuthoringPartyCode: "INTERNAL",
  PHSACustomValidationCompleted_c: true,
  AccessLevel: "UPDATE",
  OrgId: 300000004527105,
  LegalEntityId: 300000004643005,
};

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

function normalizeAscii(str) {
  if (!str) return str;
  return str
    .replace(/[–—]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/™/g, "(TM)")
    .replace(/®/g, "(R)")
    .replace(/ /g, " ")
    .replace(/…/g, "...")
    .replace(/½/g, "1/2")
    .replace(/¼/g, "1/4")
    .replace(/¾/g, "3/4");
}

function parseDate(dateStr) {
  if (blank(dateStr)) return null;
  const s = dateStr.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const parts = s.split("/");
  if (parts.length === 3) {
    const [m, d, y] = parts;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return s;
}

function buildDescription(row) {
  const parts = [];
  if (!blank(row.ContractDescription)) parts.push(normalizeAscii(row.ContractDescription.trim()));
  if (!blank(row.ContractCommentTitle)) parts.push(normalizeAscii(row.ContractCommentTitle.trim()));
  if (!blank(row.LatestComment)) parts.push(normalizeAscii(row.LatestComment.trim()));
  return parts.join("\n") || null;
}

function normalizeCategory(val) {
  if (!val || !val.trim()) return null;
  return val.trim().toUpperCase().replace(/[\s/\-]+/g, "_");
}

function extractError(data) {
  if (typeof data === "string") return data.slice(0, 300);
  if (data?.detail) return data.detail;
  if (data?.message) return data.message;
  if (data?.title) return data.title;
  return JSON.stringify(data).slice(0, 300);
}

function findNewestReferenceFile(dir) {
  try {
    const files = readdirSync(dir)
      .filter(f => f.endsWith("-reference.csv"))
      .sort()
      .reverse();
    return files.length > 0 ? resolve(dir, files[0]) : null;
  } catch { return null; }
}

function buildPayload(row, distributorLookup) {
  const supplierId = Number(row.PrimaryPartyId);

  const payload = {
    ...STATIC_PAYLOAD,
    ContractTypeId: row.ContractTypeId,
    ContractNumber: row.ContractNumber,
    PrimaryPartyId: supplierId,
    PartyId: supplierId,
    CurrencyCode: blank(row.Currency) ? "CAD" : row.Currency.trim(),
    Cognomen: blank(row.Title) ? row.ContractNumber : normalizeAscii(row.Title.trim()),
    StartDate: parseDate(row.ContractStartDate),
    EndDate: parseDate(row.ContractEndDate),
    EstimatedAmount: blank(row.TotalValue) ? 0 : Number(String(row.TotalValue).replace(/,/g, "")),
    ContractParty: [{ PartyRoleCode: "SUPPLIER", PartyId: supplierId }],
  };

  const desc = buildDescription(row);
  if (desc) payload.Description = desc;

  const flex = { contractExecutionApproved: "PHSA" };
  if (!blank(row.CMTeam)) flex.phsaCMTeam = row.CMTeam.trim();

  const distVmId = (row.Distributor_VendorMasterId || "").trim();
  if (distVmId) {
    const distPartyId = distributorLookup.get(distVmId);
    if (distPartyId) flex.phsaDistributor1 = Number(distPartyId);
  }

  if (!blank(row.Category1Name)) {
    flex.phsaCategory1 = normalizeCategory(row.Category1Name);
    flex.phsaCategory1Name = row.Category1Name.trim();
  }
  if (!blank(row.Category2Name)) {
    flex.phsaCategory2 = normalizeCategory(row.Category2Name);
    flex.phsaCategory2Name = row.Category2Name.trim();
  }
  if (!blank(row.Category3Name)) {
    flex.phsaCategory3 = normalizeCategory(row.Category3Name);
    flex.phsaCategory3Name = row.Category3Name.trim();
  }

  payload.ContractHeaderFlexfieldVA = [flex];
  return payload;
}

function saveCsv(filePath, headers, rows) {
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map(h => csvEscape(row[h] ?? "")).join(","));
  }
  writeFileSync(filePath, lines.join("\n") + "\n");
}

async function main() {
  mkdirSync(LOG_DIR, { recursive: true });
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const settings = TOML.parse(readFileSync(SETTINGS_PATH, "utf-8"));
  const { baseUrl, username, password } = settings.server;
  const serverOrigin = /^https?:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`;

  const stamp = timestamp();
  const log = createLogger(LOG_DIR, { prefix: `insert-contract-${stamp}` });
  const client = await createClient(log, { username, password }, { baseUrl: serverOrigin });

  log.info("Script: 7-InsertContract");
  log.info(`Server: ${serverOrigin}`);
  log.info(`Input: ${INPUT_CSV}`);
  log.info("");

  // Build distributor lookup: VendorMasterId → SupplierId
  // Reference CSV gives VendorMasterId → SupplierPartyId; suppliers API gives SupplierPartyId → SupplierId
  const refFile = findNewestReferenceFile(REF_DIR);
  const vmIdToPartyId = new Map();
  if (refFile) {
    const refRows = parse(readFileSync(refFile, "utf-8"), { columns: true, skip_empty_lines: true, bom: true });
    for (const r of refRows) {
      if (r.VendorMasterId && r.SupplierPartyId) {
        vmIdToPartyId.set(String(r.VendorMasterId).trim(), String(r.SupplierPartyId).trim());
      }
    }
    log.info(`Reference CSV: ${vmIdToPartyId.size} VendorMasterId→SupplierPartyId entries from ${refFile}`);
  } else {
    log.info("WARNING: No reference CSV in 6-FillPrimaryPartyId/output/ — distributors will not be resolved");
  }

  // Fetch suppliers to build SupplierPartyId → SupplierId map
  log.info("Fetching suppliers for SupplierPartyId→SupplierId map...");
  const partyIdToSupplierId = new Map();
  {
    let offset = 0, total = null;
    while (true) {
      const res = await client.get(
        `${SUPPLIERS_ENDPOINT}?fields=SupplierId,SupplierPartyId&onlyData=true&totalResults=true&limit=500&offset=${offset}`
      );
      if (!res.ok) { log.error(`Supplier fetch failed: HTTP ${res.status}`); break; }
      const items = res.data.items || [];
      if (total === null) { total = res.data.totalResults || 0; }
      for (const s of items) partyIdToSupplierId.set(String(s.SupplierPartyId), String(s.SupplierId));
      offset += items.length;
      if (items.length < 500 || offset >= total) break;
    }
    log.info(`  SupplierPartyId→SupplierId: ${partyIdToSupplierId.size} entries`);
  }

  // Compose: VendorMasterId → SupplierId
  const distributorLookup = new Map();
  for (const [vmId, partyId] of vmIdToPartyId) {
    const supplierId = partyIdToSupplierId.get(partyId);
    if (supplierId) distributorLookup.set(vmId, supplierId);
  }
  log.info(`Distributor lookup: ${distributorLookup.size} VendorMasterId→SupplierId entries`);

  // Parse input CSV
  const raw = readFileSync(INPUT_CSV, "utf-8");
  const rows = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    relax_column_count: true,
    trim: true,
  });

  const headers = Object.keys(rows[0]);
  // OracleContractId is already col 1 in the schema; init blanks for any row missing it
  for (const row of rows) {
    if (row.OracleContractId === undefined) row.OracleContractId = "";
  }

  const toInsert = rows.filter(r => blank(r.OracleContractId));
  const alreadyDone = rows.length - toInsert.length;

  log.info(`Rows: ${rows.length} total, ${alreadyDone} skipped (already have OracleContractId), ${toInsert.length} to insert`);
  log.info("");

  if (toInsert.length === 0) {
    log.info("Nothing to insert.");
    log.summary();
    return;
  }

  let inserted = 0, failed = 0;
  const failedRows = [];

  for (let i = 0; i < toInsert.length; i++) {
    const row = toInsert[i];
    const contractNumber = (row.ContractNumber || "").trim();
    log.info(`[${i + 1}/${toInsert.length}] ${contractNumber}`);

    if (blank(row.PrimaryPartyId)) {
      const msg = "SKIP: PrimaryPartyId blank";
      log.info(`  ${msg}`);
      failedRows.push({ contractNumber, primaryPartyId: "", contractTypeId: row.ContractTypeId || "", error: msg });
      failed++;
      continue;
    }
    if (blank(row.ContractTypeId)) {
      const msg = "SKIP: ContractTypeId blank";
      log.info(`  ${msg}`);
      failedRows.push({ contractNumber, primaryPartyId: row.PrimaryPartyId, contractTypeId: "", error: msg });
      failed++;
      continue;
    }

    const payload = buildPayload(row, distributorLookup);
    const res = await client.post(CONTRACTS_ENDPOINT, payload);

    if (!res.ok) {
      const errMsg = extractError(res.data);
      log.error(`  POST ${res.status} — ${errMsg}`);
      log.error(`  Payload: ${JSON.stringify(payload)}`);
      failedRows.push({ contractNumber, primaryPartyId: row.PrimaryPartyId, contractTypeId: row.ContractTypeId, error: `HTTP ${res.status}: ${errMsg}` });
      failed++;
      continue;
    }

    const contractId = res.data.ContractId;
    if (!contractId) {
      const msg = "FAIL: No ContractId in response";
      log.error(`  ${msg}: ${JSON.stringify(res.data).slice(0, 200)}`);
      failedRows.push({ contractNumber, primaryPartyId: row.PrimaryPartyId, contractTypeId: row.ContractTypeId, error: msg });
      failed++;
      continue;
    }

    row.OracleContractId = String(contractId);
    log.info(`  Created: ContractId=${contractId}`);
    inserted++;

    if ((i + 1) % 10 === 0 || i === toInsert.length - 1) {
      saveCsv(INPUT_CSV, headers, rows);
    }
  }

  saveCsv(INPUT_CSV, headers, rows);
  log.info(`\nFilled CSV written: ${INPUT_CSV}`);

  const failedFile = resolve(OUTPUT_DIR, `insert-contract-${stamp}-failed.csv`);
  writeFileSync(failedFile, [
    ["ContractNumber", "PrimaryPartyId", "ContractTypeId", "Error"].join(","),
    ...failedRows.map(r => [r.contractNumber, r.primaryPartyId, r.contractTypeId, r.error].map(csvEscape).join(",")),
  ].join("\n") + "\n");

  log.info("=".repeat(50));
  log.info(`Inserted: ${inserted}`);
  log.info(`Failed:   ${failed}`);
  log.info(`Failed report: ${failedFile}`);
  log.info("=".repeat(50));
  log.summary();

  console.log(`\nInserted: ${inserted}  Failed: ${failed}`);
  if (failed > 0) console.log(`Failed report: ${failedFile}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
