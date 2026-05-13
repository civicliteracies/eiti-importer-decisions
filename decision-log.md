# Decision Log

How the EITI Data Importer handles data, organized by topic. Each entry documents a choice that affects what the tool does with submitted files.

The first section, **Pending Decisions**, lists choices we know we need to make but can't yet — typically because they depend on EITI clarification, an upstream template fix, or empirical observation we haven't gathered. Each pending entry names the question, the current workaround, what would unblock the decision, and the consequence of the workaround so a reader knows what's compromised. When a pending decision resolves, it moves into the appropriate section below as a normal entry, and the pending row is deleted.

---

## 0. Pending Decisions

### v2.1 / v2.0 company-revenue Sector column — VLOOKUP misalignment

**Question:** Should `sector` on company revenue rows (v2.x Part 5 / Gov_revs_comp_proj) be typed as `Sector | NotAvailable` and validated against the `Sector` enum, or remain `str | NotAvailable` (validation suspended)?
**Blocker:** The v2.1 Excel template's Sector column uses `=VLOOKUP(C15, Companies[], 3, FALSE)`, which pulls column index 3 ("Company type", e.g. "State-owned enterprises"), NOT column index 5 ("Sector"). v2.0 Norway shows the same shape with company registration numbers. v2.0 Philippines happens to be correct. The bug is in the EITI template, not our parser.
**Current workaround:** Field typed as `sector: str | NotAvailable` in `v2p1.py` and `v2p0.py`; comment "validation suspended until EITI clarification" cites this task.
**What unblocks:** EITI confirms the formula should use index 5 (and ships a corrected template) OR confirms the column is intentionally Company type and we rename the field.
**Consequence of workaround:** Sector values in our ledger from v2.x company revenue tables are unreliable — they may be company-type strings, registration numbers, or the correct sector, depending on which template version the country used. Dashboards aggregating by Sector will produce nonsense buckets. Document this in test-deploy release notes.
**Action when resolved:** uplift field type, drop the suspension comment, add the correct enum membership test, audit existing v2.x ledger rows for backfill.

---

## 1. Data Quality Policy

### Fixable vs source-only error classification

**Situation:** A validation error is found in parsed data.
**Decision:** Errors with correction candidates (dropdown options) or a proposed value (auto-fix) are "fixable" in the review UI. Errors with neither are "source-only" — the submitter must fix the source Excel file.
**Rationale:** Operators need to distinguish between errors they can resolve in the tool and errors that require the data submitter to re-export.

### Source-only errors block import

**Situation:** The dashboard displays a status after validation.
**Decision:** If any source-only error exists, status is BLOCKED. The operator cannot proceed to import.
**Rationale:** Source-only errors cannot be resolved in the tool. Importing data with them would produce a corrupted dataset.

### Crosscheck findings trigger review

**Situation:** Consistency findings (unregistered entities, currency mismatches) are present but no source-only validation errors exist.
**Decision:** Status is NEEDS_REVIEW, not SUCCESS.
**Rationale:** Consistency warnings indicate data quality issues even if each individual cell validates. The operator must acknowledge them before proceeding.

### Quality score weighting

**Situation:** A 0-100 data quality score is computed from findings.
**Decision:** Source-only errors count as 1 error per row. Fixable errors count as 0.5. Score = (1 - weighted_errors / total_rows) x 100.
**Rationale:** Source-only errors are more disruptive (they block import), so they are weighted more heavily.

### Quality score color bands

**Situation:** The quality score is displayed on the dashboard.
**Decision:** >= 90 = good (green). >= 70 = warn (yellow). < 70 = bad (red).
**Rationale:** Quick visual triage for the operator.

### Template placeholders are errors

**Situation:** A cell contains angle-bracket placeholder text (e.g. `<placeholder>`) or instruction text like "add new rows as necessary".
**Decision:** Flagged as a validation error asking the submitter to provide real data.
**Rationale:** Template instructions left in cells by data submitters should not be imported as data.

### Misspelled enum values are fixable

**Situation:** A cell value fails enum validation (e.g. misspelled sector name).
**Decision:** The valid enum values are extracted and attached to the finding as correction candidates, making the error fixable via dropdown.
**Rationale:** The operator can select the correct value without needing to know the enum definition.

### "Not available" and "Not applicable" sentinels

**Situation:** Cells contain the strings "Not available" or "Not applicable" where numeric data is expected.
**Decision:** Accepted by the parser. Written to the ledger as literal strings. Clean tables convert them to NULL via SQL CASE guard, with the original sentinel recorded in `clean_flags`.
**Rationale:** Preserves the distinction between genuinely empty (NULL) and explicitly marked as unavailable. The ledger is raw; clean tables are analysis-ready.

### Three sentinel types: NotAvailable, NotApplicable, Blank

**Situation:** The parser needs to represent three reasons a cell value is absent: data not available (NV), data not applicable (NA), and field legitimately empty (BLANK).
**Decision:** Three separate StrEnum types in `shared.diagnostics` — `NotAvailable` (NV), `NotApplicable` (NA), `Blank` (BLANK). Each communicates different things and has different pipeline consequences:
- `NotAvailable` — data gap. Filled by cleaner's `MapToNotAvailableRule`. Produces a Finding visible in UI.
- `NotApplicable` — structural inapplicability. Set by parser via `@model_validator(mode="before")` cascade. No error.
- `Blank` — optional by design. Set by parser via field default. No error.
A field's type signature declares exactly which sentinels it accepts. `NotAvailable` and `NotApplicable` may appear together where real data uses both (e.g., `submitted_data_to_eiti: ResponseOption | NotApplicable | NotAvailable`); the helper's precedence rule resolves which BLANK_CELL_* code applies.
**Rationale:** Combining NV and NA in one enum meant any field accepting one implicitly accepted the other. Three separate types give precise control: `T | NotAvailable` allows data gaps, `T | NotApplicable` allows dependency-driven absence, `T | Blank` allows optional emptiness.

### EITI's enum design conflated values with sentinels

**Situation:** `Sector.NOT_APPLICABLE`, `ProjectStatus.NOT_APPLICABLE`, and `ResponseOption.NOT_APPLICABLE`/`NOT_AVAILABLE` mixed categorical values with absence sentinels in the same StrEnum.
**Decision:** Remove these members from the enums; consumer fields that legitimately accept NA/NV are union-typed with the appropriate sentinel(s) per a per-field audit. `ReportingOption` keeps its NA/NV members because they are semantically valid answers to the metadata-row question, not absence sentinels.
**Rationale:** `Sector | NotApplicable` is unambiguous; `Sector` containing both real sectors and `Not applicable` was not. Single source of truth: `"Not available"` always parses to `NotAvailable.NV` (except for `ReportingOption` answers, which are intentionally distinct).

### Parser field types are information contracts

**Situation:** Choosing Pydantic field types for parser schemas.
**Decision:** Field types tell downstream consumers what to expect — they don't decide what the data should be. A field typed `float | NotAvailable` declares "data field, absence is a gap". A field typed `T | NotApplicable` declares "dependent — absence has structural meaning when upstream is present".
**Rationale:** Without explicit sentinels in the type, downstream cannot distinguish "missing data" from "structurally absent" from "legitimately empty". Each sentinel in a union grants a specific permission to the field.

### Field categories: data, dependent, free, structural-NA

**Situation:** Each parser schema field needs a policy for blank cells.
**Decision:** Four categories, expressed entirely through the type signature:
- **Data (blocking)** — `T`. Blank = `BLANK_CELL_BLOCKING` (source must be fixed).
- **Data (non-blocking)** — `T | NotAvailable`. Blank = `BLANK_CELL` → cleaner fills NV.
- **Dependent** — `T | NotApplicable`. Cascade pre-fills NA when upstream is absent. Blank when upstream present = `BLANK_CELL_DEPENDENT` (blocking).
- **Structural NA** — bare `NotApplicable`. Cascade pre-fills NA when cell is None; non-NA strings rejected as `INVALID_DATATYPE` (preserves alignment errors).
- **Free** — `FreeText` typed alias (`Annotated[str | Blank, BeforeValidator(_none_to_blank)]`) with default `Blank.BLANK`. The `BeforeValidator` coerces explicit `None` from empty cells to `Blank.BLANK`; the default fills missing keys.
**Rationale:** Categories drive the entire sentinel flow — parser behavior, cleaner rules, and UI visibility all derive from the type signature. No per-field flag table needed.

### Data fields are never BLANK

**Situation:** Some data (e.g., ASM employment, investment) is not tracked by all countries.
**Decision:** Data fields never use BLANK. A missing data value is always NV (`NotAvailable`), never BLANK (`optional by design`). Only comments and free text use BLANK.
**Rationale:** The parser cannot know whether data is absent because the country doesn't track it or because they forgot to report it. That distinction is for the human reviewer to assess in the UI. NV signals "this is a data gap" — whether expected or not — and keeps the auto-fill visible.

### Blocking vs non-blocking blank cells

**Situation:** A blank data cell needs classification — should it block import?
**Decision:** Three parser codes derived by `_blank_cell_code_for(model, field_name)` introspection:
- `BLANK_CELL` (non-blocking) — type union contains `NotAvailable`. Cleaner's `MapToNotAvailableRule` fills with NV automatically.
- `BLANK_CELL_BLOCKING` — strict `T` (no sentinels). No candidates, no cleaner fill — source-only. User fixes the source file or escalates via FLAGGED.
- `BLANK_CELL_DEPENDENT` — type union contains `NotApplicable` (and not `NotAvailable`). Parser puts `'Not applicable'` in candidates (extracted from the Pydantic enum error on the union), so the user picks NA via the review dropdown, fills real data, or escalates via FLAGGED.

When both `NotAvailable` and `NotApplicable` are in the union, `BLANK_CELL` wins by precedence (treats blank as data gap by default; reviewer can override via the review dropdown).
**Rationale:** Blocking is a domain decision encoded in the type. Making it explicit in the Finding code lets the UI present it without needing domain knowledge. The cleaner respects the field-type contract — it does not override strict types or auto-pick between NA/NV when the field declares both as alternatives.

### BLANK_CELL vs INVALID_DATATYPE codes

**Situation:** A cell fails validation. What parser code should it get?
**Decision:** Two distinct paths based on cell content:
- Cell is None (whitespace-only normalized to None upstream) → `BLANK_CELL_*` derived from type via `_blank_cell_code_for`.
- Cell has a non-None value but wrong type → `INVALID_DATATYPE` (existing). Cleaner may fuzzy-fix (`EnumCorrectionRule`), standardize (`StandardizeNotAvailableRule` / `StandardizeNotApplicableRule`), or remove (`PlaceholderRemovalRule`).
**Rationale:** Blank cells and wrong-type cells have different error semantics, different cleaner rules, and different reviewer actions. Distinct codes make this explicit.

### Blank cells: parser sets NA, cleaner sets NV

**Situation:** A cell is blank. Who decides whether it becomes NV or NA?
**Decision:** The parser sets NA via `@model_validator(mode="before")` cascade when a dependency makes the field irrelevant (domain knowledge). The cleaner fills NV for `BLANK_CELL` findings (no domain knowledge needed). The cleaner never sets NA.
**Rationale:** NA requires understanding *why* a field is empty (e.g., in-kind volume is NA when payment isn't in-kind). Only the parser has this domain knowledge. The cleaner's rule is simple: non-blocking blank cell = NV.

---

## 2. Currency & Financial Calculations

### Exchange rate convention

**Situation:** The About sheet declares an exchange rate.
**Decision:** Interpreted as "1 USD = X local currency units". Local-to-USD divides by rate. USD-to-local multiplies by rate.
**Rationale:** Matches the label used in EITI templates ("Exchange rate used: 1 USD =").

### Zero exchange rate treated as missing

**Situation:** The About sheet has exchange rate = 0.
**Decision:** Treated as "not provided". USD totals become N/A.
**Rationale:** Zero is never a meaningful FX rate and would cause division by zero.

### Infinity and NaN exchange rates rejected

**Situation:** The exchange rate field contains a value like "1e309" or "nan".
**Decision:** Rejected at the boundary. Both produce 0.0 (treated as missing).
**Rationale:** Infinity divisor silently produces 0. NaN propagates. Both produce wrong totals.

### Dual-currency totals

**Situation:** The dashboard displays financial totals.
**Decision:** Every total is computed in two currencies: local (reporting currency) and USD. The dashboard shows USD as the primary figure and local as a secondary line.
**Rationale:** The EITI audience needs USD comparability across countries, but local currency is what the declaration reports.

### One unconvertible row poisons the total

**Situation:** A table has rows in mixed currencies and one row cannot be converted.
**Decision:** If any single row's value is uncomputable on one side (local or USD), the entire total for that side becomes N/A.
**Rationale:** A partial sum missing some rows would be misleading. Better to show N/A than an incomplete total.

### Foreign non-USD rows are unconvertible

**Situation:** A row's currency is neither the reporting currency nor USD.
**Decision:** Both the local and USD values for that row are uncomputable.
**Rationale:** The tool has only one exchange rate (USD-local). Converting a third currency (e.g. EUR) requires an additional rate that the file does not provide.

### USD-reporting files need no conversion

**Situation:** The About sheet declares reporting currency = USD.
**Decision:** Both local and USD totals are identical. No exchange rate needed. No secondary line on the dashboard.
**Rationale:** USD-to-USD conversion is identity. Showing the same number twice adds no information.

### Reconciliation gap definition

**Situation:** The reconciliation gap is computed.
**Decision:** Gap = total government revenue minus total company payments. Positive means government reported more than companies. Percentage = gap / total government revenue x 100.
**Rationale:** Matches the EITI reconciliation methodology (government side as reference).

### Gap percentage prefers local currency

**Situation:** The reconciliation gap percentage is computed.
**Decision:** Uses the local currency pair if both sides are available. Falls back to the USD pair otherwise.
**Rationale:** Local currency avoids introducing conversion noise into the percentage.

### Gap color threshold

**Situation:** The reconciliation gap is displayed on the dashboard.
**Decision:** Absolute gap percentage <= 10% = green. > 10% = red.
**Rationale:** 10% threshold is a meaningful indicator of reconciliation quality for EITI data.

### V1 rows assumed to be in reporting currency

**Situation:** V1 template files have no per-row currency column.
**Decision:** All rows are treated as being in the reporting currency. Local total is always computable. USD total requires the exchange rate from the About sheet.
**Rationale:** V1 template design predates per-row currency columns.

### V1 exchange rate fallback from EITI historical data

**Situation:** V1 files never include an exchange rate in the About sheet, but EITI's own API export has rates for 96% of historical declarations.
**Decision:** A committed JSON file (`v1_exchange_rates.json`, extracted from the EITI API export) provides fallback rates keyed by `{iso3}_{year}`. When a v1 file's About sheet has no rate, `compute_stats` looks up the rate from the JSON using `country_iso3` + `end_date` year. Both Python and JS receive the rates via the `/stats-config` endpoint.
**Rationale:** Historical exchange rates are stable and available from EITI's own data. A static JSON avoids runtime dependency on external services. Both language implementations read the same source, preventing drift.

### V1 USD conversion: two independent paths (UI vs DB)

**Situation:** V1 files lack exchange rates. USD values are needed both in the dashboard (UI) and in the database views (datasette).
**Decision:** Two independent mechanisms:
- **UI path**: `compute_stats` (stats.py / stats.js) uses a runtime fallback from `v1_exchange_rates.json` — works for any v1 file at any time, even without importing.
- **DB path**: SQL views (`view_payments_detailed`, `view_revenues_detailed`) read `exchange_rate_used` from `metadata_summary_data_files`. For v1 files, this column is populated by a one-time backfill script (`scripts/backfill_v1_exchange_rates.py`) after import.
**Rationale:** The mapper is not touched — adding a v1-specific branch to the hot path for a one-time historical import is not justified. The backfill script is idempotent and isolated. Both paths read from the same `v1_exchange_rates.json` source.

### SQL views use DROP + CREATE (not IF NOT EXISTS)

**Situation:** View definitions may change between releases.
**Decision:** `init_target_db()` runs `DROP VIEW IF EXISTS` + `CREATE VIEW` at startup.
**Rationale:** `CREATE VIEW IF NOT EXISTS` silently keeps the old definition when the SQL changes. Drop+create ensures the view always matches the code.

### V1 dashboard shows local currency as primary

**Situation:** V1 files without a historical exchange rate have no USD totals, but local totals are computable.
**Decision:** The dashboard shows local currency as the primary (large) figure for v1 files without a rate. No "N/A" notice, no USD line. When USD is available (v2.x with rate, or v1 with fallback rate), USD is shown as primary with local as secondary.
**Rationale:** Showing "N/A" when a computable value exists is misleading. The local total is the most useful number for the operator reviewing the file.

### Sentinel revenue values excluded from clean tables

**Situation:** A revenue cell contains "Not available" or "Not applicable".
**Decision:** Rows with sentinel revenue values are excluded entirely from clean table aggregations (not just NULLed).
**Rationale:** A "Not available" payment should not appear as zero in aggregations.

---

## 3. Workflow & Status

### Three-status model

**Situation:** The operator uploads a file and sees the dashboard.
**Decision:** SUCCESS = no validation errors or crosscheck issues. NEEDS_REVIEW = fixable errors or crosscheck issues. BLOCKED = source-only errors present.
**Rationale:** Maps to the operator's action: proceed immediately, review and correct, or reject back to submitter.

### Degraded output over abort

**Situation:** A non-critical service (enricher, crosschecker, cleaner) encounters an error.
**Decision:** The service catches its own exceptions, produces an error finding, and returns normally. The pipeline continues. Only template detection and parsing produce terminal errors.
**Rationale:** Degraded output (fewer findings) is more useful than aborting. Enrichment failing should not prevent the operator from seeing validation results.

### Import requires explicit human confirmation

**Situation:** The pipeline reaches the import stage.
**Decision:** The operator must select a responsible user, optionally add comments, and explicitly click "Confirm Import". Rejection returns to a rejected state.
**Rationale:** Import is the single mutation point. No data is written without deliberate human authorization.

### Audit stamp required for import and deletion

**Situation:** Data is about to be written to or deleted from the database.
**Decision:** Both operations require an audit stamp (full name, email, role, channel, comments). An audit record is created.
**Rationale:** Full accountability chain for who touched the database and why.

### Findings are append-only

**Situation:** Services produce findings as they run.
**Decision:** The pipeline context carries findings as an append-only list. Services add to it but never modify existing findings.
**Rationale:** Preserves the full audit trail of proposed changes.

### User corrections take precedence

**Situation:** The operator corrects a cell value in the review UI.
**Decision:** Correction precedence: user correction > cleaner > extracted data. Corrected values skip automated transforms.
**Rationale:** The operator's explicit fix is the most authoritative source.

### "Restart" and "Cancel & Start Over" buttons are destructive

**Situation:** The Web UI offers a "Restart session" button in the header and a "Cancel & Start Over" button in the template-confirmation modal.
**Decision:** Both call `POST /sessions/{id}/kill`. The session is written as `CANCELLED` (a terminal state), the cached PipelineContext is deleted, and the operator returns to the upload zone. There is no undo. The same applies at batch level: `POST /batches/{id}/kill` cancels every non-terminal member of the batch in one transaction.
**Rationale:** "Restart" matches the operator's mental model — start over from scratch. The underlying mechanism is destructive cancellation, not preservation. Cancellation is what releases the file-content hash dedup slot immediately, removes the session from the recovery sweep's attention, and frees the cache row.

### Batch confirm requires every member to be decided

**Situation:** The operator clicks "Confirm batch" on a batch whose members are in mixed states (some at CONFIRMING, some still in REVIEWING, some in ERROR_DATA).
**Decision:** `POST /batches/{id}/confirm` returns 409 unless every member is in a decided state (CONFIRMING, CONFIRMED, IMPORTED, REJECTED, ERROR_DATA, ERROR_UNKNOWN, CANCELLED). Once all are decided, CONFIRMED is written atomically for the CONFIRMING subset; members already in terminal states are left alone. The Web UI mirrors this by disabling "Confirm batch" until every member is decided.
**Rationale:** Each batch member is an independent declaration — no business-data atomicity is required across them. But forcing per-member decisions before bulk confirm prevents partial-state surprises: the operator must explicitly resolve each file (approve at review or reject) before bulk-committing the approved subset.

---

## 4. Template Recognition

### Three-signal confidence scoring

**Situation:** An uploaded Excel file needs to be identified as v1, v2.0, or v2.1.
**Decision:** Confidence score (0-150) is computed from three weighted signals: version string in Introduction sheet (50 pts), required sheets present (20 pts), table and column structure match (80 pts).
**Rationale:** Weighted combination handles files with missing metadata or renamed sheets while still producing reliable identification.

### Candidate threshold

**Situation:** Template versions are scored against a file.
**Decision:** Any version scoring >= 40 is added to the candidates list.
**Rationale:** 40 is low enough to catch files with significant variations but high enough to exclude random matches.

### Ambiguous detection triggers user confirmation

**Situation:** Multiple templates score above the threshold.
**Decision:** The pipeline suspends. The user must pick the correct version.
**Rationale:** Automatic selection from ambiguous candidates could import data using the wrong schema.

### Exact match skips confirmation

**Situation:** Exactly one template scores above the threshold AND the detected cohort set is exactly one NEW cohort with zero DUPE cohorts.
**Decision:** The pipeline continues automatically.
**Rationale:** No ambiguity, nothing to choose between, nothing already imported. Reduces friction for the SDF happy path. Any of: ambiguous template, multiple NEW cohorts (fat-file fan-out), or any DUPE cohort routes to the SELECTION_CONFIRMING interrupt for explicit user input.

### Unrecognized file is a terminal error

**Situation:** No template scores above the threshold.
**Decision:** The pipeline transitions to an error state.
**Rationale:** Cannot proceed without a known schema to parse against.

### Wrong-sheet penalty

**Situation:** A table is found on a different sheet than expected during identification.
**Decision:** 50% score penalty for that signal.
**Rationale:** Files may have tables on moved sheets. This reduces confidence without eliminating the candidate.

### Schema staleness detection

**Situation:** Parser schema files change between sessions (code deployment).
**Decision:** A hash of parser schema files is stored with each session. On resume, if the hash differs, the session is marked stale and re-run.
**Rationale:** Cached results from an old parser version may be incorrect.

---

## 5. Entity Resolution

### Exact match by normalized name

**Situation:** A company, agency, or project name from the file is compared against the EITI database.
**Decision:** Names are normalized (Unicode transliteration, trimmed, uppercased) and compared. Exact match assigns the database entity ID.
**Rationale:** Unicode normalization and case-insensitive matching handles accents and capitalization differences without fuzzy matching.

### New entities get UUID4 identifiers

**Situation:** An entity name has no match in the EITI database.
**Decision:** A UUID4 is assigned as the entity's business key. The entity is written to the metadata table as a new entry.
**Rationale:** New entities need a stable identifier for the ledger even though they do not exist in the external database yet.

### Companies searched globally; agencies and projects filtered by country

**Situation:** The enricher queries the external EITI database.
**Decision:** Company search is global (no country filter). Agency and project searches are filtered by the file's country code.
**Rationale:** Companies operate across countries (multinational). Agencies and projects are country-specific.

### Declaration UUID from country + year

**Situation:** A unique identifier is needed for each declaration.
**Decision:** UUID5 from "{country_iso3}:{year}". Same country + year always produces the same UUID.
**Rationale:** Deterministic identity allows detecting re-imports of the same declaration.

### Cohort as the unit of duplicate detection

**Situation:** A file is identified. The system checks the target DB for prior imports.
**Decision:** Detection is per-cohort, not per-file. Each `SubmissionDefinition` declares a `cohort_schema` that enumerates the cohorts the file contains. SDF declares a single `(country_iso3, year)` cohort. Fat-file submissions (validation data, company assessment, API extracts) declare N cohorts per file. DetectorService emits one COHORT_DETECTED finding per cohort and classifies each NEW or DUPE against the target DB.
**Rationale:** A fat file with 50 country-years may have 48 new cohorts and 2 already imported. Per-file dedup would force the operator to delete the prior 2 (or rebuild the file without them) before importing. Per-cohort dedup lets them import only the new cohorts and decide explicitly what to do with the duplicates.

### Duplicate submission policy

**Situation:** DetectorService classifies every declared cohort against the target DB.
**Decision:**
- Every cohort DUPE → terminal `DUPLICATE_SUBMISSION` finding → ERROR.DATA. The operator must explicitly delete the prior import(s) and re-upload if they want to proceed.
- Mixed NEW + DUPE, or multiple NEW cohorts → SELECTION_CONFIRMING interrupt. The operator picks which cohorts to import.
- Exactly one NEW + zero DUPE → continue silently.
**Rationale:** All-DUPE means the operator likely uploaded the wrong file or forgot a prior import was already there — fail loud rather than silently overwriting. Mixed cases need human judgment because the answer depends on what the operator intended (re-import a corrected version? skip the duplicates? cancel?). Silent continue is reserved for the unambiguous SDF happy path.

### False negatives preferred over false positives in entity matching

**Situation:** The enricher can either match aggressively (risk linking to the wrong entity) or conservatively (risk treating a known entity as new).
**Decision:** Conservative — exact normalized match only. No fuzzy matching, no partial scoring.
**Rationale:** False negatives are recoverable: the mapper assigns a fresh UUID4, and a future dedup pass can merge it with the correct record. False positives corrupt ledger foreign keys — the row points to the wrong entity, and there is no automated correction path. The asymmetry in recovery cost dictates the conservative strategy.

---

## 6. Consistency Rules

### Part 5 entities must be registered in Part 3

**Situation:** Company, agency, or project names appear in Part 5 (company payments) data.
**Decision:** Each name is checked against Part 3 registration tables. Unregistered names produce consistency findings.
**Rationale:** Part 5 should only reference entities formally registered in Part 3. Unregistered entities suggest data entry errors or incomplete registration.

### Part 5 revenue streams must exist in Part 4

**Situation:** Revenue stream names in Part 5 are not found in Part 4 (government revenues table).
**Decision:** A finding is produced for each unmatched stream.
**Rationale:** Revenue streams should be consistently named across Parts 4 and 5 for reconciliation.

### Entity name matching is case-insensitive

**Situation:** Names are compared across parts of the template.
**Decision:** Names are lowercased before comparison.
**Rationale:** Minor capitalization differences should not produce false positives.

### Empty tables produce completeness findings

**Situation:** The parser found the government revenues or company payments table, but it has zero data rows.
**Decision:** A finding is produced. The message explains the corresponding side of the reconciliation gap is uncomputable.
**Rationale:** An empty table is distinct from a missing table (the parser reports those separately). Zero rows means the parser succeeded but found no data.

### Per-row currency consistency check

**Situation:** V2.0 and v2.1 files have per-row currency columns.
**Decision:** Each row's currency is compared to the reporting currency from the About sheet. Mismatches produce findings.
**Rationale:** Mixed currencies require the exchange rate to be correct and available. The operator should be aware of mismatches.

### Missing reporting currency blocks currency check

**Situation:** The About sheet does not declare a reporting currency, but per-row currency columns exist.
**Decision:** A single finding is produced. Per-row checks are skipped entirely.
**Rationale:** Without a reference currency, there is nothing to compare against.

### Crosscheck findings are warnings, not blocking

**Situation:** Crosscheck findings are produced.
**Decision:** They trigger NEEDS_REVIEW status, not BLOCKED. The operator can proceed to import after reviewing them.
**Rationale:** Crosscheck issues may be legitimate (e.g. an entity registered under a slightly different name). They require human judgment, not automatic rejection.

### In-file totals crosschecked against computed sums

**Situation:** Excel files include "Total in [currency]" rows that contain pre-computed sums.
**Decision:** Extract totals as regular data rows via `KVP_SCAN`, then crosscheck against computed sums from the corresponding data table with a tolerance of 1.0 currency unit.
**Rationale:** Excel SUMIF rounding produces sub-cent drift. A tolerance of 1.0 absorbs this without masking genuine discrepancies.

### Totals crosscheck uses declarative config

**Situation:** Different submission types have different table names, field names, and grouping semantics for the totals comparison.
**Decision:** `TotalsSpec` dataclass config defined per `SubmissionConfig` profile in `crosscheck_totals`. Each spec declares the data table, totals table, value fields, group-by field, and mismatch code.
**Rationale:** Adding a new submission type means config entries, not code. The check logic is format-agnostic by design — it operates on the `extracted_data` contract, not the source format.

---

## 7. Import Behavior

### Importer has no domain knowledge

**Situation:** Data needs to be written to the database.
**Decision:** The importer reads only mapped findings from the pipeline context. It never reads extracted data. All data preparation is done upstream by the mapper.
**Rationale:** Single responsibility. The importer cannot introduce data interpretation errors.

### Re-import replaces existing data

**Situation:** An import targets a declaration that already has data in the database.
**Decision:** Existing rows for that declaration are deleted before writing new ones.
**Rationale:** Re-import should produce the same result as a fresh import. No duplicate accumulation.

### Metadata tables use upsert

**Situation:** Reference data (countries, currencies, GFS codes) may already exist.
**Decision:** Insert-or-ignore for all metadata tables. Deduplication by natural key.
**Rationale:** Multiple files from the same country should not create duplicate records.

### Deletion is audit-preserving

**Situation:** The operator deletes a declaration from the data management tab.
**Decision:** Data rows (clean tables and ledger) are permanently deleted. The summary data file record is soft-deleted. An audit record of the deletion persists.
**Rationale:** Data is permanently removed for privacy and correctness, but the audit trail of who deleted what and when is preserved.

### Deletion requires two-step confirmation

**Situation:** The operator clicks "Delete".
**Decision:** First step: select responsible user and click "Delete permanently". Second step: browser confirmation dialog.
**Rationale:** Destructive operation requires deliberate intent.

### Clean tables generated via SQL

**Situation:** After ledger rows are written.
**Decision:** Clean tables are generated via submission-dispatched INSERT...SELECT queries that join ledger rows with metadata entity tables.
**Rationale:** Clean tables denormalize data for direct querying. No application code needed for the denormalization step.

### Missing declaration UUID blocks import

**Situation:** No declaration UUID is found in the pipeline findings when the importer runs.
**Decision:** Import is aborted with an error finding.
**Rationale:** The declaration UUID is the primary key for all data rows. Without it, nothing can be written.

### Duplicate detection runs in three independent layers

**Situation:** An operator uploads a file that may have been imported before.
**Decision:** Three layers run in sequence, each catching a different failure shape:

- **Layer 1 — file-content hash at upload.** SHA-256 of the upload bytes is checked against prior successful imports. A match rejects the upload with 409. Catches "same file uploaded twice."
- **Layer 2 — cohort classification at identification.** The detector enumerates the cohorts the file contains (one for SDF, N for fat files) via the submission's `cohort_schema`. Each cohort is checked against the active declaration registry. All-DUPE terminates with ERROR.DATA; mixed NEW/DUPE routes to the SELECTION_CONFIRMING interrupt. Catches "different file claiming the same identity" and "fat file overlapping with prior imports."
- **Layer 3 — file-content hash at confirmation.** The hash is re-checked against both committed imports AND active in-flight sibling sessions before the importer commits. A match rejects with 409. Catches the race where two operators upload identical content simultaneously and both pass Layer 1.

**Rationale:** Each layer has a different blast radius. Layer 1 is cheapest, catches the common case, runs before any pipeline work begins. Layer 2 handles the semantic "I edited the file but it's still the same declaration" case. Layer 3 is structural, vanishingly rare in a single-operator team, but closes the TOCTOU window that the other two cannot.

### Hash dedup respects soft-delete

**Situation:** An operator deleted a declaration and re-uploads the same file (identical bytes).
**Decision:** Soft-deleted prior imports do NOT block the upload — the hash check looks only for active declarations (`is_deleted = 0`).
**Rationale:** Deletion is the operator's "let me try again" signal. Permanent blocking would defeat the user flow.

### Failed imports do not block retries

**Situation:** An operator's prior upload of the same file failed mid-import (status != success).
**Decision:** The hash check filters on `status = success` only. Failed imports are invisible to dedup.
**Rationale:** Retries of failed work are the legitimate next step. Blocking them would force the operator to mutate the file just to bypass the check.

### File-hash dedup is disabled in LOCAL only

**Situation:** A developer iterates on a fixture file on their laptop, repeatedly re-uploading.
**Decision:** `Settings.dedup_uploads_by_hash` is False in the LOCAL profile and True in every other environment (DEV, TEST, STAGING, PROD). There is no request-header bypass.
**Rationale:** Dev iteration without bypass forces `mise run db:reset` between every test upload — friction with no integrity benefit at a single-developer machine. Server environments enforce dedup uniformly; no caller can disable it.

### Hash-collision 409 surfaces a release action

**Situation:** Operator B uploads a file whose SHA-256 matches an in-flight session held by Operator A (who walked away mid-flow). Without intervention, Operator B is blocked from confirming until Operator A's session TTL expires (hours to days).
**Decision:** 409 responses at upload time and at confirmation time include `sibling_session_ids`, `sibling_batch_id` (if applicable), and a structured `release_action(s)` field naming the kill endpoint the caller can invoke to release the dedup slot immediately. The Web UI surfaces this as a "Cancel that session and retry" modal action; the CLI prompts via `questionary`.
**Rationale:** Without the release path, the only unblock is TTL — operationally unacceptable when an abandoned session blocks a colleague's legitimate work. Activity-based auto-release (heartbeat-tracked idle sessions auto-yielding their slot) is deferred to MVP6 because it needs activity-tracking infrastructure and an auth model. Until then, the explicit release action makes the workaround discoverable to anyone who hits the collision.

---

## 8. Version Differences

### V1 has no Excel named tables

**Situation:** V1 template does not use Excel's formal named table feature.
**Decision:** All V1 table identification uses anchor-based fallbacks (searching for header text in sheets).
**Rationale:** V1 template design predates Excel named tables.

### V1 has no projects or agencies tables

**Situation:** V1 template does not have dedicated sheets for projects or agencies.
**Decision:** V1 crosscheck and enrichment skip projects and agencies. V1 clean tables omit project and agency tables.
**Rationale:** V1 template does not include these entities.

### Government revenue field name differs across versions

**Situation:** The stats engine sums government revenues.
**Decision:** V1 uses "revenue_total". V2.0 and v2.1 use "revenue_value". Dispatched via config.
**Rationale:** Different template versions use different column names for the same concept.

### V1 has no per-row currency columns

**Situation:** Currency consistency check or stats computation for a v1 file.
**Decision:** V1 currency fields are null in the config. Currency consistency check skips entirely. Stats engine treats all rows as being in the reporting currency.
**Rationale:** V1 template predates per-row currency columns.

### V1 revenue sheet is pivoted

**Situation:** V1 has companies as column headers rather than rows in the revenue sheet.
**Decision:** The parser unpivots the data during extraction into a flat table matching the v2.x shape.
**Rationale:** Normalizes the data to a consistent shape for all downstream processing.

### Separate ledger tables per version

**Situation:** V1, v2.0, and v2.1 have different column sets.
**Decision:** Separate ledger tables per version. The mapper dispatches to the correct table models.
**Rationale:** Shared tables would require nullable columns for version-specific fields, making queries harder.

### About sheet field names differ across versions

**Situation:** V1 uses "ISO currency code" / "Conversion rate". V2.x uses "Reporting currency (ISO-4217)" / "Exchange rate used: 1 USD =".
**Decision:** A config dispatch dict maps each version to the correct Python attribute names. All consumers use this dispatch.
**Rationale:** Single source of truth for field name resolution. Adding a new version only requires updating the config.

### V2.0 non-obvious table names

**Situation:** V2.0 has tables named "Companies15" (projects) and "Table10" (company data).
**Decision:** The mapper registry maps these names to the correct models.
**Rationale:** V2.0 template uses inconsistent internal Excel names that do not match their semantic purpose.

### V1 government revenue parent rows are filtered at parse time

**Situation:** V1 templates render the GFS taxonomy as visual indent in revenue rows. Parent rows like `('11E', 'Taxes', None, None, None, None)` reach the parser as candidate data rows alongside real data rows.
**Decision:** `BaseTableSchema.row_filter` (a `Callable[[dict], bool] | None`) lets schemas reject rows after extraction but before validation. `GOV_REVENUE_SCHEMA_V1` declares `row_filter=_is_v1_revenue_data_row`, which keeps a row only if at least one country-supplied field is populated.
**Rationale:** Without the filter, the sentinel-only typing would generate ~50 spurious `BLANK_CELL` findings per file from parent rows whose blanks are structural, not country gaps. The principled placement is on `BaseTableSchema` (not `HeaderSearchSchema`) because the policy generalises — any future schema can declare a row filter. Row-iterating readers (`TableReader`, `PivotTableReader`) call `schema.row_filter` directly, no `getattr` duck-typing. v2.x schemas leave it `None`; their data is already flat.

### V1 schemas use sentinel-only typing per the country-side / template-side split

**Situation:** The sentinel-only typing (ADR-009) is extended to v1 schemas.
**Decision:** Country-supplied fields type as `T | NotAvailable` (blanks produce `BLANK_CELL` findings, cleaner backfills `NotAvailable.NV`). Template-supplied row labels and ditto-pattern fields type as `FreeText` (`Annotated[str | Blank, BeforeValidator(_none_to_blank)]` — None silently coerces to `Blank.BLANK`).
**Rationale:** v1 templates predate the standardised "every cell required" design and have a structural mix of country-supplied data fields and template-side label fields. Treating both as the same erases real gaps (with `Blank` everywhere) or generates noise (with `NotAvailable` everywhere). The split is decided per field by asking "is this cell the country's responsibility, or pre-filled by the template?"

---

## Cross-Cutting

### Stats computed client-side

**Situation:** The dashboard needs financial totals and reconciliation gap.
**Decision:** Stats are computed in the browser (JS) and CLI (Python) from extracted data. The server never computes stats.
**Rationale:** Stats are a presentation concern. The pipeline context carries only raw data and findings, not derived statistics.

### Shared JSON config between Python and JS

**Situation:** Both Python and JS need the same table and field mappings.
**Decision:** A single `stats_config.json` is loaded by both runtimes. A contract test verifies both produce identical stats from the same fixture.
**Rationale:** Eliminates drift between the two implementations.

### Per-check exception isolation in crosschecker

**Situation:** One crosscheck function crashes.
**Decision:** Each check is wrapped in its own try/except. A crash produces an error finding scoped to that check. Other checks still run.
**Rationale:** One bad check should not prevent the operator from seeing results from other checks.

### Numeric ID normalization

**Situation:** Excel reads numeric IDs (company ID, project ID) as floats (e.g. 12345.0).
**Decision:** A validator strips the `.0` suffix before validation.
**Rationale:** IDs are identifiers, not numbers. Excel's float representation should not leak into the data.

### Datasette streaming for large entity tables

**Situation:** The enricher fetches entity data from the external EITI database via Datasette.
**Decision:** Streaming mode is enabled on all Datasette requests.
**Rationale:** Without streaming, Datasette's default row limit (5000) silently truncates large tables (the companies table has 5400+ rows).

### Session expiration

**Situation:** A session is abandoned (user never resumes).
**Decision:** Sessions are marked expired after a TTL period. Cache is eligible for cleanup.
**Rationale:** Abandoned sessions should not consume storage indefinitely.

### Sector validation suspended for v2.1 company revenue

**Situation:** The sector field on v2.1 company revenue rows.
**Decision:** Validation is disabled (type is Any).
**Rationale:** EITI has not clarified the expected values for this field. Suspending validation avoids rejecting valid data.

### Pipeline configuration priority: client > submission type > service

**Situation:** Multiple layers need to control what the pipeline does — the submission type defines version-specific rules, but the client (API, CLI, batch) may need to override which services run or what dependencies they use.
**Decision:** Three-tier priority model. Service defaults are the fallback. Submission type config (per-service dicts keyed by SubmissionID) overrides defaults. Client instructions (factory skip flags + DI parameters) override everything.
**Rationale:** Keeps the pipeline linear and predictable while allowing both data-driven customization (submission type) and operator-driven customization (client mode).

### Submission-type config is scattered, not centralized

**Situation:** Each service maintains its own config dict keyed by SubmissionID. Adding a new submission type requires touching 6+ files.
**Decision:** Keep the scattered approach for now. Centralize into a SubmissionProfile when submission types grow beyond 3-4. Exhaustiveness test guards against missing entries.
**Rationale:** Scattered dicts are pragmatic for 3 types. Centralization is the right long-term architecture but a significant refactor.

### Enricher/mapper split forced by review interrupt boundary

**Situation:** Entity resolution needs two steps — resolve names to database IDs, then assign fresh IDs to unresolved names. Both could live in one service.
**Decision:** The enricher resolves (runs before the REVIEWING interrupt). The mapper assigns fresh UUIDs (runs after the REVIEWING interrupt).
**Rationale:** User corrections at the review interrupt can change entity names. ID assignment must happen after corrections are final. If the enricher assigned IDs before review, corrections would invalidate already-issued IDs with no mechanism to update downstream references.

### Cleaner fills NV only for BLANK_CELL (non-blocking)

**Situation:** The parser distinguishes three blank-cell codes by field type — `BLANK_CELL` (non-blocking, `T | NotAvailable`), `BLANK_CELL_BLOCKING` (strict `T`), `BLANK_CELL_DEPENDENT` (`T | NotApplicable` with upstream present). Earlier draft of this PR auto-filled all three; reverted because strict types declare a hard contract.
**Decision:** Cleaner only fills `BLANK_CELL`. `BLANK_CELL_BLOCKING` is source-only — the field type explicitly disallows sentinels, so the user must fix the source. `BLANK_CELL_DEPENDENT` is dropdown-fixable — the parser puts `'Not applicable'` in the finding's candidates (extracted from the Pydantic enum error on the `T | NotApplicable` union), so the user picks NA via review, or fills real data, or escalates via FLAGGED.
**Rationale:** Auto-filling NV on a strict-typed field would lie about the contract. The whole point of declaring `revenue_value: float` (no sentinel) is to require real data. The cleaner respects the field-type semantics; the user makes the call for ambiguous cases via review or FLAGGED escalation.

### /review gate requires explicit coverage for every VALIDATION finding

**Situation:** Pre-PR gate excluded findings with candidates from "unfixable." That meant a `BLANK_CELL_DEPENDENT` carrying `candidates=('Not applicable',)` passed the gate without the user actually picking — and the row got written with NULL into a nullable column.
**Decision:** The gate now requires every VALIDATION finding (without its own `proposed_value`) to be COVERED — either by a `CLEANING` finding with `proposed_value` at the same coords, or by a `USER_CHOICE` correction submitted via the request body or already in `context.findings`. Findings with candidates but no pick AND no cleaner coverage are unfixable until the user picks.
**Rationale:** The "candidates exist therefore fixable" check was a soft promise. Forcing user picks closes the silent-NULL path that previously existed. UX impact: every dropdown-fixable cell becomes a required review action, which matches the strict-typing philosophy.

### Mapper emits CELL_MAPPED for every column on validated rows; failed rows skipped

**Situation:** Pre-PR, the mapper had two independent paths that could silently write NULL into a data column: a `if val is not None: emit_finding(...)` skip, and the importer's `_coerce_row` None fallback. Combined with nullable DDL, this hid contract violations.
**Decision:** Mapper emits CELL_MAPPED for every column on validated rows (no `is not None` skip — though uncovered None values still get a per-cell skip with a comment). Rows with uncovered VALIDATION findings are filtered out entirely (`failed_rows` set) so the importer never sees a partial row. DDL declares NOT NULL on text-shaped `*_col_content` columns. `MissingRequiredFieldError` exists as defense-in-depth in `_coerce_row`, though its branch rarely fires for tightened columns because Phase 8 used `default=""` to keep dataclass instantiation working.
**Rationale:** Closes the silent-NULL path at multiple levels. Numeric `*_col_content: float | None` columns remain nullable; a future typed-storage refactor will address those.

### FLAGGED replaces DISMISSED; two-endpoint feedback flow

**Situation:** `CorrectionCode.DISMISSED` was reserved for "user dismisses the error, importer keeps going." That bypass is obsolete — under the strict-type design, blanks either become sentinel strings (cleaner-filled or user-picked) or get rejected by the /review gate. There's no "dismiss and keep going" path anymore.
**Decision:** Rename `CorrectionCode` → `FeedbackCode`; `MANUAL_FIX` → `USER_CHOICE`; `DISMISSED` → `FLAGGED`. The DISMISSED bypass at `/review` is removed entirely. FLAGGED gets a meaningful escalation channel via two new endpoints: `POST /session/{id}/flag` (interim, replace-on-POST, doesn't transition state) and `POST /session/{id}/feedback` (terminal, transitions to ERROR_DATA, emits structlog events). Flags persist in `metadata_feedback_flags` (target DB) keyed by session_id.
**Rationale:** Separates iterative editing from terminal abort. Modal can save freely without committing. Survives session abort so the dev team can query flagged findings post-mortem.

### `Finding.table_row_index` is 0-indexed; presentation layer adds +1

**Situation:** The parser emitted `ParsingError.table_row_index = i + 1` (1-indexed) while every other service (enricher, crosschecker, mapper) used `enumerate(rows)` (0-indexed). The mismatch caused user `USER_CHOICE` and cleaner-produced `BLANK_TO_NOT_AVAILABLE` overrides to silently miss in the mapper's `overrides.get((table, row_idx, field))` lookup. Bug uncaught because no integration test exercised override application.
**Decision:** `Finding.table_row_index` is **0-indexed** end-to-end internally. Presentation-layer consumers (CLI, web UI, CSV export, screen-reader labels, text exports) prefer `sheet_row_index` (Excel-absolute, 1-indexed) for display, falling back to `table_row_index + 1`. Helpers: `displayRow(f)` in `apps/web_ui/web-utils.js`, `_display_row(f)` in `apps/cli/src/cli/main.py`.
**Rationale:** One convention everywhere is cleaner than `+1` patches at every consumer. Tests already constructed findings with `table_row_index=0`, indicating the surrounding code believed the convention was 0-indexed. Migrating the parser fixes the latent override bug as a side effect.
