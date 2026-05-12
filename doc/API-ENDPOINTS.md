# API Endpoints

Every Oracle endpoint touched by the scripts in this repo, inventoried from the code.
Regenerate this file whenever the scripts change.

## Connection

- **Host:** `iaequp.fa.ocs.oraclecloud.com` (PROD), from `settings.toml` `[server] baseUrl` (Node scripts) / `.settings` `BaseUrl` (PowerShell scripts).
- **REST base path:** `/fscmRestApi/resources/11.13.18.05`
- **Auth:** HTTP Basic — `Authorization: Basic base64(username:password)`. User `CONVERSION`.
- **Default headers (Node `lib/client.js`):** `Content-Type: application/json`, `Accept: application/json` (overridden where noted).
- **Retry:** exponential backoff on network errors and retryable HTTP codes; **400/401/403/404 are never retried** (auth/permission errors abort immediately). Honours `Retry-After` on 429.
- **Common query params:** `onlyData=true` (strip links/metadata), `totalResults=true` (include `totalResults` count), `limit=N` + `offset=N` (pagination — scripts page in 500s, except the document-existence check in step 11 which uses 200), `q=<expr>` (filter), `fields=<csv>` (projection), `expand=all|<child>`.

---

## REST — `/contracts`

### `GET /contracts?q=ContractNumber=<n>&fields=ContractId&onlyData=true[&totalResults=true]`
Resolve a `ContractNumber` to its Fusion `ContractId`. 0 results = not found; >1 = ambiguous (the scripts flag this).
**Used by:** `1-DeleteContracts` (before delete), `12-SubmitContractsForApproval` (fallback when a row has no `OracleContractId`), `10-EnrichDocumentFilesList` (PowerShell, "pass 1 — resolve contracts").

### `GET /contracts?limit=1&onlyData=true`
Startup sanity check (any 2xx = API reachable / creds OK).
**Used by:** `1-DeleteContracts`, `11-ImportContractDocuments` (PowerShell), `12-SubmitContractsForApproval/run.ps1` (reference PowerShell).

### `GET /contracts?fields=ContractId,ContractNumber&onlyData=true&totalResults=true&limit=500&offset=N`  *(paginated)*
Pull every contract to build a `ContractNumber → ContractId` map.
**Used by:** `9-InsertContacts`, `9-InsertContacts/retry-and-report.js` (these add `Id`), `8-InsertContractProperties` (variant: `fields=Id,ContractId,ContractNumber,MajorVersion` — also needs the internal `Id`/version).

### `GET /contracts/{ContractId}?expand=all`  *(or `expand=ContractHeaderFlexfieldVA`)*
Full contract resource, including child collections `ContractParty`, `ContractHeaderFlexfieldVA` (PHSA header DFF: `contractExecutionApproved`, `phsaCMTeam`, `phsaDistributor1`, `phsaCategory1/2/3`, …), `ContractDocuments`, `SupportingDocuments`, `ContractStatusHistory`, `ContractApprovalHistory`, etc. Key scalar fields: `StsCode` (`DRAFT` / `PENDING_APPROVAL` / `APPROVED` / `PENDING_SIGNATURE` / `SIGNED` / `ACTIVE` / `EXPIRED` / …), `StateTransitionFlowState`, `Status`, `SubmitRenderedFlag`, `SignContractRenderedFlag`, `ValidateContractRenderedFlag`, `DateApproved`, `DateSigned`.
**Used by:** ad-hoc diagnostics (status checks, reading the header flexfield). Not a pipeline step on its own.

### `POST /contracts`  *(body = contract payload)*
Create a contract (in `DRAFT`). Response carries `ContractId`.
Payload: a fixed base —
```json
{ "EnableElectronicSignFlag": false, "TemplateFlag": false, "BuyOrSell": "B",
  "AuthoringPartyCode": "INTERNAL", "PHSACustomValidationCompleted_c": true,
  "AccessLevel": "UPDATE", "OrgId": 300000004527105, "LegalEntityId": 300000004643005 }
```
— plus the row's mapped attributes (`ContractNumber`, `ContractTypeId`, `PrimaryPartyId`, `Cognomen`/title, `StartDate`/`EndDate`, currency, distributor `SupplierId`, etc.), `Description` (concatenation of `ContractDescription` / `ContractCommentTitle` / `LatestComment`, ASCII-transliterated), and `ContractHeaderFlexfieldVA: [ { … phsaCMTeam, contractExecutionApproved:"PHSA", phsaCategory1/2/3 … } ]`. Dates are sent as `YYYY-MM-DD`.
**Used by:** `7-InsertContract`.

### `DELETE /contracts/{ContractId}`
**Used by:** `1-DeleteContracts`.

### `GET /contracts/{ContractId}/child/ContractParty?expand=all`
The contract's parties; each item has `PartyRoleCode` (`CUSTOMER` / `SUPPLIER`), a `self` link `href`, and a nested `ContractPartyContact[]` (each with `ContactRoleCode` — `CONTRACT_ADMIN` / `BUYER` / `VENDOR_CONTACT` — `PartyContactName`, and a `self` link).
**Used by:** `9-InsertContacts`, `9-InsertContacts/retry-and-report.js` — to find the CUSTOMER/SUPPLIER party hrefs, see which contact roles already exist, and locate the leftover `CONVERSION` contact.

### `POST {ContractPartyHref}/child/ContractPartyContact`  *(body = contact payload)*
Add a contact (admin/buyer to the CUSTOMER party, vendor contact to the SUPPLIER party). The path is derived from the `ContractParty` self-link href (host stripped) + `/child/ContractPartyContact`. Body carries `ContactRoleCode` and the resolved `ContactId` (internal contacts come from the SOAP crosswalk; vendor contacts from `contractVContacts` / created on the supplier).
**Used by:** `9-InsertContacts`, `9-InsertContacts/retry-and-report.js`.

### `DELETE {ContractPartyContactHref}`
Remove the migration `CONVERSION` contact from the CUSTOMER party.
**Used by:** `9-InsertContacts`.

### `GET /contracts/{ContractId}/child/ContractDocuments?fields=…&limit=200&offset=N`  *(paginated)*
Existing contract documents. **Note:** `?fields=UploadedFileName` returns `null` on this child resource — the full item must be fetched; `UploadedFileName` / `FileName` are populated there. `CategoryName` values seen: `OKC_DOCUMENTS_CONTRACT`, `OKC_DOCUMENTS_PCD`.
**Used by:** `11-ImportContractDocuments` (PowerShell — existence check, skip already-uploaded files).

### `GET /contracts/{ContractId}/child/SupportingDocuments?…&limit=200&offset=N`  *(paginated)*
Peer collection to `ContractDocuments` (not nested under it — fetch separately). `CategoryName` values: `OKC_DOCUMENTS_SUPPORTING_DOC`, `PHSA_ITEM_SPREADSHEETS`.
**Used by:** `11-ImportContractDocuments` (PowerShell).

### `POST /contracts/{ContractId}/child/ContractDocuments`  *(body = document payload)*
### `POST /contracts/{ContractId}/child/SupportingDocuments`  *(same shape)*
Upload a file to a contract. Body:
```json
{ "DatatypeCode": "FILE", "Title": "<file name, ≤80 chars, extension kept>",
  "UploadedFileContentType": "<MIME type>", "UploadedFileName": "<full file name>",
  "FileContents": "<base64 of the file bytes>", "Description": "...",
  "FileName": "<full file name>", "CategoryName": "<see below>" }
```
Resource & `CategoryName` are chosen from the load-list `DocType`: `ContractDoc` → `ContractDocuments` + `OKC_DOCUMENTS_CONTRACT`; `SupportingDoc` → `SupportingDocuments` + `OKC_DOCUMENTS_SUPPORTING_DOC`; `Excel` → `SupportingDocuments` + `PHSA_ITEM_SPREADSHEETS`.
**Used by:** `11-ImportContractDocuments` (PowerShell).

### `POST /contracts/{ContractId}/action/submitForApproval`
Submit a draft contract into the BPM approval workflow. **`Content-Type: application/vnd.oracle.adf.action+json`** (the ADF custom-action media type — **not** `application/json`); **no request body**. Returns 200 on accept; the contract may still fail validation and stay in `DRAFT` (see `validateContract`). Failures seen: `OKC-196129` (contract not in a state from which SUBMIT is valid — e.g. `PENDING_ACCEPTANCE`, `EXPIRED`).
**Used by:** `12-SubmitContractsForApproval`.

### `POST /contracts/{ContractId}/action/sign`
Sign an approved contract (final transition → `ACTIVE`). **`Content-Type: application/vnd.oracle.adf.action+json`**; **no body**. Failures seen: `OKC-196583` (contract not in `PENDING_SIGNATURE` status), `OKC-196434` (operation not allowed on this contract type).
**Used by:** `13-ActivateContracts`.

### `POST /contracts/{ContractId}/action/validateContract`
Run contract validation without changing state. **`Content-Type: application/vnd.oracle.adf.action+json`**; **no body**. Returns `{ "result": { "Errors": [ { "MessageName": "...", "MessageText": "...", "ObjectName": "...", ... } ], "Warnings": [...] } }`. Useful for diagnosing why `submitForApproval` succeeds (200) but the contract won't leave `DRAFT` (e.g. `OKC_VAL_INACTIVE_SUPPLIER_CONT` — "The supplier contact … is inactive").
**Used by:** diagnostics (not a pipeline step).

### `GET /contracts/300000006409761/lov/ContractTypeAllVA?fields=ContractTypeId,Name&onlyData=true&limit=500`
The contract-type list of values (`ContractTypeId` ↔ `Name`). `300000006409761` is a fixed reference contract id used only to reach the LOV resource.
**Used by:** `5-FillContractTypeId`.

---

## REST — `/suppliers`

### `GET /suppliers?fields=SupplierId,SupplierPartyId,Supplier,DFF&expand=all&onlyData=true&totalResults=true&limit=500&offset=N`  *(paginated)*
Every supplier, with the descriptive flexfield (`DFF`) — the `VendorMasterId` lives there. Used to build a `VendorMasterId → SupplierPartyId` table.
**Used by:** `6-FillPrimaryPartyId`.

### `GET /suppliers?fields=SupplierId,SupplierPartyId&onlyData=true&totalResults=true&limit=500&offset=N`  *(paginated)*
`SupplierPartyId → SupplierId` map (composed with step 6's reference CSV → `VendorMasterId → SupplierId` for the distributor on the contract).
**Used by:** `7-InsertContract`.

### `GET /suppliers?q=SupplierPartyId=<id>&fields=SupplierId,SupplierPartyId&onlyData=true`
Resolve one supplier's `SupplierId` from its party id.
**Used by:** `9-InsertContacts`, `9-InsertContacts/retry-and-report.js`.

### `POST /suppliers/{SupplierId}/child/contacts`  *(body = supplier-contact payload)*
Create a supplier contact when the needed vendor contact doesn't already exist. Body:
```json
{ "FirstName": "...", "LastName": "...", "AdministrativeContactFlag": true,
  "PhoneNumber": "...", "Email": "..." }
```
**Used by:** `9-InsertContacts`, `9-InsertContacts/retry-and-report.js`.

---

## REST — `/contractVContacts`

### `GET /contractVContacts?onlyData=true&fields=ContactId,PartyId,ContactName,EmailAddress&q=PartyId=<primaryPartyId>`
Existing vendor contacts for a supplier party — used to find an existing `ContactId` before creating a new supplier contact.
**Used by:** `9-InsertContacts`, `9-InsertContacts/retry-and-report.js`.

---

## REST — `/ContractProperties_c`  *(PHSA custom EFF object; auto-created by Oracle when a contract is created)*

### `GET /ContractProperties_c?fields=Id,ObjectId_c&onlyData=true&totalResults=true&limit=500&offset=N`  *(paginated)*
All properties records → `ObjectId_c` (= the contract's internal `Id`) → record `Id`. Used to decide POST-new vs PATCH-existing.
**Used by:** `8-InsertContractProperties`.

### `GET /ContractProperties_c?q=ContractNumber_c=<n>&fields=Id,ContractNumber_c,ObjectId_c,RecordName,MajorVersion_c,CreationDate&onlyData=true&limit=500&offset=N`
Properties records for a given contract number — used to find what to delete.
**Used by:** `DeleteContractProperties`.

### `POST /ContractProperties_c`  *(body = properties payload)*
### `PATCH /ContractProperties_c/{Id}`  *(same body — used when a record already exists)*
Body: `RecordName` (= ContractNumber), `ObjectId_c` (= contract internal Id), `MajorVersion_c`, `SourcingTrackerID_c`, `ParticipatingHA_c`, `Text02_c`, `Number06_c`–`Number14_c` (the per-health-org estimated annual spends + total), `PDText01_c` (JSON array of `ContractTypeName`), `PDText02_c` (`InitialProcurementStrategy`), `PDText03_c` (`ExpiryStrategy`), `Text11_c`/`Text12_c`/`Text13_c` (rebate fields), `Text18_c` (`AgencyOrDepartment`), `Date01_c` (`DateOfNextPriceIncrease`, ISO date). Null/blank fields are omitted.
**Used by:** `8-InsertContractProperties`.

### `DELETE /ContractProperties_c/{Id}`
**Used by:** `DeleteContractProperties`.

---

## REST — `/valueSets` and `/standardLookups`  *(reference-code lookups)*

### `GET /valueSets/{resourceCode}/child/values?fields=Value&onlyData=true[&limit=N&offset=N]`
Valid values for a value set. Used for `CMTeam` → `PHSA_CM_TEAMS`.
**Used by:** `4-ValidateValues`; `3-TransformValues` (the live-fetch path is present but commented out — it ships with a built-in list of valid codes).

### `GET /standardLookups/{resourceCode}/child/lookupCodes?fields=LookupCode&q=<filter>&onlyData=true`
Valid lookup codes for a standard lookup. Used for `ExpiryStrategy` → `PHSA_EXPIRY_STRATEGY`, `InitialProcurementStrategy` → `PHSA_INITIAL_PRC_STRATEGY`, `OptionYearsAvailable` → `PHSA_OPTION_YEARS_AVAILABLE`, `ContractTypeName` → `PHSA_WB_CONTRACT_TYPE`.
**Used by:** `4-ValidateValues`; `3-TransformValues` (commented-out fetch path).

---

## SOAP / BI Publisher — `/xmlpserver/services/ExternalReportWSSService`

### `POST /xmlpserver/services/ExternalReportWSSService`
**`Content-Type: application/soap+xml; charset=utf-8`** (SOAP 1.2). Body = a `runReport` envelope (`http://xmlns.oracle.com/oxp/service/PublicReportService`) with `reportAbsolutePath` = `/Custom/PHSA/Suppliers/Interfaces/PARTY_CONTACT_ID_CROSSWALK.xdo`. Response: extract the `<ns2:reportBytes>` element, base64-decode → a CSV that maps **email → Oracle ContactId** (the crosswalk for resolving internal contacts).
**Used by:** `9-InsertContacts`, `9-InsertContacts/retry-and-report.js`.

---

## Quick reference — script → endpoints

| Script | Endpoints used |
|---|---|
| `1-DeleteContracts` | `GET /contracts?q=ContractNumber=…`; `GET /contracts?limit=1` (sanity); `DELETE /contracts/{id}` |
| `2-TransformHeadings` | *(none — offline CSV reshape)* |
| `3-TransformValues` | *(none active — `GET /valueSets/.../child/values`, `GET /standardLookups/.../child/lookupCodes` present but commented out)* |
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
| *(diagnostics)* | `GET /contracts/{id}?expand=all`; `POST /contracts/{id}/action/validateContract` |
