# Decision Log

How the EITI Data Importer handles data, organized by topic. Each entry documents a choice that affects what the tool does with submitted files.

The first section, **Pending Decisions**, lists choices we know we need to make but can't yet — typically because they depend on EITI clarification, an upstream template fix, or empirical observation we haven't gathered. Each pending entry names the question, the current workaround, what would unblock the decision, and the consequence of the workaround so a reader knows what's compromised. When a pending decision resolves, it moves into the appropriate section below as a normal entry, and the pending row is deleted.

---

## 0. Pending Decisions

### Why are v2.x sector values unreliable?
<!-- scenario: trust-the-data; topic: pending-decisions -->

**Question:** Should `sector` on company revenue rows (v2.x Part 5 / Gov_revs_comp_proj) be typed as `Sector | NotAvailable` and validated against the `Sector` enum, or remain `str | NotAvailable` (validation suspended)?

**Blocker:** The v2.1 Excel template's Sector column uses `=VLOOKUP(C15, Companies[], 3, FALSE)`, which pulls column index 3 ("Company type", e.g. "State-owned enterprises"), NOT column index 5 ("Sector"). v2.0 Norway shows the same shape with company registration numbers. v2.0 Philippines happens to be correct. The bug is in the EITI template, not our parser.

**Current workaround:** Field typed as `sector: str | NotAvailable` in `v2p1.py` and `v2p0.py`; comment "validation suspended until EITI clarification" cites this task.

**What unblocks:** EITI confirms the formula should use index 5 (and ships a corrected template) OR confirms the column is intentionally Company type and we rename the field.

**Consequence of workaround:** Sector values in our ledger from v2.x company revenue tables are unreliable — they may be company-type strings, registration numbers, or the correct sector, depending on which template version the country used. Dashboards aggregating by Sector will produce nonsense buckets. Document this in test-deploy release notes.

**Action when resolved:** uplift field type, drop the suspension comment, add the correct enum membership test, audit existing v2.x ledger rows for backfill.

---

## 1. Data Quality Policy

### What kinds of errors can be fixed in the tool?
<!-- scenario: fix-problems-before-import; topic: data-quality-policy -->

**Situation:** A validation error is found in parsed data.

**Decision:** Errors with correction candidates (dropdown options) or a proposed value (auto-fix) are "fixable" in the review UI. Errors with neither are "source-only" — the submitter must fix the source Excel file.

**Rationale:** Users need to distinguish between errors they can resolve in the tool and errors that require the data submitter to re-export.

### When does an error block import?
<!-- scenario: trust-the-data; topic: data-quality-policy -->

**Situation:** The dashboard displays a status after validation.

**Decision:** If any source-only error exists, status is BLOCKED. The user cannot proceed to import.

**Rationale:** Source-only errors cannot be resolved in the tool. Importing data with them would produce a corrupted dataset.

### When is a review required before import?
<!-- scenario: trust-the-data; topic: data-quality-policy -->

**Situation:** Consistency findings (unregistered entities, currency mismatches) are present but no source-only validation errors exist.

**Decision:** Status is NEEDS_REVIEW, not SUCCESS.

**Rationale:** Consistency warnings indicate data quality issues even if each individual cell validates. The user must acknowledge them before proceeding.

### How is the data quality score computed?
<!-- scenario: trust-the-data; topic: data-quality-policy -->

**Situation:** A 0-100 data quality score is computed from findings.

**Decision:** Source-only errors count as 1 error per row. Fixable errors count as 0.5. Score = (1 - weighted_errors / total_rows) x 100.

**Rationale:** Source-only errors are more disruptive (they block import), so they are weighted more heavily.

### How are quality scores color-coded?
<!-- scenario: trust-the-data; topic: data-quality-policy -->

**Situation:** The quality score is displayed on the dashboard.

**Decision:** >= 90 = good (green). >= 70 = warn (yellow). < 70 = bad (red).

**Rationale:** Quick visual triage for the user.

### Are template placeholders treated as data?
<!-- scenario: trust-the-data; topic: data-quality-policy -->

**Situation:** A cell contains angle-bracket placeholder text (e.g. `<placeholder>`) or instruction text like "add new rows as necessary".

**Decision:** Flagged as a validation error asking the submitter to provide real data.

**Rationale:** Template instructions left in cells by data submitters should not be imported as data.

### Can a user fix a misspelled value in the tool?
<!-- scenario: fix-problems-before-import; topic: data-quality-policy -->

**Situation:** A cell value fails enum validation (e.g. misspelled sector name).

**Decision:** The valid enum values are extracted and attached to the finding as correction candidates, making the error fixable via dropdown.

**Rationale:** The user can select the correct value without needing to know the enum definition.

### How does the tool handle 'Not available' and 'Not applicable' cells?
<!-- scenario: trust-the-data; topic: data-quality-policy -->

**Situation:** Cells contain the strings "Not available" or "Not applicable" where numeric data is expected.

**Decision:** Accepted by the parser. Written to the ledger as literal strings. Clean tables convert them to NULL via SQL CASE guard, with the original sentinel recorded in `clean_flags`.

**Rationale:** Preserves the distinction between genuinely empty (NULL) and explicitly marked as unavailable. The ledger is raw; clean tables are analysis-ready.

### How does the tool distinguish missing data from intentionally empty cells?
<!-- scenario: trust-the-data; topic: data-quality-policy -->

**Situation:** The parser needs to represent three reasons a cell value is absent: data not available (NV), data not applicable (NA), and field legitimately empty (BLANK).

**Decision:** Three separate sentinel concepts, each with different pipeline consequences:
- **Not available** (NV) — a data gap. Filled automatically by the cleaner and produces a Finding visible in the UI.
- **Not applicable** (NA) — the field doesn't apply given other answers in the same record. Set by the parser based on the record's own structure. No error.
- **Blank** — the field is optional by design. No error.

Each field declares which of these sentinels it accepts. Some fields accept both NV and NA, where real data legitimately uses both; in that case a precedence rule decides which blank-cell code applies.

**Rationale:** Treating "not available" and "not applicable" as a single value meant any field accepting one implicitly accepted the other, blurring two very different situations. Keeping them separate gives precise control over what each field is allowed to mean when empty: a data gap, a dependency-driven absence, or an optional emptiness.

**Technical detail:** Three `StrEnum` types in `shared.diagnostics` — `NotAvailable`, `NotApplicable`, `Blank`. `NotAvailable` is filled by the cleaner's `MapToNotAvailableRule`; `NotApplicable` is set by parser `@model_validator(mode="before")` cascades; `Blank` is set by field default. Example field signature: `submitted_data_to_eiti: ResponseOption | NotApplicable | NotAvailable`.

### Why did the tool replace EITI's enum design?
<!-- scenario: trust-the-data; topic: data-quality-policy -->

**Situation:** EITI's original schemas mixed real categorical values (sectors, project statuses, response options) with absence sentinels ("Not applicable", "Not available") inside the same enum.

**Decision:** Remove the absence members from those enums. Fields that legitimately accept NA or NV declare it explicitly in their type, decided per field by an audit. The exception is `ReportingOption`, which keeps its NA/NV members because in that field they are real answers to a metadata question, not absence sentinels.

**Rationale:** Mixing categorical values and absence sentinels in one list made it impossible to say what a field actually accepted — "Sector" implicitly included "Not applicable" as if it were a sector. Separating them gives a single, unambiguous source of truth: "Not available" always means a data gap, except in the one field where it is genuinely an answer.

**Technical detail:** Removed `Sector.NOT_APPLICABLE`, `ProjectStatus.NOT_APPLICABLE`, and `ResponseOption.NOT_APPLICABLE`/`NOT_AVAILABLE`. Consumer fields are now union-typed (e.g., `Sector | NotApplicable`).

### What do field types in the parser communicate?
<!-- scenario: cross-cutting; topic: data-quality-policy -->

**Situation:** Choosing Pydantic field types for parser schemas.

**Decision:** Field types tell downstream consumers what to expect — they don't decide what the data should be. A field typed `float | NotAvailable` declares "data field, absence is a gap". A field typed `T | NotApplicable` declares "dependent — absence has structural meaning when upstream is present".

**Rationale:** Without explicit sentinels in the type, downstream cannot distinguish "missing data" from "structurally absent" from "legitimately empty". Each sentinel in a union grants a specific permission to the field.

### What categories does the parser use to classify fields?
<!-- scenario: cross-cutting; topic: data-quality-policy -->

**Situation:** Every field in the parser's schema needs a policy for what happens when its cell is blank.

**Decision:** Five categories, each tied to how the field is declared:
- **Data (blocking)** — blank produces `BLANK_CELL_BLOCKING`; the source file must be fixed.
- **Data (non-blocking)** — blank produces `BLANK_CELL`; the cleaner fills it with "Not available".
- **Dependent** — blank produces `BLANK_CELL_DEPENDENT` when the field should have been filled given other answers (blocking). When a dependency makes the field irrelevant, NA is set automatically.
- **Structural NA** — the field is always "Not applicable"; NA is filled automatically, and any non-NA text is rejected as `INVALID_DATATYPE` to surface alignment errors.
- **Free** — free text or comments; missing or empty is treated as Blank by design.

**Rationale:** Tying these categories to the field declaration itself means parser behavior, cleaner behavior, and UI visibility all flow from one place. There is no separate per-field configuration table to keep in sync.

**Technical detail:** Categories are expressed as Pydantic type signatures: `T` (blocking), `T | NotAvailable` (non-blocking), `T | NotApplicable` (dependent), bare `NotApplicable` (structural NA), `FreeText = Annotated[str | Blank, BeforeValidator(_none_to_blank)]` with default `Blank.BLANK` (free). The `BeforeValidator` coerces explicit `None` to `Blank.BLANK`; the default fills missing keys.

### Why is a blank data field always treated as missing rather than legitimate?
<!-- scenario: trust-the-data; topic: data-quality-policy -->

**Situation:** Some data — for example ASM employment or investment figures — isn't tracked by every country.

**Decision:** A blank data field is always recorded as "Not available", never as a legitimate empty. Only comments and free-text fields can be genuinely blank.

**Rationale:** The tool can't tell the difference between "the country doesn't track this" and "the country forgot to report it" — both look identical on the page. That judgement belongs to a human reviewer in the UI. Recording every blank data cell as a data gap keeps the auto-fill visible and leaves the interpretation to the reviewer.

### Which blank cells block import and which don't?
<!-- scenario: fix-problems-before-import; topic: data-quality-policy -->

**Situation:** When a data cell is blank, the tool needs to decide whether the import can proceed or whether the source file has to be corrected first.

**Decision:** Three codes, chosen from how the field is declared:
- **BLANK_CELL** (non-blocking) — the field allows "Not available". The cleaner fills it automatically.
- **BLANK_CELL_BLOCKING** — the field requires a real value. There's nothing to auto-fill; the user fixes the source file or escalates via FLAGGED.
- **BLANK_CELL_DEPENDENT** — the field allows "Not applicable" but not "Not available". The user picks "Not applicable" from the review dropdown, fills a real value, or escalates via FLAGGED.

When a field allows both "Not available" and "Not applicable", BLANK_CELL wins: the blank is treated as a data gap by default, and the reviewer can override that in the UI.

**Rationale:** Whether a blank blocks import is a domain decision — some fields genuinely require an answer, others have a sensible default. Making that decision explicit in the Finding code lets the UI present it without re-deriving the domain rules. The cleaner only auto-fills where the field's declared shape permits it, and never guesses between NA and NV when both are valid.

**Technical detail:** Codes are derived by `_blank_cell_code_for(model, field_name)` via introspection of the field's type union. For `BLANK_CELL_DEPENDENT`, the parser extracts `'Not applicable'` from the Pydantic enum error on the union and puts it in the review candidates.

### How does the tool distinguish a blank cell from a wrongly-typed value?
<!-- scenario: fix-problems-before-import; topic: data-quality-policy -->

**Situation:** A cell fails validation. The tool needs to record what kind of failure it was.

**Decision:** Two distinct paths:
- The cell is empty (or contains only whitespace, which is normalised to empty) — recorded as one of the blank-cell codes, chosen by the field's declared shape.
- The cell has a value, but the value doesn't fit the field — recorded as `INVALID_DATATYPE`. The cleaner may then fuzzy-match it, standardise an alternate spelling of "Not available" or "Not applicable", or remove a known placeholder.

**Rationale:** Empty cells and wrongly-filled cells have different causes, are fixed by different cleaner rules, and need different reviewer actions. Giving them distinct codes makes that visible all the way through the pipeline.

**Technical detail:** Blank path goes through `_blank_cell_code_for`. Wrong-type path is handled by `EnumCorrectionRule`, `StandardizeNotAvailableRule`, `StandardizeNotApplicableRule`, and `PlaceholderRemovalRule`.

### Who decides whether a blank cell becomes 'Not applicable' or 'Not available'?
<!-- scenario: cross-cutting; topic: data-quality-policy -->

**Situation:** A cell is blank. Something has to decide whether it should be recorded as "Not available" or "Not applicable".

**Decision:** The parser sets "Not applicable" when another answer in the same record makes the field irrelevant — that takes domain knowledge. The cleaner fills "Not available" for non-blocking blank cells — that doesn't. The cleaner never sets "Not applicable".

**Rationale:** Marking a field as "Not applicable" requires understanding *why* it's empty — for instance, an in-kind volume field is "Not applicable" when the payment wasn't in-kind. Only the parser, which sees the whole record, has that information. The cleaner's job is much simpler: a non-blocking blank means "Not available".

**Technical detail:** Parser sets NA via `@model_validator(mode="before")` cascades. Cleaner fills NV via `MapToNotAvailableRule`.

---

## 2. Currency & Financial Calculations

### What direction is the exchange rate?
<!-- scenario: reconcile-government-vs-companies; topic: currency-financial-calculations -->

**Situation:** The About sheet declares an exchange rate.

**Decision:** Interpreted as "1 USD = X local currency units". Local-to-USD divides by rate. USD-to-local multiplies by rate.

**Rationale:** Matches the label used in EITI templates ("Exchange rate used: 1 USD =").

### What happens when the exchange rate is zero?
<!-- scenario: reconcile-government-vs-companies; topic: currency-financial-calculations -->

**Situation:** The About sheet has exchange rate = 0.

**Decision:** Treated as "not provided". USD totals become N/A.

**Rationale:** Zero is never a meaningful FX rate and would cause division by zero.

### How are nonsensical exchange rates handled?
<!-- scenario: reconcile-government-vs-companies; topic: currency-financial-calculations -->

**Situation:** The exchange rate field contains a value like "1e309" or "nan".

**Decision:** Rejected at the boundary. Both produce 0.0 (treated as missing).

**Rationale:** Infinity divisor silently produces 0. NaN propagates. Both produce wrong totals.

### In what currencies are totals displayed?
<!-- scenario: reconcile-government-vs-companies; topic: currency-financial-calculations -->

**Situation:** The dashboard displays financial totals.

**Decision:** Every total is computed in two currencies: local (reporting currency) and USD. The dashboard shows USD as the primary figure and local as a secondary line.

**Rationale:** The EITI audience needs USD comparability across countries, but local currency is what the declaration reports.

### What happens to a total if one row cannot be converted?
<!-- scenario: reconcile-government-vs-companies; topic: currency-financial-calculations -->

**Situation:** A table has rows in mixed currencies and one row cannot be converted.

**Decision:** If any single row's value is uncomputable on one side (local or USD), the entire total for that side becomes N/A.

**Rationale:** A partial sum missing some rows would be misleading. Better to show N/A than an incomplete total.

### Why might a row be uncomputable?
<!-- scenario: reconcile-government-vs-companies; topic: currency-financial-calculations -->

**Situation:** A row's currency is neither the reporting currency nor USD.

**Decision:** Both the local and USD values for that row are uncomputable.

**Rationale:** The tool has only one exchange rate (USD-local). Converting a third currency (e.g. EUR) requires an additional rate that the file does not provide.

### What happens when the reporting currency is USD?
<!-- scenario: reconcile-government-vs-companies; topic: currency-financial-calculations -->

**Situation:** The About sheet declares reporting currency = USD.

**Decision:** Both local and USD totals are identical. No exchange rate needed. No secondary line on the dashboard.

**Rationale:** USD-to-USD conversion is identity. Showing the same number twice adds no information.

### How is the reconciliation gap computed?
<!-- scenario: reconcile-government-vs-companies; topic: currency-financial-calculations -->

**Situation:** The reconciliation gap is computed.

**Decision:** Gap = total government revenue minus total company payments. Positive means government reported more than companies. Percentage = gap / total government revenue x 100.

**Rationale:** Matches the EITI reconciliation methodology (government side as reference).

### Which currency is used for the reconciliation gap percentage?
<!-- scenario: reconcile-government-vs-companies; topic: currency-financial-calculations -->

**Situation:** The reconciliation gap percentage is computed.

**Decision:** Uses the local currency pair if both sides are available. Falls back to the USD pair otherwise.

**Rationale:** Local currency avoids introducing conversion noise into the percentage.

### When is the reconciliation gap considered concerning?
<!-- scenario: reconcile-government-vs-companies; topic: currency-financial-calculations -->

**Situation:** The reconciliation gap is displayed on the dashboard.

**Decision:** Absolute gap percentage <= 10% = green. > 10% = red.

**Rationale:** 10% threshold is a meaningful indicator of reconciliation quality for EITI data.

### How is currency handled for v1 files without per-row currency?
<!-- scenario: compare-across-versions; topic: currency-financial-calculations -->

**Situation:** V1 template files have no per-row currency column.

**Decision:** All rows are treated as being in the reporting currency. Local total is always computable. USD total requires the exchange rate from the About sheet.

**Rationale:** V1 template design predates per-row currency columns.

### Where does the tool get exchange rates for old v1 files?
<!-- scenario: compare-across-versions; topic: currency-financial-calculations -->

**Situation:** V1 files never include an exchange rate in the About sheet, but EITI's own API export has rates for 96% of historical declarations.

**Decision:** The tool ships with a committed lookup table of historical exchange rates, extracted from EITI's API export and keyed by country and year. When a v1 file's About sheet has no rate, the stats computation looks up the rate by the file's country code and reporting-period end year. The dashboard (in the browser) and the server-side computation read from the same lookup source.

**Rationale:** Historical exchange rates are stable and available from EITI's own data. A static, committed table avoids runtime dependency on external services and guarantees that the dashboard and the server can't drift apart.

**Technical detail:** Lookup file `v1_exchange_rates.json`, keyed by `{iso3}_{year}`. `compute_stats` resolves the rate using `country_iso3` + `end_date` year. The same JSON is served to the browser via the `/stats-config` endpoint, so Python and JS share one source.

### How does the tool convert v1 rows to USD in the dashboard vs the database?
<!-- scenario: reconcile-government-vs-companies; topic: currency-financial-calculations -->

**Situation:** V1 files lack exchange rates. USD values are needed both in the dashboard (UI) and in the queryable database views.

**Decision:** Two independent mechanisms handle USD conversion for v1 files:
- **Dashboard path**: the stats computation applies the fallback rate at display time, so any v1 file shows USD values immediately, even before it has been imported.
- **Database path**: the SQL views read a per-file stored exchange rate from the imported metadata. For v1 files, that stored rate is filled in by a one-time backfill run after import.

Both paths read their rate from the same committed lookup table, so the dashboard and the database agree.

**Rationale:** The main import pipeline stays untouched — adding a v1-specific branch to the hot path for a one-time historical conversion isn't justified. The backfill is idempotent and isolated to the files that need it. Because both paths share the same rate source, the dashboard preview and the post-import database give the same USD numbers.

**Technical detail:** Dashboard path: `compute_stats` in `stats.py` / `stats.js` reads `v1_exchange_rates.json` at runtime. DB path: `view_payments_detailed` and `view_revenues_detailed` read `exchange_rate_used` from `metadata_summary_data_files`; that column is populated by `scripts/backfill_v1_exchange_rates.py` post-import.

### Why are SQL views recreated at startup?
<!-- scenario: cross-cutting; topic: currency-financial-calculations -->

**Situation:** View definitions may change between releases.

**Decision:** Every time the API starts, it drops the existing SQL views and recreates them from the current code.

**Rationale:** The "create only if missing" variant silently keeps the old definition when the SQL changes, so a release that updates a view would have no effect until the database was wiped. Drop-and-recreate guarantees the views in the database always match the code that's running.

**Technical detail:** `init_target_db()` issues `DROP VIEW IF EXISTS` followed by `CREATE VIEW` for each view on startup.

### Which currency does the v1 dashboard prioritize?
<!-- scenario: reconcile-government-vs-companies; topic: currency-financial-calculations -->

**Situation:** V1 files without a historical exchange rate have no USD totals, but local totals are computable.

**Decision:** The dashboard shows local currency as the primary (large) figure for v1 files without a rate. No "N/A" notice, no USD line. When USD is available (v2.x with rate, or v1 with fallback rate), USD is shown as primary with local as secondary.

**Rationale:** Showing "N/A" when a computable value exists is misleading. The local total is the most useful number for the user reviewing the file.

### What happens to 'Not available' revenue rows in aggregations?
<!-- scenario: trust-the-data; topic: currency-financial-calculations -->

**Situation:** A revenue cell contains "Not available" or "Not applicable".

**Decision:** Rows with sentinel revenue values are excluded entirely from clean table aggregations (not just NULLed).

**Rationale:** A "Not available" payment should not appear as zero in aggregations.

---

## 3. Workflow & Status

### What are the possible statuses of a file?
<!-- scenario: submit-a-report; topic: workflow-status -->

**Situation:** The user uploads a file and sees the dashboard.

**Decision:** SUCCESS = no validation errors or crosscheck issues. NEEDS_REVIEW = fixable errors or crosscheck issues. BLOCKED = source-only errors present.

**Rationale:** Maps to the user's action: proceed immediately, review and correct, or reject back to submitter.

### What does the tool do when an internal check crashes?
<!-- scenario: trust-the-data; topic: workflow-status -->

**Situation:** A non-critical service (enricher, crosschecker, cleaner) encounters an error.

**Decision:** The service catches its own exceptions, produces an error finding, and returns normally. The pipeline continues. Only template detection and parsing produce terminal errors.

**Rationale:** Degraded output (fewer findings) is more useful than aborting. Enrichment failing should not prevent the user from seeing validation results.

### What information is expected to finalize a data import?
<!-- scenario: submit-a-report; topic: workflow-status -->

**Situation:** The pipeline reaches the import stage.

**Decision:** The user must select a responsible user, optionally add comments, and explicitly click "Confirm Import". Rejection returns to a rejected state.

**Rationale:** Import is the single mutation point. No data is written without deliberate human authorization.

### Who is held accountable for an import or deletion?
<!-- scenario: audit-who-did-what; topic: workflow-status -->

**Situation:** Data is about to be written to or deleted from the database.

**Decision:** Both operations require an audit stamp (full name, email, role, channel, comments). An audit record is created.

**Rationale:** Full accountability chain for who touched the database and why.

### Can a finding be modified or removed from a session?
<!-- scenario: audit-who-did-what; topic: workflow-status -->

**Situation:** Services produce findings as they run.

**Decision:** The pipeline context carries findings as an append-only list. Services add to it but never modify existing findings.

**Rationale:** Preserves the full audit trail of proposed changes.

### What takes priority: the user's correction or the tool's suggestion?
<!-- scenario: fix-problems-before-import; topic: workflow-status -->

**Situation:** The user corrects a cell value in the review UI.

**Decision:** Correction precedence: user correction > cleaner > extracted data. Corrected values skip automated transforms.

**Rationale:** The user's explicit fix is the most authoritative source.

### What do the Restart and Cancel & Start Over buttons do?
<!-- scenario: submit-a-report; topic: workflow-status -->

**Situation:** The Web UI offers a "Restart session" button in the header and a "Cancel & Start Over" button in the template-confirmation modal.

**Decision:** Both buttons cancel the current session outright. The session is marked CANCELLED (a terminal state), any in-memory work for it is discarded, and the user returns to the upload zone. There is no undo. The same applies at batch level: cancelling a batch cancels every non-terminal member of the batch in one transaction.

**Rationale:** "Restart" matches the user's mental model — start over from scratch. The underlying mechanism is destructive cancellation, not preservation. Cancelling immediately releases the duplicate-file lock on that file's contents, takes the session out of the background recovery sweep's attention, and frees the cached working state.

**Technical detail:** Both buttons call `POST /sessions/{id}/kill`; the cached `PipelineContext` for the session is deleted. The batch-level equivalent is `POST /batches/{id}/kill`.

### Can a batch be confirmed if some members are still under review?
<!-- scenario: submit-a-report; topic: workflow-status -->

**Situation:** The user clicks "Confirm batch" on a batch whose members are in mixed states — some ready to confirm, some still under review, some in a data-error state.

**Decision:** The bulk-confirm action is rejected unless every member of the batch has reached a decided state (ready-to-confirm, already confirmed, already imported, rejected, in a data error, in an unknown error, or cancelled). Once all members are decided, the bulk-confirm atomically promotes the ready-to-confirm subset to CONFIRMED and leaves members already in terminal states alone. The Web UI mirrors this by disabling the "Confirm batch" button until every member is decided.

**Rationale:** Each batch member is an independent declaration — there's no business reason to require all-or-nothing atomicity across them. But forcing per-member decisions before a bulk confirm prevents partial-state surprises: the user must explicitly resolve each file (approve at review or reject it) before bulk-committing the approved subset.

**Technical detail:** `POST /batches/{id}/confirm` returns 409 if any member is not in {CONFIRMING, CONFIRMED, IMPORTED, REJECTED, ERROR_DATA, ERROR_UNKNOWN, CANCELLED}. On success, only the CONFIRMING subset transitions to CONFIRMED.

---

## 4. Template Recognition

### How does the tool identify which template a file uses?
<!-- scenario: submit-a-report; topic: template-recognition -->

**Situation:** An uploaded Excel file needs to be identified as v1, v2.0, or v2.1.

**Decision:** Confidence score (0-150) is computed from three weighted signals: version string in Introduction sheet (50 pts), required sheets present (20 pts), table and column structure match (80 pts).

**Rationale:** Weighted combination handles files with missing metadata or renamed sheets while still producing reliable identification.

### When does a template version qualify as a candidate?
<!-- scenario: submit-a-report; topic: template-recognition -->

**Situation:** Template versions are scored against a file.

**Decision:** Any version scoring >= 40 is added to the candidates list.

**Rationale:** 40 is low enough to catch files with significant variations but high enough to exclude random matches.

### What happens when more than one template could fit?
<!-- scenario: submit-a-report; topic: template-recognition -->

**Situation:** Multiple templates score above the threshold.

**Decision:** The pipeline suspends. The user must pick the correct version.

**Rationale:** Automatic selection from ambiguous candidates could import data using the wrong schema.

### When does the tool skip the template-confirmation step?
<!-- scenario: submit-a-report; topic: template-recognition -->

**Situation:** Exactly one template scores above the threshold AND the detected cohort set is exactly one NEW cohort with zero DUPE cohorts.

**Decision:** The pipeline continues automatically.

**Rationale:** No ambiguity, nothing to choose between, nothing already imported. Reduces friction for the SDF happy path. Any of: ambiguous template, multiple NEW cohorts (fat-file fan-out), or any DUPE cohort routes to the SELECTION_CONFIRMING interrupt for explicit user input.

### What happens if the tool can't identify the template?
<!-- scenario: submit-a-report; topic: template-recognition -->

**Situation:** No template scores above the threshold.

**Decision:** The pipeline transitions to an error state.

**Rationale:** Cannot proceed without a known schema to parse against.

### How does the tool handle a table found on the wrong sheet?
<!-- scenario: submit-a-report; topic: template-recognition -->

**Situation:** A table is found on a different sheet than expected during identification.

**Decision:** 50% score penalty for that signal.

**Rationale:** Files may have tables on moved sheets. This reduces confidence without eliminating the candidate.

### What happens when the parser schema changes between sessions?
<!-- scenario: operate-at-scale; topic: template-recognition -->

**Situation:** Parser schema files change between sessions (code deployment).

**Decision:** A hash of parser schema files is stored with each session. On resume, if the hash differs, the session is marked stale and re-run.

**Rationale:** Cached results from an old parser version may be incorrect.

---

## 5. Entity Resolution

### How does the tool match a name to an existing entity?
<!-- scenario: trust-the-data; topic: entity-resolution -->

**Situation:** A company, agency, or project name from the file is compared against the EITI database.

**Decision:** Names are normalized (Unicode transliteration, trimmed, uppercased) and compared. Exact match assigns the database entity ID.

**Rationale:** Unicode normalization and case-insensitive matching handles accents and capitalization differences without fuzzy matching.

### What identifier is given to a brand-new entity?
<!-- scenario: trust-the-data; topic: entity-resolution -->

**Situation:** An entity name has no match in the EITI database.

**Decision:** A UUID4 is assigned as the entity's business key. The entity is written to the metadata table as a new entry.

**Rationale:** New entities need a stable identifier for the ledger even though they do not exist in the external database yet.

### Why is a company matched globally but agencies and projects per-country?
<!-- scenario: trust-the-data; topic: entity-resolution -->

**Situation:** The enricher queries the external EITI database.

**Decision:** Company search is global (no country filter). Agency and project searches are filtered by the file's country code.

**Rationale:** Companies operate across countries (multinational). Agencies and projects are country-specific.

### How is a declaration uniquely identified?
<!-- scenario: avoid-duplicate-imports; topic: entity-resolution -->

**Situation:** A unique identifier is needed for each declaration.

**Decision:** UUID5 from "{country_iso3}:{year}". Same country + year always produces the same UUID.

**Rationale:** Deterministic identity allows detecting re-imports of the same declaration.

### What does the tool treat as a single submission for duplicate detection?
<!-- scenario: avoid-duplicate-imports; topic: entity-resolution -->

**Situation:** A file is uploaded. The tool checks whether its contents have been imported before.

**Decision:** Duplicate detection runs per cohort, not per file. Each submission type declares which cohorts it contains: an SDF file holds one cohort (one country, one year), while fat-file submissions (validation data, company assessment, API extracts) hold many cohorts in a single file. The detector emits one COHORT_DETECTED finding per cohort and classifies each one as NEW or DUPE against what's already in the database.

**Rationale:** A fat file covering 50 country-years might have 48 cohorts the database has never seen and 2 that were already imported. Treating the whole file as one unit would force the user to either delete the two prior imports or rebuild the file without them before they could proceed. Classifying cohort-by-cohort lets the user import the 48 new ones and decide explicitly what to do with the overlapping 2.

**Technical detail:** Each `SubmissionDefinition` declares a `cohort_schema` enumerating the cohorts the file contains. `DetectorService` emits the COHORT_DETECTED findings and runs the NEW/DUPE classification.

### What happens when the user uploads a file that's already imported?
<!-- scenario: avoid-duplicate-imports; topic: entity-resolution -->

**Situation:** The detector has classified every cohort declared by the file against what's already in the database.

**Decision:**
- Every cohort is a DUPE: the run ends with a terminal DUPLICATE_SUBMISSION finding and ERROR_DATA status. The user must explicitly delete the prior import(s) and re-upload to proceed.
- A mix of NEW and DUPE cohorts, or several NEW cohorts: the run pauses at the SELECTION_CONFIRMING interrupt so the user can pick which cohorts to import.
- Exactly one NEW cohort and no DUPEs: the run continues silently.

**Rationale:** All-DUPE usually means the user uploaded the wrong file or forgot a prior import existed — better to fail loudly than to silently overwrite. Mixed cases need a human decision because the right answer depends on intent: re-import a corrected version, skip the duplicates, or cancel entirely. Silent continuation is reserved for the unambiguous happy path of a single new declaration.

### Why doesn't the tool guess on close matches?
<!-- scenario: trust-the-data; topic: entity-resolution -->

**Situation:** The enricher can either match aggressively (risk linking to the wrong entity) or conservatively (risk treating a known entity as new).

**Decision:** Conservative — exact normalized match only. No fuzzy matching, no partial scoring.

**Rationale:** False negatives are recoverable: the mapper assigns a fresh UUID4, and a future dedup pass can merge it with the correct record. False positives corrupt ledger foreign keys — the row points to the wrong entity, and there is no automated correction path. The asymmetry in recovery cost dictates the conservative strategy.

---

## 6. Consistency Rules

### Why does the tool warn about Part 5 entities missing from Part 3?
<!-- scenario: trust-the-data; topic: consistency-rules -->

**Situation:** Company, agency, or project names appear in Part 5 (company payments) data.

**Decision:** Each name is checked against Part 3 registration tables. Unregistered names produce consistency findings.

**Rationale:** Part 5 should only reference entities formally registered in Part 3. Unregistered entities suggest data entry errors or incomplete registration.

### Why does the tool warn about revenue streams in Part 5 not found in Part 4?
<!-- scenario: trust-the-data; topic: consistency-rules -->

**Situation:** Revenue stream names in Part 5 are not found in Part 4 (government revenues table).

**Decision:** A finding is produced for each unmatched stream.

**Rationale:** Revenue streams should be consistently named across Parts 4 and 5 for reconciliation.

### Are entity names compared case-sensitively?
<!-- scenario: trust-the-data; topic: consistency-rules -->

**Situation:** Names are compared across parts of the template.

**Decision:** Names are lowercased before comparison.

**Rationale:** Minor capitalization differences should not produce false positives.

### What happens when a required table is found but empty?
<!-- scenario: trust-the-data; topic: consistency-rules -->

**Situation:** The parser found the government revenues or company payments table, but it has zero data rows.

**Decision:** A finding is produced. The message explains the corresponding side of the reconciliation gap is uncomputable.

**Rationale:** An empty table is distinct from a missing table (the parser reports those separately). Zero rows means the parser succeeded but found no data.

### When does the tool flag a per-row currency mismatch?
<!-- scenario: reconcile-government-vs-companies; topic: consistency-rules -->

**Situation:** V2.0 and v2.1 files have per-row currency columns.

**Decision:** Each row's currency is compared to the reporting currency from the About sheet. Mismatches produce findings.

**Rationale:** Mixed currencies require the exchange rate to be correct and available. The user should be aware of mismatches.

### What happens to per-row currency checks if the reporting currency is missing?
<!-- scenario: reconcile-government-vs-companies; topic: consistency-rules -->

**Situation:** The About sheet does not declare a reporting currency, but per-row currency columns exist.

**Decision:** A single finding is produced. Per-row checks are skipped entirely.

**Rationale:** Without a reference currency, there is nothing to compare against.

### Do consistency warnings block import?
<!-- scenario: trust-the-data; topic: consistency-rules -->

**Situation:** Crosscheck findings are produced.

**Decision:** They trigger NEEDS_REVIEW status, not BLOCKED. The user can proceed to import after reviewing them.

**Rationale:** Crosscheck issues may be legitimate (e.g. an entity registered under a slightly different name). They require human judgment, not automatic rejection.

### What does the tool do with 'Total' rows already in the file?
<!-- scenario: trust-the-data; topic: consistency-rules -->

**Situation:** Excel files include "Total in [currency]" rows that contain pre-computed sums.

**Decision:** The tool extracts each "Total" row as regular data alongside the rest of the sheet, then cross-checks it against the sum it independently computes from the corresponding data table. A difference of up to 1.0 currency unit is accepted; anything larger is flagged as a discrepancy.

**Rationale:** Excel's SUMIF rounding produces sub-cent drift between the pre-computed totals and a fresh sum. A one-currency-unit tolerance absorbs that drift without masking genuine inconsistencies in the file.

**Technical detail:** Totals are pulled via the `KVP_SCAN` extractor and compared in the totals crosscheck step.

### How does the totals check work across different submission types?
<!-- scenario: cross-cutting; topic: consistency-rules -->

**Situation:** Different submission types have different table names, field names, and grouping semantics for the totals comparison.

**Decision:** Each submission type declares, in its profile, how its totals check works: which data table holds the rows, which table holds the pre-computed totals, which fields carry the values, which field groups them, and which finding code to raise on a mismatch. The check logic itself is shared and reads only those declarations.

**Rationale:** Adding a new submission type means adding configuration entries, not writing new check code. The check is format-agnostic by design — it operates on the tool's normalized extracted-data shape, not on the original spreadsheet layout, so it doesn't care whether a new type is structurally similar to the existing ones.

**Technical detail:** Per-type config lives in `crosscheck_totals` on the `SubmissionConfig` profile; each entry is a `TotalsSpec` dataclass declaring data table, totals table, value fields, group-by field, and mismatch finding code. The shared check operates on the `extracted_data` contract.

---

## 7. Import Behavior

### Why does the importer never inspect the data being written?
<!-- scenario: cross-cutting; topic: import-behavior -->

**Situation:** Data needs to be written to the database.

**Decision:** The importer reads only mapped findings from the pipeline context. It never reads extracted data. All data preparation is done upstream by the mapper.

**Rationale:** Single responsibility. The importer cannot introduce data interpretation errors.

### What happens if the user re-imports a declaration?
<!-- scenario: submit-a-report; topic: import-behavior -->

**Situation:** An import targets a declaration that already has data in the database.

**Decision:** Existing rows for that declaration are deleted before writing new ones.

**Rationale:** Re-import should produce the same result as a fresh import. No duplicate accumulation.

### What happens to reference data from multiple files of the same country?
<!-- scenario: cross-cutting; topic: import-behavior -->

**Situation:** Reference data (countries, currencies, GFS codes) may already exist.

**Decision:** Insert-or-ignore for all metadata tables. Deduplication by natural key.

**Rationale:** Multiple files from the same country should not create duplicate records.

### What is kept when a declaration is deleted?
<!-- scenario: audit-who-did-what; topic: import-behavior -->

**Situation:** The user deletes a declaration from the data management tab.

**Decision:** Data rows (clean tables and ledger) are permanently deleted. The summary data file record is soft-deleted. An audit record of the deletion persists.

**Rationale:** Data is permanently removed for privacy and correctness, but the audit trail of who deleted what and when is preserved.

### What does the user have to do to delete a declaration?
<!-- scenario: audit-who-did-what; topic: import-behavior -->

**Situation:** The user clicks "Delete".

**Decision:** First step: select responsible user and click "Delete permanently". Second step: browser confirmation dialog.

**Rationale:** Destructive operation requires deliberate intent.

### How are clean tables built after import?
<!-- scenario: cross-cutting; topic: import-behavior -->

**Situation:** After ledger rows are written.

**Decision:** Clean tables are generated via submission-dispatched INSERT...SELECT queries that join ledger rows with metadata entity tables.

**Rationale:** Clean tables denormalize data for direct querying. No application code needed for the denormalization step.

### Why might an import fail at the last step?
<!-- scenario: submit-a-report; topic: import-behavior -->

**Situation:** No declaration UUID is found in the pipeline findings when the importer runs.

**Decision:** Import is aborted with an error finding.

**Rationale:** The declaration UUID is the primary key for all data rows. Without it, nothing can be written.

### What kinds of duplicate uploads does the tool catch?
<!-- scenario: avoid-duplicate-imports; topic: import-behavior -->

**Situation:** A user uploads a file that may have been imported before.

**Decision:** Three layers run in sequence, each catching a different failure shape:

- **Layer 1 — file-content hash at upload.** A fingerprint of the uploaded bytes is compared against prior successful imports. A match rejects the upload with a 409 response. Catches "same file uploaded twice."
- **Layer 2 — cohort classification at identification.** The detector enumerates the cohorts the file contains (one for SDF, many for fat files) and checks each against the registry of active declarations. All-DUPE terminates the run with ERROR_DATA; a mix of NEW and DUPE routes to the SELECTION_CONFIRMING interrupt so the user can choose. Catches "different file claiming the same identity" and "fat file overlapping with prior imports."
- **Layer 3 — file-content hash at confirmation.** The fingerprint is re-checked against both committed imports and active in-flight sibling sessions just before the importer commits. A match rejects with 409. Catches the race where two users upload identical content at the same time and both pass Layer 1.

**Rationale:** Each layer has a different blast radius. Layer 1 is the cheapest check and catches the common case before any pipeline work begins. Layer 2 handles the semantic case — the file was edited but still represents the same declaration. Layer 3 is structural; it's vanishingly rare on a single-user team, but it closes a timing window the other two layers cannot.

**Technical detail:** Layer 1 and Layer 3 use SHA-256 over the upload bytes. Layer 2 is driven by the submission's `cohort_schema`.

### Can the user re-upload the same file after deleting the prior import?
<!-- scenario: avoid-duplicate-imports; topic: import-behavior -->

**Situation:** A user deleted a declaration and re-uploads the same file (identical bytes).

**Decision:** A soft-deleted prior import does not block the new upload. The duplicate check only looks at declarations that are currently active.

**Rationale:** Deletion is the user's "let me try again" signal. Permanent blocking would defeat that flow.

**Technical detail:** The hash lookup filters on `is_deleted = 0`.

### Can the user retry the same file after an import failure?
<!-- scenario: avoid-duplicate-imports; topic: import-behavior -->

**Situation:** A user's earlier attempt to import the same file failed partway through.

**Decision:** Only successful imports count toward the duplicate check. Failed imports are invisible to it, so the user can retry the same file directly.

**Rationale:** Retrying after a failure is a legitimate next step. Blocking it would force the user to mutate the file just to get past the check.

**Technical detail:** The hash lookup filters on `status = success`.

### When is duplicate detection by file hash skipped?
<!-- scenario: operate-at-scale; topic: import-behavior -->

**Situation:** A developer iterates on a fixture file on their laptop, repeatedly re-uploading it.

**Decision:** Hash-based duplicate detection is disabled in the LOCAL profile and enabled in every other environment (DEV, TEST, STAGING, PROD). There is no per-request bypass — callers cannot turn it off.

**Rationale:** On a developer's machine, dedup just creates friction: every test upload would need a database reset first, with no integrity benefit at a single-developer workstation. Server environments enforce dedup uniformly so no caller can quietly disable it.

**Technical detail:** Controlled by `Settings.dedup_uploads_by_hash`.

### What happens when a colleague's stuck session blocks the user from confirming a file?
<!-- scenario: avoid-duplicate-imports; topic: import-behavior -->

**Situation:** User B uploads a file whose contents match an in-flight session that User A started and walked away from. Without intervention, User B is blocked from confirming until User A's session expires, which can take hours or days.

**Decision:** The 409 responses returned at upload and at confirmation include the IDs of the blocking sibling session (and its batch, if it has one), plus a structured release action that names the endpoint the caller can hit to cancel the stuck session and free the slot immediately. The Web UI surfaces this as a "Cancel that session and retry" modal action; the CLI surfaces it as an interactive prompt.

**Rationale:** Without an explicit release path, the only way to unblock is to wait for the session to time out — operationally unacceptable when an abandoned session is blocking a colleague's legitimate work. A smarter approach (idle sessions yielding their slot automatically based on activity tracking) needs infrastructure that doesn't exist yet, so it's deferred. Until then, the release action makes the workaround discoverable to anyone who runs into a collision.

**Technical detail:** The 409 payload carries `sibling_session_ids`, `sibling_batch_id`, and `release_action(s)`. The CLI prompt uses the `questionary` library. Activity-based auto-release is deferred to MVP6.

---

## 8. Version Differences

### Does v1 use Excel's named tables?
<!-- scenario: compare-across-versions; topic: version-differences -->

**Situation:** V1 template does not use Excel's formal named table feature.

**Decision:** All V1 table identification uses anchor-based fallbacks (searching for header text in sheets).

**Rationale:** V1 template design predates Excel named tables.

### Does v1 collect data on projects and agencies?
<!-- scenario: compare-across-versions; topic: version-differences -->

**Situation:** V1 template does not have dedicated sheets for projects or agencies.

**Decision:** V1 crosscheck and enrichment skip projects and agencies. V1 clean tables omit project and agency tables.

**Rationale:** V1 template does not include these entities.

### What field holds the government revenue value across versions?
<!-- scenario: compare-across-versions; topic: version-differences -->

**Situation:** The stats engine sums government revenues.

**Decision:** V1 uses "revenue_total". V2.0 and v2.1 use "revenue_value". Dispatched via config.

**Rationale:** Different template versions use different column names for the same concept.

### Does v1 declare currency per row?
<!-- scenario: compare-across-versions; topic: version-differences -->

**Situation:** Currency consistency check or stats computation for a v1 file.

**Decision:** V1 currency fields are null in the config. Currency consistency check skips entirely. Stats engine treats all rows as being in the reporting currency.

**Rationale:** V1 template predates per-row currency columns.

### How is the v1 revenue sheet shaped compared to v2?
<!-- scenario: compare-across-versions; topic: version-differences -->

**Situation:** V1 has companies as column headers rather than rows in the revenue sheet.

**Decision:** The parser unpivots the data during extraction into a flat table matching the v2.x shape.

**Rationale:** Normalizes the data to a consistent shape for all downstream processing.

### Why are there separate ledger tables per template version?
<!-- scenario: compare-across-versions; topic: version-differences -->

**Situation:** V1, v2.0, and v2.1 have different column sets.

**Decision:** Separate ledger tables per version. The mapper dispatches to the correct table models.

**Rationale:** Shared tables would require nullable columns for version-specific fields, making queries harder.

### How does the tool find the same About-sheet field across versions?
<!-- scenario: compare-across-versions; topic: version-differences -->

**Situation:** V1 uses "ISO currency code" / "Conversion rate". V2.x uses "Reporting currency (ISO-4217)" / "Exchange rate used: 1 USD =".

**Decision:** A config dispatch dict maps each version to the correct Python attribute names. All consumers use this dispatch.

**Rationale:** Single source of truth for field name resolution. Adding a new version only requires updating the config.

### Why does v2.0 reference internal Excel table names that don't match the data?
<!-- scenario: compare-across-versions; topic: version-differences -->

**Situation:** V2.0 has tables named "Companies15" (projects) and "Table10" (company data).

**Decision:** The mapper registry maps these names to the correct models.

**Rationale:** V2.0 template uses inconsistent internal Excel names that do not match their semantic purpose.

### How does the tool filter out v1 GFS taxonomy parent rows?
<!-- scenario: compare-across-versions; topic: version-differences -->

**Situation:** V1 templates render the GFS taxonomy as visual indent in revenue rows. Parent rows like `('11E', 'Taxes', None, None, None, None)` reach the parser as candidate data rows alongside real data rows.

**Decision:** Schemas can declare a row filter that rejects rows after extraction but before validation. The v1 government revenue schema uses one that keeps a row only if at least one country-supplied field is populated. v2.x schemas don't need a filter; their data is already flat.

**Rationale:** Without the filter, parent rows whose blanks are structural (not country gaps) would generate roughly 50 spurious BLANK_CELL findings per file. Placing the row-filter hook at the base schema level means any future schema can opt in without special-casing.

**Technical detail:** The hook is `BaseTableSchema.row_filter: Callable[[dict], bool] | None`. `GOV_REVENUE_SCHEMA_V1` sets `row_filter=_is_v1_revenue_data_row`. Row-iterating readers (`TableReader`, `PivotTableReader`) call `schema.row_filter` directly rather than relying on `getattr` duck-typing.

### How does the tool distinguish country-supplied fields from template-supplied labels in v1?
<!-- scenario: compare-across-versions; topic: version-differences -->

**Situation:** The sentinel-only typing approach (ADR-009) is being extended to v1 schemas, but v1 templates predate the "every cell required" design and mix country-supplied data fields with template-side label fields in the same row.

**Decision:** Country-supplied fields are typed so that blanks produce BLANK_CELL findings and the cleaner backfills "Not available." Template-supplied row labels and ditto-pattern fields are treated as free text — a missing value silently becomes a blank sentinel rather than a finding. The split is decided per field by asking "is this cell the country's responsibility, or pre-filled by the template?"

**Rationale:** Treating both kinds of cell the same way either erases real country gaps (if blanks are always silent) or generates noise on structural blanks the country never owned (if blanks are always findings). Splitting them per field preserves the strict-typing philosophy where it applies and stays quiet where it doesn't.

**Technical detail:** Country-supplied fields type as `T | NotAvailable`. Template-supplied fields type as `FreeText` — `Annotated[str | Blank, BeforeValidator(_none_to_blank)]`, where `_none_to_blank` coerces `None` to `Blank.BLANK`.

---

## Cross-Cutting

### Where are dashboard stats computed: server or browser?
<!-- scenario: cross-cutting; topic: cross-cutting -->

**Situation:** The dashboard needs financial totals and reconciliation gap.

**Decision:** Stats are computed in the browser (JS) and CLI (Python) from extracted data. The server never computes stats.

**Rationale:** Stats are a presentation concern. The pipeline context carries only raw data and findings, not derived statistics.

### How do Python and JS produce consistent stats?
<!-- scenario: cross-cutting; topic: cross-cutting -->

**Situation:** Both Python and JS need the same table and field mappings.

**Decision:** A single `stats_config.json` is loaded by both runtimes. A contract test verifies both produce identical stats from the same fixture.

**Rationale:** Eliminates drift between the two implementations.

### What happens when a single crosscheck function crashes?
<!-- scenario: cross-cutting; topic: cross-cutting -->

**Situation:** One crosscheck function crashes.

**Decision:** Each check is wrapped in its own try/except. A crash produces an error finding scoped to that check. Other checks still run.

**Rationale:** One bad check should not prevent the user from seeing results from other checks.

### How are numeric IDs from Excel handled?
<!-- scenario: trust-the-data; topic: cross-cutting -->

**Situation:** Excel reads numeric IDs (company ID, project ID) as floats (e.g. 12345.0).

**Decision:** A validator strips the `.0` suffix before validation.

**Rationale:** IDs are identifiers, not numbers. Excel's float representation should not leak into the data.

### How does the tool avoid truncating large entity lists from the database?
<!-- scenario: operate-at-scale; topic: cross-cutting -->

**Situation:** The enricher fetches entity data from the external EITI database via Datasette.

**Decision:** Streaming mode is enabled on all Datasette requests.

**Rationale:** Without streaming, Datasette's default row limit (5000) silently truncates large tables (the companies table has 5400+ rows).

### What happens to abandoned sessions?
<!-- scenario: operate-at-scale; topic: cross-cutting -->

**Situation:** A session is abandoned (user never resumes).

**Decision:** Sessions are marked expired after a TTL period. Cache is eligible for cleanup.

**Rationale:** Abandoned sessions should not consume storage indefinitely.

### Why is the v2.x sector field not validated?
<!-- scenario: trust-the-data; topic: cross-cutting -->

**Situation:** The sector field on v2.1 company revenue rows.

**Decision:** Validation is disabled (type is Any).

**Rationale:** EITI has not clarified the expected values for this field. Suspending validation avoids rejecting valid data.

### How is pipeline behavior customized across clients and submission types?
<!-- scenario: cross-cutting; topic: cross-cutting -->

**Situation:** Multiple layers need to control what the pipeline does — the submission type defines version-specific rules, but the client (API, CLI, batch) may need to override which services run or what dependencies they use.

**Decision:** A three-tier priority model. Service defaults are the fallback. Per-submission-type configuration overrides defaults. Client instructions (skip flags and injected dependencies) override everything.

**Rationale:** Keeps the pipeline linear and predictable while allowing both data-driven customization (per submission type) and user-driven customization (per client mode).

### Why is per-submission-type config spread across services rather than centralized?
<!-- scenario: cross-cutting; topic: cross-cutting -->

**Situation:** Each service maintains its own configuration dictionary keyed by submission ID. Adding a new submission type requires touching six or more files.

**Decision:** Keep the scattered approach for now. Centralize into a single submission-profile object when submission types grow beyond three or four. An exhaustiveness test guards against missing entries in the meantime.

**Rationale:** Scattered dictionaries are pragmatic for three types. Centralization is the right long-term architecture but a significant refactor that isn't yet justified.

### Why are entity resolution and ID assignment split into two services?
<!-- scenario: cross-cutting; topic: cross-cutting -->

**Situation:** Entity resolution needs two steps — resolve names to database IDs, then assign fresh IDs to unresolved names. Both could live in one service.

**Decision:** The enricher resolves names against existing records before the review interrupt. The mapper assigns fresh IDs to anything still unresolved after the review interrupt.

**Rationale:** User corrections at the review interrupt can change entity names. ID assignment must happen after corrections are final. If IDs were assigned before review, corrections would invalidate already-issued IDs with no mechanism to update downstream references.

### Which kinds of blank cells does the cleaner auto-fill?
<!-- scenario: fix-problems-before-import; topic: cross-cutting -->

**Situation:** The parser distinguishes three blank-cell codes by field type: BLANK_CELL (non-blocking, the field accepts "Not available"), BLANK_CELL_BLOCKING (strict — no sentinel allowed), and BLANK_CELL_DEPENDENT (the field accepts "Not applicable" but only when an upstream field is populated). An earlier draft auto-filled all three.

**Decision:** The cleaner only fills BLANK_CELL. BLANK_CELL_BLOCKING is source-only — the field type explicitly disallows sentinels, so the user must fix the source. BLANK_CELL_DEPENDENT is dropdown-fixable — the parser offers "Not applicable" as a candidate, and the user either picks it via review, fills real data, or escalates via FLAGGED.

**Rationale:** Auto-filling "Not available" on a strict-typed field would lie about the contract. The whole point of declaring a field as requiring a real value is to require real data. The cleaner respects field-type semantics; the user makes the call for ambiguous cases via review or FLAGGED escalation.

**Technical detail:** "Not applicable" candidates are extracted from the validator's enum error on the `T | NotApplicable` union and attached to the finding.

### What does the tool require before letting the user move past review?
<!-- scenario: fix-problems-before-import; topic: cross-cutting -->

**Situation:** The original gate excluded any finding with candidates from "unfixable." That meant a BLANK_CELL_DEPENDENT carrying "Not applicable" as a candidate passed the gate without the user actually picking — and the row got written with NULL into a nullable column.

**Decision:** The gate now requires every VALIDATION finding (that doesn't carry its own proposed value) to be covered — either by a CLEANING finding with a proposed value at the same coordinates, or by a USER_CHOICE correction submitted via the request body or already recorded for the session. A finding that has candidates but no pick and no cleaner coverage is unfixable until the user picks.

**Rationale:** The earlier "candidates exist therefore fixable" check was a soft promise. Forcing user picks closes the silent-NULL path. The UX consequence is that every dropdown-fixable cell becomes a required review action, which matches the strict-typing philosophy.

### How does the tool guarantee that every imported cell has been mapped?
<!-- scenario: cross-cutting; topic: cross-cutting -->

**Situation:** Previously the mapper had two independent paths that could silently write NULL into a data column: one that skipped emitting a mapping when the value was None, and a None fallback in the importer when coercing a row. Combined with nullable column definitions, this hid contract violations.

**Decision:** The mapper emits CELL_MAPPED for every column on validated rows. Rows that still carry uncovered VALIDATION findings are filtered out entirely so the importer never sees a partial row. Text-shaped content columns are declared NOT NULL in the schema. A defensive error type in the importer's row-coercion path catches anything that slips through.

**Rationale:** Closes the silent-NULL path at multiple levels — at the mapper (no skip), at the row gate (no partial rows reach the importer), and at the DDL (the database refuses NULL on text columns). Numeric content columns remain nullable for now; a future typed-storage refactor will address those.

**Technical detail:** Uncovered None values still get a per-cell skip with a comment. Rows with uncovered findings are tracked in a `failed_rows` set. The defensive `MissingRequiredFieldError` branch in `_coerce_row` rarely fires for tightened columns because dataclass fields kept `default=""` to preserve instantiation.

### How does the user escalate a finding the tool can't resolve?
<!-- scenario: fix-problems-before-import; topic: cross-cutting -->

**Situation:** A "dismissed" feedback code used to mean "user dismisses the error, importer keeps going." That bypass is obsolete — under the strict-type design, blanks either become sentinel strings (cleaner-filled or user-picked) or get rejected by the review gate. There is no "dismiss and keep going" path anymore.

**Decision:** Feedback codes are renamed to reflect the new model: a manual-fix code becomes USER_CHOICE, and the dismissal code becomes FLAGGED. The dismiss bypass at the review endpoint is removed entirely. FLAGGED gets a meaningful escalation channel via two new endpoints: an interim flag endpoint (replace-on-POST, doesn't transition session state) and a terminal feedback endpoint (transitions the session to an error-data state, emits structured log events). Flags persist in the target database keyed by session ID.

**Rationale:** Separates iterative editing from terminal abort. The user can save flag notes freely without committing the session. Flags survive session abort so the dev team can query flagged findings post-mortem.

**Technical detail:** `CorrectionCode` → `FeedbackCode`; `MANUAL_FIX` → `USER_CHOICE`; `DISMISSED` → `FLAGGED`. Endpoints are `POST /session/{id}/flag` (interim) and `POST /session/{id}/feedback` (terminal). Flag rows live in `metadata_feedback_flags`.

### How does the tool keep row numbers consistent across the API and the UI?
<!-- scenario: cross-cutting; topic: cross-cutting -->

**Situation:** The parser emitted row indices as 1-indexed while every other service used 0-indexed enumeration. The mismatch caused user picks and cleaner-produced overrides to silently miss in the mapper's override lookup. The bug went uncaught because no integration test exercised override application.

**Decision:** Row indices are 0-indexed end-to-end internally. Presentation-layer consumers (CLI, web UI, CSV export, screen-reader labels, text exports) prefer the Excel-absolute (1-indexed) sheet row number for display, falling back to the internal index plus one when the sheet number is unavailable.

**Rationale:** One convention everywhere is cleaner than patching `+1` at every consumer. Tests already constructed findings as if the convention were 0-indexed, indicating that's what the surrounding code believed. Migrating the parser fixes the latent override bug as a side effect.

**Technical detail:** Internal field: `Finding.table_row_index` (0-indexed). Display field: `sheet_row_index` (1-indexed, Excel-absolute). Helpers: `displayRow(f)` in `apps/web_ui/web-utils.js`; `_display_row(f)` in `apps/cli/src/cli/main.py`.
