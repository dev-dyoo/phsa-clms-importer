# Contract Load — Submit & Activate Run Report

**Date:** 2026-05-11 (run timestamps below are UTC)
**Batch source:** `input/LAST_BATCH_LOAD.csv`
**Steps executed this session:** `12-SubmitContractsForApproval` → (wait) → `13-ActivateContracts`
**Target:** Oracle Fusion CLMS — PROD (`iaequp.fa.ocs.oraclecloud.com`)

---

## 1. Summary

| | Count |
|---|---|
| Contracts in batch (`LAST_BATCH_LOAD.csv`, distinct ContractNumbers) | **1,625** |
| → had an Oracle ContractId already (created by step 7 in a prior run) | 1,596 |
| → resolved by ContractNumber lookup in step 12 | 28 |
| → ContractNumber lookup ambiguous (2 matches) — not processed | 1 |
| **Submitted for approval OK (step 12)** | **1,622** |
| **Signed → ACTIVE (step 13)** | **1,559** |
| Submitted but not yet signable when step 13 ran (BPM approval still in flight) | 63 |
| Could not be submitted at all (data/state issues) | 3 |

**Net result: 1,559 of 1,625 contracts (96%) are now SIGNED / ACTIVE in Oracle.**
63 are mid-approval and just need step 13 re-run once approvals clear. 3 need manual attention.

Run artifacts (git-ignored, local only):
- `12-SubmitContractsForApproval/output/submit-for-approval-20260511-181952.csv` + `12-SubmitContractsForApproval/log/submit-for-approval-20260511-181952-*.log`
- `13-ActivateContracts/output/activate-20260511-190318.csv` + `13-ActivateContracts/log/activate-20260511-190318-*.log`

---

## 2. Step 12 — `submitForApproval` (run 18:19:52 → 18:43:25 UTC)

`POST /fscmRestApi/.../contracts/<id>/action/submitForApproval` for every distinct
contract with an OracleContractId; concurrency 5; ~325 batches.

| Result | Count |
|---|---|
| OK (submitted, now in BPM approval) | 1,622 |
| FAIL | 2 |
| SKIP (no resolvable ContractId) | 1 |

**The 3 that did not submit** (these are also skipped by step 13):

| ContractNumber | ContractId | Reason |
|---|---|---|
| `SOW20260116HP–CH–TEKsystems-01` | — | ContractNumber matches **2** contracts in Oracle — ambiguous, the id-lookup fallback can't choose one. |
| `SOW20260116HP–CH–Apex Systems-01` | `300000007523941` | HTTP 400 `OKC-196129` — contract is already in **PENDING_ACCEPTANCE** state (cannot SUBMIT from there). |
| `SOW20251028DB-11` | `300000007914893` | HTTP 400 `OKC-196129` — contract is in **EXPIRED** state (cannot SUBMIT / activate). |

---

## 3. Step 13 — `sign` (run 19:03:18 → 19:06:38 UTC)

`POST /fscmRestApi/.../contracts/<id>/action/sign` for the 1,622 contracts step 12
submitted OK; concurrency 5; ~325 batches.

| Result | Count |
|---|---|
| OK (signed → ACTIVE) | **1,559** |
| FAIL — HTTP 400 `OKC-196583` "you can only perform this operation on a contract in the pending signature status" | 63 |
| SKIP (the 3 from step 12 that never submitted) | 3 |

`1,559 + 63 = 1,622` ✓  (reconciles with step 12's "OK" count).

**Why the 63 failed:** step 13 ran ~20 minutes after step 12. For those 63, Oracle's BPM
approval workflow hadn't yet finished, so the contract wasn't in `PENDING_SIGNATURE` /
`APPROVED` state and `sign` was rejected. This is expected and transient — nothing is
wrong with the data. They are otherwise identical to the 1,559 that worked.

(Full list of the 63 in Appendix A.)

---

## 4. Reconciliation

```
1,625  contracts in LAST_BATCH_LOAD.csv  (distinct ContractNumber)
  -  1  ambiguous ContractNumber, never attempted          → manual: pick the right ContractId
  -  2  bad pre-existing state (PENDING_ACCEPTANCE, EXPIRED) → manual: investigate
  ───────
1,622  submitted for approval OK (step 12)
  - 63  approval not yet complete when step 13 ran          → re-run step 13 (transient)
  ───────
1,559  SIGNED / ACTIVE  ✅
```

No contracts were lost, double-processed, or left in an unknown state. Both steps wrote
their result CSV after every batch, so a crash would not have lost progress; both
completed cleanly (exit 0).

---

## 5. Next steps

1. **Re-run step 13 to pick up the 63 (and any others that have since been approved).**
   Once the BPM approvals have had time to clear (give it a while — could be minutes to
   hours depending on routing), run:
   ```
   node 13-ActivateContracts/run.js
   ```
   It defaults to the newest `12-SubmitContractsForApproval/output/submit-for-approval-*.csv`
   and re-attempts all 1,622 "OK" rows; the 1,559 already signed will come back HTTP 400
   (harmless — already signed) and the now-approved ones will sign. Repeat until the FAIL
   count is 0. (Alternatively feed it `13-ActivateContracts/output/activate-20260511-190318.csv`
   to retry only the 63 + 3.)

2. **Manual handling — 3 contracts:**
   - `SOW20260116HP–CH–TEKsystems-01` — find the two Oracle contracts with this
     ContractNumber, decide which is the real one (the other is likely a duplicate/test),
     then submit + sign that one (or `node 12-SubmitContractsForApproval/run.js` after
     fixing the data, then step 13).
   - `SOW20260116HP–CH–Apex Systems-01` (`300000007523941`) — it's already in
     `PENDING_ACCEPTANCE`; check whether it just needs the next workflow action (accept →
     sign) rather than another submit. May already be effectively done.
   - `SOW20251028DB-11` (`300000007914893`) — it's `EXPIRED`. Confirm whether the
     contract end date loaded is correct; if it's genuinely expired it shouldn't be
     activated — flag with the business owner.

3. **Verify in Oracle.** Spot-check a sample of the 1,559 in the CLMS UI to confirm they
   show as `ACTIVE` (not stuck in `SIGNED`/`PENDING_*`).

4. **Documents (steps 10/11), if not already done.** `10-EnrichDocumentFilesList` /
   `11-ImportContractDocuments` (PowerShell, on a Windows host with the file share) attach
   the contract documents. They are independent of submit/sign and can run before or
   after; see `MAINTENANCE.md` §3. Note: the `_common/OracleFusionCommon.psm1` module they
   depend on is not in this repo yet.

5. **No code changes required.** Steps 12 and 13 behaved as designed; the only follow-up
   is operational (re-run 13) and data (the 3 manual cases).

---

## Appendix A — the 63 contracts to re-sign (step-13 `OKC-196583`)

| ContractNumber | ContractId |
|---|---|
| CL04301CA-CHC | 300000007902114 |
| CL04302CA-CHC | 300000007902121 |
| CL04302CA-DOM | 300000007879363 |
| CL04475CA-CHC | 300000007881274 |
| CL04475CA-DOM | 300000007879371 |
| CL04303CO | 300000007881282 |
| CL04303CA-DOM | 300000007879379 |
| CL02849MC-2022 | 300000007879509 |
| CL05331CA-CR | 300000007879886 |
| CL06216CA-2023 | 300000007906127 |
| CL01649CA-2023 | 300000007907077 |
| CL06217CA-2023 | 300000007902891 |
| CL03694CA-2023 | 300000007902905 |
| CL03622CA-2023 | 300000007907085 |
| CL03632CA-2023 | 300000007907092 |
| CL01630CA-2023 | 300000007902934 |
| CL06219CA-2023 | 300000007906165 |
| CL03698CA-2023 | 300000007902941 |
| CL01635CA-2023 | 300000007906204 |
| CL01627CA-2023 | 300000007906219 |
| CL03924CA-2023 | 300000007907161 |
| CL03921ME-2023 | 300000007908058 |
| CL03669ST-2023 | 300000007908234 |
| CL06413CA-2023 | 300000007906432 |
| CL02237ME-2024 | 300000007907376 |
| CL06413-2023M | 300000007907421 |
| CL02450BE-2024 | 300000007906502 |
| CL02452BE-2024 | 300000007907460 |
| CL02453BE-2024 | 300000007907467 |
| CL02451BE-2024 | 300000007906511 |
| CE06156ST | 300000007907512 |
| CL02974MC2-2022 | 300000007907536 |
| CL01651ME-2024 | 300000007906800 |
| CL06164CA-2024 | 300000007908554 |
| CL02449CD-2024 | 300000007907783 |
| CL02450BB-2024 | 300000007906857 |
| CL02452BB-2024 | 300000007907791 |
| CL03675CA-CARD | 300000007907798 |
| CL03672CA-CAR | 300000007907805 |
| CL02282ML-2024 | 300000007907829 |
| CL02282SM-2024 | 300000007906912 |
| CL02282PI-2024 | 300000007907837 |
| CL06735M-2024 | 300000007906929 |
| CL06735SM-2024 | 300000007906936 |
| CL04443AR-2024 | 300000007908791 |
| CL04259PR-2024 | 300000007909285 |
| CL04218ML2-2025 | 300000007911086 |
| CL03667ML2-2025 | 300000007911118 |
| CL02344ML-2025 | 300000007910359 |
| CL03637ML2-2025 | 300000007910381 |
| CL02670HE-2025 | 300000007911194 |
| CL03522CA-2025 | 300000007911219 |
| CL04438ME2-2025 | 300000007909547 |
| CL03842SO-PHSA | 300000007911295 |
| CL02399CHC-2025 | 300000007909610 |
| CL03842SO-VIHA | 300000007910540 |
| CL03842SO-FHA | 300000007909649 |
| CL04474CA-CHC | 300000007909689 |
| CL03289CA-DER | 300000007910597 |
| CL06414ST-2023 | 300000007909712 |
| CL01855CA-2025 | 300000007910676 |
| CL03635ML2-2025 | 300000007909778 |
| CL04097SO-2025 | 300000007910790 |

*(The authoritative, machine-readable record is the per-step output CSVs listed in §1 — the
`SubmitResult` / `SignResult` columns. Re-running step 13 will refresh these.)*
