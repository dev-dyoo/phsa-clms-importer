# PHSA CLMS Data Loader — Guide

Hand-off documentation for whoever runs and maintains this loader next.
(Companion to the *CLMS Data Conversion Report — Final*, which reports the
results of the post-go-live batch this loader was built for.

This repo loads PHSA contract data into **Oracle Fusion Cloud — Enterprise
Contracts (CLMS)** via the Fusion REST API (and one SOAP/BI-Publisher call).
It is a batch-conversion toolkit — a standalone, plainly-readable rewrite of the
import logic that PHSA previously ran through an n8n workflow: each step is a
standalone script that reads a CSV (and/or Oracle), does one job, and writes
results + logs. **The leading numbers on the folders are just execution order —
they are not version numbers or semantic identifiers.** You generally run them
low-to-high; some are optional or rerun-only.

---

## 1. Platform & environment

| Thing | Detail |
|---|---|
| **Node scripts** (steps 1–9, 12, 13, `DeleteContractProperties`) | Node.js 18+ (uses the built-in global `fetch`). ESM (`"type": "module"`). Deps: `@iarna/toml`, `csv-parse`. Run `npm install` (or copy `node_modules/`). |
| **PowerShell scripts** (steps 10, 11) | Windows PowerShell 5.0+ (`#Requires -Version 5.0`). They walk a Windows network file share (`\\phsabc\root\...`) so they must run on a Windows host that can see the share. They use the shared `11-ImportContractDocuments/_common/OracleFusionCommon.psm1` module (settings, auth, retry, logging, CSV helpers), which is in the repo. |
| **Target system** | Oracle Fusion pod `iaequp.fa.ocs.oraclecloud.com` (PROD). Basic auth, user `CONVERSION`. REST base path `/fscmRestApi/resources/11.13.18.05`. |
| **Credentials** | Node scripts read repo-root `settings.toml` (`[server] baseUrl/username/password`, `[retry] max_retries`). PowerShell scripts read a per-folder `.settings` JSON (`BaseUrl/Username/Password/ApiPath/MaxRetries/RetryBaselineSeconds`). **Both real files are git-ignored.** Templates committed: `settings.example.toml`, `10-EnrichDocumentFilesList/.settings.example`, `11-ImportContractDocuments/.settings.example`. Copy a template, drop the password in. |
| **Runtime artifacts** | Every script writes a timestamped run log under `<step>/log/` (Node) or `<step>/logs/` (PowerShell), and result CSVs under `<step>/output/` (Node) or `<step>/logs/` (PowerShell). All of `**/log/`, `**/logs/`, `**/output/` are git-ignored. |

### Shared library (`lib/`, used by the Node scripts)

- `lib/client.js` — `createClient(log, {username,password}, {baseUrl, maxRetries})`. Basic-auth HTTP client over `fetch` with `GET/POST/PATCH/DELETE`. Exponential-backoff retry on network errors and retryable HTTP codes; **does not retry 400/401/403/404** (auth/permission failures abort immediately). Honours `Retry-After` on 429.
- `lib/logger.js` — `createLogger(baseLogDir, {prefix})`. Writes `<prefix>-<ts>-summary.log` / `-errors.log` / `-debug.log`, mirrors `info`/`error` to the console, and `summary()` prints a totals line.
- `lib/config.js` — fallback `loadConfig()` reading `config.toml`; the conversion scripts pass `baseUrl` explicitly so this is effectively unused. `lib/csv.js`, `lib/prompt.js` — small helpers, not used by the conversion scripts.

### Shared conventions in the Node scripts

- Input CSVs parsed with `csv-parse/sync` (`columns:true, bom:true, trim:true, relax_column_count:true`).
- `LAST_BATCH_LOAD.csv` (in `input/`) is the spine of the contract-load pipeline: steps 2–6 rewrite it in place (filling ID columns), step 7 fills `OracleContractId`, and steps 8/9/12 read it.
- `NULL` / empty strings are treated as blank.
- "Already done" rows are skipped on re-run (idempotency by checking the relevant ID column or querying Oracle), so steps can safely be re-run after partial failures.
- Steps that POST to PROD also write the input/output CSV periodically (every N rows / every batch) so a crash mid-run isn't a total loss.

---

## 2. The data files (`input/`)

| File | Used by | Shape |
|---|---|---|
| `input/LAST_BATCH_LOAD.csv` | steps 2–9, 12, `DeleteContractProperties` | The contract conversion sheet. After step 2 the leading columns are `OracleContractId, ContractTypeId, PrimaryPartyId, CONTRACT_TYPE, ... ContractNumber, Title, ContractDescription, ...` plus dozens of attribute columns. |
| `input/LAST_BATCH_PURGE.csv` | step 1 | `Source, ContractNumber` — contracts to delete. |
| `input/LAST_BATCH_FILES.csv` | step 10 (PowerShell) | `CONTRACT_NUMBER, PATH` — each contract's document folder on the network share. |

---

## 3. The scripts

### Step 1 — `1-DeleteContracts` (Node)
1. **What it does:** Looks up each contract in `LAST_BATCH_PURGE.csv` by `ContractNumber` and deletes it. Cleanup step for re-loading a batch.
2. **Deps:** Node, `lib/client`, `lib/logger`, `settings.toml`. Concurrency 5.
3. **In/out:** In `input/LAST_BATCH_PURGE.csv` (`Source, ContractNumber`). Out `1-DeleteContracts/output/delete-contracts-<ts>.csv` (`Source, ContractNumber, ContractId, RESULT, ERROR, DUPLICATE`) + run log.
4. **Validation endpoints:** `GET /contracts?q=ContractNumber=<n>&fields=ContractId&onlyData=true&totalResults=true` to resolve the ContractId(s) before deleting; a startup `GET /contracts?limit=1` sanity check.
5. **Specific logic:** A ContractNumber resolving to >1 ContractId is flagged `DUPLICATE` and all matches are deleted. Delete = `DELETE /contracts/<ContractId>`.

### Step 2 — `2-TransformHeadings` (Node — offline, no API)
1. **What it does:** Reshapes `LAST_BATCH_LOAD.csv` headers to the canonical "batch-3" format and rewrites the file in place.
2. **Deps:** Node, `csv-parse` only. No Oracle, no settings.
3. **In/out:** In/out are the **same file** `input/LAST_BATCH_LOAD.csv` (overwritten).
4. **Validation endpoints:** none.
5. **Specific logic:** Prepends 4 columns `OracleContractId, ContractTypeId, PrimaryPartyId, CONTRACT_TYPE` (the first three blank, ready to be filled by steps 5/6/7); moves the source `CONTRACT_TYPE` value into the 4th column; renames `VendorMasterDescrip_REFERENCE2 → "master vendor descrip"`, `DistributorMasterDescrip_REFERENCE → "master vendor distributor desc"`, `Distributor_VendorMasterID → Distributor_VendorMasterId`; strips non-breaking spaces from header names; trims all cell values.

### Step 3 — `3-TransformValues` (Node)
1. **What it does:** Normalizes a handful of coded columns in `LAST_BATCH_LOAD.csv` so their values match Oracle's accepted lookup/valueSet codes; rewrites the file in place; reports any value that still isn't a known code.
2. **Deps:** Node, `lib/client` (the live API-fetch path is currently commented out — it ships with a built-in list of valid codes; uncomment to re-fetch), `lib/logger`, `settings.toml`. (The `@iarna/toml` / client imports are commented in the current build.)
3. **In/out:** In/out `input/LAST_BATCH_LOAD.csv` (overwritten). Out also `3-TransformValues/output/transform-values-<ts>.csv` — rows whose normalized value isn't a recognized code.
4. **Validation endpoints (when the fetch path is enabled):** `GET /fscmRestApi/.../valueSets/<code>/child/values?fields=Value` and `GET /fscmRestApi/.../standardLookups/<code>/child/lookupCodes?fields=LookupCode&q=...`.
5. **Specific logic:** Columns handled — `CMTeam` (valueSet `PHSA_CM_TEAMS`), `ExpiryStrategy` (lookup `PHSA_EXPIRY_STRATEGY`), `InitialProcurementStrategy` (`PHSA_INITIAL_PRC_STRATEGY`), `OptionYearsAvailable` (`PHSA_OPTION_YEARS_AVAILABLE`), `ContractTypeName` (`PHSA_WB_CONTRACT_TYPE`). Normalization, in order: drop everything from the first `(` onward; trim; collapse runs of 2+ spaces to one; replace each space/`/`/`-` with `_`.

### Step 4 — `4-ValidateValues` (Node — reporting only, writes nothing to Oracle)
1. **What it does:** Builds a comparison report of the coded-column values in `LAST_BATCH_LOAD.csv` (and, if present, the PROD batch CSVs) against the live valid codes from Oracle, so you can eyeball mismatches before loading.
2. **Deps:** Node, `lib/client`, `lib/logger`, `settings.toml`. Optionally reads `metadata/PROD-contracts-suppliers-batch-{1,2,3}.csv` if those exist (they're not in the repo by default; missing → skipped).
3. **In/out:** In `input/LAST_BATCH_LOAD.csv` (+ optional `metadata/...`). Out `doc/column-value-comparison.csv` and `doc/column-value-comparison.md` (invalid LAST_BATCH values shown ~~struck through~~ in the markdown) + run log.
4. **Validation endpoints:** `GET .../valueSets/<code>/child/values` and `GET .../standardLookups/<code>/child/lookupCodes` — same five fields as step 3 (`PHSA_CM_TEAMS`, `PHSA_EXPIRY_STRATEGY`, `PHSA_INITIAL_PRC_STRATEGY`, `PHSA_OPTION_YEARS_AVAILABLE`, `PHSA_WB_CONTRACT_TYPE`).
5. **Specific logic:** A field whose code-fetch fails is logged and treated as "no valid codes" (so everything for it shows as unmatched) rather than aborting the run. `RebateOrValueAdd / RebateFrequencyName / RebateDescription / AgencyOrDepartment` are intentionally excluded.

### Step 5 — `5-FillContractTypeId` (Node)
1. **What it does:** Maps each row's `CONTRACT_TYPE` text to an Oracle `ContractTypeId` and writes it into the `ContractTypeId` column of `LAST_BATCH_LOAD.csv` (in place); reports unmatched rows.
2. **Deps:** Node, `lib/client`, `lib/logger`, `settings.toml`.
3. **In/out:** In/out `input/LAST_BATCH_LOAD.csv` (overwritten). Out also `5-FillContractTypeId/output/fill-contract-type-id-<ts>.csv` — rows with no match.
4. **Validation endpoints:** `GET /fscmRestApi/.../contracts/300000006409761/lov/ContractTypeAllVA?fields=ContractTypeId,Name&onlyData=true&limit=500` — the contract-type list of values.
5. **Specific logic:** Match is case-insensitive: first an exact match on `Name`, then a fallback where the first 15 characters of both strings match. (`300000006409761` is a fixed reference contract used purely to reach the LOV resource.)

### Step 6 — `6-FillPrimaryPartyId` (Node)
1. **What it does:** Pages every Oracle supplier, builds a `VendorMasterId → SupplierPartyId` table, and writes each row's `PrimaryPartyId` (resolved from the row's `VendorMasterId`) into `LAST_BATCH_LOAD.csv` in place. Also emits the full supplier reference (used later by step 7) and an unmatched-rows list.
2. **Deps:** Node, `lib/client`, `lib/logger`, `settings.toml`.
3. **In/out:** In/out `input/LAST_BATCH_LOAD.csv` (overwritten). Out also `6-FillPrimaryPartyId/output/fill-primary-party-id-<ts>-reference.csv` (full supplier map — **step 7 reads the newest of these**) and `...-unmatched.csv` (rows with no supplier match).
4. **Validation endpoints:** `GET /fscmRestApi/.../suppliers?fields=SupplierId,SupplierPartyId,Supplier,DFF&expand=all&onlyData=true&totalResults=true&limit=500` (paginated through all suppliers).
5. **Specific logic:** The `VendorMasterId` it matches on comes from the supplier DFF (descriptive flexfield) attributes — that's why it requests `&expand=all` and reads `DFF`.

### Step 7 — `7-InsertContract` (Node) — **writes to PROD**
1. **What it does:** POSTs one `/contracts` record per row in `LAST_BATCH_LOAD.csv`, writes the returned `ContractId` back into the row's `OracleContractId` column (intermediate save every 10 rows), and lists failures. Skips rows that already have an `OracleContractId`, so it's safely re-runnable.
2. **Deps:** Node, `lib/client`, `lib/logger`, `settings.toml`. **Prereqs: steps 3, 5, 6 must have run.** Reads the newest `6-FillPrimaryPartyId/output/*-reference.csv`.
3. **In/out:** In/out `input/LAST_BATCH_LOAD.csv` (overwritten with `OracleContractId` filled). Out also `7-InsertContract/output/insert-contract-<ts>-failed.csv` (rows that failed) + run log.
4. **Validation endpoints:** `GET /fscmRestApi/.../suppliers?fields=SupplierId,SupplierPartyId&...` (paginated) to build a `SupplierPartyId → SupplierId` map; composed with the step-6 reference CSV (`VendorMasterId → SupplierPartyId`) this yields `VendorMasterId → SupplierId` so the distributor supplier on the contract can be resolved. (The contract POST itself isn't pre-validated — Oracle validates on insert.)
5. **Specific logic:** Skips a row with a `SKIP` result if `PrimaryPartyId` or `ContractTypeId` is blank. Builds the payload from a fixed base (`BuyOrSell:"B"`, `AuthoringPartyCode:"INTERNAL"`, `AccessLevel:"UPDATE"`, `OrgId:300000004527105`, `LegalEntityId:300000004643005`, `PHSACustomValidationCompleted_c:true`, etc.) plus the row's mapped attributes; description is the concatenation of `ContractDescription / ContractCommentTitle / LatestComment`; non-ASCII punctuation is transliterated; `M/D/Y` dates are normalized to `YYYY-MM-DD`; category names are upper-cased and word-joined with `_`. New contracts are created in **DRAFT** status.

### Step 8 — `8-InsertContractProperties` (Node) — **writes to PROD**
1. **What it does:** Creates the `ContractProperties_c` extensible-flexfield record for each loaded contract. Concurrency 10.
2. **Deps:** Node, `lib/client`, `lib/logger`, `settings.toml`. **Prereq: step 7 must have run** (rows need `OracleContractId`).
3. **In/out:** In `input/LAST_BATCH_LOAD.csv` (rows with a non-blank `OracleContractId`). Out `8-InsertContractProperties/output/insert-contract-properties-<ts>.csv` (per-row results) + run log.
4. **Validation endpoints:** `GET /fscmRestApi/.../contracts?fields=Id,ContractId,ContractNumber,MajorVersion&...` (paginated — resolves the internal Oracle `Id`/version); `GET /fscmRestApi/.../ContractProperties_c?fields=Id,ObjectId_c&...` (paginated — to skip contracts that already have a properties record).
5. **Specific logic:** If a properties record already exists for the contract it `PATCH`es it instead of `POST`ing a new one. Fields populated: `RecordName, ObjectId_c, MajorVersion_c, SourcingTrackerID_c, ParticipatingHA_c, Text02_c, Number06_c–Number14_c, PDText01_c–PDText03_c, Text11_c–Text13_c, Text18_c, Date01_c`.

### Step 9 — `9-InsertContacts` (Node) — **writes to PROD**
1. **What it does:** Adds the `CONTRACT_ADMIN`, `BUYER`, and `VENDOR_CONTACT` parties to each loaded contract, then deletes the leftover `CONVERSION` contact from the contract's CUSTOMER party. Concurrency 10.
2. **Deps:** Node, `lib/client`, `lib/logger`, `settings.toml`. **Prereq: step 7 must have run.**
3. **In/out:** In `input/LAST_BATCH_LOAD.csv` (rows with `OracleContractId`). Out `9-InsertContacts/output/insert-contacts-<ts>.csv` (per-row results) + run log.
4. **Validation endpoints:**
   - SOAP/BI-Publisher: `POST /xmlpserver/services/ExternalReportWSSService` running report `/Custom/PHSA/Suppliers/Interfaces/PARTY_CONTACT_ID_CROSSWALK.xdo` (`Content-Type: application/soap+xml`) — the response is base64 in `<ns2:reportBytes>`; decoded it's a CSV giving the **email → Oracle ContactId** crosswalk.
   - `GET /fscmRestApi/.../contracts?fields=ContractId,ContractNumber&...` (paginated — ContractNumber → ContractId).
   - `GET /fscmRestApi/.../contractVContacts?q=PartyId=<primaryPartyId>&fields=ContactId,PartyId,ContactName,EmailAddress` — existing vendor contacts for the supplier party.
   - `GET /fscmRestApi/.../suppliers?q=SupplierPartyId=<primaryPartyId>&fields=SupplierId,SupplierPartyId` — to add a new supplier contact via `POST /suppliers/<SupplierId>/child/contacts` when the vendor contact doesn't already exist.
   - `GET /fscmRestApi/.../contracts/<ContractId>/child/ContractParty?expand=all` then `.../child/ContractPartyContact` — to locate and delete the `CONVERSION` contact on the CUSTOMER party.
5. **Specific logic:** Internal contacts (admin/buyer) are matched to ContactIds via the SOAP crosswalk by email; vendor contacts are matched against `contractVContacts` and created on the supplier if missing. Per-row result records the outcome of each of the three contact types plus the CONVERSION cleanup.

### `9-InsertContacts/retry-and-report.js` (Node — one-off helper) — **writes to PROD**
1. **What it does:** Re-attempts a small set of vendor-contact rows that previously failed with a transient "supplier locked / lock collision" error (5-second delay between each), then writes a combined failure report enriched with Oracle contract data.
2. **Deps:** Node, `lib/client`, `lib/logger`, `settings.toml`. Reads step 9's previous output CSV(s).
3. **In/out:** In `input/LAST_BATCH_LOAD.csv` + step 9 outputs. Out a manual-handling report CSV under `9-InsertContacts/output/` + run log.
4. **Validation endpoints:** same family as step 9 (`contracts`, `contractVContacts`, `suppliers`, plus the SOAP crosswalk).
5. **Specific logic:** Skips reasons that won't fix themselves on retry (e.g. *"This supplier profile is locked for editing as a profile change request is pending approval"*) and routes those to the manual-handling report instead.

### Step 10 — `10-EnrichDocumentFilesList` (PowerShell) — *runs against PROD (read-only) + the file share*
1. **What it does:** Turns the per-contract folder list (`input/LAST_BATCH_FILES.csv`, "F1") into a per-document load list ("F2", `logs/ContractDocumentLoadList-<ts>.csv`) for step 11: resolves each contract's Oracle ContractId, then walks each contract folder and emits one row per document file found.
2. **Deps:** Windows PowerShell 5.0+, the `_common/OracleFusionCommon.psm1` module (in the repo, under step 11), `<step>/.settings`, and read access to the contract folders on the `\\phsabc\root\...` share.
3. **In/out:** In `input/last_batch_files.csv` (`ContractNumber`, `Path`). Out `10-EnrichDocumentFilesList/logs/ContractDocumentLoadList-<yyyyMMdd-HHmmss>.csv` with columns `ID, ContractNumber, DocType, ContractId, Title, FileName, FullPath, Done, Error, ErrorDescription` + a run log. (Only `ContractNumber` is carried over from F1.)
4. **Validation endpoints:** `GET {ApiPath}?q=ContractNumber=<number>` (i.e. `.../contracts?q=...`) — 0 results ⇒ row marked `Error="True", ErrorDescription="404 Contract not found."`; a >1 match is logged and the first is used; HTTP/network error ⇒ remembered as a lookup error.
5. **Specific logic — folder→DocType mapping:** `<Path>\ContractDoc\*` ⇒ `DocType="ContractDoc"`; `<Path>\SupportingDoc\*` ⇒ `DocType="Excel"` if the file matches `*.xls*` else `"SupportingDoc"`. Fallback when neither sub-folder yields anything: top-level files named `PO*`/`SOW*` (case-insensitive) ⇒ `DocType="ContractDoc"`. New file rows get `Done="READY"`, `Error="False"`. A missing ContractNumber/Path, a non-existent Path, a path with no matching docs, or a lookup failure each produce a single row with `Error="True"` and a description (no file, `Done` blank). `Title`/`FileName` are whitespace-trimmed and transliterated to ASCII (extension preserved).

### Step 11 — `11-ImportContractDocuments` (PowerShell) — **writes to PROD**
1. **What it does:** Uploads the document files listed in the step-10 F2 CSV into their contracts in Oracle. Idempotent and resumable via the `Done` column. 5 parallel workers (RunspacePool).
2. **Deps:** Windows PowerShell 5.0+, `_common/OracleFusionCommon.psm1` (in the repo), `<step>/.settings`, and read access to the document files on the share (it reads the bytes and base64-encodes them).
3. **In/out:** In a `ContractDocumentLoadList-<ts>.csv` (the step-10 output, or a prior step-11 output to retry failures). Out an updated copy of that CSV under `11-ImportContractDocuments/logs/` with `Done/Error/ErrorDescription` refreshed, plus a lightweight progress CSV appended after every result, plus a run log.
4. **Validation endpoints:** startup `GET .../contracts?limit=1` sanity check; **existence check** (default on) `GET .../contracts/<ContractId>/child/ContractDocuments` and `.../child/SupportingDocuments` (paginated, `limit=200`) to build a case-insensitive set of already-present filenames per contract — rows whose `FileName` is already there are marked `Done="TRUE"` with `ErrorDescription="Already exists in Oracle (UploadedFileName matched)"` and **not** uploaded. (Note: `?fields=UploadedFileName` returns null on these resources, so the full item is fetched.)
5. **Specific logic — row selection by `Done`:** `TRUE` ⇒ skip; `READY` ⇒ upload (never attempted); `FALSE` ⇒ retry (failed before); blank/other ⇒ not a real file row, skip. `Error`/`ErrorDescription` are informational only and do **not** drive selection. **Upload:** `POST .../contracts/<ContractId>/child/<ContractDocuments|SupportingDocuments>` with `DatatypeCode, Title, UploadedFileContentType, UploadedFileName, FileContents (base64), Description, FileName, CategoryName`. `DocType` → child resource (`ContractDoc`→`ContractDocuments`, else `SupportingDocuments`) and `CategoryName` (`ContractDoc`→`OKC_DOCUMENTS_CONTRACT`, `SupportingDoc`→`OKC_DOCUMENTS_SUPPORTING_DOC`, `Excel`→`PHSA_ITEM_SPREADSHEETS`). `Title` is truncated to ≤80 chars (extension kept) because Oracle's Title is length-limited; `FileName`/`UploadedFileName` go at full length. On success `Done="TRUE"`; on failure `Done="FALSE"` (re-attempted next run).

### Step 12 — `12-SubmitContractsForApproval` (Node) — **writes to PROD**
1. **What it does:** Submits each loaded draft contract into Oracle's BPM approval workflow. Concurrency 5; output CSV re-saved after every batch.
2. **Deps:** Node, `lib/client`, `lib/logger`, `settings.toml`. Reads `input/LAST_BATCH_LOAD.csv` by default (a different CSV can be passed as the first CLI argument). `DRY_RUN=1` env var logs the POSTs without sending.
3. **In/out:** In `input/LAST_BATCH_LOAD.csv` — every distinct row with a non-blank `OracleContractId`. Out `12-SubmitContractsForApproval/output/submit-for-approval-<ts>.csv` (`ContractNumber, OracleContractId, Submitted, SubmitResult`; `Submitted=TRUE` on a clean submit) + run log. **Step 13 consumes this CSV.**
4. **Validation endpoints:** `GET /fscmRestApi/.../contracts?q=ContractNumber='<n>'&fields=ContractId&onlyData=true` — **fallback only**, used to resolve `OracleContractId` for rows that have a `ContractNumber` but no id. (No other validation; Oracle validates the submit.)
5. **Specific logic:** `POST /fscmRestApi/.../contracts/<ContractId>/action/submitForApproval` with `Content-Type: application/vnd.oracle.adf.action+json` (the ADF custom-action media type — **not** `application/json`) and **no request body**. An optional `Submitted`/`Done` truthy column in the input skips that contract. **Submission is asynchronous — Oracle's BPM workflow takes time to clear; wait before running step 13.**

### Step 13 — `13-ActivateContracts` (Node) — **writes to PROD**
1. **What it does:** Signs the contracts that step 12 successfully submitted; once a contract is approved and signed, Oracle moves it to `ACTIVE`. (There is no separate "activate" call — signing is the last step.) Concurrency 5; output CSV re-saved after every batch.
2. **Deps:** Node, `lib/client`, `lib/logger`, `settings.toml`. By default reads the **newest** `12-SubmitContractsForApproval/output/submit-for-approval-*.csv` (a different CSV can be passed as the first CLI argument). `DRY_RUN=1` env var logs the POSTs without sending.
3. **In/out:** In step 12's output CSV (or any CSV with an `OracleContractId`/`ContractId` column). Out `13-ActivateContracts/output/activate-<ts>.csv` (`ContractNumber, OracleContractId, Activated, SignResult`; `Activated=TRUE` on a clean sign) + run log. Re-feed this CSV to retry just the failures.
4. **Validation endpoints:** none — it relies on step 12's `SubmitResult` column.
5. **Specific logic:** Signs only rows whose `SubmitResult` ≈ `OK` (or whose `Submitted` column is truthy); if the input has no `SubmitResult` column it signs every row with an id; an optional `Signed`/`Activated`/`Done` truthy column skips already-done rows. `POST /fscmRestApi/.../contracts/<ContractId>/action/sign` with `Content-Type: application/vnd.oracle.adf.action+json` and **no body**. **Run this only after step 12's approvals have had time to clear.**

### `DeleteContractProperties` (Node — utility, not numbered) — **writes to PROD**
1. **What it does:** For each `ContractNumber` in `LAST_BATCH_LOAD.csv`, finds all `ContractProperties_c` records for it, dumps them, then deletes them. Cleanup counterpart to step 8. Concurrency 10.
2. **Deps:** Node, `lib/client`, `lib/logger`, `settings.toml`.
3. **In/out:** In `input/LAST_BATCH_LOAD.csv` (ContractNumber column). Out `DeleteContractProperties/output/delete-contract-properties-<ts>-found.csv` and `...-deleted.csv` + run log.
4. **Validation endpoints:** `GET /fscmRestApi/.../ContractProperties_c?q=ContractNumber_c=<n>&fields=Id,ContractNumber_c,ObjectId_c,RecordName,MajorVersion_c,CreationDate&...` (paginated) to find the records to delete.
5. **Specific logic:** Delete = `DELETE /ContractProperties_c/<Id>`.

---

## 4. Typical run order

For a fresh batch load:

```
1-DeleteContracts            (only if re-loading numbers that already exist)
2-TransformHeadings          (reshape LAST_BATCH_LOAD.csv)
3-TransformValues            (normalize coded columns)
4-ValidateValues             (eyeball the comparison report — optional but recommended)
5-FillContractTypeId
6-FillPrimaryPartyId
7-InsertContract             ← creates the contracts (DRAFT)
8-InsertContractProperties
9-InsertContacts             (then 9-InsertContacts/retry-and-report.js for stragglers)
10-EnrichDocumentFilesList   (build the document load list — PowerShell, on Windows)
11-ImportContractDocuments   (upload the documents — PowerShell)
12-SubmitContractsForApproval ← submit drafts for approval; then WAIT for BPM
13-ActivateContracts         ← sign the approved contracts → ACTIVE
```

`DeleteContractProperties` is the cleanup partner for step 8 (and `1-DeleteContracts` for step 7) when a batch needs to be rolled back and reloaded.

All Node steps re-run safely (they skip rows already done). Step 11 re-runs safely via its `Done` column.

---

## 5. Gotchas / things to know

- **`settings.toml` and `.settings` are not in git** — a fresh checkout has no credentials; copy a `*.example` template and fill in the password before running anything.
- **The PowerShell steps (10, 11) load `11-ImportContractDocuments/_common/OracleFusionCommon.psm1`** — the shared module with settings, auth, retry, logging and CSV helpers. It's in the repo; keep the two scripts and that folder together.
- **Steps 10/11 walk a Windows network share** (`\\phsabc\root\HSSBC\SupplyChainAutomation\...`) — they only work from a host that can see it.
- **The two action steps (12, 13) use `Content-Type: application/vnd.oracle.adf.action+json` with no body.** Plain `application/json` will not work for `submitForApproval` / `sign`.
- **`401`/`403` aborts the client's retries immediately** — if you see those, it's almost always a bad/expired password in `settings.toml` / `.settings`.
- **Step 12 → step 13 is not instantaneous:** step 12 only *submits* for approval; Oracle's BPM workflow runs asynchronously. Confirm approvals have cleared before running step 13.
- **Run artifacts (`log/`, `logs/`, `output/`) are git-ignored** and contain PROD contract data — don't commit them.
- The `metadata/` directory referenced by step 4 is optional and not in the repo; step 4 just skips the PROD-batch comparison if it's absent.
- More REST endpoint detail (parameters, payload shapes) lives in `doc/API-ENDPOINTS.md`.
