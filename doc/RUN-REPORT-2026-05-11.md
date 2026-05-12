# Contract Load — Current State (as of 2026-05-11)

State of the 1,625-contract batch (`input/LAST_BATCH_LOAD.csv`) in Oracle Fusion CLMS — PROD
(`iaequp.fa.ocs.oraclecloud.com`), after the load (steps 1–9), document import (steps 10–11),
submit-for-approval (step 12), and sign (step 13).

---

## 1. Summary

| State | Count | |
|---|---:|---|
| **ACTIVE** (submitted, approved, signed) | **1,559** | ✅ done |
| **DRAFT — blocked** by an inactive supplier contact on the contract | **63** | needs data fix (§3) |
| **Individual exceptions** | **3** | needs investigation (§4) |
| **Total** | **1,625** | |

`1,559 + 63 + 3 = 1,625` ✓

The 1,559 ACTIVE contracts are complete — `submitForApproval` and `sign` both succeeded and a
spot-check confirms `StsCode = ACTIVE`.

---

## 2. ACTIVE — 1,559 contracts

No action required. These walked DRAFT → PENDING_APPROVAL → APPROVED → PENDING_SIGNATURE →
SIGNED → ACTIVE. (Recommended: spot-check a sample in the CLMS UI to confirm.)

---

## 3. DRAFT, blocked — 63 contracts (inactive supplier contact)

These 63 are still in `StsCode = DRAFT`. `submitForApproval` returns HTTP 200 but the contract
cannot leave DRAFT: it fails the contract validation **`OKC_VAL_INACTIVE_SUPPLIER_CONT`** —
*"The supplier contact &lt;name&gt; is inactive. Select an active contact on the parties tab."*
(Confirmed by running the `validateContract` action on each.) Re-running step 12 or step 13 will
not change this until the contact data is fixed.

**The 63 break down across 9 inactive supplier contacts:**

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
| **Total** | **63** |

**To clear them:** reactivate those 9 contacts in their Oracle supplier records, **or** on each of
the 63 contracts replace the inactive supplier contact with an active one on the Parties tab.
Then re-run `node 12-SubmitContractsForApproval/run.js <csv of the 63>` → wait → `node
13-ActivateContracts/run.js`. (A ready-made input CSV of the 63 — ContractNumber, OracleContractId
— can be regenerated from the run output, or see Appendix A.)

Full per-contract list in **Appendix A**.

---

## 4. Individual exceptions — 3 contracts

| ContractNumber | ContractId | Current state | What's needed |
|---|---|---|---|
| `SOW20260116HP–CH–TEKsystems-01` | — (ambiguous) | This ContractNumber matches **2** separate contracts in Oracle, so it was never processed. | Identify the two contracts, determine which is correct (the other is likely a duplicate/test), then submit + sign the correct one. |
| `SOW20260116HP–CH–Apex Systems-01` | `300000007523941` | `PENDING_ACCEPTANCE`. `submitForApproval` is rejected (`OKC-196129` — not valid from this state); `sign` is rejected (`OKC-196434` — "this operation isn't allowed on this contract type"). | Check whether it just needs the next workflow step (e.g. acceptance) rather than submit/sign — its contract type apparently doesn't use the e-signature `sign` action. May already be effectively complete. |
| `SOW20251028DB-11` | `300000007914893` | `EXPIRED`. Can't be submitted or signed from this state. | Confirm the contract end date is correct. If it's genuinely expired it shouldn't be activated — flag with the business owner. |

---

## 5. Next steps (summary)

1. **63 blocked** — fix the 9 inactive supplier contacts (reactivate, or swap on the contracts), then re-run step 12 → step 13 for the 63.
2. **3 exceptions** — handled individually per §4 (data / functional, with PHSA + Oracle admin).
3. **Spot-check** a sample of the 1,559 ACTIVE in the CLMS UI.
4. **No code changes required** — steps 12 and 13 worked as designed; everything outstanding is Oracle data/config.

After (1) and (2), all 1,625 should be ACTIVE (modulo any contract that legitimately shouldn't be, e.g. the expired one).

---

## Appendix A — the 63 DRAFT/blocked contracts and their inactive supplier contact

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

*(The live, machine-readable record is the step output CSVs under `12-SubmitContractsForApproval/output/`
and `13-ActivateContracts/output/`; the `validateContract` action gives the per-contract blocker.)*
