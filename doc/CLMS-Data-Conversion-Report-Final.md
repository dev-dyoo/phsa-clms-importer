<!-- TITLE: CLMS Data Conversion Report - Final -->
<!-- SUBTITLE: PHSA — Oracle Fusion Cloud Enterprise Contracts (CLMS) -->
<!-- META: Prepared by | Attain Solutions Inc. -->
<!-- META: Date | 2026-05-11 -->
<!-- META: Version | 1.0 — Initial version -->
<!-- META: Status | Final -->
<!-- META: Target system | Oracle Fusion Cloud — Enterprise Contracts, PROD pod iaequp.fa.ocs.oraclecloud.com -->
<!-- PAGEBREAK -->

# Document Control

## Revision History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-11 | Attain Solutions Inc. | Initial version. |

## Related documents and source artifacts

| Item | Location / reference |
|---|---|
| Per-line contract-document load status | `doc/LAST_BATCH_FILES-final-status-2026-05-11.csv` (Appendix C) |
| Appendix A — blocked contracts and their inactive supplier contact | `doc/appendix-a-blocked-contracts.csv` |
| Appendix B — contract numbers not found in Oracle | `doc/appendix-b-contracts-not-found.csv` |
| Appendix E — party/contact insertion exceptions (step 9) | `doc/Supplier-Contacts-FAILED.csv` |
| PHSA CLMS Data Loader Guide — per-script reference | `doc/PHSA-CLMS-Data-Loader-Guide.md` (Appendix D) |
| API endpoint inventory (source) | `doc/API-ENDPOINTS.md` |
| Contract-load batch input | `input/LAST_BATCH_LOAD.csv` — 1,625 contracts |
| Document-load batch input | `input/LAST_BATCH_FILES.csv` — 1,111 lines |
| Internal-contact crosswalk report (BI Publisher) | `/Custom/PHSA/Suppliers/Interfaces/PARTY_CONTACT_ID_CROSSWALK.xdo` |

<!-- PAGEBREAK -->

# Table of Contents

<!-- TOC -->

<!-- PAGEBREAK -->

# 1. Introduction

## 1.1 Purpose

This report documents the data conversion of PHSA contract records and contract documents into Oracle Fusion Cloud — Enterprise Contracts (CLMS), PROD environment. It records the conversion approach, the process steps that were executed, the results of each load, a full reconciliation of source records against the target system, and the outstanding items that require PHSA business or Oracle administrator action. It is intended both as a sign-off record for the conversion and as a reference for whoever maintains or re-runs any part of the pipeline.

This report covers **the last batch of contracts**, provided by PHSA **after go-live** (`input/LAST_BATCH_LOAD.csv` — 1,625 contracts — plus the accompanying contract-document batch). Earlier batches were loaded with a different toolset.

A second reason for this report is that this batch was loaded with **a new set of loader scripts**. Earlier loads were run through an **n8n** workflow; for this load the import scripts were **rewritten from scratch** — as a standalone, plainly-readable set of scripts — to satisfy PHSA's request to be given copies of the contract-loading scripts. Section 1.5 gives a brief description, the platform requirements, and how to run them; the full per-script reference is the *PHSA CLMS Data Loader Guide* (`doc/PHSA-CLMS-Data-Loader-Guide.md`, Appendix D).

## 1.2 Scope

Two related workstreams are covered:

- **Contract conversion** — creating the contract headers, properties, parties/contacts, then driving each contract through Oracle's approval and e-signature workflow so it becomes `ACTIVE`. Source: `input/LAST_BATCH_LOAD.csv` (1,625 contracts).
- **Contract document load** — uploading the source files (contract documents, supporting documents) from the network share and attaching them to the matching contracts in Oracle. Source: `input/LAST_BATCH_FILES.csv` (1,111 contract-folder lines).

Out of scope: the upstream extraction/cleansing of the source CSVs themselves, and any PHSA-side master-data remediation (e.g. reactivating supplier contacts), which is identified here but performed by PHSA / the Oracle administrator.

## 1.3 Target environment

| Item | Value |
|---|---|
| Application | Oracle Fusion Cloud — Enterprise Contracts (CLMS) |
| Pod | `iaequp.fa.ocs.oraclecloud.com` (PROD) |
| REST API base path | `/fscmRestApi/resources/11.13.18.05` |
| Authentication | HTTP Basic — service account `CONVERSION` |
| Org / Legal entity (contracts created against) | `OrgId = 300000004527105`, `LegalEntityId = 300000004643005` |

## 1.4 Glossary

| Term | Meaning |
|---|---|
| CLMS | Contract Lifecycle Management — the PHSA name for the Oracle Fusion Enterprise Contracts module |
| `StsCode` | Oracle contract status code: `DRAFT` → `PENDING_APPROVAL` → `APPROVED` → `PENDING_SIGNATURE` → `SIGNED` → `ACTIVE`; also `PENDING_ACCEPTANCE`, `EXPIRED` |
| ADF custom action | An Oracle REST "action" sub-resource (e.g. `.../action/sign`); requires `Content-Type: application/vnd.oracle.adf.action+json` and takes no request body |
| BPM | Oracle's business-process workflow engine that runs contract approvals asynchronously |
| Header DFF / `ContractHeaderFlexfieldVA` | The descriptive flexfield child collection on a contract — holds PHSA fields such as `contractExecutionApproved`, `phsaCMTeam`, `phsaCategory1/2/3` |
| `ContractProperties_c` | A PHSA custom EFF object linked to each contract, auto-created by Oracle when the contract is created |
| Supplier contact | A contact on the contract's Parties tab in the `SUPPLIER` role; if the underlying supplier-contact record is inactive, contract validation fails |
| n8n | A workflow-automation tool used for earlier PHSA contract loads; superseded for this batch by the standalone loader scripts described below |

## 1.5 The loader scripts

For this batch the import was performed by a purpose-built set of scripts — rewritten from scratch (replacing the earlier n8n workflow) so that PHSA has a self-contained, readable copy of the contract-loading logic. They live in this repository, one numbered folder per step; the leading numbers are execution order, not version numbers.

**What they do.** Each step is a small, standalone, idempotent script that reads a CSV (and/or queries Oracle), performs one job — transform a column, validate values, resolve an id, create a contract, add properties, add contacts, upload documents, submit for approval, sign — and writes a result/log CSV. Because each step records per-record success/failure, any step can be re-run against its own output to retry only what failed. They cover the full pipeline: contract header creation (steps 1–7), contract properties (step 8), parties/contacts (step 9), contract-document upload (steps 10–11), and the approval/signature workflow (steps 12–13), plus a few cleanup utilities.

**Platform.**

| Component | Requirement |
|---|---|
| Steps 1–9, 12, 13 (and `DeleteContractProperties`) | Node.js 18+ (uses built-in `fetch`); ESM. Dependencies: `@iarna/toml`, `csv-parse` (`npm install`). |
| Steps 10–11 (document load) | Windows PowerShell 5.0+; must run on a Windows host that can see the `\\phsabc\root\…` file share. They depend on a `_common/OracleFusionCommon.psm1` module (carried alongside step 11). |
| Target / auth | Oracle Fusion pod `iaequp.fa.ocs.oraclecloud.com` (PROD), HTTP Basic, service account `CONVERSION`, REST base path `/fscmRestApi/resources/11.13.18.05`. |
| Credentials | Node steps read repo-root `settings.toml`; PowerShell steps read a per-folder `.settings` JSON. Both real files are git-ignored; `.example` templates are committed — copy a template and fill in the password. |

**Usage (typical run).** Configure `settings.toml` (and the PowerShell `.settings` files). Then, from the repo root, run the steps in order for a given batch CSV — e.g. `node 7-InsertContract/run.js`, `node 8-InsertContractProperties/run.js`, `node 9-InsertContacts/run.js`, then (after the documents are staged) the PowerShell steps `10` and `11`, then `node 12-SubmitContractsForApproval/run.js`, wait for Oracle's BPM approval to complete, then `node 13-ActivateContracts/run.js`. Each script writes a timestamped log under `<step>/log/` (Node) or `<step>/logs/` (PowerShell) and result CSVs under `<step>/output/` (Node) or `<step>/logs/` (PowerShell); re-run a step against its output CSV to pick up only the rows that failed. Several Node steps honour `DRY_RUN=1` to preview without writing to Oracle.

**Full reference:** the *PHSA CLMS Data Loader Guide* — `doc/PHSA-CLMS-Data-Loader-Guide.md` (Appendix D) — documents every script: what it does, its platform/code dependencies, its inputs and outputs, the endpoints it uses to validate data, and any specific logic that applies. Section 3 of this report lists the steps in order; Section 6 is the API endpoint catalogue.

<!-- PAGEBREAK -->

# 2. Conversion Approach & Architecture

## 2.1 Overview

The conversion is implemented as a set of small, idempotent, individually runnable scripts, numbered by execution order. Each script reads a CSV (or a previous step's output CSV), calls the Oracle Fusion REST API, and writes an output/log CSV that records per-record success or failure, so a step can be safely re-run against its own output to pick up only what failed. The contract workstream (steps 1–9, 12, 13) is implemented in Node.js 18+; the document workstream (steps 10–11) is implemented in Windows PowerShell 5+ because it walks a Windows file share.

## 2.2 Source data

| Source file | Rows | Feeds |
|---|---:|---|
| `input/LAST_BATCH_LOAD.csv` | 1,625 contracts | Contract conversion (steps 1–9), then submit/sign (steps 12–13) |
| `input/LAST_BATCH_FILES.csv` | 1,111 contract-folder lines (962 distinct contract numbers) | Document load (steps 10–11) |
| Network share | `\\phsabc\root\HSSBC\SupplyChainAutomation\ConsultantContract\…` | Document load — the files themselves |
| BI Publisher report `PARTY_CONTACT_ID_CROSSWALK.xdo` | — | Step 9 — maps internal contact email → Oracle `ContactId` |

## 2.3 Integration method

All contract and document operations use the Oracle Fusion REST API under `/fscmRestApi/resources/11.13.18.05`, with HTTP Basic auth (service account `CONVERSION`). State transitions (submit-for-approval, sign, validate) use Oracle's ADF custom-action endpoints, which require the `application/vnd.oracle.adf.action+json` content type and no request body. The internal-contact crosswalk is retrieved via a SOAP call to BI Publisher (`/xmlpserver/services/ExternalReportWSSService`, `runReport`). The shared Node HTTP client retries on network errors and retryable HTTP status codes with exponential backoff, honours `Retry-After` on HTTP 429, and never retries 400/401/403/404 (so auth/permission problems abort immediately rather than looping). The full endpoint catalogue is in Section 6.

<!-- PAGEBREAK -->

# 3. Conversion Process

The pipeline steps, in execution order. Step numbering is sequential only — it does not imply that every step is run on every batch.

| # | Step | Platform | What it does |
|---|---|---|---|
| 1 | DeleteContracts | Node.js | Deletes contracts by `ContractNumber` (resolves each to a `ContractId`, then `DELETE`). Used to clear a prior load before re-running. |
| 2 | TransformHeadings | Node.js | Offline CSV reshape — renames/normalises column headings to the canonical names the later steps expect. No API calls. |
| 3 | TransformValues | Node.js | Offline value transformation — maps source codes to valid Oracle codes. Ships with a built-in list of valid codes; a live-fetch path against value sets / lookups exists but is commented out. |
| 4 | ValidateValues | Node.js | Validates the transformed values against Oracle reference data — value sets (`PHSA_CM_TEAMS`) and standard lookups (`PHSA_EXPIRY_STRATEGY`, `PHSA_INITIAL_PRC_STRATEGY`, `PHSA_OPTION_YEARS_AVAILABLE`, `PHSA_WB_CONTRACT_TYPE`). |
| 5 | FillContractTypeId | Node.js | Resolves each contract-type name to its `ContractTypeId` via the contract-type list of values. |
| 6 | FillPrimaryPartyId | Node.js | Resolves the supplier/distributor (`VendorMasterId`) to a `SupplierPartyId` by reading all suppliers (with the DFF that carries `VendorMasterId`). |
| 7 | InsertContract | Node.js | Creates the contract in Oracle (`POST /contracts`) — a fixed base payload plus the row's mapped attributes, description, dates (`YYYY-MM-DD`), and the PHSA header flexfield (`ContractHeaderFlexfieldVA`, incl. `contractExecutionApproved = "PHSA"`). Contract is created in `DRAFT`. |
| 8 | InsertContractProperties | Node.js | Populates the `ContractProperties_c` custom object for each contract — POST a new record or PATCH the auto-created one (per-health-org estimated annual spend, contract-type/strategy fields, rebate fields, etc.). |
| 9 | InsertContacts | Node.js | Adds the contract's parties' contacts — admin/buyer contacts on the CUSTOMER party, vendor contact on the SUPPLIER party — resolving internal contacts via the BI Publisher email→ContactId crosswalk and vendor contacts via `contractVContacts` (creating a supplier contact if none exists), then removes the migration `CONVERSION` placeholder contact. (`9-InsertContacts/retry-and-report.js` re-runs the contact load against failures and reports, without the CONVERSION delete.) |
| 10 | EnrichDocumentFilesList | PowerShell | Reads `LAST_BATCH_FILES.csv`, resolves each `CONTRACT_NUMBER` to a `ContractId`, walks the folder `PATH` on the share, and emits an enriched per-file load list (file name, MIME type, doc type, target `ContractId`). |
| 11 | ImportContractDocuments | PowerShell | Uploads each file from the enriched list to its contract — `ContractDoc` → `ContractDocuments` collection, `SupportingDoc`/`Excel` → `SupportingDocuments` collection — skipping files already present (existence check), trimming `Title` to ≤ 80 characters. |
| 12 | SubmitContractsForApproval | Node.js | For each `DRAFT` contract from `LAST_BATCH_LOAD.csv`, `POST .../action/submitForApproval` to enter the BPM approval workflow. Returns 200 on accept; Oracle then processes the approval asynchronously, so a wait is required before step 13. |
| 13 | ActivateContracts | Node.js | For each contract that step 12 submitted OK, `POST .../action/sign` — the final transition to `ACTIVE`. |
| — | DeleteContractProperties | Node.js | Utility — deletes `ContractProperties_c` records for given contract numbers (used to clean up before re-running step 8). |
| — | (diagnostics) | Node.js | `GET /contracts/{id}?expand=all` (status / header flexfield checks), `POST .../action/validateContract` (why a contract won't leave `DRAFT`). |

<!-- PAGEBREAK -->

# 4. Contract Conversion — Results & Reconciliation

State of the 1,625-contract batch (`input/LAST_BATCH_LOAD.csv`) in CLMS PROD after the load (steps 1–9), the document import (steps 10–11), submit-for-approval (step 12) and sign (step 13).

## 4.1 Summary

| State | Count | Status |
|---|---:|---|
| ACTIVE (submitted, approved, signed) | 1,559 | Done |
| DRAFT — blocked by an inactive supplier contact on the contract | 63 | Needs data fix (§4.3) |
| Individual exceptions | 3 | Needs investigation (§4.4) |
| Total | 1,625 | |

1,559 + 63 + 3 = 1,625. The 1,559 ACTIVE contracts are complete — `submitForApproval` and `sign` both succeeded and a spot-check confirms `StsCode = ACTIVE`.

## 4.2 ACTIVE — 1,559 contracts

No action required. These walked DRAFT → PENDING_APPROVAL → APPROVED → PENDING_SIGNATURE → SIGNED → ACTIVE. Recommended: spot-check a sample in the CLMS UI to confirm.

## 4.3 DRAFT, blocked — 63 contracts (inactive supplier contact)

These 63 are still in `StsCode = DRAFT`. `submitForApproval` returns HTTP 200 but the contract cannot leave DRAFT: it fails the contract validation `OKC_VAL_INACTIVE_SUPPLIER_CONT` — "The supplier contact &lt;name&gt; is inactive. Select an active contact on the parties tab." (Confirmed by running the `validateContract` action on each.) Re-running step 12 or step 13 will not change this until the contact data is fixed.

The 63 break down across 9 inactive supplier contacts:

| Inactive supplier contact | # contracts |
|---|---:|
| ChristyAnn Fratpietro | 24 |
| Shelley Masyoluk | 22 |
| Adam Sawulski | 6 |
| Ian Pequegnat | 4 |
| Amy Maher | 2 |
| Jack Krzyanowski | 2 |
| Bruce Nelson | 1 |
| Darren Bombardier | 1 |
| NA NA | 1 |
| Total | 63 |

**To clear them:** reactivate those 9 contacts in their Oracle supplier records, or on each of the 63 contracts replace the inactive supplier contact with an active one on the Parties tab. Then re-run `node 12-SubmitContractsForApproval/run.js <csv of the 63>` → wait for Oracle's BPM approval → `node 13-ActivateContracts/run.js`. A ready-made input CSV of the 63 (ContractNumber, ContractId, inactive contact) is `doc/appendix-a-blocked-contracts.csv` (also reproduced in Appendix A).

## 4.4 Individual exceptions — 3 contracts

| ContractNumber | ContractId | Current state | What's needed |
|---|---|---|---|
| `SOW20260116HP–CH–TEKsystems-01` | — (ambiguous) | This ContractNumber matches 2 separate contracts in Oracle, so it was never processed. | Identify the two contracts, determine which is correct (the other is likely a duplicate/test), then submit + sign the correct one. |
| `SOW20260116HP–CH–Apex Systems-01` | `300000007523941` | `PENDING_ACCEPTANCE`. `submitForApproval` is rejected (`OKC-196129` — not valid from this state); `sign` is rejected (`OKC-196434` — operation not allowed on this contract type). | Check whether it just needs the next workflow step (e.g. acceptance) rather than submit/sign — its contract type apparently doesn't use the e-signature `sign` action. May already be effectively complete. |
| `SOW20251028DB-11` | `300000007914893` | `EXPIRED`. Can't be submitted or signed from this state. | Confirm the contract end date is correct. If it's genuinely expired it shouldn't be activated — flag with the business owner. |

## 4.5 Party / contact insertion exceptions — 107 contracts (step 9)

Step 9 (`InsertContacts`) adds the lead-manager / buyer contacts to the CUSTOMER party and the vendor contact to the SUPPLIER party of each contract, then removes the migration `CONVERSION` placeholder contact. For **107 contracts** one or more of those operations could not be completed and the contract was written to `doc/Supplier-Contacts-FAILED.csv` (columns `ContractNumber, ContractId, OracleInternalId, PrimaryPartyId, SupplierName, VendorContactName, VendorContactEmail, ISSUE, ACTION_NEEDED, ADMIN_RESULT, BUYER_RESULT, VENDOR_RESULT, DELETE_CONVERSION`). These are master-data / concurrency follow-ups, not load defects — and they are independent of the 1,559 / 63 / 3 contract-status outcome in §4.1 (a contract can be ACTIVE and still appear here if, e.g., its admin/buyer contacts weren't in the crosswalk).

| `ISSUE` | # contracts | Meaning | Action needed |
|---|---:|---|---|
| `NO_PHSA_CONTACTS` | 87 | The lead-manager and buyer emails are not in Oracle's contact directory / crosswalk (`ADMIN_RESULT = BUYER_RESULT = NOT_IN_CROSSWALK`); the vendor contact was generally fine (`VENDOR_RESULT = ALREADY_EXISTS` on 83, `SKIP` on 4). | Add those internal contacts to the Oracle contact directory, then re-run step 9 for these contracts. |
| `VENDOR_CONTACT_ORPHANED` | 8 | A supplier contact **was created in Oracle** but could not be linked to the contract (`VENDOR_RESULT = FAIL: Created but could not resolve ContactId from contractVContacts`). | On the supplier record, find the just-created contact and link it to the contract as `VENDOR_CONTACT`. **Do not create a new one** (doing so would duplicate it). |
| `VENDOR_CONTACT_NOT_CREATED` | 8 | The `POZ_SUPPLIERS` row was locked by another user at the time (`VENDOR_RESULT = FAIL: HTTP 400 … Failed to lock the record in table POZ_SUPPLIERS …`); the contact was **never created**. | Re-run the vendor-contact insert (step 9) for these contracts. |
| `SUPPLIER_PROFILE_LOCKED` | 4 | The supplier has a pending profile change request, so Oracle won't accept edits (`VENDOR_RESULT = FAIL: HTTP 400 … This supplier profile is locked for editing … (POZ-2130454)`). Affects `STEVENS COMPANY LTD` (Tomas Zeman) ×2 and `BOWERS MEDICAL SUPPLY` (Joel De Leon) ×2. | Wait for the supplier's profile change request to be approved, then re-run step 9 for these contracts. |
| **Total** | **107** | | |

The 8 supplier contacts that **were created in Oracle but not linked** (`VENDOR_CONTACT_ORPHANED`) are the ones to clean up carefully — link, don't re-create:

| ContractNumber | ContractId | Supplier (`PrimaryPartyId`) | Created contact |
|---|---|---|---|
| `SOW20240531PD-4` | `300000007914043` | `300000006504462` | Peter Janke |
| `SOW20241212PD` | `300000007912630` | `300000006503701` | Nathan Ing |
| `SOW20241220CS-12` | `300000007913611` | `300000006471712` | Michael Pedemonti |
| `SOW20250616CS` | `300000007912917` | `300000006471712` | Ian Brunton |
| `SOW20250911SL` | `300000007914770` | `300000006471712` | Manish Anand |
| `SOW20251021CS3` | `300000007913109` | `300000006471712` | Saad Zafar |
| `SOW20260120ZZ` | `300000007916385` | `300000006503701` | Bryan Farrell |
| `SOW20260319MT` | `300000007913133` | `300000006471712` | Thomas Yoo |

Separately, on 88 of the 107 the migration `CONVERSION` placeholder contact could not be removed from the CUSTOMER party (`DELETE_CONVERSION = FAIL: HTTP 400`); on the other 19 there was nothing to remove (`NONE_FOUND`). Once the contact issues above are resolved and step 9 is re-run, the leftover `CONVERSION` contact should be cleaned up on those 88 as well. Per-contract detail (including `ACTION_NEEDED` text and the per-role results) is in `doc/Supplier-Contacts-FAILED.csv`.

<!-- PAGEBREAK -->

# 5. Contract Document Load — Results & Reconciliation

Upload of the source files referenced by `input/LAST_BATCH_FILES.csv` into the matching CLMS contracts. The companion per-line status file is `doc/LAST_BATCH_FILES-final-status-2026-05-11.csv` (Appendix C).

## 5.1 Summary

| Metric | Count |
|---|---:|
| Batch lines (contract folders) | 1,111 |
| → resulted in document loads (`LOADED`) | 593 |
| → contract number not in Oracle (`CONTRACT NOT FOUND`) | 516 |
| → contract found but folder empty (`NO DOCUMENTS FOUND`) | 2 |
| Distinct contracts in the batch | 962 |
| → found & loaded in Oracle | 538 |
| → not found in Oracle | 424 |
| Document upload attempts (one per file found) | 2,631 |
| → uploaded OK | 2,631 (100%) |
| → failed to load | 0 |
| Duplicate copies created during loading, then removed | 107 |
| Distinct documents now in Oracle (across the 538 contracts) | 2,529 — 1,754 Contract Documents + 775 Supporting Documents |

Every file that the batch pointed at and that belongs to a contract Oracle knows about is loaded. The only non-loads are batch lines for contracts that don't exist in this Oracle instance (424 distinct, Appendix B) and one contract whose folders were empty.

**On the 2,631 vs 2,529:** about 50 contracts were listed twice in the batch — once under `…\consultantcr\<SOW…>\` and once under `…\consultantcr\March2026\<SOW…>\` — with the same files in both folders. Each listing was uploaded, producing 102 duplicate documents; an earlier smoke test also caused 5 documents on `SOW20210603GP` to be loaded twice. All 107 duplicate copies were removed in a follow-up de-duplication pass, leaving exactly one copy of each filename per contract. So the `LOADED` lines and the per-line `DOCS_LOADED` column count files attempted from that path (2,631 total); Oracle holds 2,529 distinct documents.

## 5.2 Document load status — by outcome

| Status | Batch lines | Documents |
|---|---:|---|
| `LOADED` | 593 | 2,631 uploaded (2,529 distinct after de-dup) |
| `CONTRACT NOT FOUND` | 516 (424 distinct contract numbers; 92 of them appear on >1 line) | 0 |
| `NO DOCUMENTS FOUND` | 2 (1 contract, listed under 2 paths) | 0 |
| Total | 1,111 | |

By document type (uploaded): 1,856 Contract Documents (`OKC_DOCUMENTS_CONTRACT`), 775 Supporting Documents (`OKC_DOCUMENTS_SUPPORTING_DOC`), 0 Excel/spreadsheet (`PHSA_ITEM_SPREADSHEETS`).

## 5.3 Documents that did not load — and why

No documents are currently in a failed state — every file that could be uploaded was. For completeness:

**A. Transient failures during the run — all resolved.** 56 documents failed on the first pass with `HTTP 400 — Value '<filename>' for field Title exceeds the maximum length allowed` (file names longer than ~80 characters; Oracle's `Title` attribute is length-limited, `UploadedFileName` / `FileName` are not). The importer now trims `Title` to ≤ 80 characters (keeping the extension) and sends the full file name in the other fields. All 56 were re-loaded on the re-run (1 was found already present by the existence check, so 55 were uploaded). 0 remain failed.

**B. Batch lines that produced no document load:**

| Reason | Batch lines | Affects |
|---|---:|---|
| Contract number does not exist in Oracle Fusion (`/contracts?q=ContractNumber=…` returned no match) | 516 | 424 distinct contract numbers — full list in Appendix B and in `LAST_BATCH_FILES-final-status-2026-05-11.csv` (rows with `STATUS = CONTRACT NOT FOUND`) |
| Contract found, but no `ContractDoc`, `SupportingDoc`, or `PO*/SOW*` files in the folder | 2 | `SOW20251211-POSPF-BH` (ContractId `300000007911000`), listed under both `\\phsabc\root\HSSBC\SupplyChainAutomation\ConsultantContract\consultantcr\SOW20251211-POSPF-BH` and `…\consultantcr\March2026\SOW20251211-POSPF-BH` — both folders empty of loadable documents |

The 424 unresolved contract numbers (≈ 44% of the batch's distinct contracts) suggest either an environment mismatch, contracts not yet migrated, or contract-number formatting differences. None of this is a defect in the load — there was simply nothing in Oracle to attach the documents to.

## 5.4 De-duplication (follow-up cleanup)

107 duplicate documents were created during loading and then removed:

| Source of duplicates | Count | Contracts |
|---|---:|---|
| Contracts listed twice in the batch (two paths, same files) | 102 | 50 |
| `SOW20210603GP` — 5 docs loaded by a smoke test, then re-loaded by the main run | 5 | 1 |
| Total deleted | 107 | 51 |

Done via a de-duplication pass (dry-run reviewed, then live): 107 deletes, 0 failures, then a re-scan confirmed 0 duplicates remaining. Each affected contract now holds exactly the required (distinct) set of documents.

## 5.5 Where the data lives

| Item | Path |
|---|---|
| Final per-line status (this report's companion) | `doc/LAST_BATCH_FILES-final-status-2026-05-11.csv` — columns `CONTRACT_NUMBER, PATH, CONTRACT_ID, STATUS, DOCS_LOADED, DETAIL`, one row per batch input line |
| Per-document detail (every file, with `Done` / `Error` / `ErrorDescription`) | `11-ImportContractDocuments/logs/ContractDocumentLoadList-…csv` |
| Enrichment output (the load list) | `10-EnrichDocumentFilesList/logs/ContractDocumentLoadList-…csv` |
| De-dup plan / result | `…/logs/DeduplicateContractDocuments-{plan,result}-*.csv` |
| Run logs | `<ScriptName>/logs/<ScriptName>-<timestamp>.log` |

<!-- PAGEBREAK -->

# 6. Integration / API Reference

Every Oracle endpoint touched by the conversion scripts, inventoried from the code.

## 6.1 Connection

| Item | Value |
|---|---|
| Host | `iaequp.fa.ocs.oraclecloud.com` (PROD) — from `settings.toml` `[server] baseUrl` (Node) / `.settings` `BaseUrl` (PowerShell) |
| REST base path | `/fscmRestApi/resources/11.13.18.05` |
| Auth | HTTP Basic — `Authorization: Basic base64(username:password)`, user `CONVERSION` |
| Default headers (Node `lib/client.js`) | `Content-Type: application/json`, `Accept: application/json` (overridden for ADF actions and SOAP) |
| Retry | exponential backoff on network errors and retryable HTTP codes; 400/401/403/404 are never retried; honours `Retry-After` on 429 |
| Common query params | `onlyData=true`, `totalResults=true`, `limit=N` + `offset=N` (pages of 500, except the step-11 existence check which uses 200), `q=<expr>`, `fields=<csv>`, `expand=all|<child>` |

## 6.2 Endpoint catalogue

### 6.2.1 `/contracts`

| Method & path | Purpose | Notes / payload | Used by |
|---|---|---|---|
| `GET /contracts?q=ContractNumber=<n>&fields=ContractId&onlyData=true` | Resolve a `ContractNumber` to its Fusion `ContractId` | 0 results = not found; >1 = ambiguous (flagged) | `1-DeleteContracts`, `12-SubmitContractsForApproval` (fallback), `10-EnrichDocumentFilesList` |
| `GET /contracts?limit=1&onlyData=true` | Startup sanity check (any 2xx = API reachable / creds OK) | — | `1-DeleteContracts`, `11-ImportContractDocuments`, reference PowerShell |
| `GET /contracts?fields=ContractId,ContractNumber&onlyData=true&totalResults=true&limit=500&offset=N` (paginated) | Build a `ContractNumber → ContractId` map | step 8 variant adds `Id,MajorVersion` (needs internal `Id`/version) | `9-InsertContacts` (+ `retry-and-report.js`), `8-InsertContractProperties` |
| `GET /contracts/{ContractId}?expand=all` (or `expand=ContractHeaderFlexfieldVA`) | Full contract resource incl. child collections | key scalars: `StsCode`, `StateTransitionFlowState`, `Status`, `SubmitRenderedFlag`, `SignContractRenderedFlag`, `ValidateContractRenderedFlag`, `DateApproved`, `DateSigned` | diagnostics |
| `POST /contracts` | Create a contract (in `DRAFT`); response carries `ContractId` | fixed base — `EnableElectronicSignFlag:false, TemplateFlag:false, BuyOrSell:"B", AuthoringPartyCode:"INTERNAL", PHSACustomValidationCompleted_c:true, AccessLevel:"UPDATE", OrgId:300000004527105, LegalEntityId:300000004643005` — plus mapped attributes, `Description` (ASCII-transliterated), `ContractHeaderFlexfieldVA:[{ … phsaCMTeam, contractExecutionApproved:"PHSA", phsaCategory1/2/3 … }]`; dates `YYYY-MM-DD` | `7-InsertContract` |
| `DELETE /contracts/{ContractId}` | Delete a contract | — | `1-DeleteContracts` |
| `GET /contracts/{ContractId}/child/ContractParty?expand=all` | The contract's parties (each: `PartyRoleCode` CUSTOMER/SUPPLIER, self-link `href`, nested `ContractPartyContact[]` with `ContactRoleCode` CONTRACT_ADMIN/BUYER/VENDOR_CONTACT, `PartyContactName`) | — | `9-InsertContacts` (+ `retry-and-report.js`) |
| `POST {ContractPartyHref}/child/ContractPartyContact` | Add a contact (admin/buyer to CUSTOMER, vendor contact to SUPPLIER) | path = ContractParty self-link href (host stripped) + `/child/ContractPartyContact`; body: `ContactRoleCode` + resolved `ContactId` | `9-InsertContacts` (+ `retry-and-report.js`) |
| `DELETE {ContractPartyContactHref}` | Remove the migration `CONVERSION` contact from the CUSTOMER party | — | `9-InsertContacts` |
| `GET /contracts/{ContractId}/child/ContractDocuments?fields=…&limit=200&offset=N` (paginated) | Existing contract documents (existence check) | `?fields=UploadedFileName` returns `null` here — fetch the full item; `CategoryName` seen: `OKC_DOCUMENTS_CONTRACT`, `OKC_DOCUMENTS_PCD` | `11-ImportContractDocuments` |
| `GET /contracts/{ContractId}/child/SupportingDocuments?…&limit=200&offset=N` (paginated) | Peer collection to ContractDocuments (fetch separately) | `CategoryName` seen: `OKC_DOCUMENTS_SUPPORTING_DOC`, `PHSA_ITEM_SPREADSHEETS` | `11-ImportContractDocuments` |
| `POST /contracts/{ContractId}/child/ContractDocuments` &nbsp;/&nbsp; `POST /contracts/{ContractId}/child/SupportingDocuments` | Upload a file to a contract | body: `DatatypeCode:"FILE", Title:"<file name, ≤80 chars>", UploadedFileContentType:"<MIME>", UploadedFileName:"<full name>", FileContents:"<base64>", Description, FileName:"<full name>", CategoryName`; resource & `CategoryName` from `DocType`: `ContractDoc`→ContractDocuments+`OKC_DOCUMENTS_CONTRACT`, `SupportingDoc`→SupportingDocuments+`OKC_DOCUMENTS_SUPPORTING_DOC`, `Excel`→SupportingDocuments+`PHSA_ITEM_SPREADSHEETS` | `11-ImportContractDocuments` |
| `POST /contracts/{ContractId}/action/submitForApproval` | Submit a draft contract into the BPM approval workflow | `Content-Type: application/vnd.oracle.adf.action+json`, no body; 200 on accept but the contract may still fail validation and stay `DRAFT`; failure seen: `OKC-196129` (not in a state from which SUBMIT is valid — e.g. `PENDING_ACCEPTANCE`, `EXPIRED`) | `12-SubmitContractsForApproval` |
| `POST /contracts/{ContractId}/action/sign` | Sign an approved contract (final transition → `ACTIVE`) | `Content-Type: application/vnd.oracle.adf.action+json`, no body; failures seen: `OKC-196583` (not in `PENDING_SIGNATURE`), `OKC-196434` (operation not allowed on this contract type) | `13-ActivateContracts` |
| `POST /contracts/{ContractId}/action/validateContract` | Run contract validation without changing state | `Content-Type: application/vnd.oracle.adf.action+json`, no body; returns `{ result: { Errors:[{ MessageName, MessageText, ObjectName, … }], Warnings:[…] } }`; e.g. `OKC_VAL_INACTIVE_SUPPLIER_CONT` | diagnostics |
| `GET /contracts/300000006409761/lov/ContractTypeAllVA?fields=ContractTypeId,Name&onlyData=true&limit=500` | Contract-type list of values (`ContractTypeId` ↔ `Name`) | `300000006409761` is a fixed reference contract id used only to reach the LOV resource | `5-FillContractTypeId` |

### 6.2.2 `/suppliers`

| Method & path | Purpose | Notes / payload | Used by |
|---|---|---|---|
| `GET /suppliers?fields=SupplierId,SupplierPartyId,Supplier,DFF&expand=all&onlyData=true&totalResults=true&limit=500&offset=N` (paginated) | Every supplier with the DFF (carries `VendorMasterId`) → build `VendorMasterId → SupplierPartyId` | — | `6-FillPrimaryPartyId` |
| `GET /suppliers?fields=SupplierId,SupplierPartyId&onlyData=true&totalResults=true&limit=500&offset=N` (paginated) | `SupplierPartyId → SupplierId` map (composed with step 6's reference CSV → `VendorMasterId → SupplierId`) | — | `7-InsertContract` |
| `GET /suppliers?q=SupplierPartyId=<id>&fields=SupplierId,SupplierPartyId&onlyData=true` | Resolve one supplier's `SupplierId` from its party id | — | `9-InsertContacts` (+ `retry-and-report.js`) |
| `POST /suppliers/{SupplierId}/child/contacts` | Create a supplier contact when the needed vendor contact doesn't exist | body: `FirstName, LastName, AdministrativeContactFlag:true, PhoneNumber, Email` | `9-InsertContacts` (+ `retry-and-report.js`) |

### 6.2.3 `/contractVContacts`

| Method & path | Purpose | Notes | Used by |
|---|---|---|---|
| `GET /contractVContacts?onlyData=true&fields=ContactId,PartyId,ContactName,EmailAddress&q=PartyId=<primaryPartyId>` | Existing vendor contacts for a supplier party — find an existing `ContactId` before creating one | — | `9-InsertContacts` (+ `retry-and-report.js`) |

### 6.2.4 `/ContractProperties_c` (PHSA custom EFF object; auto-created when a contract is created)

| Method & path | Purpose | Notes / payload | Used by |
|---|---|---|---|
| `GET /ContractProperties_c?fields=Id,ObjectId_c&onlyData=true&totalResults=true&limit=500&offset=N` (paginated) | All properties records → `ObjectId_c` (= contract internal `Id`) → record `Id`; decide POST-new vs PATCH-existing | — | `8-InsertContractProperties` |
| `GET /ContractProperties_c?q=ContractNumber_c=<n>&fields=Id,ContractNumber_c,ObjectId_c,RecordName,MajorVersion_c,CreationDate&onlyData=true&limit=500&offset=N` | Properties records for a given contract number — find what to delete | — | `DeleteContractProperties` |
| `POST /ContractProperties_c` &nbsp;/&nbsp; `PATCH /ContractProperties_c/{Id}` | Create / update the properties record | body: `RecordName` (= ContractNumber), `ObjectId_c` (= contract internal Id), `MajorVersion_c`, `SourcingTrackerID_c`, `ParticipatingHA_c`, `Text02_c`, `Number06_c`–`Number14_c` (per-health-org estimated annual spend + total), `PDText01_c` (JSON array of `ContractTypeName`), `PDText02_c` (`InitialProcurementStrategy`), `PDText03_c` (`ExpiryStrategy`), `Text11_c`/`Text12_c`/`Text13_c` (rebate), `Text18_c` (`AgencyOrDepartment`), `Date01_c` (`DateOfNextPriceIncrease`, ISO date); null/blank fields omitted | `8-InsertContractProperties` |
| `DELETE /ContractProperties_c/{Id}` | Delete a properties record | — | `DeleteContractProperties` |

### 6.2.5 `/valueSets` and `/standardLookups` (reference-code lookups)

| Method & path | Purpose | Notes | Used by |
|---|---|---|---|
| `GET /valueSets/{resourceCode}/child/values?fields=Value&onlyData=true[&limit=N&offset=N]` | Valid values for a value set — `CMTeam` → `PHSA_CM_TEAMS` | — | `4-ValidateValues`; `3-TransformValues` (live path commented out) |
| `GET /standardLookups/{resourceCode}/child/lookupCodes?fields=LookupCode&q=<filter>&onlyData=true` | Valid lookup codes — `ExpiryStrategy` → `PHSA_EXPIRY_STRATEGY`, `InitialProcurementStrategy` → `PHSA_INITIAL_PRC_STRATEGY`, `OptionYearsAvailable` → `PHSA_OPTION_YEARS_AVAILABLE`, `ContractTypeName` → `PHSA_WB_CONTRACT_TYPE` | — | `4-ValidateValues`; `3-TransformValues` (commented out) |

### 6.2.6 SOAP / BI Publisher — `/xmlpserver/services/ExternalReportWSSService`

| Method & path | Purpose | Notes | Used by |
|---|---|---|---|
| `POST /xmlpserver/services/ExternalReportWSSService` | Run the internal-contact crosswalk report | `Content-Type: application/soap+xml; charset=utf-8` (SOAP 1.2); body = a `runReport` envelope (`http://xmlns.oracle.com/oxp/service/PublicReportService`) with `reportAbsolutePath = /Custom/PHSA/Suppliers/Interfaces/PARTY_CONTACT_ID_CROSSWALK.xdo`; response: extract `<ns2:reportBytes>`, base64-decode → CSV mapping email → Oracle `ContactId` | `9-InsertContacts` (+ `retry-and-report.js`) |

## 6.3 Script → endpoints

| Script | Endpoints used |
|---|---|
| `1-DeleteContracts` | `GET /contracts?q=ContractNumber=…`; `GET /contracts?limit=1` (sanity); `DELETE /contracts/{id}` |
| `2-TransformHeadings` | none — offline CSV reshape |
| `3-TransformValues` | none active — `GET /valueSets/.../child/values`, `GET /standardLookups/.../child/lookupCodes` present but commented out |
| `4-ValidateValues` | `GET /valueSets/{code}/child/values`; `GET /standardLookups/{code}/child/lookupCodes` |
| `5-FillContractTypeId` | `GET /contracts/300000006409761/lov/ContractTypeAllVA` |
| `6-FillPrimaryPartyId` | `GET /suppliers?...&expand=all` (paginated) |
| `7-InsertContract` | `GET /suppliers?fields=SupplierId,SupplierPartyId` (paginated); `POST /contracts` |
| `8-InsertContractProperties` | `GET /contracts?fields=Id,ContractId,ContractNumber,MajorVersion` (paginated); `GET /ContractProperties_c?fields=Id,ObjectId_c` (paginated); `POST /ContractProperties_c`; `PATCH /ContractProperties_c/{id}` |
| `9-InsertContacts` | `POST /xmlpserver/services/ExternalReportWSSService` (SOAP crosswalk); `GET /contracts?fields=ContractId,ContractNumber` (paginated); `GET /contracts/{id}/child/ContractParty?expand=all`; `GET /contractVContacts?q=PartyId=…`; `GET /suppliers?q=SupplierPartyId=…`; `POST /suppliers/{id}/child/contacts`; `POST {partyHref}/child/ContractPartyContact`; `DELETE {partyContactHref}` |
| `9-InsertContacts/retry-and-report.js` | same family as `9-InsertContacts` (minus the CONVERSION delete) |
| `10-EnrichDocumentFilesList` (PowerShell) | `GET /contracts?q=ContractNumber=…` |
| `11-ImportContractDocuments` (PowerShell) | `GET /contracts?limit=1` (sanity); `GET /contracts/{id}/child/ContractDocuments` & `…/SupportingDocuments` (paginated, limit=200 — existence check); `POST /contracts/{id}/child/ContractDocuments` & `…/SupportingDocuments` (upload) |
| `12-SubmitContractsForApproval` | `GET /contracts?q=ContractNumber=…` (fallback id resolve); `POST /contracts/{id}/action/submitForApproval` |
| `13-ActivateContracts` | `POST /contracts/{id}/action/sign` |
| `DeleteContractProperties` | `GET /ContractProperties_c?q=ContractNumber_c=…` (paginated); `DELETE /ContractProperties_c/{id}` |
| diagnostics | `GET /contracts/{id}?expand=all`; `POST /contracts/{id}/action/validateContract` |

<!-- PAGEBREAK -->

# 7. Outstanding Items & Recommendations

## 7.1 Contract conversion

- **63 blocked contracts** — fix the 9 inactive supplier contacts (reactivate them in their Oracle supplier records, or swap them for active contacts on each of the 63 contracts' Parties tab), then re-run step 12 → wait for BPM approval → step 13 for the 63. Input list: `doc/appendix-a-blocked-contracts.csv` / Appendix A.
- **3 individual exceptions** — handled per §4.4, with PHSA + the Oracle administrator: resolve the ambiguous `SOW20260116HP–CH–TEKsystems-01` (two matching contracts); confirm whether `SOW20260116HP–CH–Apex Systems-01` (PENDING_ACCEPTANCE, contract type that doesn't use `sign`) is already complete; confirm whether `SOW20251028DB-11` (EXPIRED) should be activated at all.
- **107 party/contact exceptions** (step 9, §4.5 / Appendix E / `doc/Supplier-Contacts-FAILED.csv`) — add the 87 contracts' lead-manager/buyer contacts to the Oracle contact directory; **link** (don't re-create) the 8 orphaned supplier contacts that were already created; re-run step 9 for the 8 lock-contention and 4 supplier-profile-locked contracts (the latter after the supplier profile change requests clear); then clean up the leftover `CONVERSION` placeholder on the 88 where its removal failed.
- **Spot-check** a sample of the 1,559 ACTIVE contracts in the CLMS UI.
- **No code changes required** — steps 12 and 13 worked as designed; everything outstanding is Oracle data/config.

After the 63 and the 3 are resolved, all 1,625 should be ACTIVE (modulo any contract that legitimately shouldn't be, e.g. the expired one).

## 7.2 Contract document load

- **424 unresolved contract numbers** (`CONTRACT NOT FOUND`) — need a PHSA decision: not yet migrated? wrong environment? contract-number formatting differences? Full list in Appendix B / `doc/appendix-b-contracts-not-found.csv`, and as the `STATUS = CONTRACT NOT FOUND` rows of `LAST_BATCH_FILES-final-status-2026-05-11.csv` (which also shows the source folder path; 92 of the 424 appear on more than one batch line).
- **`SOW20251211-POSPF-BH`** (ContractId `300000007911000`) — both source folders were empty of loadable documents; confirm there are no documents to load, or supply them.
- **No defects in the load itself** — 2,631/2,631 files uploaded; the 56 transient Title-length failures were resolved; 107 duplicates were cleaned up; 0 duplicates remain.

## 7.3 General

- **Credentials** — the PROD Oracle password lives only in the git-ignored `settings.toml` / `.settings` files; only `.example` templates with placeholder passwords are committed. Rotate the `CONVERSION` account password if there's any concern it was exposed.
- **Runtime artifacts** — `*/log/`, `*/logs/`, `*/output/` are git-ignored and contain PROD data; keep them out of version control.
- **Maintenance / re-running the loader** — see the *PHSA CLMS Data Loader Guide* (`doc/PHSA-CLMS-Data-Loader-Guide.md`, Appendix D) for the per-script reference: what each script does, its platform/code dependencies, inputs/outputs, validation endpoints, and specific logic. Section 1.5 of this report has the short version.

<!-- PAGEBREAK -->

# 8. Appendices

| Appendix | Contents | File |
|---|---|---|
| A | The 63 DRAFT/blocked contracts and their inactive supplier contact (ContractNumber, ContractId) | `doc/appendix-a-blocked-contracts.csv` |
| B | The 424 contract numbers referenced by the document batch that do not exist in Oracle Fusion | `doc/appendix-b-contracts-not-found.csv` |
| C | Final per-line contract-document load status — one row per batch input line (`CONTRACT_NUMBER, PATH, CONTRACT_ID, STATUS, DOCS_LOADED, DETAIL`) | `doc/LAST_BATCH_FILES-final-status-2026-05-11.csv` |
| D | PHSA CLMS Data Loader Guide — per-script reference (purpose, platform/code dependencies, inputs/outputs, validation endpoints, specific logic) | `doc/PHSA-CLMS-Data-Loader-Guide.md` |
| E | Party/contact insertion exceptions (step 9) — 107 contracts, per-role results and action needed | `doc/Supplier-Contacts-FAILED.csv` |

## Appendix A — the 63 DRAFT/blocked contracts and their inactive supplier contact

Source: `doc/appendix-a-blocked-contracts.csv` (columns `InactiveSupplierContact, ContractNumber, ContractId`).

| Inactive supplier contact | ContractNumber | ContractId |
|---|---|---|
| Adam Sawulski | CL02282SM-2024 | 300000007906912 |
| Adam Sawulski | CL03842SO-FHA | 300000007909649 |
| Adam Sawulski | CL03842SO-PHSA | 300000007911295 |
| Adam Sawulski | CL03842SO-VIHA | 300000007910540 |
| Adam Sawulski | CL04097SO-2025 | 300000007910790 |
| Adam Sawulski | CL06735SM-2024 | 300000007906936 |
| Amy Maher | CL02849MC-2022 | 300000007879509 |
| Amy Maher | CL02974MC2-2022 | 300000007907536 |
| Bruce Nelson | CE06156ST | 300000007907512 |
| ChristyAnn Fratpietro | CL01855CA-2025 | 300000007910676 |
| ChristyAnn Fratpietro | CL02399CHC-2025 | 300000007909610 |
| ChristyAnn Fratpietro | CL02449CD-2024 | 300000007907783 |
| ChristyAnn Fratpietro | CL02450BB-2024 | 300000007906857 |
| ChristyAnn Fratpietro | CL02450BE-2024 | 300000007906502 |
| ChristyAnn Fratpietro | CL02451BE-2024 | 300000007906511 |
| ChristyAnn Fratpietro | CL02452BB-2024 | 300000007907791 |
| ChristyAnn Fratpietro | CL02452BE-2024 | 300000007907460 |
| ChristyAnn Fratpietro | CL02453BE-2024 | 300000007907467 |
| ChristyAnn Fratpietro | CL03289CA-DER | 300000007910597 |
| ChristyAnn Fratpietro | CL03522CA-2025 | 300000007911219 |
| ChristyAnn Fratpietro | CL03672CA-CAR | 300000007907805 |
| ChristyAnn Fratpietro | CL03675CA-CARD | 300000007907798 |
| ChristyAnn Fratpietro | CL03924CA-2023 | 300000007907161 |
| ChristyAnn Fratpietro | CL04301CA-CHC | 300000007902114 |
| ChristyAnn Fratpietro | CL04302CA-CHC | 300000007902121 |
| ChristyAnn Fratpietro | CL04302CA-DOM | 300000007879363 |
| ChristyAnn Fratpietro | CL04303CA-DOM | 300000007879379 |
| ChristyAnn Fratpietro | CL04303CO | 300000007881282 |
| ChristyAnn Fratpietro | CL04474CA-CHC | 300000007909689 |
| ChristyAnn Fratpietro | CL04475CA-CHC | 300000007881274 |
| ChristyAnn Fratpietro | CL04475CA-DOM | 300000007879371 |
| ChristyAnn Fratpietro | CL05331CA-CR | 300000007879886 |
| ChristyAnn Fratpietro | CL06164CA-2024 | 300000007908554 |
| Darren Bombardier | CL04443AR-2024 | 300000007908791 |
| Ian Pequegnat | CL03669ST-2023 | 300000007908234 |
| Ian Pequegnat | CL06413-2023M | 300000007907421 |
| Ian Pequegnat | CL06413CA-2023 | 300000007906432 |
| Ian Pequegnat | CL06414ST-2023 | 300000007909712 |
| Jack Krzyanowski | CL02282PI-2024 | 300000007907837 |
| Jack Krzyanowski | CL04259PR-2024 | 300000007909285 |
| NA NA | CL02670HE-2025 | 300000007911194 |
| Shelley Masyoluk | CL01627CA-2023 | 300000007906219 |
| Shelley Masyoluk | CL01630CA-2023 | 300000007902934 |
| Shelley Masyoluk | CL01635CA-2023 | 300000007906204 |
| Shelley Masyoluk | CL01649CA-2023 | 300000007907077 |
| Shelley Masyoluk | CL01651ME-2024 | 300000007906800 |
| Shelley Masyoluk | CL02237ME-2024 | 300000007907376 |
| Shelley Masyoluk | CL02282ML-2024 | 300000007907829 |
| Shelley Masyoluk | CL02344ML-2025 | 300000007910359 |
| Shelley Masyoluk | CL03622CA-2023 | 300000007907085 |
| Shelley Masyoluk | CL03632CA-2023 | 300000007907092 |
| Shelley Masyoluk | CL03635ML2-2025 | 300000007909778 |
| Shelley Masyoluk | CL03637ML2-2025 | 300000007910381 |
| Shelley Masyoluk | CL03667ML2-2025 | 300000007911118 |
| Shelley Masyoluk | CL03694CA-2023 | 300000007902905 |
| Shelley Masyoluk | CL03698CA-2023 | 300000007902941 |
| Shelley Masyoluk | CL03921ME-2023 | 300000007908058 |
| Shelley Masyoluk | CL04218ML2-2025 | 300000007911086 |
| Shelley Masyoluk | CL04438ME2-2025 | 300000007909547 |
| Shelley Masyoluk | CL06216CA-2023 | 300000007906127 |
| Shelley Masyoluk | CL06217CA-2023 | 300000007902891 |
| Shelley Masyoluk | CL06219CA-2023 | 300000007906165 |
| Shelley Masyoluk | CL06735M-2024 | 300000007906929 |

## Appendix B — contract numbers not found in Oracle (424)

Source: `doc/appendix-b-contracts-not-found.csv` (one `ContractNumber` per row). Also available as the `STATUS = CONTRACT NOT FOUND` rows of `LAST_BATCH_FILES-final-status-2026-05-11.csv` (which also shows the source folder path; 92 of these appear on more than one batch line). The full list is the CSV; it is not reproduced inline here.

## Appendix C — final per-line document-load status

`doc/LAST_BATCH_FILES-final-status-2026-05-11.csv` — one row per batch input line, columns `CONTRACT_NUMBER, PATH, CONTRACT_ID, STATUS, DOCS_LOADED, DETAIL`.

## Appendix D — PHSA CLMS Data Loader Guide

`doc/PHSA-CLMS-Data-Loader-Guide.md` — the per-script reference for the loader scripts introduced for this batch (see §1.5): what each script does, its platform/code dependencies, its inputs and outputs, the endpoints it uses to validate data, and any specific logic that applies. (Formerly `MAINTENANCE.md`.)

## Appendix E — party/contact insertion exceptions (step 9)

`doc/Supplier-Contacts-FAILED.csv` — the 107 contracts where step 9 (`InsertContacts`) could not fully add the parties' contacts (see §4.5 for the summary). Columns:

- `ContractNumber`, `ContractId`, `OracleInternalId`, `PrimaryPartyId`, `SupplierName`, `VendorContactName`, `VendorContactEmail` — identify the contract, the supplier party, and the vendor contact involved.
- `ISSUE` — one of `NO_PHSA_CONTACTS`, `VENDOR_CONTACT_ORPHANED`, `VENDOR_CONTACT_NOT_CREATED`, `SUPPLIER_PROFILE_LOCKED`.
- `ACTION_NEEDED` — the per-row remediation instruction.
- `ADMIN_RESULT`, `BUYER_RESULT`, `VENDOR_RESULT` — the per-role outcome: `ALREADY_EXISTS`, `NOT_IN_CROSSWALK`, `SKIP`, or `FAIL:<message>`.
- `DELETE_CONVERSION` — whether the migration `CONVERSION` placeholder contact was removed from the CUSTOMER party: `NONE_FOUND` (nothing to remove) or `FAIL:HTTP 400` (removal rejected).
