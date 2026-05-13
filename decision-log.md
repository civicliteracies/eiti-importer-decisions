# Decision Log

How the EITI Data Importer handles data, organized by topic. Each entry documents a choice that affects what the tool does with submitted files.

The first section, **Pending Decisions**, lists choices we know we need to make but can't yet — typically because they depend on EITI clarification, an upstream template fix, or empirical observation we haven't gathered. Each pending entry names the question, the current workaround, what would unblock the decision, and the consequence of the workaround so a reader knows what's compromised. When a pending decision resolves, it moves into the appropriate section below as a normal entry, and the pending row is deleted.

---

## 0. Pending Decisions

### Why are v2.x sector values unreliable?
<!-- scenario: trust-the-data; topic: pending-decisions -->

**Situation:** On v2.x company-revenue rows (Part 5 in v2.1, "Table10" in v2.0), the Sector column is populated by an Excel VLOOKUP rather than typed by the country submitter. The formula in the v2.1 template (`=VLOOKUP(C15, Companies[], 3, FALSE)`) pulls column index 3 from the Companies table, which is "Company type" (`State-owned enterprise`, `Publicly listed company`, etc.) — not column index 5, which is "Sector" (`Oil`, `Gas`, `Mining`, `Oil & Gas`, `Other`). The bug is in the EITI template, not the parser.

**Question:** Should the `sector` field on company-revenue rows be typed as `Sector | NotAvailable` and validated against the `Sector` enum, or stay as `str | NotAvailable` with validation suspended?

**Current workaround:** The field is declared `sector: str | NotAvailable` in `packages/parser/src/parser/domain/schemas/v2p1.py` (`CompanyRevenueRow`) and `packages/parser/src/parser/domain/schemas/v2p0.py` (`CompanyRevenueRowV2P0`). Each carries a comment that validation is suspended until EITI clarifies the VLOOKUP. Observed shapes in the wild: v2.0 Norway shows company registration numbers instead of the sector enum, v2.0 Philippines happens to be correct, v2.1 files show company-type strings.

**Blocker / what unblocks:** EITI confirms the formula should use column index 5 and ships a corrected template, or confirms the column was intentionally meant to be Company type and we rename the field accordingly.

**Consequence of workaround:** Sector values landing in the ledger from v2.x company-revenue tables are unreliable — any given row may carry a company-type string, a registration number, or a real sector. Dashboards that aggregate by Sector produce meaningless buckets. Test-deploy release notes need to call this out.

**Action when resolved:** uplift the field type to `Sector | NotAvailable`, drop the suspension comment, add the enum-membership test in `tests/unit/test_v2p1_validators.py`, and audit existing v2.x ledger rows for backfill.

---

## 1. Data Quality Policy

### What kinds of errors can be fixed in the tool?
<!-- scenario: fix-problems-before-import; topic: data-quality-policy -->

**Situation:** A validation finding is produced for a cell in the uploaded file. The dashboard needs to tell the user which findings they can resolve in the review UI and which require going back to the source Excel file.

**Decision:** A finding is "fixable" if it either carries a non-empty `candidates` tuple (dropdown options the user can pick from) or a `proposed_value` (an auto-fix the user can accept). A finding with neither is "source-only" — there is nothing for the user to choose or accept in the UI, so the only path forward is editing the source file. For example, a misspelled sector value produces a finding whose `candidates` are the five members of the `Sector` enum (`Oil`, `Gas`, `Mining`, `Oil & Gas`, `Other`), so it's fixable; a `BLANK_CELL_BLOCKING` on a strictly-typed numeric field has no candidates and no proposed value, so it's source-only.

**Rationale:** The user needs to know whether a finding can be cleared in the current session or whether they have to reject the submission back to the data submitter. Conflating the two would either hide actionable fixes behind a generic "go fix the file" message or set the wrong expectation that every error has a dropdown.

**Technical detail:** The classification lives in `apps/web_ui/dashboard-utils.js` in `classifyFinding(f)`: it returns `'fixable'` when `f.candidates.length > 0` or `f.proposed_value` is set, and `'source_only'` otherwise. The same rule drives the BLOCKED-vs-NEEDS_REVIEW status banner in `apps/web_ui/components/dashboard.js`.

### When does an error block import?
<!-- scenario: trust-the-data; topic: data-quality-policy -->

**Situation:** After validation runs, the dashboard shows one of three statuses (SUCCESS, NEEDS_REVIEW, BLOCKED) and a banner explaining what the user has to do next.

**Decision:** If any validation finding is source-only — neither a dropdown pick nor an auto-fix is available — the status is BLOCKED and the user cannot advance to the import step. The banner counts these and says `"N errors must be fixed in the source file"`. The user's only options are to fix the source Excel file and re-upload, or escalate via the FLAGGED feedback flow.

**Rationale:** Source-only findings sit on cells the tool has no way to repair. Letting the user "proceed" past them would either skip those rows silently or land a known-bad value in the ledger. Either outcome breaks the contract that an imported declaration matches what the submitter declared, so the safer behaviour is to refuse import entirely until the source is corrected.

**Technical detail:** The status calculation lives in `apps/web_ui/components/dashboard.js` (`updateStatusBanner`): `status = sourceOnly.length > 0 ? 'BLOCKED' : ((hasErrors || hasCrosscheckIssues) ? 'NEEDS_REVIEW' : 'SUCCESS')`. The matching server-side gate is in `apps/api/src/api/endpoints.py` on the `/review` endpoint, which returns HTTP 422 if any validation finding lacks both a cleaner proposal and a user-supplied `USER_CHOICE` correction.

### When is a review required before import?
<!-- scenario: trust-the-data; topic: data-quality-policy -->

**Situation:** Validation has produced findings that are all fixable (every one carries either candidates or a proposed value), or the crosschecker has reported issues like unregistered entities or per-row currency mismatches — but no source-only error is present.

**Decision:** The status banner lands on NEEDS_REVIEW rather than SUCCESS. The user can proceed to import, but only after every fixable validation finding has been covered (a cleaner proposal accepted, or a `USER_CHOICE` correction submitted at the same coordinates). Crosscheck findings (`UNREGISTERED_COMPANY`, `MISSING_REVENUE_STREAM`, `GOV_CURRENCY_MISMATCH`, and so on) do not have to be resolved — they just have to be visible to the user before they confirm.

**Rationale:** A fixable finding that's left untouched would otherwise commit a row with a null or default value into a column the source didn't actually fill. Crosscheck findings need human judgement (a company registered under a slightly different spelling is legitimate; a payment in EUR against a GHS-reporting file is suspicious) so the right action is to surface them and require the user to look, not to auto-block.

**Technical detail:** The dashboard branch is in `apps/web_ui/components/dashboard.js`; the import-time enforcement of "every fixable finding must be covered" lives in the `/review` endpoint in `apps/api/src/api/endpoints.py`, which builds a set of covered coordinates from cleaning findings and `USER_CHOICE` corrections and rejects with HTTP 422 if any uncovered validation finding remains.

### How is the data quality score computed?
<!-- scenario: trust-the-data; topic: data-quality-policy -->

**Situation:** The dashboard shows a 0–100 data quality score next to the validation summary so the user gets a quick read on how clean the file is.

**Decision:** The score is the percentage of rows with no validation problem, with source-only findings weighted twice as heavily as fixable ones. Each source-only finding contributes 1 to the weighted error count and each fixable finding contributes 0.5; the score is `round((1 - min(weighted_errors / total_rows, 1)) * 100)`. So a file with 100 rows, 4 source-only errors, and 6 fixable errors yields `(1 - (4 + 3) / 100) * 100 = 93`. Only findings in the `VALIDATION` category count — crosscheck and enrichment findings do not move the score. The score is `null` when `total_rows` is 0.

**Rationale:** Source-only errors are more disruptive because they block import outright, so the score reflects that asymmetry rather than treating every finding as equal weight. The `(1 - errors/rows)` shape ties the score to row-level health rather than absolute error counts, so a 10-row file with 2 errors and a 1000-row file with 200 errors land in the same band.

**Technical detail:** The function is `computeQualityScore(findings, totalRows)` in `apps/web_ui/dashboard-utils.js`, called from `apps/web_ui/components/dashboard.js`. The fixable-vs-source-only split is delegated to `classifyFinding(f)` in the same module.

### How are quality scores color-coded?
<!-- scenario: trust-the-data; topic: data-quality-policy -->

**Situation:** The data quality score appears on the dashboard as a coloured badge so the user can triage at a glance.

**Decision:** Scores of 80 or higher render green ("good"), scores between 50 and 79 render yellow ("warn"), and scores below 50 render red ("bad"). A null score (no rows to score) renders as "unknown".

**Rationale:** Three bands match the user's coarse decision: ship it, look at it, or send it back. Tighter thresholds would make the green band rare and reduce its signal; coarser thresholds would let visibly broken files sit in the green band.

**Technical detail:** Implemented in `qualityBand(score)` in `apps/web_ui/dashboard-utils.js` (`>= 80 → 'good'`, `>= 50 → 'warn'`, otherwise `'bad'`; `null` → `'unknown'`).

### Are template placeholders treated as data?
<!-- scenario: trust-the-data; topic: data-quality-policy -->

**Situation:** A submitter sometimes leaves the EITI template's instructional text in a data cell — either a literal placeholder like `<insert company name>` or an instruction phrase the template uses such as `"add new rows as necessary"`, `"if yes, please specify name"`, or `"other sectors, if applicable"`.

**Decision:** A field-level Pydantic validator (`validate_template_values`) rejects both shapes as `INVALID_DATATYPE` validation errors with a message that identifies the value as a template placeholder or template instruction. The cleaner picks up that finding and, because the message contains the marker `"template placeholder"` or `"template instruction"`, proposes a `PLACEHOLDER_REMOVED` cleaning finding whose effect is to drop the cell. The submitter is asked to provide real data; the mapper skips the cell on import.

**Rationale:** Importing instructional scaffolding as if it were data corrupts the ledger silently — a row whose Company column reads "add new rows as necessary" looks like a real entity and would flow through entity resolution as a new company. Detecting it at the field validator catches both the angle-bracket shape and the specific instruction phrases the template ships with.

**Technical detail:** The detection lives in `packages/parser/src/parser/domain/schemas/validation_helpers.py` (`validate_template_values`, `TEMPLATE_INSTRUCTIONS` list). The removal is handled by `PlaceholderRemovalRule` in `packages/cleaner/src/cleaner/rules.py`, which keys on the `"template placeholder"` / `"template instruction"` substrings in the parser's error message.

### Can a user fix a misspelled value in the tool?
<!-- scenario: fix-problems-before-import; topic: data-quality-policy -->

**Situation:** A cell carries a value that doesn't match its field's enum — for example, the Sector column contains `"Minning"` where only `Oil`, `Gas`, `Mining`, `Oil & Gas`, or `Other` are valid.

**Decision:** The row validator extracts the valid enum members from the Pydantic enum error and attaches them to the finding as the `candidates` tuple. The review UI renders this as a dropdown, so the user can pick `Mining` without having to look up what the legal values are. In parallel, the `EnumCorrectionRule` in the cleaner fuzzy-matches the cell value against those candidates with a WRatio threshold of 80 and, if any candidate scores above the cut, emits an `ENUM_CORRECTED` cleaning finding with `proposed_value=Mining` — so the typo case is offered as a one-click accept rather than a manual dropdown pick.

**Rationale:** A user reviewing a 200-row file shouldn't have to memorise five enum vocabularies. Surfacing the candidates makes the fix obvious; the fuzzy-match auto-proposal makes the common typo case zero-click. The threshold sits below the entity-matching threshold (86) because the candidate set is small (3–6 options) and any wrong fuzzy match is visible to the user in the review UI before commit.

**Technical detail:** Candidate extraction lives in `_extract_enum_candidates` in `packages/parser/src/parser/validation/row_validator.py` (regex over Pydantic's enum error `ctx.expected` string). The auto-proposal lives in `EnumCorrectionRule` in `packages/cleaner/src/cleaner/rules.py` with `ENUM_CORRECTION_THRESHOLD = 80`.

### How does the tool handle 'Not available' and 'Not applicable' cells?
<!-- scenario: trust-the-data; topic: data-quality-policy -->

**Situation:** A submitter writes the literal string `"Not available"` or `"Not applicable"` in a cell where the schema expects a number (a payment value, an in-kind volume) or an enum (a sector).

**Decision:** The parser accepts these as first-class values: fields that may legitimately be missing are typed as a union with `NotAvailable` (data gap — should have a value but wasn't provided) or `NotApplicable` (structural inapplicability — the field doesn't apply in this row's context). The literal sentinel string is written through to the ledger column as-is. The clean tables, which are the analysis-ready surface, replace any sentinel with SQL `NULL` via a `CASE WHEN col NOT IN ('Not available', 'Not applicable', 'Blank') THEN CAST(col AS REAL) ELSE NULL END` guard around every numeric column, and a row in `clean_flags` records what the original ledger value was. A third sentinel, `Blank` (`packages/shared/src/shared/diagnostics.py:Blank`), covers fields where empty is by-design — comments and free-text columns.

**Rationale:** Aggregations need numeric NULLs, not strings — `SUM("Not available", 100)` is nonsense. But the ledger has to preserve what the country actually declared so an auditor can tell "the country said the field was inapplicable" apart from "the value was genuinely null". Splitting raw (ledger) from clean (analysis) achieves both, and `clean_flags` keeps the round-trip back to the original sentinel intact.

**Technical detail:** Sentinel types live in `packages/shared/src/shared/diagnostics.py` (`NotAvailable.NV = "Not available"`, `NotApplicable.NA = "Not applicable"`, `Blank.BLANK = "Blank"`, `SENTINEL_VALUES` frozenset). The `CASE` guard is generated by `SENTINELS_SQL` in `packages/importer/src/importer/clean_queries.py`. The audit table is `CleanFlags` in `packages/shared/src/shared/db_models.py` (`clean_flags`: `source_table`, `field_name`, `row_index`, `original_value`).

### Why is a blank data field always treated as missing rather than legitimate?
<!-- scenario: trust-the-data; topic: data-quality-policy -->

**Situation:** Some data points — ASM employment headcounts, investment-by-sector figures, GDP shares — aren't tracked by every country. When such a cell is empty in the submitted file, there's no way for the tool to tell whether the country doesn't collect the metric at all or whether it just got forgotten in this file.

**Decision:** A blank data cell is always recorded as the "Not available" sentinel (`NotAvailable.NV`), never as a genuine empty. The cleaner auto-fills the sentinel on blanks where the field's type union allows it. Only free-text fields (`comments`, free-form value cells), declared with the `FreeText` alias that maps `None` to `Blank.BLANK`, can carry a legitimate empty.

**Rationale:** The tool has no information that distinguishes "country doesn't track this" from "country forgot to report it" — both arrive as the same empty cell. Auto-marking it `Not applicable` would claim structural inapplicability the tool can't actually verify; leaving it null in the ledger would erase the distinction between an unknown gap and a deliberate omission. Treating every blank as a data gap keeps the auto-fill visible in the review UI, where a human reviewer can override it to `Not applicable` if that's the right call.

**Technical detail:** The mapping rule is `MapToNotAvailableRule` in `packages/cleaner/src/cleaner/rules.py` — it fires only on `ParserCode.BLANK_CELL`, which is itself only emitted when the field's type union explicitly contains `NotAvailable` (see `_blank_cell_code_for` in `packages/parser/src/parser/validation/row_validator.py`). The `FreeText` carve-out is the `Annotated[str | Blank, BeforeValidator(_none_to_blank)]` alias in `packages/parser/src/parser/domain/schemas/validation_helpers.py`.

### Which blank cells block import and which don't?
<!-- scenario: fix-problems-before-import; topic: data-quality-policy -->

**Situation:** A data cell is blank. The tool has to decide whether the import can proceed (with an auto-fill or a user pick) or whether the source file has to be corrected first.

**Decision:** Three parser codes, chosen by introspecting the field's type union:

- **`BLANK_CELL`** (non-blocking) — the field's type contains `NotAvailable`. The cleaner auto-fills `"Not available"` via `MapToNotAvailableRule` and the user can accept silently.
- **`BLANK_CELL_BLOCKING`** — the field's type contains neither `NotAvailable` nor `NotApplicable` (a strict-typed `float` or required enum). No sentinel is legal, so there's nothing to auto-fill; the user has to fix the source file or escalate via the FLAGGED feedback flow.
- **`BLANK_CELL_DEPENDENT`** — the field's type contains `NotApplicable` but not `NotAvailable` (for example `in_kind_volume: float | NotApplicable`). The user picks `"Not applicable"` from the review dropdown (the parser ships it as a candidate), enters a real value, or escalates.

When a field's union contains both `NotAvailable` and `NotApplicable`, `BLANK_CELL` wins — the cell is treated as a data gap by default, and the reviewer can override to `Not applicable` in the UI.

**Rationale:** Whether a blank blocks import is a domain decision that depends on what the field means: a strictly-typed payment value cannot be silently filled, while an optional headcount can. Encoding the answer in the finding code itself lets the dashboard surface the right action without re-deriving the rule, and prevents the cleaner from guessing between NA and NV when both are legal.

**Technical detail:** The code is derived by `_blank_cell_code_for(model, field_name)` in `packages/parser/src/parser/validation/row_validator.py`, which calls `get_args` on the field's annotation and returns `BLANK_CELL` if `NotAvailable` is in the union, `BLANK_CELL_DEPENDENT` if `NotApplicable` is in it, and `BLANK_CELL_BLOCKING` otherwise. The dependent-case candidate is pulled by `_extract_enum_candidates` from the Pydantic enum error on the union.

### How does the tool distinguish a blank cell from a wrongly-typed value?
<!-- scenario: fix-problems-before-import; topic: data-quality-policy -->

**Situation:** A cell fails Pydantic validation. The downstream pipeline (cleaner rules, review UI, source-only gate) needs to know whether the failure is "cell was empty" or "cell had something in it that didn't fit".

**Decision:** Two paths, decided in `_map_pydantic_errors` after the validator has run:

- The cell is empty (`cell_value is None`, including whitespace-only strings the field-level validator normalised to `None`) — recorded as one of the three blank-cell codes (`BLANK_CELL` / `BLANK_CELL_BLOCKING` / `BLANK_CELL_DEPENDENT`), chosen from the field's type union.
- The cell has a non-empty value that didn't pass — recorded as `INVALID_DATATYPE`. The cleaner then has a chance to repair it: `EnumCorrectionRule` fuzzy-matches against the enum candidates, `StandardizeNotAvailableRule` and `StandardizeNotApplicableRule` coerce variant spellings like `"not availble"` or `"n/a"` to the canonical sentinel, and `PlaceholderRemovalRule` drops template scaffolding like `<insert company name>`.

**Rationale:** Empty cells and wrongly-filled cells have different causes (forgotten data vs. wrong vocabulary), different cleaner rules apply to each, and the reviewer's action is different (look up the missing data vs. confirm the proposed correction). Giving them distinct codes keeps that distinction visible end-to-end and prevents the cleaner from running NV-mapping logic on cells that aren't actually blank.

**Technical detail:** The branch is at lines 199–202 of `packages/parser/src/parser/validation/row_validator.py`: `if bad_value is None and resolved_field in model.model_fields: code = _blank_cell_code_for(...)` else `code = ParserCode.INVALID_DATATYPE`. Whitespace-to-`None` normalisation is `validate_template_values` in `packages/parser/src/parser/domain/schemas/validation_helpers.py`. The four cleaner rules live in `packages/cleaner/src/cleaner/rules.py`.

### Who decides whether a blank cell becomes 'Not applicable' or 'Not available'?
<!-- scenario: cross-cutting; topic: data-quality-policy -->

**Situation:** A cell is blank. Some component has to decide whether to record it as `"Not available"` (data should have been there) or `"Not applicable"` (the field doesn't apply in this row's context).

**Decision:** The parser sets `Not applicable` only when another field in the same record makes the cell structurally inapplicable, because that judgement takes domain knowledge of the row. For example, on a v2.1 company-revenue row, the `cascade` model-validator pre-fills `in_kind_volume = NotApplicable.NA` and `unit = NotApplicable.NA` whenever `payment_made_in_kind != "Yes"`; the same validator pre-fills `project_name = NotApplicable.NA` when neither `levied_on_project` nor `reported_by_project` is `"Yes"`. The cleaner only ever fills `Not available`, and it does so only for `BLANK_CELL` findings (fields whose union explicitly allows `NotAvailable`). The cleaner never sets `Not applicable` on its own.

**Rationale:** Marking a cell `Not applicable` is a claim about *why* the cell is empty — that the field structurally doesn't apply given the rest of the record. Only the parser has the whole row in hand when it runs cascades, so only the parser can defensibly make that claim. The cleaner sees individual findings without their row context, so its safe behaviour is the conservative one: a non-blocking blank means "this data is missing", not "this data doesn't belong here".

**Technical detail:** Parser cascades are `@model_validator(mode="before")` methods on the relevant row models — see `cascade` on `CompanyRevenueRow` in `packages/parser/src/parser/domain/schemas/v2p1.py` and the shared helper `cascade_metadata_row_na` in `packages/parser/src/parser/domain/schemas/validation_helpers.py`. The cleaner's NV fill is `MapToNotAvailableRule` in `packages/cleaner/src/cleaner/rules.py`, gated on `f.code == ParserCode.BLANK_CELL` — it never matches `BLANK_CELL_DEPENDENT` or `BLANK_CELL_BLOCKING`.

---

## 2. Currency & Financial Calculations

### What direction is the exchange rate?
<!-- scenario: reconcile-government-vs-companies; topic: currency-financial-calculations -->

**Situation:** When a v2.x file is uploaded, the About sheet carries a row labelled "Exchange rate used: 1 USD =" with a numeric rate next to it. The tool needs to know which way that rate goes before it can convert any row.

**Decision:** The tool reads the rate verbatim from that cell and treats it as "1 USD = X local currency units". A row already in the reporting currency is divided by the rate to get its USD value; a row tagged as USD in a non-USD file is multiplied by the rate to get its local-currency value. For example, if a v2.1 file from Armenia declares "1 USD = 484.0" AMD and a row reports 484,000 AMD of revenue, the USD column shows 1,000.

**Rationale:** The convention matches the literal phrasing on the EITI template, so the value the submitter typed is the value the tool uses with no inversion step in between. If the tool flipped the rate silently, a stray transcription error in either direction would be invisible to the submitter checking the dashboard against their file.

**Technical detail:** The v2.0 and v2.1 schemas in `packages/parser/src/parser/domain/schemas/v2p0.py` and `v2p1.py` map the header `("Exchange rate used: 1 USD =", 2)` to the field `exchange_rate_used`. The conversion direction is implemented once in `_convert_row` in `apps/cli/src/cli/stats.py` and mirrored in `convertRow` in `apps/web_ui/stats.js`: a local-currency row produces `val / exchange_rate` for the USD side, a USD row produces `val * exchange_rate` for the local side.

### What happens when the exchange rate is zero?
<!-- scenario: reconcile-government-vs-companies; topic: currency-financial-calculations -->

**Situation:** The About sheet's exchange-rate cell is present but holds `0` (or a blank that gets coerced to zero). Without rejecting this, the tool would divide every row's local-currency value by zero.

**Decision:** Zero is treated as "rate not provided". The stats engine never records it, the v1 historical-rates fallback is still given a chance to fire, and the USD totals fall back to N/A on the dashboard with the notice "USD totals not available — no exchange rate in file".

**Rationale:** A literal zero is never a meaningful FX rate — no currency has ever traded at zero against the dollar — so the only situations producing it are a submitter who typed nothing, a template default that leaked through, or a parsing edge case. Treating it as missing produces the same observable behaviour as if the cell had been left blank, which is what the data actually means.

**Technical detail:** In `compute_stats` in `apps/cli/src/cli/stats.py`, the guard is `if rate_float > 0.0 and math.isfinite(rate_float)` before assigning `exchange_rate`. The JS side enforces the same gate via `if (rateFloat > 0)` in `apps/web_ui/stats.js`. Because `exchange_rate` stays `None`, the v1 fallback block immediately below runs unchanged for v1 submissions.

### How are nonsensical exchange rates handled?
<!-- scenario: reconcile-government-vs-companies; topic: currency-financial-calculations -->

**Situation:** The exchange-rate cell holds something Python or JS can technically parse as a float but that is not a real number — `1e309` overflows to infinity, the string `"nan"` parses to NaN, and either one will silently corrupt every USD total downstream.

**Decision:** Both are rejected at the boundary where the rate is first read. The rate is only accepted if it is strictly greater than zero AND passes a finiteness check, which excludes both infinity and NaN. A rejected rate is treated identically to no rate at all — USD totals become N/A and the v1 fallback path is still eligible to fire.

**Rationale:** Without the finiteness guard, an infinite rate divides every revenue figure down to 0 (because `val / inf == 0`), and a NaN rate propagates NaN through every sum. Both outcomes look like real numeric output on the dashboard but are wrong by orders of magnitude. Catching them once at the boundary is cheaper than auditing every arithmetic site downstream.

**Technical detail:** In `apps/cli/src/cli/stats.py`, the guard is `rate_float > 0.0 and math.isfinite(rate_float)`. In `apps/web_ui/stats.js`, `safeFloat` uses `isFinite(n)` so that `parseFloat("1e309")` (which returns `Infinity`) and `parseFloat("nan")` (which returns `NaN`) both come back as `0.0` and are then rejected by the same `rateFloat > 0` check.

### In what currencies are totals displayed?
<!-- scenario: reconcile-government-vs-companies; topic: currency-financial-calculations -->

**Situation:** Every revenue figure in an EITI file is reported in the country's local currency, but the EITI dashboards EITI International and external analysts use need USD so countries can be compared.

**Decision:** Every total — gov revenue, company payments, reconciliation gap — is computed twice: once in the reporting currency (`_local`) and once in USD (`_usd`). On the dashboard, USD is rendered as the large primary figure with "USD" underneath, and the local-currency total appears below it as a smaller secondary line prefixed by the ISO code (for instance "AMD 484,000,000"). If only the local total is computable — typically a v1 file with no exchange rate — the local figure is promoted to the primary slot and the USD line is dropped entirely.

**Rationale:** Stripping the local figure would mean any submitter trying to reconcile the dashboard against their source file has to reverse the conversion in their head. Stripping the USD figure would mean any cross-country aggregation has to fetch and apply rates separately. Carrying both side by side lets a single dashboard view serve both audiences without either having to re-derive anything.

**Technical detail:** The dual totals live in the `ReportStats` dataclass in `apps/cli/src/cli/stats.py` as `total_gov_revenue_local`/`_usd`, `total_company_payments_local`/`_usd`, and `reconciliation_gap_local`/`_usd`. The dashboard rendering rule lives in `renderFinancialValue` in `apps/web_ui/components/dashboard.js`: it renders USD primary plus a local secondary line when `mainCurrency !== 'USD' && mainCurrency !== 'Unknown'`, falls back to local-only when USD is null but local is computable, and emits an N/A card with a contextual notice when neither is available.

### What happens to a total if one row cannot be converted?
<!-- scenario: reconcile-government-vs-companies; topic: currency-financial-calculations -->

**Situation:** A v2.x company payments table contains one row in EUR alongside thirty rows in the reporting currency. The tool only carries the USD-to-local rate from the About sheet, so it cannot convert that one EUR row.

**Decision:** The local-side total and the USD-side total are tracked with independent failure flags. As soon as any single row's local value is uncomputable the entire local total for that table becomes None; the USD total is treated the same way independently. The reconciliation gap inherits this: if either gov or company total is None on a side, the gap on that side is None too.

**Rationale:** A partial sum that silently drops the EUR row would understate the true figure with no visible warning, and a reviewer comparing the dashboard against the source file would see two numbers that should match but don't. Returning N/A surfaces the gap honestly — the reviewer sees that the table contains a currency the file cannot resolve and can decide whether to fix the source or accept the loss of comparability.

**Technical detail:** In `_sum_gov_revenues` and `_sum_company_payments` (both in `apps/cli/src/cli/stats.py`), each row that returns `(None, _)` from `_convert_row` sets `local_failed = True`; each row that returns `(_, None)` sets `usd_failed = True`. After the loop, `local_total` is replaced with `None` if `local_failed` is set, and the same for `usd_total`. The gov breakdown by sector shares the local convertibility constraint and is nulled together with `local_total`.

### Why might a row be uncomputable?
<!-- scenario: reconcile-government-vs-companies; topic: currency-financial-calculations -->

**Situation:** A v2.x revenue row has a per-row currency column. The file's About sheet declares one exchange rate, which links the reporting currency and USD. The row's currency might not be either of those two.

**Decision:** A row whose currency is the reporting currency, blank, or missing is treated as already in the reporting currency and is convertible both ways. A row tagged USD in a non-USD-reporting file is also convertible — the rate covers that pair. A row in any third currency, for example an EUR-denominated payment in a file reporting AMD with a USD/AMD rate, is marked uncomputable on both sides.

**Rationale:** Converting a third currency requires a second exchange rate (EUR-USD or EUR-AMD) that the file does not provide. The tool refuses to invent one or pull from a live FX feed because the EITI methodology is that the file declares its own conversion basis. Recording the row as uncomputable lets the totals turn to N/A rather than silently mixing currencies.

**Technical detail:** The branching lives in `_convert_row` in `apps/cli/src/cli/stats.py` and `convertRow` in `apps/web_ui/stats.js`. The first branch handles "local row" (row currency missing, empty, equal to reporting currency, or reporting currency itself unknown). The second branch handles `row_currency == "USD"` in a non-USD file. Anything that falls through returns `(None, None)`, which propagates the failure flag in the caller.

### What happens when the reporting currency is USD?
<!-- scenario: reconcile-government-vs-companies; topic: currency-financial-calculations -->

**Situation:** The About sheet's reporting-currency cell contains "USD" — the country has chosen to denominate its declaration directly in dollars.

**Decision:** Each row's value is taken as its own USD value and its own local value simultaneously, with no conversion step. The local total and USD total are therefore mathematically identical. The dashboard skips the secondary local line because the test `mainCurrency !== 'USD'` returns false, so only one figure with "USD" beneath it appears.

**Rationale:** Conversion is the identity function in this case, so applying it is pointless. Showing "USD 100,000,000" and immediately below it "USD 100,000,000" gives the reader no extra information and looks like a rendering bug.

**Technical detail:** In `_convert_row` in `apps/cli/src/cli/stats.py`, the local-row branch checks `if reporting_currency == "USD"` and returns `(val, val)` directly. The exchange-rate field is not consulted on that path — a USD-reporting file with no rate produces normal totals, not N/A. The dashboard suppression is `const isLocalDifferent = stats.mainCurrency !== 'USD' && stats.mainCurrency !== 'Unknown'` in `apps/web_ui/components/dashboard.js`; when this is false, the `card-secondary` line is omitted.

### How is the reconciliation gap computed?
<!-- scenario: reconcile-government-vs-companies; topic: currency-financial-calculations -->

**Situation:** EITI files report government revenue and company payments separately. These two sides should match if every payment is properly accounted for. The dashboard needs a single figure that tells the reviewer whether they do.

**Decision:** Gap equals total government revenue minus total company payments. A positive gap means the government side reported more than the company side; a negative gap means the opposite. The gap percentage is `gap / total_gov_revenue * 100`, using the government figure as the denominator. Both are computed independently in the local pair and in the USD pair.

**Rationale:** Subtracting in this direction matches the EITI reconciliation methodology, which uses the government-side figure as the reference and asks "how much of what the government said it received are companies confirming?". The percentage is more useful than the absolute gap for cross-country comparison because it normalises away the scale difference between, say, Nigeria's oil revenues and Chad's mining revenues.

**Technical detail:** In `apps/cli/src/cli/stats.py`, the gap is computed at the end of `compute_stats` only when both sides on a given currency pair are non-None: `stats.reconciliation_gap_local = stats.total_gov_revenue_local - stats.total_company_payments_local` and likewise for USD. The percentage path also guards against `base != 0.0` — a country reporting literally zero government revenue would otherwise trigger ZeroDivisionError, and a bare-truthy check would have silently dropped the percentage in that case. The same logic lives in `computeStats` in `apps/web_ui/stats.js`.

### Which currency is used for the reconciliation gap percentage?
<!-- scenario: reconcile-government-vs-companies; topic: currency-financial-calculations -->

**Situation:** The percentage is a ratio, so mathematically it could be derived from either the local pair or the USD pair. The two pairs are not numerically identical in practice — each USD figure is the local figure divided by the rate, and floating-point arithmetic introduces small differences.

**Decision:** The percentage is computed from the local pair if both sides are available locally; only if one of the local sides is None does it fall back to the USD pair. The reported percentage is therefore the same number regardless of whether the user is looking at the local or USD totals on the dashboard.

**Rationale:** The local pair has not been through a division step, so it carries no conversion-rounding noise. Using it as the basis means a "5.0% gap" on the dashboard reflects exactly what falls out of the file's own numbers, not an artefact of how `_safe_float` and `/` interact at the boundaries of floating-point precision. The USD fallback only kicks in when the local total is missing — typically a row in a third currency the tool cannot resolve.

**Technical detail:** In `compute_stats` in `apps/cli/src/cli/stats.py`: `gap = stats.reconciliation_gap_local; base = stats.total_gov_revenue_local`, then `if gap is None or base is None: gap = stats.reconciliation_gap_usd; base = stats.total_gov_revenue_usd`. The percentage is a single scalar `reconciliation_gap_pct` on `ReportStats` — there is no separate `_local` and `_usd` version. Mirrored in `apps/web_ui/stats.js`.

### When is the reconciliation gap considered concerning?
<!-- scenario: reconcile-government-vs-companies; topic: currency-financial-calculations -->

**Situation:** The reconciliation gap percentage appears on the dashboard as a coloured card. The reviewer needs a quick visual cue separating "looks fine" from "needs attention" without having to interpret the raw percentage.

**Decision:** If the absolute value of the gap percentage is 10% or less, the card is rendered with the success style (green). Above 10%, it is rendered with the error style (red). When the gap percentage cannot be computed at all — one side missing on both currency pairs — no colour is applied.

**Rationale:** EITI reconciliation reports treat single-digit-percent discrepancies as ordinary noise from reporting calendars, in-kind versus cash recognition, and rounding. Crossing ten percent typically signals either a real reporting gap that warrants investigation or a structural mismatch in how the two sides are tabulated. The threshold gives the reviewer one fewer thing to remember during triage.

**Technical detail:** The threshold is applied at render time in `apps/web_ui/components/dashboard.js`: `const gapColor = stats.reconciliationGapPct != null ? (Math.abs(stats.reconciliationGapPct) <= 10 ? 'success' : 'error') : '';`. The threshold is not configurable from the stats config — changing it requires a code change in the dashboard component.

### How is currency handled for v1 files without per-row currency?
<!-- scenario: compare-across-versions; topic: currency-financial-calculations -->

**Situation:** A v1 EITI Summary Data Template is older than the per-row currency columns introduced in v2.0. Every revenue and payment row in a v1 file is just a number — there is no column saying which currency it's in.

**Decision:** Every row in a v1 file is treated as already being in the reporting currency declared in the About sheet. The local total is therefore always computable from any v1 file that has a reporting currency and at least one numeric row. The USD total requires an exchange rate — either from the About sheet (rare for v1) or from the historical-rates fallback table.

**Rationale:** With no per-row currency column there's no way to detect a mixed-currency v1 file, and in practice these files predate the multinational-USD-payment use case that motivated the per-row column. Treating every row as reporting-currency mirrors how the submitter implicitly thought about the file when they filled it in.

**Technical detail:** In `packages/shared/src/shared/stats_config.json`, `currency_field.summary_v1` is `{"gov": null, "comp": null}`. The stats engine reads those nulls into `gov_currency_field` and `comp_currency_field` and so never tries to look up a per-row currency on a v1 row — `row_currency` stays `None`, which routes the row through the "local row" branch of `_convert_row`. The currency-mismatch crosscheck in `packages/crosschecker/src/crosschecker/crosschecker_service.py` skips v1 entirely on the same signal.

### Where does the tool get exchange rates for old v1 files?
<!-- scenario: compare-across-versions; topic: currency-financial-calculations -->

**Situation:** V1 files never include an exchange rate in the About sheet, but EITI's own API export has rates for 96% of historical declarations.

**Decision:** The tool ships with a committed lookup table of historical exchange rates, extracted from EITI's API export and keyed by country and year. When a v1 file's About sheet has no rate, the stats computation looks up the rate by the file's country code and reporting-period end year. The dashboard (in the browser) and the server-side computation read from the same lookup source.

**Rationale:** Historical exchange rates are stable and available from EITI's own data. A static, committed table avoids runtime dependency on external services and guarantees that the dashboard and the server can't drift apart.

**Technical detail:** Lookup file `v1_exchange_rates.json`, keyed by `{iso3}_{year}`. `compute_stats` resolves the rate using `country_iso3` + `end_date` year. The same JSON is served to the browser via the `/stats-config` endpoint, so Python and JS share one source.

### Which currency does the v1 dashboard prioritize?
<!-- scenario: reconcile-government-vs-companies; topic: currency-financial-calculations -->

**Situation:** A v1 file from a country with no entry in the historical rates table — or from a year before the EITI export covers — has a computable local total but no USD total at all.

**Decision:** When the USD total is None and the local total is a real number, the dashboard promotes the local figure to the primary (large) slot with the ISO currency code (for instance "AMD") underneath it. No "N/A" notice appears, no USD line, no warning. When the USD total is available — whether from a v2.x About-sheet rate, a v1 About-sheet rate, or the historical-rates fallback — USD is the primary figure with the local total as the secondary line.

**Rationale:** Showing "N/A" when there is a real, computable, useful number in the file is misleading — the reviewer is doing in-country review against the source document and the local-currency total is exactly the figure they want to see. The USD figure is only valuable for cross-country comparison; suppressing the local total to enforce that hierarchy would actively damage the in-country review case.

**Technical detail:** The fall-through is in `renderFinancialValue` in `apps/web_ui/components/dashboard.js`. The first branch handles `usdVal !== null` and renders USD primary with optional local secondary. The second branch handles `localVal !== null` (with USD null) and renders local as primary. Only when both are null does the function emit an N/A card, and the notice text is chosen based on whether `mainCurrency` is `"Unknown"` versus whether `exchangeRateUsed` is null.

### What happens to 'Not available' revenue rows in aggregations?
<!-- scenario: trust-the-data; topic: currency-financial-calculations -->

**Situation:** A revenue cell in the ledger contains the literal string "Not available", "Not applicable", or "Blank" — the parser accepted the value, the cleaner did not need to rewrite it, and now the import is producing the analysis-ready clean tables.

**Decision:** Rows whose revenue value is one of these sentinel strings are excluded entirely from the clean-table INSERT — they don't become NULL rows, they don't appear in the clean table at all. Both the SELECT-time `CASE` guard that converts a numeric string to a float and the `WHERE` clause filter the same set of sentinels.

**Rationale:** A "Not available" payment behaves differently from a zero payment, and aggregations downstream — totals, averages, sector breakdowns — should not treat them as the same thing. Carrying the sentinel through as NULL would still let it count as a row in `COUNT(*)`, skewing per-country row counts. Dropping the row from the clean table is the most defensible aggregation behaviour: the row is preserved in the raw ledger (with the original sentinel string), but the analysis-ready table only contains rows with a real numeric payment.

**Technical detail:** The clean-table inserts live in `packages/importer/src/importer/clean_queries.py`. The sentinel list is `SENTINELS_SQL = "'Not available', 'Not applicable', 'Blank'"`, applied at two points in each query: a `CASE WHEN ... NOT IN (...)` guard on the numeric cast (so a sentinel that slipped past the WHERE clause would still produce NULL rather than coerce to 0.0), and a `WHERE l.<value_col> NOT IN (...)` filter that drops the row. The sentinel substitutions are also recorded in the `clean_flags` table for traceability — the raw ledger keeps the original string regardless.

---

## 3. Workflow & Status

### What are the possible statuses of a file?
<!-- scenario: submit-a-report; topic: workflow-status -->

**Situation:** After upload, the dashboard shows a status banner with one of three labels — SUCCESS, NEEDS_REVIEW, or BLOCKED — indicating what the user has to do next.

**Decision:** The banner runs three checks against the findings the pipeline produced. If any validation finding is "source-only" (no proposed value, no candidates), the file is BLOCKED. Otherwise, if there's any validation finding or any crosscheck finding, it's NEEDS_REVIEW. Otherwise it's SUCCESS. BLOCKED means the user has to fix the Excel file and re-upload; NEEDS_REVIEW means the user can resolve everything in the review tab and continue; SUCCESS means the file can move straight to the import step.

**Rationale:** These three labels map cleanly to the three actions the user can take — proceed, review and correct, or send back to the submitter. Folding everything else into one of those three keeps the dashboard's first impression actionable rather than diagnostic.

**Technical detail:** The classification is computed in the browser by `updateStatusBanner` in `apps/web_ui/components/dashboard.js`. It filters `context.findings` by category, then applies `classifyFinding` to validation findings to split them into "fixable" and "source_only" buckets. The status is not stored on the server — it's derived live from whatever findings the pipeline produced for that session. The same classification feeds the colored quality bands shown on the dashboard cards.

### What does the tool do when an internal check crashes?
<!-- scenario: trust-the-data; topic: workflow-status -->

**Situation:** A service in the middle of the pipeline — the cleaner, the enricher, the crosschecker, or the mapper — hits an unhandled exception while processing a file.

**Decision:** The service catches its own exception, emits a single `SERVICE_ERROR` finding describing what crashed, and returns a normal report. The pipeline keeps running. The user still sees the dashboard, still sees every finding the surviving services produced, and can still proceed to review and import the file. The only services that turn a crash into a terminal pipeline error are template identification and parsing — the upstream stages whose output everything else depends on.

**Rationale:** Each downstream service produces a slice of the dashboard view (cleaner fills, entity matches, consistency warnings, mapped target columns). If one of them dies, the rest of the dashboard is still useful and the user can make a judgment call. Aborting the whole run on a single component crash would force the user to retry blind without knowing whether the other slices would have flagged anything worth seeing.

**Technical detail:** Each service's `run` method wraps its body in a try/except that returns a report containing one `SERVICE_ERROR` finding (`CrosscheckCode.SERVICE_ERROR`, `EnrichmentCode.SERVICE_ERROR`, `CleaningCode.SERVICE_ERROR`, `MappingCode.SERVICE_ERROR`) — see `packages/cleaner/src/cleaner/cleaner_service.py`, `packages/crosschecker/src/crosschecker/crosschecker_service.py`, `packages/enricher/src/enricher/enricher_service.py`, `packages/mapper/src/mapper/mapper_service.py`. The crosschecker also isolates each individual check inside the service so one check crashing doesn't suppress the others. The pipeline executor in `packages/pipeline/src/pipeline/executor.py` only escalates to `ERROR_UNKNOWN` when a service raises out of `run` entirely (the safety net) or to `ERROR_DATA` when a service emits a code in the definition's `terminal_codes` set — currently `DetectionCode.SERVICE_ERROR`, `ParserCode.FILE_OPEN_ERROR`, `ParserCode.BLOCK_PARSING_ERROR`, `ImporterCode.MISSING_DECLARATION_UUID`, `ImporterCode.DB_WRITE_FAILURE`, and the two duplicate/unrecognized codes from detection.

### What information is expected to finalize a data import?
<!-- scenario: submit-a-report; topic: workflow-status -->

**Situation:** The pipeline has finished all checks and pauses at the CONFIRMING interrupt. The import tab shows a "Responsible User" dropdown, a comments box, and Confirm Import / Reject buttons.

**Decision:** The user must pick a name from the user dropdown (populated from `/users`) and click Confirm Import. Comments are optional. The client POSTs to `/sessions/{id}/confirmation` with `action: "confirm"` plus the picked user's full name, email, role, and channel; the API turns those into an audit stamp and writes a CONFIRMED event before launching the importer. Clicking Reject sends `action: "reject"` and writes the session to REJECTED (terminal) without writing any data.

**Rationale:** The importer is the only stage in the pipeline that writes to the target database. Requiring a named user and an explicit click means every row that lands in the DB is attributable to a person who made the call — no implicit imports, no "the tool decided." Reject is offered as a peer action so a reviewer can close out a session that shouldn't be imported without leaving it open.

**Technical detail:** The CONFIRMING interrupt's POST endpoint is in `apps/api/src/api/endpoints.py` (`confirmation_post`). It builds an `AuditStamp` from the request fields (`AuditStamp` is defined in `packages/shared/src/shared/diagnostics.py`) and passes it to the importer via `executor.resume`'s `user_input` dict, where it's set as `context.audit_stamp`. The user list shown in the dropdown comes from the `allowed_users` setting (`packages/shared/src/shared/settings.py`).

### Who is held accountable for an import or deletion?
<!-- scenario: audit-who-did-what; topic: workflow-status -->

**Situation:** A write to the target database — either a confirmed import or a declaration deletion — is about to land.

**Decision:** Both writes carry an audit stamp with the responsible user's full name, email, role, the channel they came through (`importer_web_ui`, `importer_cli`, `datasette_manual`, `api_direct`), and any free-text comments. Import confirmation gets the stamp via the CONFIRMING POST endpoint; deletion gets the stamp via the body of `DELETE /declarations/{uuid}`. Both writes record an event row in addition to the data change, so the database always carries a trail of who touched what and when.

**Rationale:** The target DB is the operational record everyone downstream queries. The only mutations into it are imports and deletions, and both need to be attributable: if data shows up wrong six months later, the audit row is the answer to "who put this here." Channel is recorded because the importer can be driven from the CLI as well as the Web UI and the two have different review flows.

**Technical detail:** `AuditStamp` is defined in `packages/shared/src/shared/diagnostics.py` and uses `EmailStr` validation so a malformed email is rejected at the boundary. Import-time stamps are persisted to `metadata_import_events` in the target DB by the importer service. Deletion stamps are written by `TargetDbManager.delete` in `packages/shared/src/shared/session/target_db_manager.py`, and the API also writes a `SUBMISSION_DELETED` session event with a fresh session_id so the operational event log keeps the deletion as a peer record alongside imports.

### Can a finding be modified or removed from a session?
<!-- scenario: audit-who-did-what; topic: workflow-status -->

**Situation:** Each service in the pipeline produces findings (validation errors, cleaner fills, enrichment matches, consistency warnings). Other services and the review UI consume them.

**Decision:** No. The findings list on `PipelineContext` is append-only. The executor calls `context.findings.extend(report.findings)` after each service runs — never replaces, never edits in place. User corrections submitted at REVIEWING come in as new findings with code `USER_CHOICE` that get appended alongside the originals; the FLAGGED escalation path likewise adds rows rather than mutating existing ones. The original validation finding that triggered a correction stays in the list.

**Rationale:** The cache snapshot at every interrupt has to be exactly what the next stage will see. If a service could quietly drop or rewrite a prior finding, the dashboard the user reviewed could disagree with what the importer actually consumed. Keeping the list append-only means everything that was ever raised is still visible at confirmation time, and the post-hoc record (cache JSON + event log) is a complete account of what each service did.

**Technical detail:** `PipelineContext.findings` is declared as a `list[Finding | ParsingError | DetectionResult]` in `packages/shared/src/shared/pipeline_context.py`, and the only mutation site in the executor is `context.findings.extend(report.findings)` (`packages/pipeline/src/pipeline/executor.py`). Pydantic `extra="forbid"` on the model prevents accidental phantom fields. The mapper's precedence rule (USER_CHOICE wins over cleaner overrides wins over extracted data) is enforced by reading the list and building override maps rather than rewriting earlier entries.

### What takes priority: the user's correction or the tool's suggestion?
<!-- scenario: fix-problems-before-import; topic: workflow-status -->

**Situation:** The cleaner has proposed a fix for a cell (e.g. normalising "n/a" to "Not available"), and the user has separately picked a value in the review dropdown for the same cell.

**Decision:** The user's pick wins. When the mapper builds the row that will land in the target DB, it walks the findings list and constructs a per-cell override map with this precedence: a `USER_CHOICE` finding (the user's pick at review) overrides any cleaner override code (`ENUM_CORRECTED`, `STANDARDIZED_TO_NOT_AVAILABLE`, `STANDARDIZED_TO_NOT_APPLICABLE`, `BLANK_TO_NOT_AVAILABLE`) at the same coordinates, which in turn overrides the original extracted value. `PLACEHOLDER_REMOVED` cells are skipped entirely.

**Rationale:** The cleaner's fills are heuristics — fine when nobody contradicts them, but a reviewer who looked at the cell and picked something else has more context than the rule did. Inverting that precedence would mean the user's explicit pick could be silently overwritten by an automated fix, which is exactly the silent-mutation path the strict-typing review gate was designed to close.

**Technical detail:** The precedence is implemented in the mapper service's correction-collection step at `packages/mapper/src/mapper/mapper_service.py` (the `_OVERRIDE_CODES` tuple is ordered `USER_CHOICE` first, then the cleaning codes). Findings with no `(table_name, table_row_index, field_name)` triple are ignored — the override map only applies to coordinate-anchored corrections.

### What do the Restart and Cancel & Start Over buttons do?
<!-- scenario: submit-a-report; topic: workflow-status -->

**Situation:** The Web UI offers a "Restart" button in the header (always visible during an active session) and a "Cancel & Start Over" button inside the template-confirmation modal that appears when detection is ambiguous.

**Decision:** Both buttons hit the same endpoint and have the same effect — they cancel the session outright. The API writes a `CANCELLED` event (terminal) and deletes the cached `PipelineContext` for the session. There is no undo. The user is returned to the upload zone and any work the pipeline had done — extracted tables, findings, candidate template picks — is gone. At batch level, cancelling cancels every non-terminal member of the batch in one transaction; members already in a terminal state are left untouched.

**Rationale:** "Restart" is the user's mental model — abandon what's there and start clean — and that maps directly to destructive cancellation rather than rewind. Cancelling immediately releases the duplicate-file lock on the file's contents, so a colleague trying to upload the same bytes is unblocked instantly rather than waiting for a TTL. It also takes the session out of the recovery sweep's attention and frees the cache slot.

**Technical detail:** Both Web UI buttons call `window.killSession()` which POSTs to `/sessions/{id}/kill` (`apps/web_ui/app.js` and `apps/web_ui/index.html`). The endpoint handler in `apps/api/src/api/endpoints.py` writes `SessionState.CANCELLED` via the event manager and calls `cache_manager.delete`. The batch-level equivalent is `POST /batches/{id}/kill`, which delegates to `BatchManager.kill_all` (`packages/shared/src/shared/session/batch_manager.py`).

### Can a batch be confirmed if some members are still under review?
<!-- scenario: submit-a-report; topic: workflow-status -->

**Situation:** A fat-file fan-out or multi-upload produces a batch with N member sessions, each progressing independently. The user clicks "Confirm batch" while some members are at CONFIRMING and others are still in the middle of the pipeline.

**Decision:** The bulk confirm is rejected unless every member has reached a decided state. Decided means one of `CONFIRMING` (ready to confirm), `CONFIRMED`, `IMPORTED`, `REJECTED`, `ERROR_DATA`, `ERROR_UNKNOWN`, `CANCELLED`, `EXPIRED`, `SUBMISSION_DELETED`, or `STALE`. If any member is still pending — for example sitting at `REVIEWING` — the endpoint responds 409 with the list of pending members. Once every member is decided, the bulk confirm atomically writes `CONFIRMED` for the subset currently in `CONFIRMING` and leaves members already in terminal states alone. The "Confirm batch" button in the Web UI is disabled until every member is decided.

**Rationale:** Each batch member is an independent declaration — there's no business reason to require all-or-nothing atomicity across them. But forcing the user to make a per-member decision before bulk-committing prevents partial-state surprises: every file in the batch has to be explicitly approved (at its own review step) or rejected before the user can commit the approved subset in one click.

**Technical detail:** `POST /batches/{id}/confirm` delegates to `BatchManager.confirm_atomic` in `packages/shared/src/shared/session/batch_manager.py`. The gate set `_BATCH_DECIDED_STATES` is `TERMINAL_STATES | {CONFIRMING, CONFIRMED, IMPORTED, EXPIRED, SUBMISSION_DELETED, STALE}`. The atomic write only transitions members whose latest state is `CONFIRMING` — already-decided members are returned in the response's `already_terminal` list. The pre-flight failure raises `BatchHasPendingMembers`, which the endpoint translates into the 409 with the pending list.

---

## 4. Template Recognition

### How does the tool identify which template a file uses?
<!-- scenario: submit-a-report; topic: template-recognition -->

**Situation:** An uploaded Excel file needs to be recognized as one of the known EITI templates — v1, v2.0, or v2.1 — before parsing can pick a schema.

**Decision:** Every registered template is scored on the same 0-150 scale, built from three weighted signals. The first signal (50 points) looks at the Introduction sheet for an explicit version string — `Version 2\.1`, `Version 2\.0`, or `Version 1\.\d` as a regex. The second signal (20 points, prorated) checks how many of the template's declared sheets are present, where the declared set comes from the schemas themselves (whatever sheet a schema points at is required). The third signal (80 points, prorated) walks each scoring schema and verifies that its named Excel table, header layout, or key-value labels actually appear in the file. The highest scorer wins.

**Rationale:** A single hard rule (e.g. "exact version string must match") breaks the moment a submitter renames a sheet, edits the Introduction text, or copies tables into a fresh workbook. The weighted blend means missing metadata can be compensated for by structural evidence, and vice versa, so the detector still produces a usable answer on real-world files that drift from the template.

**Technical detail:** Scoring lives in `score_templates` in `packages/parser/src/parser/identification/matcher.py`. Each `SubmissionDefinition` in `packages/parser/src/parser/domain/submissions/registry.py` supplies its `FingerprintRules.version_string` regex and its `schemas` sequence; the schemas whose `used_in_identification` flag is set feed signal C. The dispatcher inside `score_templates` picks one of `_check_standard_table`, `_check_kvp`, or `_check_fixed_columns` per schema type.

### When does a template version qualify as a candidate?
<!-- scenario: submit-a-report; topic: template-recognition -->

**Situation:** After scoring each registered template against the file, the detector has a score for every version. It needs to decide which scores are credible enough to keep in the candidate set the user might be shown.

**Decision:** Any version scoring 40 points or higher is added to the candidate list. A score below 40 is dropped silently — that template is not considered a possible match for this file.

**Rationale:** The cutoff lets the detector tolerate files with significant drift from the template (renamed sheets, missing Introduction text, partial column coverage) without admitting random Excel workbooks that happen to share a sheet name or two. Setting it too high would force a re-upload every time a submitter edited the boilerplate; setting it too low would surface bogus candidates and force needless template-confirmation prompts.

**Technical detail:** The threshold is the literal `if final_score >= 40` check in `score_templates` in `packages/parser/src/parser/identification/matcher.py`. The resulting list flows out as `MatchResult.candidates` and drives the `SUBMISSION_DETECTED` vs `SUBMISSION_AMBIGUOUS` branch in `DetectorService._build_detection_findings`.

### What happens when more than one template could fit?
<!-- scenario: submit-a-report; topic: template-recognition -->

**Situation:** Two or more template versions clear the 40-point candidate threshold against the same file — for example, a v2.0 file whose About sheet has been touched up to look like v2.1, or a v2.1 file with some sheets renamed back to v2.0 names.

**Decision:** The detector emits a `SUBMISSION_AMBIGUOUS` finding listing every candidate with its score, and the pipeline suspends at the SELECTION_CONFIRMING interrupt. The user picks the right version in the template-confirmation modal before parsing begins. There is an additional guard for near ties: if the best candidate beats the runner-up by fewer than 10 points, the detector also clears its internal "best match" pick, so the UI cannot pre-select a version on the user's behalf.

**Rationale:** Each template version has its own schema definitions, validation rules, and clean-table queries. Picking the wrong one would interpret cells against the wrong types and silently corrupt the imported data — the user wouldn't see a parse error, just rows in the wrong shape. A human pick is cheap (a single click) compared to the cost of rolling back a bad import.

**Technical detail:** Near-tie detection is the `NEAR_TIE_THRESHOLD = 10` block in `score_templates` in `packages/parser/src/parser/identification/matcher.py`. The interrupt is registered in `packages/pipeline/src/pipeline/factory.py` (`interrupts.add(SessionState.SELECTION_CONFIRMING)`) and gated in `packages/pipeline/src/pipeline/transition.py`, which checks for `SUBMISSION_AMBIGUOUS` among the detector's findings.

### When does the tool skip the template-confirmation step?
<!-- scenario: submit-a-report; topic: template-recognition -->

**Situation:** Detection has finished. The system needs to decide whether to pause for an explicit user pick or continue straight into parsing.

**Decision:** The SELECTION_CONFIRMING interrupt is skipped only when all three conditions hold: detection was unambiguous (a single candidate), the file declared exactly one cohort, and that cohort was classified NEW (not already in the database). Any deviation — multiple template candidates, multiple cohorts in a fat-file submission, or any cohort already imported — routes through the interrupt so the user can pick a template and/or choose which cohorts to import.

**Rationale:** Skipping confirmation is reserved for the unambiguous SDF happy path, where there's literally nothing for the user to choose between. The moment more than one option exists — template, cohort, or "new vs duplicate" — a silent continuation could write data the user didn't intend (the wrong template's schema, an extra cohort, a clobbered prior import). Forcing an explicit pick in those cases turns each ambiguity into a deliberate decision.

**Technical detail:** The gating logic lives in `packages/pipeline/src/pipeline/transition.py` in `check_transition`. It counts `DetectionCode.COHORT_NEW` and `DetectionCode.COHORT_DUPE` findings, checks for `SUBMISSION_AMBIGUOUS`, and computes `needs_selection = (new_count != 1) or (dupe_count > 0)`. The interrupt fires unless detection is unambiguous and `needs_selection` is false.

### What happens if the tool can't identify the template?
<!-- scenario: submit-a-report; topic: template-recognition -->

**Situation:** No template version scores high enough to land in the candidate set — every registered template falls below the 40-point cutoff against this file.

**Decision:** The detector emits a `SUBMISSION_UNRECOGNIZED` finding and the run terminates with ERROR status. No parsing, enrichment, crosschecking, or import runs against the file. The user sees an error screen explaining that the file does not match any known EITI template.

**Rationale:** Each downstream service is wired to a specific schema. Without a recognized template there is no schema to parse against, no mapper registry to translate cells into target columns, and no clean-table queries to project the data into analysis-ready form. Continuing the pipeline would produce empty or junk findings and waste compute on a file that needs to go back to the submitter.

**Technical detail:** `SUBMISSION_UNRECOGNIZED` is registered as a terminal finding code in `packages/pipeline/src/pipeline/factory.py` (in the `terminal_codes` set alongside `DUPLICATE_SUBMISSION` and `FILE_OPEN_ERROR`). The detector emits it from `_build_detection_findings` in `packages/parser/src/parser/identification/detector_service.py` when `result.candidates` is empty.

### How does the tool handle a table found on the wrong sheet?
<!-- scenario: submit-a-report; topic: template-recognition -->

**Situation:** During scoring, the detector locates an expected named table — say, `Companies` — but finds it on a sheet other than the one the schema expects, or locates a key-value sheet whose name has been changed (e.g. `1_About` renamed to `Part 1 - About`).

**Decision:** The schema's contribution to the file's score is multiplied by 0.5. The table or sheet still counts as found, so the template stays in the running, but with half the points it would have earned from a clean placement. A variation note ("Table 'X' moved to sheet 'Y'" or "KVP Sheet 'X' renamed to 'Y'") is recorded for the report shown to the user.

**Rationale:** Templates are routinely edited by submitters — sheets get renamed, tables get copy-pasted between workbooks. Refusing to recognize a moved table would push too many real submissions into the "unrecognized" path. Halving the score keeps it as evidence without letting it dominate the choice between v2.0 and v2.1, which differ specifically in where some tables live and would otherwise be indistinguishable.

**Technical detail:** The penalty is the `score *= 0.5  # 50% penalty for wrong sheet` line in `_check_standard_table` and the matching `score *= 0.5  # 50% penalty for renamed sheet` line in `_check_kvp`, both in `packages/parser/src/parser/identification/matcher.py`.

---

## 5. Entity Resolution

### How does the tool match a name to an existing entity?
<!-- scenario: trust-the-data; topic: entity-resolution -->

**Situation:** A company, government agency, or project name extracted from the file needs to be linked to an existing record in the external EITI entity database (e.g. matching "Statoil ASA" in a Norwegian file to its database record).

**Decision:** The enricher normalizes the file name and each candidate database name the same way — Unicode transliteration via `unidecode` (so `Petróleos` and `Petroleos` collapse to the same key), whitespace trim, uppercased. An exact match on the normalized form returns the database entity ID with `EXACT` confidence and the match is applied silently. When no exact match exists, the enricher runs fuzzy matching with rapidfuzz WRatio (threshold 86 out of 100) after stripping common corporate suffixes ("INC", "LTD", "AS", "SA", "GMBH", etc.) so they don't dominate the score; any hits above threshold are reported as `AMBIGUOUS` candidates for the user to confirm or reject in the review UI — they are never auto-applied. A name with no exact match and no fuzzy hits above threshold is classified `NEW`.

**Rationale:** Plain string comparison would treat trivially different spellings — accents, casing, trailing whitespace — as distinct entities and balloon the entity table with duplicates of the same company. Auto-applying fuzzy matches would do the opposite damage: silently link a near-miss to the wrong entity, producing a foreign key that points at the wrong record with no straightforward way to detect or unwind it. Routing fuzzy hits to the user for review keeps both failure modes off the table.

**Technical detail:** Normalization is `_normalize` in `packages/enricher/src/enricher/enricher_service.py`; classification is `classify_match` in `packages/enricher/src/enricher/matching.py`. The corporate suffix regex is `_SUFFIX_PATTERN` in the same file; reference names shorter than 4 characters after suffix stripping are excluded from fuzzy matching (the `_MIN_FUZZY_NAME_LENGTH` constant) to prevent abbreviations like "INC." from matching everything. Reference records come from `DatasetteSource` (which hits the public EITI Datasette at `soe-database.eiti.org`) in dev/test environments and from `LocalDbSource` (the deployment's target DB) in staging/prod.

### What identifier is given to a brand-new entity?
<!-- scenario: trust-the-data; topic: entity-resolution -->

**Situation:** A company, agency, or project name in the file matched no existing record in the EITI entity database — and any fuzzy candidates the enricher surfaced were either rejected by the reviewer or never resolved.

**Decision:** The mapper generates a fresh UUID4 and packages it as an `EntityID` with the entity's category as a prefix: `eiti_id_company:<uuid>` for companies, `eiti_id_government:<uuid>` for government entities and agencies, `eiti_id_project:<uuid>` for projects. That ID is written into the ledger row for the entity reference and into the corresponding metadata table (`metadata_companies`, `metadata_gov_entities`, or `metadata_projects`) as a new entry, name and country and reporting date attached.

**Rationale:** Ledger rows need a foreign key to point at, even for entities the EITI database has never seen. Generating a UUID4 locally keeps the importer self-contained — it doesn't have to call out to the central database to mint an ID — while still producing something globally unique so a later reconciliation pass can merge the local record with an upstream one when the entity is eventually registered.

**Technical detail:** UUID assignment is `_complete_new_entities` in `packages/mapper/src/mapper/mapper_service.py`. The field-to-entity-type mapping is the `_ENTITY_FIELD_TYPE` dict at the top of the same file (`company_name` → COMPANY, `full_name_of_entity`/`full_name_of_agency`/`government_agency` → GOV_ENTITY, `project_name` → PROJECT). The prefix values come from `EntityType` in `packages/shared/src/shared/diagnostics.py`. Unresolved `AMBIGUOUS` findings (those where the reviewer never confirmed a candidate) get the same UUID4 treatment as `NEW` ones.

### Why is a company matched globally but agencies and projects per-country?
<!-- scenario: trust-the-data; topic: entity-resolution -->

**Situation:** The enricher needs reference data to match the file's entity names against. It has to decide what scope of the EITI database to pull — every entity of that type across all countries, or only those linked to the file's reporting country.

**Decision:** For the `companies` category the enricher requests every company in the database with no country filter, then matches the file's names against that global list. For `gov_entities` (government agencies) and `projects`, the enricher passes the file's ISO3 country code as a filter on the Datasette query, so the candidate set is restricted to that country.

**Rationale:** Companies routinely operate in more than one country — a multinational that reports in Norway one year may report in Nigeria the next, and the user shouldn't have to maintain a duplicate company record per country. Government agencies and project names, by contrast, are jurisdiction-bound: the "Ministry of Petroleum" in one country has no relationship to the "Ministry of Petroleum" in another, and matching across countries would produce spurious links. Filtering also cuts the candidate set down to a tractable size — a global agency list runs into tens of thousands of names.

**Technical detail:** The branch is the `use_country = country if category != "companies" else None` line in `_fetch_reference_data` in `packages/enricher/src/enricher/enricher_service.py`. The Datasette-side SQL templates in `packages/enricher/src/enricher/datasette_source.py` (`_SQL_COMPANIES`, `_SQL_AGENCIES`, `_SQL_PROJECTS`) build a `WHERE iso_alpha3_code = :p0` clause only when a country is passed.

### How is a declaration uniquely identified?
<!-- scenario: avoid-duplicate-imports; topic: entity-resolution -->

**Situation:** Every imported declaration needs a stable primary key — something the database can use to recognize that two uploads describe the same country-year submission, even if the file content differs.

**Decision:** The declaration's UUID is derived deterministically from the country ISO3 code and the reporting period's start year via UUID5 with a fixed namespace. The same country plus the same year always produces the same UUID, so a re-upload of the Norway 2021 declaration always resolves to the same declaration_uuid no matter how the file was edited in between.

**Rationale:** A deterministic identifier means the duplicate detector, the importer, and the cohort-existence check all derive the same key from the same inputs without needing to coordinate through a sequence or a lookup table. It also lets the importer's "re-import deletes prior rows" rule work — the new write targets exactly the same primary key as the old one. Random UUIDs would make every re-upload look like a fresh declaration.

**Technical detail:** The namespace is the fixed `DECLARATION_NAMESPACE` UUID at the top of `packages/shared/src/shared/diagnostics.py`. The derivation is `uuid5(DECLARATION_NAMESPACE, f"{country_iso3}:{year}")` in three places that must agree: `DetectorService._build_detection_findings` (emits the finding), `_sdf_existence_key` in `packages/parser/src/parser/domain/submissions/registry.py` (looks up duplicates in the target DB), and the mapper (writes the row).

### What does the tool treat as a single submission for duplicate detection?
<!-- scenario: avoid-duplicate-imports; topic: entity-resolution -->

**Situation:** A file is uploaded. The tool needs to figure out which already-imported declaration, if any, the file conflicts with.

**Decision:** Duplicate detection runs per cohort, not per file. Every submission type declares a `cohort_schema` describing the cohorts it can contain: an SDF submission produces one `SDFCohort` with a country and a year, while fat-file submissions (validation extracts, API extracts) produce many cohorts from a single workbook. The detector materializes the cohort list inside the workbook's lifetime, emits one `COHORT_DETECTED` finding per cohort, and then for each cohort checks the target database — emitting `COHORT_NEW` if no row with that existence key exists or `COHORT_DUPE` if one does.

**Rationale:** A fat file covering fifty country-years might have forty-eight cohorts the database has never seen and two that were already imported. Treating the whole file as one unit would force the user to either delete the two prior imports or rebuild the file without them before proceeding. Per-cohort classification lets the user import the forty-eight new ones in one go and decide explicitly what to do with the two overlapping ones.

**Technical detail:** `CohortSchema` in `packages/parser/src/parser/domain/submissions/models.py` is generic over `CohortT` — each submission narrows it (`SDFCohort` in `packages/parser/src/parser/domain/submissions/registry.py` is a TypedDict with `country_iso3` and `year`). The classification loop is `DetectorService._classify_cohorts` in `packages/parser/src/parser/identification/detector_service.py`, which calls `TargetDbManager.exists()` per cohort. The matcher invokes `cohort_schema.extractor(ctx)` inside `identify_template` and wraps the result in `list(...)` so lazy iterators don't escape the workbook's scope.

### What happens when the user uploads a file that's already imported?
<!-- scenario: avoid-duplicate-imports; topic: entity-resolution -->

**Situation:** The detector has finished cohort classification. It now knows, for each cohort the file declared, whether the target database already holds a matching declaration.

**Decision:** Three branches, decided by the per-cohort counts:
- Every cohort is DUPE: the detector appends a terminal `DUPLICATE_SUBMISSION` finding and the run ends in `ERROR_DATA`. The user has to delete the prior import explicitly and re-upload to proceed.
- A mix of NEW and DUPE, or several NEW cohorts: the pipeline pauses at the SELECTION_CONFIRMING interrupt and the user picks which cohorts to import.
- Exactly one NEW cohort and zero DUPE cohorts: the pipeline continues silently to parsing.

**Rationale:** All-DUPE almost always means the user uploaded the wrong file or forgot a prior import existed — failing loudly forces a deliberate decision (re-import means delete-then-upload) rather than silently overwriting. Mixed cases need a human in the loop because the right answer depends on intent: the user may want a corrected re-import of the duplicates, may want to skip them, or may want to cancel entirely. The silent continuation is reserved for the unambiguous case where there's nothing to choose between.

**Technical detail:** The all-DUPE branch is the `if classification.new_count == 0 and classification.dupe_count > 0` block in `DetectorService.run` in `packages/parser/src/parser/identification/detector_service.py`; `DUPLICATE_SUBMISSION` is in the pipeline's `terminal_codes` set in `packages/pipeline/src/pipeline/factory.py`. The mixed/multi-new branch is gated by `needs_selection = (new_count != 1) or (dupe_count > 0)` in `check_transition` in `packages/pipeline/src/pipeline/transition.py`.

### Why doesn't the tool guess on close matches?
<!-- scenario: trust-the-data; topic: entity-resolution -->

**Situation:** The enricher has a near-match between a file's entity name and a database record — close enough that a fuzzy scorer rates it high, but not an exact normalized match. The tool has to decide whether to apply that match automatically or ask the user.

**Decision:** Fuzzy candidates above the score threshold are surfaced to the user as an `AMBIGUOUS` finding with the candidate list attached, never auto-applied. If the user picks one in the review UI, that selection becomes the entity ID. If the user doesn't pick (or rejects all candidates), the mapper assigns a fresh UUID4 and treats the name as a new entity.

**Rationale:** The two failure modes are not equally recoverable. A false negative — treating "Statoil ASA" as new when the database already has it — is fixable: the mapper assigns a UUID4, and a later dedup pass can merge it with the correct record by name comparison. A false positive — linking "Statoil ASA" to the wrong company at, say, score 87 — corrupts the foreign key silently. The ledger row points at the wrong entity, no validation rule will catch it, and there's no automated path to find and fix it afterwards. The asymmetry makes "ask the user when uncertain" the conservative default.

**Technical detail:** The threshold is `DEFAULT_THRESHOLD = 86` in `packages/enricher/src/enricher/matching.py`; the comment there explains it's a noise plateau from shared corporate suffixes. The UUID4 fallback for unresolved AMBIGUOUS findings is the `if f.code == EnrichmentCode.AMBIGUOUS: ... if coord in resolved_coords: continue` block in `_complete_new_entities` in `packages/mapper/src/mapper/mapper_service.py` — only AMBIGUOUS findings the user explicitly resolved during review are skipped; the rest fall through to the same UUID4 assignment as NEW.

---

## 6. Consistency Rules

### Why does the tool warn about Part 5 entities missing from Part 3?
<!-- scenario: trust-the-data; topic: consistency-rules -->

**Situation:** Part 5 (company payments) references company names, government-agency names, and project names. Part 3 (reporting entities) is where those same entities are registered with their full metadata. A Part 5 row that names a company, agency, or project that doesn't appear in Part 3 means either a typo in the payments table or a missing Part 3 registration.

**Decision:** For each Part 5 row, the tool reads the company, agency, and project fields and looks them up in the corresponding Part 3 tables. Unmatched names produce one finding per offending row, tagged with a role-specific code: UNREGISTERED_COMPANY, UNREGISTERED_AGENCY, or UNREGISTERED_PROJECT. The reference set is rebuilt per file from the Part 3 Companies, Government_agencies, and Projects tables (v2.1) or their v2.0 equivalents (Companies, Government_agencies, Companies15-as-projects). For v1 the only Part 3 table is companies_v1 (company_name); agencies and projects don't exist as separate tables, so those checks don't run.

**Rationale:** Part 5 reconciles per-entity payments against the Part 3 register. An entity in Part 5 but not in Part 3 either won't reconcile at all or will reconcile against a registration that doesn't exist — both indicate the file was edited inconsistently. Flagging this lets the reviewer either add the registration in the source file or correct the Part 5 spelling before import.

**Technical detail:** `_check_part5_references` in `packages/crosschecker/src/crosschecker/crosschecker_service.py` consumes the per-version configs declared in `packages/pipeline/src/pipeline/profiles/summary_v1.py`, `summary_v2p0.py`, and `summary_v2p1.py`. Sentinel strings ("Not available", "Not applicable") are filtered via `is_real_string` before set membership so they never produce 'unregistered company "Not available"' findings.

### Why does the tool warn about revenue streams in Part 5 not found in Part 4?
<!-- scenario: trust-the-data; topic: consistency-rules -->

**Situation:** Part 4 (government revenues) is where each revenue stream is named once, alongside its GFS classification and the government entity that collected it. Part 5 rows then attribute payments to those streams. A stream name in Part 5 with no matching entry in Part 4 means the two sides of the reconciliation are looking at different stream vocabularies.

**Decision:** The reference set is the `revenue_stream_name` column of the Part 4 government revenues table (`government_revenues_v1` for v1, `Government_revenues_table` for v2.0/v2.1). For each Part 5 row, the `revenue_stream_name` value is looked up in that set; misses emit a MISSING_REVENUE_STREAM finding referencing the row. Sentinel-valued cells are skipped so "Not available" doesn't surface as a missing stream.

**Rationale:** Reconciliation groups payments by revenue stream and sums each side. If Part 5 reports a payment against "Corporate income tax" while Part 4 calls the same stream "Corporate tax", they reconcile as two distinct streams with zero match. Flagging the mismatch lets the reviewer harmonise the names in the source file before reconciliation produces nonsense gaps.

### Are entity names compared case-sensitively?
<!-- scenario: trust-the-data; topic: consistency-rules -->

**Situation:** The same entity often appears with minor capitalisation differences across parts of the same file — "ABC Mining Ltd" in Part 3, "ABC Mining LTD" in Part 5.

**Decision:** Both sides are lowercased before set membership is checked. The reference set built from Part 3/4 is lowercased; each Part 5 value is `.strip().lower()` before lookup. No transliteration, no whitespace collapse, no fuzzy match — only a case fold.

**Rationale:** Capitalisation differences are noise. Anything beyond case folding (Unicode normalisation, fuzzy matching) risks merging entities that genuinely differ. Case folding catches the common typo class without introducing false positives.

**Technical detail:** `_check_part5_references` in `packages/crosschecker/src/crosschecker/crosschecker_service.py` builds `ref_lower = {n.lower() for n in ref_set}` and compares against `name.lower()`. Note that case-insensitivity here is the consistency-check rule and is separate from the enricher's entity-resolution normalisation, which also handles Unicode transliteration.

### What happens when a required table is found but empty?
<!-- scenario: trust-the-data; topic: consistency-rules -->

**Situation:** The parser located a government-revenues or company-payments table (the sheet exists, the anchor was found) but it has zero data rows. This is distinct from a missing table — the parser reports those upstream as SHEET_NOT_FOUND or BLOCK_PARSING_ERROR during extraction.

**Decision:** The table-completeness check emits GOV_REVENUE_TABLE_EMPTY or COMP_PAYMENTS_TABLE_EMPTY, naming the table that was found empty and stating which side of the reconciliation gap can't be computed. The check applies uniformly to v1, v2.0, and v2.1: every EITI summary file is expected to have both a government-revenue table and a company-payments table.

**Rationale:** Zero-row tables produce silently zero totals downstream — reconciliation would show a 100% gap or a meaningless "0 vs 0 match". Surfacing the empty table as a distinct finding tells the reviewer the parser ran but found no data, which is a different remediation than a parser failure (and points to the source file rather than the tool).

**Technical detail:** `_check_table_completeness` in `packages/crosschecker/src/crosschecker/crosschecker_service.py`. Table names are read from `TABLE_KEYS` in `packages/shared/src/shared/submission_metadata.py`, keyed by SubmissionID. The check is deliberately silent on missing tables to avoid duplicating parser findings.

### When does the tool flag a per-row currency mismatch?
<!-- scenario: reconcile-government-vs-companies; topic: consistency-rules -->

**Situation:** V2.0 and v2.1 Part 4 rows carry a `currency` column and Part 5 rows carry a `reporting_currency` column. The About sheet separately declares the file's overall reporting currency. Rows that report a payment in a currency other than the file's reporting currency need an explicit conversion to reconcile.

**Decision:** For each row in the gov and company tables, the row's currency cell is stripped and compared to the About-sheet reporting currency. Differences emit GOV_CURRENCY_MISMATCH or COMP_CURRENCY_MISMATCH per row, including the row's currency and the reporting currency in the message. Empty cells in the row currency column are skipped (treated as "inherits from About"). V1 has no per-row currency columns, so the entire check returns early for v1 files.

**Rationale:** Reconciliation assumes all rows on a side share a currency. A mixed-currency table is legitimate (a country may have collected some streams in USD and the rest in local currency) but requires the exchange rate to be present and correct. The finding tells the reviewer to verify the conversion before approving the import.

**Technical detail:** `_check_currency_consistency` and `_collect_currency_mismatches` in `packages/crosschecker/src/crosschecker/crosschecker_service.py`. Per-row field names come from `CURRENCY_FIELD` in `packages/shared/src/shared/submission_metadata.py` — v2.0/v2.1 gov rows use `currency`, comp rows use `reporting_currency`; v1 has `null` for both, which short-circuits the check.

### What happens to per-row currency checks if the reporting currency is missing?
<!-- scenario: reconcile-government-vs-companies; topic: consistency-rules -->

**Situation:** The About sheet does not declare a reporting currency, but the file is v2.0 or v2.1 (so per-row currency columns exist in Part 4 and Part 5).

**Decision:** A single NO_REPORTING_CURRENCY finding is emitted against the About table, and the per-row currency loops are skipped entirely. No GOV_CURRENCY_MISMATCH or COMP_CURRENCY_MISMATCH findings are produced.

**Rationale:** Without a reference currency from the About sheet, there is nothing to compare each row's currency against. Emitting one finding per row would flood the review UI with noise that all points at the same root cause. One About-level finding tells the reviewer exactly which field needs to be filled in the source file.

### Do consistency warnings block import?
<!-- scenario: trust-the-data; topic: consistency-rules -->

**Situation:** The crosschecker has produced findings — unregistered Part 5 entities, mismatched revenue streams, currency mismatches, empty tables, or totals discrepancies.

**Decision:** All crosscheck findings are categorised as FindingCategory.CROSSCHECK. They raise the session status to NEEDS_REVIEW but do not raise it to BLOCKED. Only source-only validation errors block import. The user can acknowledge each crosscheck finding in the review UI and then proceed to Confirm Import.

**Rationale:** Crosscheck findings often have legitimate explanations — an entity registered under a slightly different spelling, a deliberate currency mix in a country reconciliation, a known data quirk the operator wants to import anyway. Forcing the submitter to re-export the source file for every unregistered-name finding would block routine work for cases that don't actually require correction. Leaving the gate to a human reviewer matches the warning's actual epistemic status: "worth a look", not "definitely wrong".

### What does the tool do with 'Total' rows already in the file?
<!-- scenario: trust-the-data; topic: consistency-rules -->

**Situation:** EITI templates include pre-computed total rows alongside the data tables. In v2.0 and v2.1 these appear as labels like "Total in USD" / "Total in EUR" sitting below the government revenues and company payments tables; in v1 the government revenues sheet carries "TOTAL, disclosed by government" and "TOTAL, reconciled" single-row aggregates.

**Decision:** The parser pulls each total as its own table — `Government_revenues_table_totals` and `Table10_totals` (v2.0) / `Gov_revs_comp_proj_totals` (v2.1) via a KVP_SCAN extractor that matches the `total in <currency>` pattern; `government_revenues_v1_totals` via a header-search extractor for v1. The totals crosscheck then independently sums the corresponding data table — grouped by currency for v2.0/v2.1, scalar for v1 — and compares each in-file total to the computed sum. Differences greater than 1.0 currency unit emit GOV_TOTAL_MISMATCH or COMP_TOTAL_MISMATCH; smaller differences are accepted silently.

**Rationale:** Excel's SUMIF rounding drifts by sub-cent amounts between the pre-computed cell and a fresh sum over the same rows. A strict equality check would flag every file. The 1.0-unit tolerance absorbs that rounding noise while still catching genuine inconsistencies — a stale total left behind after a row was edited, or a SUMIF whose range no longer covers the full table.

**Technical detail:** `TotalsSpec` in `packages/crosschecker/src/crosschecker/crosschecker_service.py` (tolerance defaults to 1.0); per-version configs in `packages/pipeline/src/pipeline/profiles/summary_v1.py`, `summary_v2p0.py`, `summary_v2p1.py`. Extraction schemas: `GOV_TOTALS_SCHEMA_V1` (HeaderSearch) in `packages/parser/src/parser/domain/schemas/v1.py`; `GOV_TOTALS_SCHEMA_V2P0` / `COMP_TOTALS_SCHEMA_V2P0` (KvpScan, pattern `^total in (.+)`) in `v2p0.py`; same shape in `v2p1.py`.

---

## 7. Import Behavior

### What happens if the user re-imports a declaration?
<!-- scenario: submit-a-report; topic: import-behavior -->

**Situation:** A confirmed import lands on a country/year that already has ledger rows in the target database. The duplicate-detection layers either let it through (the prior import was deleted) or the user explicitly chose to re-import after acknowledging the collision.

**Decision:** Before writing the new ledger rows, the importer issues `DELETE FROM <ledger_table> WHERE eiti_id_declaration = :uuid` against every registered ledger table for the declaration's UUID, then bulk-inserts the new rows. The clean tables are regenerated from the fresh ledger by the `INSERT...SELECT` queries declared in the submission's `clean_queries`. Reference and entity metadata rows go in with `INSERT OR IGNORE` so the second run doesn't try to re-create the same country, currency, or company.

**Rationale:** Re-import is a replacement, not an append — adding rows on top of the prior set would double the numbers in every aggregate. Wiping the ledger by declaration UUID before writing makes the operation idempotent: the row count after two imports of the same file equals the row count after one.

**Technical detail:** Implemented in `packages/importer/src/importer/import_service.py` step 6 (ledger delete) and step 8 (`_generate_clean_tables`). The clean tables don't need an explicit delete — the `INSERT...SELECT` queries are written to overwrite per-declaration data when the ledger is replaced.

### What happens to reference data from multiple files of the same country?
<!-- scenario: cross-cutting; topic: import-behavior -->

**Situation:** Two declarations from the same country are imported. Both files reference the same currency, the same GFS codes, and some of the same companies, agencies, and projects.

**Decision:** Every metadata write uses `INSERT OR IGNORE`. Reference tables (`metadata_countries`, `metadata_currencies`, `metadata_gfs_codes`, `metadata_submission_types`) dedupe on their natural-key primary key. Entity tables (`metadata_companies`, `metadata_gov_entities`, `metadata_projects`) and the name-dedup tables (`metadata_sectors`, `metadata_commodities`) dedupe on their unique business keys. The summary-data-file row is the only metadata write that uses upsert (`ON CONFLICT DO UPDATE` on `eiti_id_declaration`) because a re-import legitimately replaces that record.

**Rationale:** Each file carries its own copy of the reference rows it needs — there's no separate "load the reference data once" step. `INSERT OR IGNORE` lets the importer treat every file as self-contained while still converging on a single row per real-world entity in the database.

**Technical detail:** Table classification lives in `_UPSERT_TABLES`, `_ENTITY_TABLES`, and `_METADATA_TABLES` in `packages/importer/src/importer/import_service.py`. The write path for all of them is `_write_metadata_rows`, which calls `generate_insert(model_cls, or_ignore=True)`.

### What is kept when a declaration is deleted?
<!-- scenario: audit-who-did-what; topic: import-behavior -->

**Situation:** The user deletes a declaration from the data management tab.

**Decision:** All clean-table and ledger rows for that `eiti_id_declaration` are hard-deleted in FK order — clean tables first, then ledger tables. The `metadata_summary_data_files` row is soft-deleted (`is_deleted = 1`) rather than removed, and a `metadata_import_events` row with `event_type = submission_deletion` is written carrying the responsible user's name, email, role, channel, and a `log_summary` of how many rows were deleted from each table. The `metadata_users` row for the deleter is inserted alongside it.

**Rationale:** The data itself goes — the deleter explicitly asked for that and a soft-deleted row would still satisfy downstream aggregates. The audit pair (the soft-deleted SDF row plus the deletion event) stays so a future operator can answer "who deleted the Afghanistan 2014 declaration, when, and why" without consulting external logs. The soft-delete flag also powers the dedup carve-out: a re-upload of the same file after deletion is allowed.

**Technical detail:** Implemented in `TargetDbManager._do_delete` at `packages/shared/src/shared/session/target_db_manager.py`. The hash lookup that enforces upload dedup filters with `NOT EXISTS (SELECT 1 FROM metadata_summary_data_files WHERE import_event_id = ie.id AND is_deleted = 1)` so soft-deleted prior imports do not block a fresh upload.

### What does the user have to do to delete a declaration?
<!-- scenario: audit-who-did-what; topic: import-behavior -->

**Situation:** The user clicks "Delete" on a declaration in the data management tab.

**Decision:** Two-step confirmation. First the user fills the responsible-user form (full name, email, role, channel) and clicks "Delete permanently"; the request goes to `DELETE /declarations/{declaration_uuid}` with the user identity in the body. Before the request fires, the browser's `confirm()` dialog asks again. Without both — a chosen user and an accepted browser dialog — nothing happens.

**Rationale:** Deletion is irreversible at the data level: the ledger rows and clean tables are hard-deleted. Requiring a deliberate identity + an OS-level confirm keeps a misclick from wiping a declaration, and the captured user identity is what the audit event records.

**Technical detail:** Endpoint `delete_declaration` in `apps/api/src/api/endpoints.py` requires a `DeleteRequest` body (`full_name`, `email`, `role`, `channel`). It constructs an `AuditStamp` and calls `TargetDbManager.delete`.

### Why might an import fail at the last step?
<!-- scenario: submit-a-report; topic: import-behavior -->

**Situation:** Every prior pipeline stage succeeded, the user confirmed, and the importer is running — but it can't find a `declaration_uuid` to write against.

**Decision:** The importer reads the declaration UUID from the `CELL_MAPPED` finding on the synthetic `about` table (`table_name == "about"`, `field_name == "declaration_uuid"`). If that finding is missing, it returns a single `MAPPING` finding with code `MISSING_DECLARATION_UUID` and writes nothing. The session lands in an error-data state. Any genuine database write failure further down (constraint violation, connection drop) is caught separately and produces a `DB_WRITE_FAILURE` finding with the underlying exception text.

**Rationale:** `eiti_id_declaration` is the foreign key on every ledger row and the primary key on `metadata_summary_data_files` — there is literally no row the importer could write without it. Erroring loud-and-early at the importer is better than letting a `NOT NULL` violation surface mid-bulk-insert with a partial commit.

**Technical detail:** Logic in `ImporterService.run` and `_get_metadata_value` in `packages/importer/src/importer/import_service.py`. The UUID is a `uuid5(DECLARATION_NAMESPACE, f"{country_iso3}:{year}")` produced by the detector and surfaced as a `CELL_MAPPED` finding by the mapper.

### What kinds of duplicate uploads does the tool catch?
<!-- scenario: avoid-duplicate-imports; topic: import-behavior -->

**Situation:** A user uploads a file that may already exist in the system, either as a committed import, as an in-flight session, or as a different file claiming the same identity.

**Decision:** Three layers, each catching a different failure shape:

- **Layer 1 — file-content hash at upload.** `POST /uploads` computes SHA-256 of the bytes and calls `TargetDbManager.find_active_import_by_hash`, which queries `metadata_import_events` for a `file_import` event with `status = success` whose linked `metadata_summary_data_files` row is not soft-deleted. A match returns 409 with the prior `source_identifier`, `event_timestamp`, and `eiti_id_declaration`.
- **Layer 2 — cohort classification at identification.** `DetectorService` runs the submission's `cohort_schema.extractor` over the workbook, emits one `COHORT_DETECTED` finding per cohort, then calls `TargetDbManager.exists` on each cohort's existence key. Cohorts are tagged `COHORT_DUPE` or `COHORT_NEW`. All-DUPE adds a terminal `DUPLICATE_SUBMISSION` finding and pushes the session to `ERROR_DATA`; any other mix routes to the `SELECTION_CONFIRMING` interrupt.
- **Layer 3 — file-content hash at confirmation.** `POST /sessions/{id}/confirmation` re-runs `find_active_import_by_hash` (catches a commit between upload and confirm) and also calls `EventManager.find_active_sessions_by_hash` to detect in-flight peer sessions whose latest state is not in `DEDUP_INACTIVE_STATES`. Either match returns 409.

**Rationale:** Each layer has a different blast radius. Layer 1 is the cheapest and catches the common case before any pipeline work begins. Layer 2 handles the semantic case — the file was edited but still represents the same declaration. Layer 3 is structural; rare on a single-user team but closes a timing window the other two cannot.

**Technical detail:** Layers 1 and 3 use SHA-256 over the upload bytes, indexed on `metadata_import_events.file_sha256`. Layer 2 is driven by the submission's `cohort_schema` and its `existence_key` function.

### Can the user re-upload the same file after deleting the prior import?
<!-- scenario: avoid-duplicate-imports; topic: import-behavior -->

**Situation:** A user deleted a declaration and re-uploads the same file (identical bytes).

**Decision:** The hash lookup that backs Layers 1 and 3 ignores soft-deleted prior imports. `find_active_import_by_hash` joins `metadata_import_events` to `metadata_summary_data_files` and applies `NOT EXISTS (SELECT 1 FROM metadata_summary_data_files sdf_check WHERE sdf_check.import_event_id = ie.id AND sdf_check.is_deleted = 1)`. Since deletion flips `is_deleted` to 1 on the SDF row, the prior event is excluded and the new upload proceeds.

**Rationale:** Deletion is the user's "let me try again" signal. Permanent blocking would force them to mutate the file just to satisfy the dedup check, defeating the recovery path the delete button exists for.

**Technical detail:** Query in `TargetDbManager.find_active_import_by_hash` at `packages/shared/src/shared/session/target_db_manager.py`.

### Can the user retry the same file after an import failure?
<!-- scenario: avoid-duplicate-imports; topic: import-behavior -->

**Situation:** A user's earlier attempt to import the same file failed partway through — either the importer raised `DB_WRITE_FAILURE` or the pipeline crashed before commit.

**Decision:** Layer 1 and Layer 3 only consider prior `metadata_import_events` rows with `status = success`. A failed attempt either never reached the importer (no event row written) or wrote an event with a non-success status; in both cases the hash lookup returns `None` and the new upload passes the dedup check.

**Rationale:** Retrying after a failure is a legitimate next step. Blocking it would force the user to alter the file just to get past the check, which is friction without integrity value.

**Technical detail:** The `find_active_import_by_hash` query filters with `ie.status = :status` where `:status` is `ImportStatus.SUCCESS.value`. Defined in `packages/shared/src/shared/session/target_db_manager.py`.

### When is duplicate detection by file hash skipped?
<!-- scenario: operate-at-scale; topic: import-behavior -->

**Situation:** A developer iterates on a fixture file on their laptop, repeatedly re-uploading it.

**Decision:** Hash-based duplicate detection is gated by `Settings.dedup_uploads_by_hash`. The LOCAL profile sets it to `False`; the DEV, TEST, STAGING, and PROD profiles set it to `True`. Both the upload-time check and the confirmation-time check guard their body with `if settings.dedup_uploads_by_hash:` — when False, both branches no-op and no SHA-256 dedup runs at either point. There is no per-request bypass; an HTTP caller cannot ask the server to skip the check.

**Rationale:** On a developer's machine, dedup just creates friction: every test upload would need a database reset first, with no integrity benefit at a single-developer workstation. Server environments enforce dedup uniformly so no caller can quietly disable it.

**Technical detail:** Field defined in `packages/shared/src/shared/settings.py` (`dedup_uploads_by_hash: bool | None = None`, profile-driven). Consumed at `endpoints.upload` and `endpoints.confirmation_post` in `apps/api/src/api/endpoints.py`.

### What happens when a colleague's stuck session blocks the user from confirming a file?
<!-- scenario: avoid-duplicate-imports; topic: import-behavior -->

**Situation:** User B uploads a file whose contents match an in-flight session that User A started and walked away from. Without intervention, User B would be blocked from confirming until User A's session expires.

**Decision:** At `POST /sessions/{id}/confirmation`, after the committed-import check, the endpoint calls `EventManager.find_active_sessions_by_hash` to find every other session whose `UPLOADED` event carries the same SHA-256 and whose latest state is not in `DEDUP_INACTIVE_STATES` (terminal + IMPORTED + EXPIRED + SUBMISSION_DELETED + STALE). If any are found, the 409 body carries `sibling_session_ids`, `sibling_batch_ids`, and a `release_actions` list — one entry per sibling session pointing at `POST /sessions/{sid}/kill`, plus one per sibling batch pointing at `POST /batches/{bid}/kill`. The Web UI surfaces this as a "Cancel that session and retry" modal; the CLI surfaces it as a `questionary` prompt offering the same choice.

**Rationale:** Without an explicit release path, the only way to unblock would be to wait for the abandoned session to time out — operationally unacceptable when a colleague's legitimate work is held up. An idle-session auto-release based on activity tracking would need infrastructure that doesn't exist yet, so it's deferred; the discoverable release action is the interim answer.

**Technical detail:** Sibling lookup in `EventManager.find_active_sessions_by_hash` at `packages/shared/src/shared/session/event_manager.py`. Response shape assembled in `confirmation_post` at `apps/api/src/api/endpoints.py`. The kill endpoints write a `CANCELLED` event and delete the cached `PipelineContext`, which releases the hash slot immediately.

---

## 8. Version Differences

### Does v1 use Excel's named tables?
<!-- scenario: compare-across-versions; topic: version-differences -->

**Situation:** Excel files can declare formal named ranges with explicit row/column boundaries via the Tables feature. v2.0 and v2.1 templates use this for their Part 3, 4, and 5 tables (`Companies`, `Government_agencies`, `Government_revenues_table`, `Gov_revs_comp_proj`, etc.). The v1 template (Version 1.1, March 2015) was authored before that convention was adopted.

**Decision:** Every v1 schema uses an anchor-based extractor — `HeaderSearchSchema`, `KeyValuePairsSchema`, `PivotHeaderSchema`, or `PivotTableSchema` — which locates each region by scanning for landmark text in a specific column ("GFS codes" in column B, "Legal name" in column H, "Conversion rate" in the About sheet). No v1 schema uses `NamedTableSchema` or `NamedTableColumnsSchema`. The v2.x extractors do try the named-table metadata first and fall back to anchor search if it's missing, but v1 doesn't have the named-table metadata to try in the first place.

**Rationale:** v1 files won't have the Excel named-range metadata regardless of country or year, so anchor-based extraction is the only path that will find anything. Building it that way keeps v1 extraction tolerant of the minor layout drift seen in real fixtures (Gabon and CAR files truncate the "GFS Descriptions" header, for example) without coupling v1 to a feature its template never used.

**Technical detail:** v1 schemas live in `packages/parser/src/parser/domain/schemas/v1.py`. Locator dispatch in `packages/parser/src/parser/extraction/excel_reader.py` maps `NAMED_TABLE` → `NamedTableLocator` (used by v2.x) and `HEADER_SEARCH` → `HeaderSearchLocator` (used by v1).

### Does v1 collect data on projects and agencies?
<!-- scenario: compare-across-versions; topic: version-differences -->

**Situation:** v2.0 and v2.1 templates have a dedicated `Government_agencies` table on Part 3 and a separate Projects table (`Companies15` in v2.0, `Projects` in v2.1). v1's revenue sheet is a single tab ("3. Revenues") with companies embedded as column headers; there is no agency table, no project table, and no concept of a project entity in the schema.

**Decision:** The v1 profile declares only `part3_companies` in `crosscheck_entities` and only `companies` + `gov_entities` (sourced from `government_revenues_v1.government_agency`, not a separate table) in `enrichment_sources`; `projects` is `None`. The Part 5 reference scan checks only the `company` and `stream` roles, never `agency` or `project`. Clean tables omit project and agency tables for v1 entirely.

**Rationale:** The data simply doesn't exist in a v1 file. Wiring crosscheck or enrichment for absent tables would produce constant findings of the shape "Part 3 agencies table not found" for every v1 file, drowning the real signal.

**Technical detail:** v1 profile config in `packages/pipeline/src/pipeline/profiles/summary_v1.py` (notably `enrichment_sources["projects"] = None`, `project_table=None`, and the absence of `part3_agencies`/`part3_projects` keys in `crosscheck_entities`). `TABLE_KEYS["summary_v1"]["projects"]` is `null` in `packages/shared/src/shared/stats_config.json`.

### Does v1 declare currency per row?
<!-- scenario: compare-across-versions; topic: version-differences -->

**Situation:** v2.0 and v2.1 rows carry their own currency code (gov rows in a `currency` column, comp rows in a `reporting_currency` column), which lets a single file mix payments reported in different currencies. v1 has no such column on either Part 4 or its company-revenue cross-tab — the only currency declaration in a v1 file is the About sheet's "ISO currency code".

**Decision:** In `packages/shared/src/shared/stats_config.json`, `currency_field.summary_v1` is `{"gov": null, "comp": null}` for both sides. The currency-consistency check reads this dispatch and short-circuits when both fields are null — no per-row comparison runs, no GOV_CURRENCY_MISMATCH or COMP_CURRENCY_MISMATCH findings are ever produced for v1 files. The stats engine treats every v1 row as being in the About-sheet reporting currency. The totals crosscheck for v1 uses a scalar comparison (no `group_by`), while v2.x groups totals by currency.

**Rationale:** v1 files genuinely have only one currency per declaration. A per-row check would have nothing to compare against; running it would either produce noise or invent currencies that aren't in the file. Treating the About-sheet currency as the single source of truth matches how v1 reports actually compute totals.

### How is the v1 revenue sheet shaped compared to v2?
<!-- scenario: compare-across-versions; topic: version-differences -->

**Situation:** v2.x lays out company payments as one row per (company, revenue stream) pair on a dedicated Part 5 sheet, with `company`, `revenue_stream_name`, `revenue_value`, and `reporting_currency` as columns. v1 puts companies as column headers (row 4 of the "3. Revenues" sheet, starting at column I) and GFS revenue streams as rows; each (row, column) cell is a single payment value — a classic cross-tab pivot.

**Decision:** The v1 company-revenue schema uses a custom `PivotTableSchema` extractor. At extraction time, `PivotTableReader` walks each data row, then for every populated company column emits one flat output row carrying `gfs_code`, `gfs_description`, `revenue_stream_name`, `government_agency` (from the row), plus `company_name` (from the column header on row 4) and `revenue_value` (the cell value). Cells with `None` are skipped, so a sparse cross-tab doesn't produce zero-payment rows. The output of `company_revenues_v1` has the same row-per-payment shape as v2.x's `Table10` / `Gov_revs_comp_proj`, so the crosschecker, enricher, mapper, and importer treat all three versions through one set of code paths.

**Rationale:** Forcing every downstream consumer to handle the pivot would scatter v1-specific logic through the crosscheck, mapper, and clean-query layers. Normalising to a flat row-per-payment table at the extraction boundary contains the version-specific shape work in one place (the pivot reader) and lets every subsequent service stay version-agnostic.

**Technical detail:** `COMPANY_REVENUE_SCHEMA_V1` and `_discover_company_columns` in `packages/parser/src/parser/domain/schemas/v1.py`; `PivotTableLocator` and `PivotTableReader` in `packages/parser/src/parser/extraction/location_strategies.py`. Company metadata (id, sector, commodities) lives in the same pivot header and is extracted separately by `COMPANY_HEADER_SCHEMA_V1` (PivotHeaderSchema) into `companies_v1`.

### Why does v2.0 reference internal Excel table names that don't match the data?
<!-- scenario: compare-across-versions; topic: version-differences -->

**Situation:** The v2.0 template (July 2019) ships with two internal Excel named-table identifiers that conflict with what they actually contain. The Projects table on "Part 3 - Reporting entities" is named `Companies15` in the workbook XML — not `Projects` — and the Part 5 company-data table on "Part 5 - Company data" is named `Table10` rather than the descriptive `Gov_revs_comp_proj` used in v2.1. These are the literal strings stored in `xl/tables/*.xml` inside the .xlsx and what `openpyxl`'s `sheet.tables` lookup returns.

**Decision:** The parser uses those literal Excel names verbatim. `REPORTING_PROJECTS_SCHEMA_V2P0` sets `table_name="Companies15"`; the v2.0 Part 5 schema sets `table_name="Table10"`. The same names cascade through `stats_config.json` (`TABLE_KEYS["summary_v2.0"]` has `comp: "Table10"`, `projects: "Companies15"`) and through the v2.0 profile's `crosscheck_entities`, `enrichment_sources`, `gfs_table`, and clean-query wiring. v2.1 renamed the tables to `Projects` and `Gov_revs_comp_proj` respectively, and the v2.1 profile uses those names.

**Rationale:** Renaming the Excel tables inside files we receive isn't an option — the .xlsx as submitted is what it is. Matching the names exactly is the only way `NamedTableLocator` can find them via `sheet.tables.get(table_name)`. The cost is that internal code identifiers for v2.0 don't match their semantic role, which is documented in the schema files and contained to v2.0 by version-specific profiles.

**Technical detail:** Quirky names declared in `packages/parser/src/parser/domain/schemas/v2p0.py` (notably `REPORTING_PROJECTS_SCHEMA_V2P0` and `COMPANY_REVENUE_SCHEMA_V2P0`); routed through `packages/shared/src/shared/stats_config.json` and `packages/pipeline/src/pipeline/profiles/summary_v2p0.py`. Lookup happens in `NamedTableLocator.locate` in `packages/parser/src/parser/extraction/location_strategies.py` via `sheet.tables.get(schema.table_name)`.

---

## Cross-Cutting

### How are numeric IDs from Excel handled?
<!-- scenario: trust-the-data; topic: cross-cutting -->

**Situation:** Excel stores any cell whose content looks like a number as a float, including identifier columns — a company ID typed as `12345` in the file arrives in Python as `12345.0`, and a project reference typed as `7890` arrives as `7890.0`.

**Decision:** Identifier fields run through a normalizer that detects integer-valued floats and converts them through int before stringifying, so `12345.0` becomes `"12345"` (not `"12345.0"`). Alphanumeric IDs like `"AB123"` pass through unchanged. The normalizer is wired into the Pydantic field type for every ID column: `id_number`, `company_id`, `legal_agreement_ref_num`, and (in v2.x where the project's "Full project name" is really a project code) `project_name`.

**Rationale:** Without the normalizer, the ledger would carry an ID column where the same underlying identifier alternates between `"12345"` and `"12345.0"` depending on how it was typed in the file. Joins, lookups, and equality comparisons against the metadata tables would break for the float-shaped rows — a real bug that costs hours to track down once it's in production data. Stripping the `.0` at the boundary keeps the rest of the pipeline free of "is this string an int-ish float" defensive code.

**Technical detail:** The normalizer is `normalize_id_column` in `packages/parser/src/parser/domain/schemas/validation_helpers.py`, exposed as `NormID = Annotated[str, BeforeValidator(normalize_id_column)]` in the same file. Field declarations in `packages/parser/src/parser/domain/schemas/v2p0.py` and `v2p1.py` use `NormID` (sometimes combined with `NotAvailable` or `NotApplicable` in a union) for the ID-shaped columns.

### What happens to abandoned sessions?
<!-- scenario: operate-at-scale; topic: cross-cutting -->

**Situation:** A user uploads a file, walks away at the review or confirmation step, and never comes back. The session, its cached `PipelineContext`, and its event history sit on disk indefinitely if nothing cleans them up.

**Decision:** A daily cleanup loop sweeps sessions older than the cache TTL (default 30 days). For each session whose latest event is older than the cutoff and which is not already `EXPIRED`, the event manager writes an `EXPIRED` event. A second pass deletes the cached `PipelineContext` file, the on-disk upload, and the session's event rows. The session is no longer eligible for the recovery sweep and no longer claims its file-content hash for duplicate detection.

**Rationale:** Abandoned sessions accumulate quietly — cache files for parsed Excel content can be large, and stale interrupt sessions sit on the recovery sweep's candidate list forever. A TTL bound on how long inaction is preserved keeps both disk usage and the recovery scan tractable without imposing a tight per-session lifetime. Marking with an `EXPIRED` event before deletion means the event log still records that the session existed and was cleaned up, rather than silently disappearing.

**Technical detail:** The TTL is `Settings.cache_ttl_days` (default 30, `packages/shared/src/shared/settings.py`) and the loop runs every `cleanup_interval_hours` (default 24). The mark step is `EventManager.mark_expired_sessions` in `packages/shared/src/shared/session/event_manager.py`; the sweep step is in `CacheManager._run_cleanup` (`packages/shared/src/shared/session/cache_manager.py`). The same `EXPIRED` state is included in `DEDUP_INACTIVE_STATES` so it stops blocking content-hash duplicate detection.

### What does the tool require before letting the user move past review?
<!-- scenario: fix-problems-before-import; topic: cross-cutting -->

**Situation:** The user has reached the REVIEWING interrupt. The dashboard shows validation findings, some with proposed cleaner values, some with dropdown candidates, some with neither. The user clicks "Submit corrections" to continue.

**Decision:** Every validation finding has to be covered before the pipeline will resume. Coverage means one of three things: the finding already carries a proposed value (a cleaner finding produced an auto-fix), or a cleaner finding at the same `(table_name, table_row_index, field_name)` coordinates has a proposed value, or the user submitted a `USER_CHOICE` correction for those coordinates (either in the POST body or earlier in the session). A finding with dropdown candidates but no pick and no cleaner fill is unfixable — the review POST returns 422 and lists how many uncovered findings remain. The user has to pick (or escalate via FLAGGED) before they can continue.

**Rationale:** Earlier in the project the gate let a finding through as "fixable" the moment it had candidates attached — the user didn't actually have to pick. That let `BLANK_CELL_DEPENDENT` findings carrying "Not applicable" as a candidate slip past review with no decision, and the row got written with `NULL` into a nullable column. The strict gate makes every dropdown-fixable cell a required review action, which matches the rest of the strict-typing design: no value lands in the database that nobody explicitly approved.

**Technical detail:** The gate lives in `review_post` in `apps/api/src/api/endpoints.py`. It builds a `covered_coords` set from cleaner findings with `proposed_value` and from `USER_CHOICE` findings (both already in `context.findings` and freshly submitted in `request.corrections`), then checks every `VALIDATION` finding without its own `proposed_value`. Findings on strict-typed fields carry no candidates and no cleaner coverage — those are source-only errors that must be fixed in the Excel file or escalated via FLAGGED.

### How does the user escalate a finding the tool can't resolve?
<!-- scenario: fix-problems-before-import; topic: cross-cutting -->

**Situation:** A user is reviewing a file and hits a finding they can't resolve — a source-only error, a cleaner correction they think is wrong, or anything else the dev team should look at. They need a way to flag it without proceeding with a broken import.

**Decision:** The user marks the finding via a flag modal in the Web UI. Each flag carries a target (`AUTO_CORRECTION`, `ERROR`, or `SOURCE_ONLY`), the finding's identifying fields, and an optional comment. Flags are saved interim via `POST /sessions/{id}/flags` (replace-on-POST: the body is the full flag list, so unticking a checkbox and re-POSTing an empty list clears them). The session state does not change during interim saves — the user can keep reviewing. When the user submits the flag set via `POST /sessions/{id}/feedback`, the endpoint emits one structlog warning per flag, transitions the session to `ERROR_DATA` (terminal), and returns 422. There is no longer any "dismiss and keep going" path.

**Rationale:** Iterative editing and terminal abort are separate gestures. Saving flag notes shouldn't commit the user to anything — they can change their minds, untick everything, and continue. Submitting feedback is the explicit "I'm done with this file and the dev team needs to see why" action. Persisting flags in the target DB keyed by session ID means the dev team can query flagged findings post-mortem even after the session itself is cleaned up.

**Technical detail:** Flag rows live in the `metadata_feedback_flags` table in the target DB (defined in `packages/shared/src/shared/db_models.py`). The interim and terminal endpoints are `post_flags` and `submit_feedback` in `apps/api/src/api/endpoints.py`. `FlagTarget` and `FeedbackCode` are defined in `packages/shared/src/shared/diagnostics.py`; the relevant `FeedbackCode` values are `USER_CHOICE` (for the manual-fix path) and `FLAGGED` (for the escalation path).
