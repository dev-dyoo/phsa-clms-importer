# Oracle Cloud API — Contract & Supplier Endpoints

Base host: `iaequp.fa.ocs.oraclecloud.com` (PROD)

All paths are relative to the base host. Version segment: `11.13.18.05`.

---

## Contract Identifier Relationships

There are four distinct identifiers on a contract. They are **not interchangeable**.

### `contracts.ContractId`

The **external Oracle contract ID**. This is what everything uses as the "contract handle":

- URL path segment for all child fetches: `/contracts/{ContractId}/child/...`
- URL path segment for PATCH and DELETE: `/contracts/{ContractId}`
- URL path segment for action calls: `/contracts/{ContractId}/action/submitForApproval`, `.../action/sign`
- Stored in output CSVs as `OracleContractId`
- Returned in POST response as `data.ContractId` (NOT `data.Id`)

### `contracts.Id`

The **internal Oracle DB primary key** (numeric). Used only for linking to `ContractProperties_c`:

- `ContractProperties_c.ObjectId_c = contracts.Id` — this is the FK from props to contract
- Composite orphan-detection key: `Id|MajorVersion` matched against `ObjectId_c|MajorVersion_c`
- NOT used in URL paths for child fetches, PATCH, DELETE, or actions

### `contracts.ContractNumber`

The **human-readable business identifier** (e.g. `"SOW20231107KN-2"`). Used for:

- Business-level lookup and matching across scripts
- Denormalized into `ContractProperties_c.ContractNumber_c`
- Filter: `?q=ContractNumber=<value>`

### `contracts.MajorVersion`

Version number. Used for:

- `ContractProperties_c.MajorVersion_c` — stored alongside `ObjectId_c` to form the composite FK
- Orphan detection: a props record is orphaned if no contract matches `Id|MajorVersion` (even if a contract with that `Id` exists at a different version)

---

### `ContractProperties_c` identifiers

| Field | Maps to | Purpose |
|---|---|---|
| `ContractProperties_c.Id` | self (props PK) | PATCH/DELETE URL: `/ContractProperties_c/{Id}` |
| `ContractProperties_c.ObjectId_c` | `contracts.Id` | FK linking props record to contract |
| `ContractProperties_c.MajorVersion_c` | `contracts.MajorVersion` | Part of composite FK with `ObjectId_c` |
| `ContractProperties_c.ContractNumber_c` | `contracts.ContractNumber` | Denormalized copy; used to look up `ContractProperties_c.Id` by contract number |

### Lookup patterns used by scripts

| Goal | How |
|---|---|
| PATCH/DELETE a contract | Use `contracts.ContractId` in URL path |
| Fetch child collections | Use `contracts.ContractId` in URL path |
| PATCH/DELETE a ContractProperties_c record | Fetch `ContractProperties_c.Id` by querying `?q=ObjectId_c=<contracts.Id>` or by `ContractNumber_c` |
| Detect orphaned ContractProperties_c | Compare `ObjectId_c\|MajorVersion_c` against known `contracts.Id\|MajorVersion` pairs |
| Resolve `SupplierPartyId` from driver CSV | Match `VendorMasterId` → `suppliers.DFF[0].vendorMasterId` → `suppliers.SupplierPartyId` |
| Link contract to supplier | `contracts.PrimaryPartyId = suppliers.SupplierPartyId` (also set as `contracts.PartyId` and `ContractParty[0].PartyId` on create) |

---

---

## `/fscmRestApi/resources/11.13.18.05/contracts`

### GET — list/search contracts

| Parameter | Values / Notes |
|---|---|
| `fields` | `ContractId, ContractNumber, ContractTypeId, PrimaryPartyId, Cognomen, Description, StartDate, EndDate, EstimatedAmount, CurrencyCode, MajorVersion, Id` |
| `q` | `ContractNumber=<value>` |
| `onlyData` | `true` |
| `totalResults` | `true` |
| `limit` | max `500` |
| `offset` | pagination |

Used by: ValidateContracts, FetchContractContacts, LoadMissingContacts, DeleteOrphanedContractProperties, enrich-master-from-api, ReassignBuyer, DeleteContracts

---

### POST — create contract

| Field | Type | Source / Notes |
|---|---|---|
| `EnableElectronicSignFlag` | bool | always `false` |
| `TemplateFlag` | bool | always `false` |
| `BuyOrSell` | string | always `"B"` |
| `AuthoringPartyCode` | string | always `"INTERNAL"` |
| `PHSACustomValidationCompleted_c` | bool | always `true` |
| `AccessLevel` | string | always `"UPDATE"` |
| `OrgId` | number | `300000004527105` |
| `LegalEntityId` | number | `300000004643005` |
| `ContractTypeId` | number | mapped from `Source` column (see ContractTypeId mapping below) |
| `StartDate` | string | `YYYY-MM-DD` — from `ContractStartDate` (M/D/YYYY) |
| `EndDate` | string | `YYYY-MM-DD` — from `ContractEndDate` (M/D/YYYY) |
| `EstimatedAmount` | number | from `TotalValue`; `0` if blank |
| `ContractNumber` | string | from `ContractNumber` |
| `PrimaryPartyId` | number | `SupplierPartyId` (resolved from `VendorMasterId` via suppliers API) |
| `PartyId` | number | same as `PrimaryPartyId` |
| `CurrencyCode` | string | from `Currency`; defaults to `"CAD"` |
| `Cognomen` | string | from `Title`; falls back to `ContractNumber` |
| `Description` | string | concat of `ContractDescription + ContractCommentTitle + LatestComment` (newline-joined); omitted if blank |
| `ContractHeaderFlexfieldVA` | array[1] | see DFF fields below; omitted if empty |
| `ContractParty` | array[1] | `[{ PartyRoleCode: "SUPPLIER", PartyId: <SupplierPartyId> }]` |

**ContractTypeId mapping by Source:**

| Source | ContractTypeId |
|---|---|
| `ConsultingContractRegistry` | `300000005684060` |
| `ContractRegistry` | `300000005684063` |
| `FleetwaveBcehs` | `300000005684063` |

**Response**: use `ContractId` field (NOT `Id`) to reference created contract.

Used by: LoadBatch

---

### PATCH — update contract fields

| Field | Type | Notes |
|---|---|---|
| `Cognomen` | string | from `Title` |
| `StartDate` | string | `YYYY-MM-DD` |
| `EndDate` | string | `YYYY-MM-DD` |
| `EstimatedAmount` | number | from `TotalValue` |
| `Description` | string | concat of description fields |
| `StsCode` | string | `"CANCELED"` — required before DELETE |

Used by: PatchContracts/patch-contracts, DeleteContracts/delete-live

---

### DELETE — delete contract

Must PATCH `StsCode = "CANCELED"` first.

Used by: DeleteContracts/delete-live

---

## `/fscmRestApi/resources/11.13.18.05/contracts/{ContractId}/child/ContractParty`

### GET

| Parameter | Values |
|---|---|
| `fields` | `PartyName, PartyId, PartyRoleCode` (basic) or `PartyName, PartyId, PartyRoleCode, ContractPartyContact` (with contacts) |
| `expand` | `all` — required to populate `ContractPartyContact` |
| `onlyData` | `true` — **omit** when you need `self` href for child POSTs |
| `limit` | `500` |

**Key fields on each item:**
- `PartyRoleCode` — `"CUSTOMER"` or `"SUPPLIER"`
- `PartyId`
- `PartyName`
- `links[rel=self].href` — encoded href required for POSTing/DELETing `ContractPartyContact`
- `ContractPartyContact` — array (only populated with `expand=all`)

Used by: LoadBatch, LoadMissingContacts, LoadMissingVendorContacts, FetchContractContacts, PatchContracts/patch-contacts, DeleteContracts, DeleteConversionContacts, ReassignBuyer, UpdateContractContacts

---

## `/fscmRestApi/resources/11.13.18.05/contracts/{ContractId}/child/ContractParty/{encodedKey}/child/ContractPartyContact`

### GET

| Parameter | Values |
|---|---|
| `fields` | `ContactId, PartyContactName, ContactRoleCode` |
| `limit` | `500` |

**Key fields on each item:**
- `ContactId`
- `PartyContactName` — `"CONVERSION"` used to identify contacts to delete
- `ContactRoleCode`
- `links[rel=self].href` — required for DELETE

### POST — add contact to party

| Field | Type | Notes |
|---|---|---|
| `ContactRoleCode` | string | `"CONTRACT_ADMIN"`, `"BUYER"`, or `"VENDOR_CONTACT"` |
| `ContactId` | number | from SOAP crosswalk (`SUPPLIER_PARTY_ID` col) for customer contacts; from `contractVContacts` for vendor |
| `OwnerFlag` | bool | `true` for `CONTRACT_ADMIN` always; `true` for `BUYER` only if no admin; omitted for `VENDOR_CONTACT` |

### DELETE

No body. Skip gracefully if error contains "owner" or "contact" (Oracle constraint).

Used by: LoadBatch, LoadMissingContacts, PatchContracts/patch-contacts, DeleteConversionContacts, ReassignBuyer, UpdateContractContacts, DeleteContracts

---

## `/fscmRestApi/resources/11.13.18.05/contracts/{ContractId}/child/ContractHeaderFlexfieldVA`

### GET

| Parameter | Values |
|---|---|
| `onlyData` | `true` |

**Key fields on each item:**
- `phsaCMTeam` — CM team code (e.g. `"PROFESSIONAL_SERVICES"`)
- `contractExecutionApproved` — always `"PHSA"` on creation
- `phsaCategory1`, `phsaCategory2`, `phsaCategory3` — category codes (CCR contracts)

### POST — set DFF values

| Field | Type | Notes |
|---|---|---|
| `phsaCMTeam` | string | from `CMTeam` — `.toUpperCase().replace(/\s+/g, "_")`, preserve hyphens |
| `contractExecutionApproved` | string | always `"PHSA"` |
| `phsaCategory1` | string | category 1 code — used by PatchContracts/patch-dff |
| `phsaCategory2` | string | category 2 code |
| `phsaCategory3` | string | category 3 code |

Used by: LoadBatch (POST on create), PatchContracts/patch-dff (POST to add/replace), ValidateContracts (GET)

---

## `/fscmRestApi/resources/11.13.18.05/contracts/{ContractId}/child/ContractDocuments`

### GET

| Parameter | Values |
|---|---|
| `fields` | `AttachedDocumentId, FileName, Title, CategoryName` |
| `onlyData` | `true` |
| `limit` | `500` |

**CategoryName values**: `OKC_DOCUMENTS_CONTRACT`, `OKC_DOCUMENTS_PCD`

Used by: DeleteContracts, ValidateContractDocuments

---

## `/fscmRestApi/resources/11.13.18.05/contracts/{ContractId}/child/SupportingDocuments`

### GET — same shape as ContractDocuments

**CategoryName values**: `OKC_DOCUMENTS_SUPPORTING_DOC`, `PHSA_ITEM_SPREADSHEETS`

> Note: peer child collection to ContractDocuments — NOT nested under it. Must fetch both separately.

Used by: DeleteContracts, ValidateContractDocuments

---

## `/fscmRestApi/resources/11.13.18.05/contracts/{ContractId}/action/submitForApproval`

### POST — submit contract for approval

No body required.

Used by: ApproveContracts

---

## `/fscmRestApi/resources/11.13.18.05/contracts/{ContractId}/action/sign`

### POST — sign contract

No body required.

Used by: ApproveContracts

---

## `/fscmRestApi/resources/11.13.18.05/ContractProperties_c`

Custom extensible flexfield — auto-created by Oracle when a contract is created.

### GET

| Parameter | Values |
|---|---|
| `fields` | `Id, RecordName, ObjectId_c, MajorVersion_c, ContractNumber_c, SourcingTrackerID_c, ParticipatingHA_c, Text02_c, Text09_c, Text11_c, Text12_c, Text13_c, Text18_c, Number06_c–Number14_c, PDText01_c, PDText02_c, PDText03_c, Date01_c, ApprovalStatus_c` |
| `q` | `ObjectId_c=<contractId>` |
| `onlyData` | `true` |
| `totalResults` | `true` |
| `limit` | `500` |

**Field mapping (CSV column → API field):**

| API Field | CSV Column | Type | Transform |
|---|---|---|---|
| `ObjectId_c` | (contract `Id`) | number | links to contract |
| `MajorVersion_c` | (contract `MajorVersion`) | number | |
| `ContractNumber_c` | `ContractNumber` | string | |
| `SourcingTrackerID_c` | `SourcingTrackerNumber` | string | |
| `ParticipatingHA_c` | `HealthOrganization` | JSON array | |
| `Text02_c` | `OptionYearsAvailable` | string | `optionYearsTransform()` |
| `Text09_c` | `RebateType` | string | `.toUpperCase().replace(/\s+/g,"_")` — validated only, not loaded |
| `Text11_c` | `RebateOrValueAdd` | string | `.toUpperCase().replace(/\s+/g,"_")` |
| `Text12_c` | `RebateFrequencyName` | string | `.toUpperCase().replace(/\s+/g,"_")` |
| `Text13_c` | `RebateDescription` | string | |
| `Text18_c` | `AgencyOrDepartment` | string | |
| `Number06_c` | `BCEHS_Est_AnnualSpend` | number | |
| `Number07_c` | `FHA_Est_AnnualSpend` | number | |
| `Number08_c` | `FNHA_Est_AnnualSpend` | number | |
| `Number09_c` | `IHA_Est_AnnualSpend` | number | |
| `Number10_c` | `VIHA_Est_AnnualSpend` | number | |
| `Number11_c` | `NHA_Est_AnnualSpend` | number | |
| `Number12_c` | `PHC_Est_AnnualSpend` | number | |
| `Number13_c` | `PHSA_Est_AnnualSpend` | number | |
| `Number14_c` | `VCHA_Est_AnnualSpend` | number | |
| `PDText01_c` | `ContractTypeName` | JSON array | |
| `PDText02_c` | `InitialProcurementStrategy` | string | `.toUpperCase().replace(/\s+/g,"_")` |
| `PDText03_c` | `ExpiryStrategy` | string | `.toUpperCase().replace(/\s+/g,"_")` |
| `Date01_c` | `DateOfNextPriceIncrease` | string | `YYYY-MM-DD` |
| `ApprovalStatus_c` | — | string | set to `"99"` by ApproveContracts |

### PATCH — update fields

Body contains only the fields to update (subset of above). Used by:
- LoadContractProperties/patch — bulk field patching
- PatchContracts/patch-props — diff-driven patching
- ApproveContracts — sets `ApprovalStatus_c: "99"`

### DELETE — remove record

Used by: DeleteOrphanedContractProperties

---

## `/fscmRestApi/resources/11.13.18.05/contractVContacts`

Vendor contacts lookup by supplier party.

### GET

| Parameter | Values |
|---|---|
| `fields` | `ContactId, PartyId, PartyName, ContactName, EmailAddress` |
| `q` | `PartyId=<SupplierPartyId>` |
| `onlyData` | `true` |
| `totalResults` | `true` |

**Match logic**: email first (case-insensitive), then full name (`ContactName`).

Used by: LoadBatch, LoadMissingVendorContacts, PatchContracts/patch-contacts, UpdateContractContacts

---

## `/fscmRestApi/resources/11.13.18.05/suppliers`

### GET

| Parameter | Values |
|---|---|
| `fields` | `SupplierId, SupplierPartyId, Supplier, DFF` |
| `expand` | `all` — required to populate `DFF` child |
| `onlyData` | `true` |
| `totalResults` | `true` |
| `limit` | `500` |

**Key fields:**
- `SupplierPartyId` — use this (NOT `SupplierId`) as contract `PrimaryPartyId` / `PartyId`
- `DFF` — array (child collection); access as `DFF[0].vendorMasterId` (camelCase)
- `DFF[0].vendorMasterId` → matched against driver CSV `VendorMasterId` to resolve `SupplierPartyId`

Used by: LoadBatch, ValidateContracts, FetchSupplierContacts, PatchContracts/gen-distributor-csv

---

## `/fscmRestApi/resources/11.13.18.05/suppliers/{SupplierId}/child/contacts`

### GET

| Parameter | Values |
|---|---|
| `fields` | `SupplierContactId, Status, InactiveDate` |
| `onlyData` | `true` |

### PATCH — inactivate a contact

| Field | Type | Notes |
|---|---|---|
| `InactiveDate` | string | `YYYY-MM-DD` |

Used by: BulkDeleteEntities/run-inactivate-contacts, LoadMissingVendorContacts

---

## SOAP — BI Publisher Contact Crosswalk

**Endpoint**: `/xmlpserver/services/ExternalReportWSSService`  
**Method**: POST  
**Content-Type**: `application/soap+xml; charset=utf-8`  
**Report path**: `/Custom/PHSA/Suppliers/Interfaces/PARTY_CONTACT_ID_CROSSWALK.xdo`

Response: base64-decode `<ns2:reportBytes>` → CSV (has BOM, use `bom: true` in csv-parse).

**CSV columns:**

| Column | Notes |
|---|---|
| `SUPPLIER_PARTY_ID` | Use as `ContactId` in ContractPartyContact POST for **customer** contacts (despite the name) |
| `SUPPLIER_PARTY_CONTACT_ID` | `-1` for customer contacts |
| `CONTRACT_CONTACT_ID` | `-1` for customer contacts |
| `PARTY_NUMBER` | |
| `EMAIL_ADDRESS` | used to build email → ContactId lookup map |

Used by: LoadBatch, LoadMissingContacts, PatchContracts/patch-contacts, ReassignBuyer, ValidateContracts/check-crosswalk

---

## Common Error Codes

| Code | Meaning |
|---|---|
| `OKC-196203` | Contact already exists (duplicate) |
| `OKC-195743` | Invalid `ContactRoleCode` |
| `OKC-195790` | Invalid party ID (use `SupplierPartyId`, not `SupplierId`) |
| `OKC-195788` | Duplicate contract number/type/intent combination |
| HTTP 400 | Client error — do NOT retry |
