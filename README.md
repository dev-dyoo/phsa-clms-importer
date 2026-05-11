# phsa-clms-importer

Standalone Oracle Cloud CLMS data-import pipeline. Extracted and flattened from
`phsa-clms/phsa_scripts` so it runs entirely from this repo with no parent-directory
dependencies.

## Setup

```bash
npm install                     # or: cp -r ../phsa-clms/node_modules .
cp settings.example.toml settings.toml   # then fill in PROD credentials
```

`settings.toml` holds the PROD Oracle CLMS credentials and is git-ignored. Each script
reads it from the repo root via `[server] baseUrl / username / password` and
`[retry] max_retries`.

## Layout

```
lib/            shared HTTP client + logger (client.js, logger.js, config.js, csv.js, prompt.js)
input/          source data — LAST_BATCH_LOAD.csv, LAST_BATCH_PURGE.csv, LAST_BATCH_FILES.csv
doc/            API notes + generated column-value-comparison report
<N>-<Name>/     one pipeline step each; run.js writes log/ and output/ subdirs at runtime
```

## Pipeline

Run in order. Steps 2–6 overwrite `input/LAST_BATCH_LOAD.csv` in place; steps 7–9 hit PROD.

| Step | Script | What it does |
|------|--------|--------------|
| 1 | `1-DeleteContracts/run.js` | Look up contracts by `ContractNumber` in `input/LAST_BATCH_PURGE.csv`, DELETE each |
| 2 | `2-TransformHeadings/run.js` | Normalize `LAST_BATCH_LOAD.csv` headers (prepend ID columns, rename, strip NBSP, trim) |
| 3 | `3-TransformValues/run.js` | Normalize lookup/valueSet field values against Oracle-fetched valid codes |
| 4 | `4-ValidateValues/run.js` | Compare `LAST_BATCH_LOAD` against valid codes → `doc/column-value-comparison.{csv,md}` (optionally also against `metadata/PROD-contracts-suppliers-batch-{1,2,3}.csv` if present; skipped otherwise) |
| 5 | `5-FillContractTypeId/run.js` | Resolve `CONTRACT_TYPE` → `ContractTypeId` from Oracle LOV |
| 6 | `6-FillPrimaryPartyId/run.js` | Build `VendorMasterId → SupplierPartyId` map from Oracle suppliers, fill `PrimaryPartyId` |
| 7 | `7-InsertContract/run.js` | POST `/contracts` for each row, write back `OracleContractId` (crash-safe every 10 rows) |
| 8 | `8-InsertContractProperties/run.js` | POST `ContractProperties_c` for rows with `OracleContractId` (concurrency 10) |
| 9 | `9-InsertContacts/run.js` | POST `CONTRACT_ADMIN` / `BUYER` / `VENDOR_CONTACT`, then delete `CONVERSION` contacts (concurrency 10) |
| — | `9-InsertContacts/retry-and-report.js` | One-off: retry lock-collision vendor contacts, emit enriched failure report |
| — | `DeleteContractProperties/run.js` | Query + DELETE all `ContractProperties_c` for contract numbers in `LAST_BATCH_LOAD.csv` |

Run a step directly or via npm scripts:

```bash
node 7-InsertContract/run.js
npm run 7-insert-contract
```

## Notes

- `input/LAST_BATCH_LOAD.csv` carries forward state from prior runs (e.g. filled
  `OracleContractId`). Step 7 skips rows that already have it.
- Per-script `log/` and `output/` directories are created at runtime and git-ignored.
- Step 7 reads the supplier reference CSV from `6-FillPrimaryPartyId/output/`, so run
  step 6 before step 7.
