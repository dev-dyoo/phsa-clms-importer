#!/usr/bin/env node
// ============================================================
// 9-InsertContacts
// Description: POST CONTRACT_ADMIN, BUYER, and VENDOR_CONTACT
//              for each row in LAST_BATCH_LOAD.csv that has
//              OracleContractId. Deletes CONVERSION contacts
//              from the CUSTOMER party after inserting.
//              Runs with CONCURRENCY=10.
//
// Prerequisites: 7-InsertContract must have run.
//
// Phases:
//   1. Fetch SOAP contact crosswalk (email → ContactId)
//   2. Fetch all contracts from Oracle (ContractNumber → ContractId)
//   3. For each row: POST CONTRACT_ADMIN, BUYER, VENDOR_CONTACT,
//      then DELETE CONVERSION contacts
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
const VCONTACTS_ENDPOINT = "/fscmRestApi/resources/11.13.18.05/contractVContacts";
const SUPPLIERS_ENDPOINT = "/fscmRestApi/resources/11.13.18.05/suppliers";
const SOAP_PATH = "/xmlpserver/services/ExternalReportWSSService";
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

// ── Phase 1: SOAP crosswalk ──────────────────────────────────

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

async function fetchContactsCrosswalk(serverOrigin, auth, log) {
  log.info("Fetching contact crosswalk via SOAP...");
  const res = await fetch(`${serverOrigin}${SOAP_PATH}`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/soap+xml; charset=utf-8" },
    body: buildSoapEnvelope(),
  });
  const text = await res.text();
  if (!res.ok) { log.error(`SOAP failed: HTTP ${res.status}`); return new Map(); }
  const match = text.match(/<ns2:reportBytes>([\s\S]*?)<\/ns2:reportBytes>/);
  if (!match) { log.error("No reportBytes in SOAP response"); return new Map(); }
  const csv = Buffer.from(match[1], "base64").toString("utf-8");
  const rows = parse(csv, { columns: true, skip_empty_lines: true, bom: true });
  const lookup = new Map();
  for (const r of rows) {
    const email = (r.EMAIL_ADDRESS || "").trim().toLowerCase();
    if (email) lookup.set(email, r.SUPPLIER_PARTY_ID);
  }
  log.info(`  ${lookup.size} email→ContactId entries`);
  return lookup;
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

// ── Contact POST/DELETE ──────────────────────────────────────

async function postContact(client, partyHref, payload) {
  const path = partyHref.replace(/^https?:\/\/[^/]+/, "") + "/child/ContractPartyContact";
  const res = await client.post(path, payload);
  if (res.ok) return "OK";
  return `FAIL: HTTP ${res.status} — ${extractError(res.data)}`;
}

async function deleteContact(client, href) {
  const path = href.replace(/^https?:\/\/[^/]+/, "");
  return client.delete(path);
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
  if (!res.ok || !res.data.items?.length) {
    log.error(`  Supplier not found for SupplierPartyId=${primaryPartyId}`);
    return null;
  }
  const id = res.data.items[0].SupplierId;
  supplierIdCache.set(primaryPartyId, id);
  return id;
}

async function resolveVendorContactId(client, log, primaryPartyId, email, firstName, lastName, phone) {
  let items = await getVendorContacts(client, primaryPartyId);
  let contactId = matchVendorContact(items, email, firstName, lastName);
  if (contactId) return { contactId, created: false, error: null };

  const supplierId = await getSupplierId(client, log, primaryPartyId);
  if (!supplierId) return { contactId: null, created: false, error: "Could not resolve SupplierId" };

  const payload = {
    FirstName: blank(firstName) ? "" : firstName.trim(),
    LastName: blank(lastName) ? "" : lastName.trim(),
    AdministrativeContactFlag: true,
  };
  if (!blank(phone)) payload.PhoneNumber = phone.trim();
  if (!blank(email)) payload.Email = email.trim();

  const res = await client.post(`${SUPPLIERS_ENDPOINT}/${supplierId}/child/contacts`, payload);
  if (!res.ok) {
    return { contactId: null, created: false, error: `HTTP ${res.status}: ${extractError(res.data)}` };
  }

  log.info(`  Created supplier contact ${firstName} ${lastName} <${email}> on SupplierId=${supplierId}`);
  vContactsCache.delete(primaryPartyId);
  items = await getVendorContacts(client, primaryPartyId);
  contactId = matchVendorContact(items, email, firstName, lastName);
  if (contactId) return { contactId, created: true, error: null };
  return { contactId: null, created: true, error: "Created but could not resolve ContactId from contractVContacts" };
}

// ── Per-row processor ────────────────────────────────────────

async function processRow(client, log, row, contractIdMap, crosswalk) {
  const contractNumber = (row.ContractNumber || "").trim();
  const contractId = contractIdMap.get(contractNumber);

  if (!contractId) {
    return { contractNumber, ADMIN_RESULT: "NO_CONTRACT", BUYER_RESULT: "NO_CONTRACT", VENDOR_RESULT: "NO_CONTRACT", DELETE_CONVERSION: "SKIP" };
  }

  const state = await getContractState(client, contractId);
  if (!state) {
    return { contractNumber, ADMIN_RESULT: "FAIL:PARTY_FETCH", BUYER_RESULT: "FAIL:PARTY_FETCH", VENDOR_RESULT: "FAIL:PARTY_FETCH", DELETE_CONVERSION: "FAIL:PARTY_FETCH" };
  }

  const result = { contractNumber, ADMIN_RESULT: "SKIP", BUYER_RESULT: "SKIP", VENDOR_RESULT: "SKIP", DELETE_CONVERSION: "SKIP" };

  // CONTRACT_ADMIN (lead manager)
  const leadEmail = (row.LeadManagerEmailAddress || "").trim().toLowerCase();
  if (leadEmail && state.customerHref) {
    if (state.hasAdmin) {
      result.ADMIN_RESULT = "ALREADY_EXISTS";
    } else {
      const contactId = crosswalk.get(leadEmail);
      if (!contactId) {
        result.ADMIN_RESULT = "NOT_IN_CROSSWALK";
      } else {
        const r = await postContact(client, state.customerHref, { ContactRoleCode: "CONTRACT_ADMIN", ContactId: Number(contactId), OwnerFlag: true });
        result.ADMIN_RESULT = r === "OK" ? "CREATED" : r;
        if (r === "OK") state.hasAdmin = true;
      }
    }
  }

  // BUYER
  const buyerEmail = (row.BuyerEmailAddress || "").trim().toLowerCase();
  if (buyerEmail && state.customerHref) {
    if (state.hasBuyer) {
      result.BUYER_RESULT = "ALREADY_EXISTS";
    } else {
      const contactId = crosswalk.get(buyerEmail);
      if (!contactId) {
        result.BUYER_RESULT = "NOT_IN_CROSSWALK";
      } else {
        const ownerFlag = !state.hasAdmin;
        const r = await postContact(client, state.customerHref, { ContactRoleCode: "BUYER", ContactId: Number(contactId), OwnerFlag: ownerFlag });
        result.BUYER_RESULT = r === "OK" ? "CREATED" : r;
      }
    }
  }

  // VENDOR_CONTACT
  const vendorEmail = blank(row.VendorContactEmail) ? null : row.VendorContactEmail.trim();
  const vendorFirst = blank(row.VendorContactFirstName) ? null : row.VendorContactFirstName.trim();
  const vendorLast = blank(row.VendorContactLastName) ? null : row.VendorContactLastName.trim();
  const vendorPhone = blank(row.VendorContactPhone) ? null : row.VendorContactPhone.trim();
  const hasVendorData = vendorEmail || (vendorFirst && vendorLast);

  if (hasVendorData && state.supplierHref) {
    if (state.hasVendor) {
      result.VENDOR_RESULT = "ALREADY_EXISTS";
    } else {
      const primaryPartyId = String(row.PrimaryPartyId || "").trim();
      if (!primaryPartyId) {
        result.VENDOR_RESULT = "NO_PRIMARY_PARTY_ID";
      } else {
        const { contactId, created, error } = await resolveVendorContactId(client, log, primaryPartyId, vendorEmail, vendorFirst, vendorLast, vendorPhone);
        if (!contactId) {
          result.VENDOR_RESULT = `FAIL:${error}`;
        } else {
          const r = await postContact(client, state.supplierHref, { ContactRoleCode: "VENDOR_CONTACT", ContactId: contactId });
          result.VENDOR_RESULT = r === "OK" ? (created ? "CREATED(new_supplier_contact)" : "CREATED") : r;
        }
      }
    }
  }

  // DELETE CONVERSION contacts
  if (state.conversionHrefs.length > 0) {
    const delResults = [];
    for (const href of state.conversionHrefs) {
      const res = await deleteContact(client, href);
      if (res.ok) {
        delResults.push("DELETED");
      } else {
        const msg = extractError(res.data);
        if (/owner|OKC-195/i.test(msg)) {
          delResults.push("SKIP:OWNER_REQUIRED");
        } else {
          delResults.push(`FAIL:HTTP ${res.status}`);
        }
      }
    }
    result.DELETE_CONVERSION = delResults.join(";");
  } else {
    result.DELETE_CONVERSION = "NONE_FOUND";
  }

  log.info(`  ${contractNumber}: admin=${result.ADMIN_RESULT} buyer=${result.BUYER_RESULT} vendor=${result.VENDOR_RESULT} conv=${result.DELETE_CONVERSION}`);
  return result;
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
  const log = createLogger(LOG_DIR, { prefix: `insert-contacts-${stamp}` });
  const client = await createClient(log, { username, password }, { baseUrl: serverOrigin });

  log.info("Script: 9-InsertContacts");
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

  // Headers may have trailing chars (e.g. U+FFFD) — match by prefix
  const headers = Object.keys(rows[0]);
  const leadEmailCol = headers.find(h => h.startsWith("LeadManagerEmailAddress")) || "LeadManagerEmailAddress";
  const buyerEmailCol = headers.find(h => h.startsWith("BuyerEmailAddress")) || "BuyerEmailAddress";

  const workRows = rows
    .filter(r => !blank(r.OracleContractId))
    .map(r => ({ ...r, LeadManagerEmailAddress: r[leadEmailCol] || "", BuyerEmailAddress: r[buyerEmailCol] || "" }));

  log.info(`Rows with OracleContractId: ${workRows.length} / ${rows.length}`);
  log.info("");

  if (workRows.length === 0) {
    log.info("Nothing to process — run 7-InsertContract first.");
    log.summary();
    return;
  }

  // Phase 1: SOAP crosswalk
  log.info("Phase 1: Contact crosswalk");
  const crosswalk = await fetchContactsCrosswalk(serverOrigin, auth, log);
  log.info("");

  // Phase 2: All contracts → ContractNumber → ContractId
  log.info("Phase 2: Fetching contracts from Oracle...");
  const contractIdMap = new Map();
  let offset = 0, total = null;
  while (true) {
    const res = await client.get(
      `${CONTRACTS_ENDPOINT}?fields=ContractId,ContractNumber&onlyData=true&totalResults=true&limit=500&offset=${offset}`
    );
    if (!res.ok) { log.error(`Contract fetch failed: HTTP ${res.status}`); break; }
    const items = res.data.items || [];
    if (total === null) { total = res.data.totalResults || 0; log.info(`  Total in Oracle: ${total}`); }
    for (const c of items) {
      const cn = (c.ContractNumber || "").trim();
      if (cn) contractIdMap.set(cn, String(c.ContractId));
    }
    offset += items.length;
    if (items.length < 500 || offset >= total) break;
  }
  log.info(`  Contract map: ${contractIdMap.size} entries`);
  log.info("");

  // Phase 3: Process contacts concurrently
  log.info("Phase 3: Processing contacts...");
  const results = [];
  let adminCreated = 0, buyerCreated = 0, vendorCreated = 0, convDeleted = 0, anyFailed = 0;

  for (let batch = 0; batch < workRows.length; batch += CONCURRENCY) {
    const slice = workRows.slice(batch, batch + CONCURRENCY);
    const batchResults = await Promise.all(
      slice.map(row => processRow(client, log, row, contractIdMap, crosswalk))
    );

    for (const r of batchResults) {
      results.push(r);
      if (r.ADMIN_RESULT === "CREATED") adminCreated++;
      if (r.BUYER_RESULT === "CREATED") buyerCreated++;
      if (r.VENDOR_RESULT === "CREATED" || r.VENDOR_RESULT === "CREATED(new_supplier_contact)") vendorCreated++;
      if (r.DELETE_CONVERSION.includes("DELETED")) convDeleted++;
      if (r.ADMIN_RESULT.startsWith("FAIL") || r.BUYER_RESULT.startsWith("FAIL") || r.VENDOR_RESULT.startsWith("FAIL")) anyFailed++;
    }

    const done = Math.min(batch + CONCURRENCY, workRows.length);
    if (done % 100 === 0 || done === workRows.length) {
      log.info(`Progress: ${done}/${workRows.length}`);
    }
  }

  const outFile = resolve(OUTPUT_DIR, `insert-contacts-${stamp}.csv`);
  writeFileSync(outFile, [
    ["ContractNumber", "ADMIN_RESULT", "BUYER_RESULT", "VENDOR_RESULT", "DELETE_CONVERSION"].join(","),
    ...results.map(r => [r.contractNumber, r.ADMIN_RESULT, r.BUYER_RESULT, r.VENDOR_RESULT, r.DELETE_CONVERSION].map(csvEscape).join(",")),
  ].join("\n") + "\n");

  log.info("=".repeat(50));
  log.info(`Admin contacts created:  ${adminCreated}`);
  log.info(`Buyer contacts created:  ${buyerCreated}`);
  log.info(`Vendor contacts created: ${vendorCreated}`);
  log.info(`CONVERSION deleted:      ${convDeleted}`);
  log.info(`Rows with any failure:   ${anyFailed}`);
  log.info(`Report: ${outFile}`);
  log.info("=".repeat(50));
  log.summary();

  console.log(`\nAdmin: ${adminCreated}  Buyer: ${buyerCreated}  Vendor: ${vendorCreated}  CONVERSION deleted: ${convDeleted}`);
  console.log(`Report: ${outFile}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
