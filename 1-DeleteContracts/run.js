#!/usr/bin/env node
// ============================================================
// 1-DeleteContracts
// Description: Lookup contracts by ContractNumber, delete each.
// Input:       input/LAST_BATCH_PURGE.csv
//              Columns: Source, ContractNumber
// Output:      1-DeleteContracts/output/<timestamp>.csv
//              Columns: Source, ContractNumber, ContractId, RESULT, ERROR, DUPLICATE
// Steps per contract:
//   1. GET /contracts?q=ContractNumber=<n> → resolve ContractId(s)
//   2. DELETE /contracts/<ContractId>
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
const INPUT_CSV = resolve(PHSA_SCRIPTS_DIR, "input", "LAST_BATCH_PURGE.csv");

const CONTRACTS_ENDPOINT = "/fscmRestApi/resources/11.13.18.05/contracts";
const CONCURRENCY = 5;

const pad = (n) => String(n).padStart(2, "0");
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

function extractError(data) {
  if (typeof data === "string") return data.slice(0, 300);
  if (data?.detail) return data.detail;
  if (data?.message) return data.message;
  if (data?.title) return data.title;
  return JSON.stringify(data).slice(0, 300);
}

async function resolveContractIds(client, contractNumber) {
  const q = encodeURIComponent(`ContractNumber=${contractNumber}`);
  const url = `${CONTRACTS_ENDPOINT}?q=${q}&fields=ContractId&onlyData=true&totalResults=true`;
  const res = await client.get(url);
  if (!res.ok) {
    return { ids: [], error: `Lookup HTTP ${res.status}: ${extractError(res.data)}` };
  }
  const ids = (res.data.items || []).map((r) => String(r.ContractId));
  return { ids, error: null };
}

async function processRow(client, log, source, contractNumber) {
  const { ids, error: lookupError } = await resolveContractIds(client, contractNumber);

  if (lookupError) {
    return [{ source, contractNumber, contractId: "", result: "NOT-DELETED", error: lookupError, duplicate: "" }];
  }

  if (ids.length === 0) {
    return [{ source, contractNumber, contractId: "", result: "NOT-DELETED", error: "Contract not found", duplicate: "" }];
  }

  const isDuplicate = ids.length > 1;
  const outputRows = [];

  for (const contractId of ids) {
    const del = await client.delete(`${CONTRACTS_ENDPOINT}/${encodeURIComponent(contractId)}`);
    if (del.ok) {
      log.info(`  DELETED ContractId=${contractId} (${contractNumber})`);
      outputRows.push({ source, contractNumber, contractId, result: "DELETED", error: "", duplicate: isDuplicate ? "true" : "" });
    } else {
      const msg = `HTTP ${del.status}: ${extractError(del.data)}`;
      log.error(`  FAILED ContractId=${contractId} (${contractNumber}): ${msg}`);
      outputRows.push({ source, contractNumber, contractId, result: "NOT-DELETED", error: msg, duplicate: isDuplicate ? "true" : "" });
    }
  }

  return outputRows;
}

async function main() {
  mkdirSync(LOG_DIR, { recursive: true });
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const settings = TOML.parse(readFileSync(SETTINGS_PATH, "utf-8"));
  const { baseUrl, username, password } = settings.server;
  const serverOrigin = /^https?:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`;

  const stamp = timestamp();
  const log = createLogger(LOG_DIR, { prefix: `delete-contracts-${stamp}` });
  const client = await createClient(log, { username, password }, { baseUrl: serverOrigin });

  log.info("Script: 1-DeleteContracts");
  log.info(`Server: ${serverOrigin}`);
  log.info(`Input: ${INPUT_CSV}`);

  const sanity = await client.get(`${CONTRACTS_ENDPOINT}?limit=1&onlyData=true`);
  if (!sanity.ok) {
    log.error(`Sanity check failed HTTP ${sanity.status}`);
    process.exit(1);
  }
  log.info("Sanity check passed");

  const raw = parse(readFileSync(INPUT_CSV, "utf-8"), {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    trim: true,
  });

  log.info(`Rows in CSV: ${raw.length}`);
  log.info("");

  const allOutput = [];
  let deleted = 0, notDeleted = 0;

  for (let i = 0; i < raw.length; i += CONCURRENCY) {
    const batch = raw.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map((row, batchIdx) => {
        const source = (row.Source || "").trim();
        const contractNumber = (row.ContractNumber || "").trim();
        const rowNum = i + batchIdx + 1;
        if (!contractNumber) {
          return Promise.resolve([{ source, contractNumber: "", contractId: "", result: "NOT-DELETED", error: "Empty ContractNumber", duplicate: "" }]);
        }
        log.info(`[${rowNum}] ${contractNumber}`);
        return processRow(client, log, source, contractNumber);
      })
    );

    for (const rows of batchResults) {
      for (const r of rows) {
        allOutput.push(r);
        if (r.result === "DELETED") deleted++;
        else notDeleted++;
      }
    }
  }

  const outFile = resolve(OUTPUT_DIR, `delete-contracts-${stamp}.csv`);
  const headers = ["Source", "ContractNumber", "ContractId", "RESULT", "ERROR", "DUPLICATE"];
  const lines = [
    headers.join(","),
    ...allOutput.map((r) =>
      [
        csvEscape(r.source),
        csvEscape(r.contractNumber),
        csvEscape(r.contractId),
        csvEscape(r.result),
        csvEscape(r.error),
        csvEscape(r.duplicate),
      ].join(",")
    ),
  ];
  writeFileSync(outFile, lines.join("\n") + "\n");

  log.info("");
  log.info("=".repeat(50));
  log.info(`Deleted:     ${deleted}`);
  log.info(`Not deleted: ${notDeleted}`);
  log.info(`Output:      ${outFile}`);
  log.info("=".repeat(50));
  log.summary();

  console.log(`\nOutput: ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
