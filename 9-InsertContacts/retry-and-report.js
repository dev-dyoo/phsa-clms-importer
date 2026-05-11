#!/usr/bin/env node
// One-off: retry 5 lock-collision vendor contacts (5s delay between each),
// then emit a combined failure report enriched with Oracle contract data.

import { mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from "fs";
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
const VCONTACTS_ENDPOINT = "/fscmRestApi/resources/11.13.18.05/contractVContacts";
const SUPPLIERS_ENDPOINT = "/fscmRestApi/resources/11.13.18.05/suppliers";
const SOAP_PATH = "/xmlpserver/services/ExternalReportWSSService";

// Vendor FAIL reasons that are NOT worth retrying (won't succeed until external state changes)
const NON_RETRIABLE_PATTERNS = [
  /This supplier profile is locked for editing as a profile change request is pending approval/i,
];
function isRetriable(vendorResult) {
  if (!vendorResult || !vendorResult.startsWith("FAIL")) return false;
  return !NON_RETRIABLE_PATTERNS.some(p => p.test(vendorResult));
}

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
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── SOAP crosswalk ───────────────────────────────────────────

function buildSoapEnvelope() {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
  <soap12:Body>
    <runReport xmlns="http://xmlns.oracle.com/oxp/service/PublicReportService">
      <reportRequest>
        <attributeFormat>csv</attributeFormat>
        <attributeLocale></attributeLocale>
        <attributeTemplate></attributeTemplate>
        <reportAbsolutePath>/Custom/PHSA/Suppliers/Interfaces/PARTY_CONTACT_ID_CROSSWALK.xdo</reportAbsolutePath>
        <sizeOfDataChunkDownload>-1</sizeOfDataChunkDownload>
      </reportRequest>
      <appParams></appParams>
    </runReport>
  </soap12:Body>
</soap12:Envelope>`;
}

async function fetchCrosswalk(serverOrigin, auth, log) {
  log.info("Fetching contact crosswalk via SOAP...");
  const res = await fetch(`${serverOrigin}${SOAP_PATH}`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/soap+xml; charset=utf-8" },
    body: buildSoapEnvelope(),
  });
  const text = await res.text();
  if (!res.ok) { log.error(`SOAP failed: HTTP ${res.status}`); return new Map(); }
  const match = text.match(/<ns2:reportBytes>([\s\S]*?)<\/ns2:reportBytes>/);
  if (!match) { log.error("No reportBytes"); return new Map(); }
  const csv = Buffer.from(match[1], "base64").toString("utf-8");
  const rows = parse(csv, { columns: true, skip_empty_lines: true, bom: true });
  const map = new Map();
  for (const r of rows) {
    const email = (r.EMAIL_ADDRESS || "").trim().toLowerCase();
    if (email) map.set(email, r.SUPPLIER_PARTY_ID);
  }
  log.info(`  ${map.size} email→ContactId entries`);
  return map;
}

// ── Contract party state ─────────────────────────────────────

async function getContractState(client, contractId) {
  const res = await client.get(`${CONTRACTS_ENDPOINT}/${contractId}/child/ContractParty?expand=all`);
  if (!res.ok) return null;
  let customerHref = null, supplierHref = null;
  let hasAdmin = false, hasBuyer = false, hasVendor = false;
  const conversionHrefs = [];
  for (const party of (res.data.items || [])) {
    const selfLink = (party.links || []).find(l => l.rel === "self");
    const href = selfLink?.href;
    if (party.PartyRoleCode === "CUSTOMER") {
      customerHref = href;
      for (const c of (party.ContractPartyContact || [])) {
        if (c.ContactRoleCode === "CONTRACT_ADMIN") hasAdmin = true;
        if (c.ContactRoleCode === "BUYER") hasBuyer = true;
        if ((c.PartyContactName || "").trim().toUpperCase() === "CONVERSION") {
          const cLink = (c.links || []).find(l => l.rel === "self");
          if (cLink?.href) conversionHrefs.push(cLink.href);
        }
      }
    } else if (party.PartyRoleCode === "SUPPLIER") {
      supplierHref = href;
      for (const c of (party.ContractPartyContact || [])) {
        if (c.ContactRoleCode === "VENDOR_CONTACT") hasVendor = true;
      }
    }
  }
  return { customerHref, supplierHref, hasAdmin, hasBuyer, hasVendor, conversionHrefs };
}

async function postContact(client, partyHref, payload) {
  const path = partyHref.replace(/^https?:\/\/[^/]+/, "") + "/child/ContractPartyContact";
  const res = await client.post(path, payload);
  if (res.ok) return "OK";
  return `FAIL:HTTP ${res.status}: ${extractError(res.data)}`;
}

// ── Vendor contact resolution ────────────────────────────────

const vContactsCache = new Map();

async function getVendorContacts(client, primaryPartyId) {
  if (vContactsCache.has(primaryPartyId)) return vContactsCache.get(primaryPartyId);
  const res = await client.get(
    `${VCONTACTS_ENDPOINT}?onlyData=true&fields=ContactId,PartyId,ContactName,EmailAddress&q=PartyId=${primaryPartyId}`
  );
  const items = res.ok ? (res.data.items || []) : [];
  vContactsCache.set(primaryPartyId, items);
  return items;
}

function matchVendorContact(items, email, firstName, lastName) {
  if (!blank(email)) {
    const lo = email.trim().toLowerCase();
    const m = items.find(i => (i.EmailAddress || "").trim().toLowerCase() === lo);
    if (m) return m.ContactId;
  }
  if (!blank(firstName) || !blank(lastName)) {
    const fullName = `${blank(firstName) ? "" : firstName.trim()} ${blank(lastName) ? "" : lastName.trim()}`.trim().toLowerCase();
    if (fullName) {
      const m = items.find(i => (i.ContactName || "").trim().toLowerCase() === fullName);
      if (m) return m.ContactId;
    }
  }
  return null;
}

const supplierIdCache = new Map();

async function getSupplierId(client, log, primaryPartyId) {
  if (supplierIdCache.has(primaryPartyId)) return supplierIdCache.get(primaryPartyId);
  const res = await client.get(
    `${SUPPLIERS_ENDPOINT}?q=SupplierPartyId=${primaryPartyId}&fields=SupplierId,SupplierPartyId&onlyData=true`
  );
  if (!res.ok || !res.data.items?.length) return null;
  const id = res.data.items[0].SupplierId;
  supplierIdCache.set(primaryPartyId, id);
  return id;
}

async function resolveVendorContactId(client, log, primaryPartyId, email, firstName, lastName, phone, { propagationDelay = 0 } = {}) {
  let items = await getVendorContacts(client, primaryPartyId);
  let contactId = matchVendorContact(items, email, firstName, lastName);
  if (contactId) return { contactId, error: null };

  const supplierId = await getSupplierId(client, log, primaryPartyId);
  if (!supplierId) return { contactId: null, error: "Could not resolve SupplierId" };

  const payload = {
    FirstName: blank(firstName) ? "" : firstName.trim(),
    LastName: blank(lastName) ? "" : lastName.trim(),
    AdministrativeContactFlag: true,
  };
  if (!blank(phone)) payload.PhoneNumber = phone.trim();
  if (!blank(email)) payload.Email = email.trim();

  const res = await client.post(`${SUPPLIERS_ENDPOINT}/${supplierId}/child/contacts`, payload);
  if (!res.ok) return { contactId: null, error: `HTTP ${res.status}: ${extractError(res.data)}` };

  log.info(`  Created supplier contact ${firstName} ${lastName} on SupplierId=${supplierId}`);
  if (propagationDelay > 0) {
    log.info(`  Waiting ${propagationDelay}ms for Oracle to propagate...`);
    await sleep(propagationDelay);
  }
  vContactsCache.delete(primaryPartyId);
  items = await getVendorContacts(client, primaryPartyId);
  contactId = matchVendorContact(items, email, firstName, lastName);
  return contactId
    ? { contactId, error: null }
    : { contactId: null, error: "Created but could not resolve ContactId from contractVContacts" };
}

async function retryVendorContact(client, log, row, contractIdMap, crosswalk) {
  const contractNumber = (row.ContractNumber || "").trim();
  const contractId = contractIdMap.get(contractNumber);
  if (!contractId) return "NO_CONTRACT";

  const state = await getContractState(client, contractId);
  if (!state) return "FAIL:PARTY_FETCH";
  if (state.hasVendor) return "ALREADY_EXISTS";

  const vendorEmail = blank(row.VendorContactEmail) ? null : row.VendorContactEmail.trim();
  const vendorFirst = blank(row.VendorContactFirstName) ? null : row.VendorContactFirstName.trim();
  const vendorLast = blank(row.VendorContactLastName) ? null : row.VendorContactLastName.trim();
  const vendorPhone = blank(row.VendorContactPhone) ? null : row.VendorContactPhone.trim();
  if ((!vendorEmail && !(vendorFirst && vendorLast)) || !state.supplierHref) return "SKIP";

  const primaryPartyId = String(row.PrimaryPartyId || "").trim();
  // Always wait for propagation on retries — these rows previously failed the lookup
  const { contactId, error } = await resolveVendorContactId(client, log, primaryPartyId, vendorEmail, vendorFirst, vendorLast, vendorPhone, { propagationDelay: 15000 });
  if (!contactId) return `FAIL:${error}`;

  const r = await postContact(client, state.supplierHref, { ContactRoleCode: "VENDOR_CONTACT", ContactId: contactId });
  return r === "OK" ? "CREATED" : r;
}

function findNewest(dir, pattern) {
  const files = readdirSync(dir).filter(f => pattern.test(f)).sort().reverse();
  return files.length ? resolve(dir, files[0]) : null;
}

// Classify a report row into a manual-handling category + recommended action.
function classifyIssue(r) {
  const bothNxw = r.ADMIN_RESULT === "NOT_IN_CROSSWALK" && r.BUYER_RESULT === "NOT_IN_CROSSWALK";
  const v = r.VENDOR_RESULT || "";

  if (v.startsWith("FAIL")) {
    if (/Failed to lock the record in table POZ_SUPPLIERS/i.test(v)) {
      return { issue: "VENDOR_CONTACT_NOT_CREATED", action: "Retry: supplier contacts table was locked; contact was never created. Re-run vendor contact insert." };
    }
    if (/Created but could not resolve ContactId/i.test(v)) {
      return { issue: "VENDOR_CONTACT_ORPHANED", action: "Link only: a supplier contact was created in Oracle but not linked to the contract. Find it on the supplier record and link as VENDOR_CONTACT. Do NOT create a new one." };
    }
    if (/supplier profile is locked for editing as a profile change request is pending approval/i.test(v)) {
      return { issue: "SUPPLIER_PROFILE_LOCKED", action: "Blocked: supplier has a pending profile change request. Wait for approval, then re-run vendor contact insert." };
    }
    return { issue: "VENDOR_CONTACT_FAILED", action: `Investigate: ${v}` };
  }

  if (bothNxw) {
    return { issue: "NO_PHSA_CONTACTS", action: "Manual: lead manager and buyer emails are not in Oracle's contact directory. Add them to the directory (crosswalk) or assign contacts manually." };
  }
  if (r.ADMIN_RESULT === "NOT_IN_CROSSWALK") {
    return { issue: "NO_LEAD_MANAGER", action: "Manual: lead manager email not in Oracle's contact directory. Add to directory or assign manually." };
  }
  if (r.BUYER_RESULT === "NOT_IN_CROSSWALK") {
    return { issue: "NO_BUYER", action: "Manual: buyer email not in Oracle's contact directory. Add to directory or assign manually." };
  }
  return { issue: "RESOLVED", action: "No action — was a prior failure, now resolved." };
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  mkdirSync(LOG_DIR, { recursive: true });
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const settings = TOML.parse(readFileSync(SETTINGS_PATH, "utf-8"));
  const { baseUrl, username, password } = settings.server;
  const serverOrigin = /^https?:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`;
  const auth = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");

  const stamp = timestamp();
  const log = createLogger(LOG_DIR, { prefix: `retry-and-report-${stamp}` });
  const client = await createClient(log, { username, password }, { baseUrl: serverOrigin });

  log.info("Script: retry-and-report");
  log.info(`Server: ${serverOrigin}`);

  // ── Read LAST_BATCH_LOAD.csv ─────────────────────────────────
  const rows = parse(readFileSync(INPUT_CSV, "utf-8"), {
    columns: true, skip_empty_lines: true, bom: true, relax_column_count: true, trim: true,
  });
  const headers = Object.keys(rows[0]);
  const leadEmailCol = headers.find(h => h.startsWith("LeadManagerEmailAddress")) || "LeadManagerEmailAddress";
  const buyerEmailCol = headers.find(h => h.startsWith("BuyerEmailAddress")) || "BuyerEmailAddress";
  const rowByContract = new Map();
  for (const r of rows) {
    const cn = (r.ContractNumber || "").trim();
    if (cn) rowByContract.set(cn, { ...r, LeadManagerEmailAddress: r[leadEmailCol] || "", BuyerEmailAddress: r[buyerEmailCol] || "" });
  }
  log.info(`CSV rows: ${rows.length}`);

  // ── SOAP crosswalk ───────────────────────────────────────────
  const crosswalk = await fetchCrosswalk(serverOrigin, auth, log);

  // ── Fetch Oracle contracts: ContractNumber → {ContractId, Id} ──
  log.info("Fetching contracts from Oracle...");
  const contractIdMap = new Map();   // ContractNumber → ContractId (for contact insertion)
  const contractInfoMap = new Map(); // ContractNumber → {oracleId (ContractId), internalId (Id)}
  let offset = 0, total = null;
  while (true) {
    const res = await client.get(
      `${CONTRACTS_ENDPOINT}?fields=Id,ContractId,ContractNumber&onlyData=true&totalResults=true&limit=500&offset=${offset}`
    );
    if (!res.ok) { log.error(`Contract fetch failed: HTTP ${res.status}`); break; }
    const items = res.data.items || [];
    if (total === null) { total = res.data.totalResults || 0; log.info(`  Total: ${total}`); }
    for (const c of items) {
      const cn = (c.ContractNumber || "").trim();
      if (cn) {
        contractIdMap.set(cn, String(c.ContractId));
        contractInfoMap.set(cn, { oracleId: String(c.ContractId), internalId: String(c.Id) });
      }
    }
    offset += items.length;
    if (items.length < 500 || offset >= total) break;
  }
  log.info(`  Contract map: ${contractInfoMap.size} entries`);

  // ── Load last insert-contacts output CSV ────────────────────
  const lastOutput = findNewest(OUTPUT_DIR, /^insert-contacts-\d{8}-\d{6}\.csv$/);
  if (!lastOutput) { log.error("No insert-contacts output CSV found in output/"); process.exit(1); }
  log.info(`Last output: ${lastOutput}`);
  const lastResults = parse(readFileSync(lastOutput, "utf-8"), {
    columns: true, skip_empty_lines: true, bom: true,
  });
  const lastResultMap = new Map();
  for (const r of lastResults) lastResultMap.set(r.ContractNumber, r);

  // Merge in vendor results from the newest prior report (preserves resolved vendor contacts)
  const prevReport = findNewest(OUTPUT_DIR, /^(failure-report-\d{8}-\d{6}|MANUAL-HANDLING-REPORT)\.csv$/);
  if (prevReport) {
    log.info(`Merging retry results from: ${prevReport}`);
    const prevRows = parse(readFileSync(prevReport, "utf-8"), {
      columns: true, skip_empty_lines: true, bom: true,
    });
    for (const r of prevRows) {
      const existing = lastResultMap.get(r.ContractNumber);
      if (existing && r.VENDOR_RESULT && !r.VENDOR_RESULT.startsWith("FAIL")) {
        existing.VENDOR_RESULT = r.VENDOR_RESULT;
      }
    }
  }

  // Identify rows with any notable issue:
  //   - BOTH admin AND buyer NOT_IN_CROSSWALK (zero PHSA contacts on the contract)
  //   - any FAIL on vendor (contact could not be created)
  const failureRows = lastResults.filter(r =>
    (r.ADMIN_RESULT === "NOT_IN_CROSSWALK" && r.BUYER_RESULT === "NOT_IN_CROSSWALK") ||
    r.VENDOR_RESULT.startsWith("FAIL")
  );
  log.info(`Failure rows from last run: ${failureRows.length}`);

  // ── Verify current Oracle state for vendor-FAIL rows (no creation) ──
  // contractVContacts has a propagation delay > 15s after a supplier contact is created,
  // so we do NOT auto-create here — only re-check whether the contract now has a vendor contact.
  const verifyContracts = failureRows
    .filter(r => r.VENDOR_RESULT.startsWith("FAIL"))
    .map(r => r.ContractNumber);
  log.info(`\nVerifying current vendor state for ${verifyContracts.length} vendor-FAIL contracts (read-only)...`);
  const retryResults = new Map();
  for (const cn of verifyContracts) {
    const contractId = contractIdMap.get(cn);
    if (!contractId) { retryResults.set(cn, "NO_CONTRACT"); continue; }
    const state = await getContractState(client, contractId);
    if (state && state.hasVendor) {
      log.info(`  ${cn}: now has vendor contact → ALREADY_EXISTS`);
      retryResults.set(cn, "ALREADY_EXISTS");
    }
    // else: leave it as-is (still failing) — don't overwrite
  }

  // ── Build combined report ────────────────────────────────────
  const supplierName = csvRow => {
    const m = (csvRow.VendorMasterDescrip_REFERENCE || csvRow["master vendor descrip"] || "").trim();
    if (m) return m;
    const first = (csvRow.VendorContactFirstName || "").trim();
    const last = (csvRow.VendorContactLastName || "").trim();
    return [first, last].filter(Boolean).join(" ");
  };
  const vendorContactName = csvRow =>
    [(csvRow.VendorContactFirstName || "").trim(), (csvRow.VendorContactLastName || "").trim()].filter(Boolean).join(" ");

  const failureContractNumbers = new Set(failureRows.map(r => r.ContractNumber));
  const reportRows = [];

  for (const r of failureRows) {
    const cn = r.ContractNumber;
    const csvRow = rowByContract.get(cn) || {};
    const info = contractInfoMap.get(cn) || {};
    reportRows.push({
      ContractNumber: cn,
      ContractId: info.oracleId || csvRow.OracleContractId || "",
      OracleInternalId: info.internalId || "",
      PrimaryPartyId: (csvRow.PrimaryPartyId || "").trim(),
      SupplierName: supplierName(csvRow),
      VendorContactName: vendorContactName(csvRow),
      VendorContactEmail: (csvRow.VendorContactEmail || "").trim(),
      ADMIN_RESULT: r.ADMIN_RESULT,
      BUYER_RESULT: r.BUYER_RESULT,
      VENDOR_RESULT: retryResults.has(cn) ? retryResults.get(cn) : r.VENDOR_RESULT,
      DELETE_CONVERSION: r.DELETE_CONVERSION,
    });
  }

  // Include any retried contracts that weren't already failure rows
  for (const [cn, result] of retryResults) {
    if (!failureContractNumbers.has(cn)) {
      const csvRow = rowByContract.get(cn) || {};
      const info = contractInfoMap.get(cn) || {};
      const last = lastResultMap.get(cn) || {};
      reportRows.push({
        ContractNumber: cn,
        ContractId: info.oracleId || csvRow.OracleContractId || "",
        OracleInternalId: info.internalId || "",
        PrimaryPartyId: (csvRow.PrimaryPartyId || "").trim(),
        SupplierName: supplierName(csvRow),
        VendorContactName: vendorContactName(csvRow),
        VendorContactEmail: (csvRow.VendorContactEmail || "").trim(),
        ADMIN_RESULT: last.ADMIN_RESULT || "",
        BUYER_RESULT: last.BUYER_RESULT || "",
        VENDOR_RESULT: result,
        DELETE_CONVERSION: last.DELETE_CONVERSION || "",
      });
    }
  }

  // Classify each row; drop rows that need no action (prior failures now resolved)
  for (const r of reportRows) {
    const { issue, action } = classifyIssue(r);
    r.ISSUE = issue;
    r.ACTION_NEEDED = action;
  }
  const resolvedCount = reportRows.filter(r => r.ISSUE === "RESOLVED").length;
  const finalRows = reportRows.filter(r => r.ISSUE !== "RESOLVED");

  const ISSUE_ORDER = ["VENDOR_CONTACT_NOT_CREATED", "VENDOR_CONTACT_ORPHANED", "SUPPLIER_PROFILE_LOCKED", "VENDOR_CONTACT_FAILED", "NO_PHSA_CONTACTS", "NO_LEAD_MANAGER", "NO_BUYER"];
  finalRows.sort((a, b) => {
    const ia = ISSUE_ORDER.indexOf(a.ISSUE), ib = ISSUE_ORDER.indexOf(b.ISSUE);
    if (ia !== ib) return ia - ib;
    return a.ContractNumber.localeCompare(b.ContractNumber);
  });

  const REPORT_HEADERS = ["ContractNumber", "ContractId", "OracleInternalId", "PrimaryPartyId", "SupplierName", "VendorContactName", "VendorContactEmail", "ISSUE", "ACTION_NEEDED", "ADMIN_RESULT", "BUYER_RESULT", "VENDOR_RESULT", "DELETE_CONVERSION"];

  // Replace any prior failure-report files with this single final report
  for (const f of readdirSync(OUTPUT_DIR)) {
    if (/^failure-report-\d{8}-\d{6}\.csv$/.test(f) || f === "MANUAL-HANDLING-REPORT.csv") {
      try { rmSync(resolve(OUTPUT_DIR, f)); } catch {}
    }
  }
  const reportFile = resolve(OUTPUT_DIR, "MANUAL-HANDLING-REPORT.csv");
  writeFileSync(reportFile, [
    REPORT_HEADERS.join(","),
    ...finalRows.map(r => REPORT_HEADERS.map(h => csvEscape(r[h] ?? "")).join(",")),
  ].join("\n") + "\n");

  // Summary by issue
  const byIssue = {};
  for (const r of finalRows) byIssue[r.ISSUE] = (byIssue[r.ISSUE] || 0) + 1;

  log.info("\n" + "=".repeat(50));
  log.info(`Report rows (need action): ${finalRows.length}  (excluded ${resolvedCount} now-resolved)`);
  for (const k of ISSUE_ORDER) if (byIssue[k]) log.info(`  ${k}: ${byIssue[k]}`);
  log.info(`Report: ${reportFile}`);
  log.info("=".repeat(50));
  log.summary();

  console.log(`\nReport rows (need action): ${finalRows.length}  (excluded ${resolvedCount} now-resolved)`);
  for (const k of ISSUE_ORDER) if (byIssue[k]) console.log(`  ${k}: ${byIssue[k]}`);
  console.log(`Report: ${reportFile}`);
}

main().catch(err => { console.error(err); process.exit(1); });
