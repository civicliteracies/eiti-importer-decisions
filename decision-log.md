# Decision Log

How the EITI Data Importer handles data, organized by topic. Each entry documents a choice that affects what the tool does with submitted files.

The first section, **Pending Decisions**, lists choices we know we need to make but can't yet — typically because they depend on EITI clarification, an upstream template fix, or empirical observation we haven't gathered. Each pending entry names the question, the current workaround, what would unblock the decision, and the consequence of the workaround so a reader knows what's compromised. When a pending decision resolves, it moves into the appropriate section below as a normal entry, and the pending row is deleted.

---

## 0. Pending Decisions

### Should the Commodity enum gain "Oil & Gas" / "Condensate" aggregates?
<!-- scenario: trust-the-data; topic: pending-decisions -->

**Situation:** Liberia and similar files report a single `"Oil, Gas, Condensates"` cell on the project commodities field — a compound aggregate, not three separate rows. The canonical `Commodity` enum has `"Crude oil (2709)"`, `"Natural gas (2711)"`, but no aggregate value covering oil+gas or a `"Condensates"` entry distinct from crude.

**Question:** Should the enum gain an aggregate value covering oil+gas, or should compound reporting always require row splitting? EITI has not stated whether multi-product aggregates are a reporting style they intend to support, or whether they expect one-product-per-row exclusively.

**Status quo:** `MULTI_VALUE_IN_SINGLE_FIELD` parser code fires only when the cell contains ≥2 *canonical* enum values separated by `[,;]`. `"Oil, Gas, Condensates"` does not match canonical tokens and falls through to `INVALID_DATATYPE`, surfacing in the review tab so the operator sees it. Operators reviewing Liberia-shaped files must reject the row and ask the submitter to split it, or pick a single canonical commodity from the dropdown.

**Technical detail:** The compound-detection logic is `detect_compound_commodity` in `packages/parser/src/parser/domain/schemas/validation_helpers.py`. When resolved: either extend `Commodity` enum members with aggregates, or update user-facing guidance on multi-commodity reporting and keep current behaviour.

---

### Should multi-commodity-per-row reporting be supported, or always require row splitting?
<!-- scenario: trust-the-data; topic: pending-decisions -->

**Situation:** A row in the Projects table represents one project with one commodity. Some countries report multiple commodities in a single row using comma separators (`"Iron (2601), Gold (7108)"`).

**Question:** Should the parser (a) emit a single-cell finding and require the operator to split the row in the source file, (b) auto-split the row into multiple rows during extraction, or (c) accept the compound encoding and represent it as a list field downstream? EITI has not specified whether compound encoding is valid syntax or a reporting error.

**Status quo:** `MULTI_VALUE_IN_SINGLE_FIELD` parser code emits a source-only finding when ≥2 canonical commodities are detected in one cell. The operator must split the row in Excel; the cleaner does not auto-split. Files with compound rows cannot import until the operator splits them. The pipeline does not silently flatten or duplicate them.

**Technical detail:** Detection is `detect_compound_commodity` in `packages/parser/src/parser/domain/schemas/validation_helpers.py`; routing through `MULTI_VALUE_IN_SINGLE_FIELD` happens in `_map_pydantic_errors` in `packages/parser/src/parser/validation/row_validator.py`. When EITI resolves: either confirm row-split is the canonical workflow (no code change) or implement auto-splitting in the parser with the appropriate downstream changes (mapper row enumeration, clean-table aggregation semantics).

---

## 1. Data Quality Policy

### What kinds of errors can be fixed in the tool?
<!-- scenario: fix-problems-before-import; topic: data-quality-policy -->

**Situation:** When the importer flags a problem with a cell in the uploaded file, the dashboard needs to tell the user which problems still need their attention, which the tool can fix automatically, and which require going back to the source Excel file.

**Decision:** Each flagged data cell falls into one of three buckets:

- **Needs your choice** — the review tab offers a dropdown of valid values; the user must pick one before the file can be confirmed. Example: a misspelled Sector value gets a dropdown of the five valid sectors (Oil, Gas, Mining, Oil & Gas, Other).
- **Auto-fixed** — the importer's cleaner has a suggested correction that will apply automatically when the user confirms the file. The user can override the suggestion from the review tab, but doing nothing accepts it. Example: a number cell whose value carries an obvious unit suffix gets the suffix stripped and the numeric portion proposed.
- **Source-only** — there is no dropdown and no suggestion; the only path forward is to fix the source Excel file and re-upload. Example: a blank cell in a strictly-typed numeric column.

The dashboard card for each file shows the split as two counts ("12 need your choice · 52 auto-fixed"). The All Files dashboard aggregates the same split across the batch ("3 need your choice · 12 auto-fixed across 2 files"). Source-only cells surface separately as a BLOCKED label on the file.

**Rationale:** Three buckets match the three actions the user can take: pick from a dropdown, accept (or override) the cleaner's suggestion, or stop and fix the source file. Two buckets — "fixable" and "source-only" — would conflate the dropdown-picking work with the no-action-needed auto-fixed bucket, leading the user to over-count their own workload. A file showing 64 issues, all auto-fixed by the cleaner, otherwise looks like 64 outstanding tasks; splitting the count makes the actual work visible.

**Technical detail:** The bucket is derived from the shape of the underlying validation finding. A finding with `candidates` populated and no cleaner `proposed_value` is "needs-choice"; a finding with `proposed_value` set is "auto-fixed"; a finding with neither is "source-only". The derivation lives on the Finding model in `packages/shared/src/shared/diagnostics.py` as a computed field `resolution_mode`, populated by a Pydantic `model_validator(mode='after')` so the value travels across the wire alongside the raw fields. Both the client gate (`isBlocked` in `apps/web_ui/blocked-status.js`) and the server gate (`validate_corrections_cover_fixable` in `packages/shared/src/shared/correction_gate.py`) read `resolution_mode` directly — a single source of truth, no parallel derivation that could drift between the two surfaces. The dashboard cards consume the same field via `classifyFinding(f)` in `apps/web_ui/dashboard-utils.js`.

### When does an error block import?
<!-- scenario: trust-the-data; topic: data-quality-policy -->

**Situation:** After the importer checks an uploaded file, the dashboard shows one of three statuses — SUCCESS, NEEDS_REVIEW, or BLOCKED — and a banner explaining what the user has to do next.

**Decision:** If any flagged problem can only be fixed in the source file (no dropdown, no suggested correction), the status is BLOCKED and the user cannot advance to import. The banner counts these and reads "N errors must be fixed in the source file". The user's options are to correct the source Excel file and re-upload, or to escalate the problem through the FLAGGED feedback action.

**Rationale:** Problems that can only be fixed in the source sit on cells the tool has no way to repair. Letting the user "proceed" past them would either skip those rows silently or land a known-bad value in the EITI database. Either outcome breaks the promise that an imported declaration matches what the submitter declared, so the safer behaviour is to refuse import entirely until the source is corrected.

**Technical detail:** The dashboard status calculation lives in `apps/web_ui/components/dashboard.js` (`updateStatusBanner`): `status = sourceOnly.length > 0 ? 'BLOCKED' : ((hasErrors || hasCrosscheckIssues) ? 'NEEDS_REVIEW' : 'SUCCESS')`. The matching server-side gate lives in `packages/shared/src/shared/correction_gate.py` (`validate_corrections_cover_fixable`), called by `BatchManager.bulk_review` via `POST /sessions/review`; the bulk endpoint returns HTTP 422 with `BulkReviewConflictsResponse` listing each session whose unfixable VALIDATION findings remain uncovered.

### When is a review required before import?
<!-- scenario: trust-the-data; topic: data-quality-policy -->

**Situation:** The importer has flagged problems, but every one of them is fixable in the tool — each comes with either a dropdown or a suggested correction. Some cross-file consistency warnings may also be present (unregistered companies, dominance of a non-reporting currency on a revenue table, and so on), but no source-only error.

**Decision:** The dashboard lands on NEEDS_REVIEW rather than SUCCESS. The user can proceed to import, but only after acting on every fixable flag — either accepting the suggested correction or picking from the dropdown. Consistency warnings do not have to be resolved; they only have to be visible to the user before they confirm.

**Rationale:** A fixable flag left untouched would commit a row with a null or default value into a column the source didn't actually fill. Consistency warnings need human judgement (a company registered under a slightly different spelling is legitimate; a Ghana-reporting file whose government revenue rows are 85% USD is suspicious), so the right action is to surface them and require the user to look, not to auto-block.

**Technical detail:** The dashboard branch is in `apps/web_ui/components/dashboard.js`; the import-time enforcement of "every fixable finding must be covered" lives in the `correction_gate.validate_corrections_cover_fixable` helper in `packages/shared/src/shared/correction_gate.py`, called by `BatchManager.bulk_review` (via `POST /sessions/review`). The bulk endpoint applies the gate per session and returns HTTP 422 with per-session failure detail if any uncovered validation finding remains in any listed session.

### How is the data quality score computed?
<!-- scenario: trust-the-data; topic: data-quality-policy -->

**Situation:** The dashboard shows a 0–100 data quality score next to the validation summary so the user gets a quick read on how clean the file is.

**Decision:** The score is the percentage of rows that have no problem flagged against them, with one wrinkle: problems that can only be fixed in the source file count twice as heavily as problems the user can fix in the review tab. Each source-only problem contributes 1 to the weighted error count and each fixable problem contributes 0.5. The score is then `round((1 - min(weighted_errors / total_rows, 1)) * 100)`. So a file with 100 rows, 4 source-only errors, and 6 fixable errors yields `(1 - (4 + 3) / 100) * 100 = 93`. Only data-cell problems count toward the score — cross-file consistency warnings and reference-data enrichments do not move it. If the file has no rows to score, the dashboard shows no score at all.

**Rationale:** Source-only errors are more disruptive because they block import outright, so the score reflects that asymmetry rather than treating every problem as equal weight. Tying the score to the share of bad rows (rather than the absolute error count) means a 10-row file with 2 errors and a 1000-row file with 200 errors land in the same band, which matches how the user reads file health.

**Technical detail:** The function is `computeQualityScore(findings, totalRows)` in `apps/web_ui/dashboard-utils.js`, called from `apps/web_ui/components/dashboard.js`. The fixable-vs-source-only split is delegated to `classifyFinding(f)` in the same module. Only findings in the `VALIDATION` category contribute; crosscheck and enrichment findings are ignored. The score is `null` when `total_rows` is 0.

### How are quality scores color-coded?
<!-- scenario: trust-the-data; topic: data-quality-policy -->

**Situation:** The data quality score appears on the dashboard as a coloured badge so the user can triage at a glance.

**Decision:** Scores of 80 or higher render green ("good"), scores between 50 and 79 render yellow ("warn"), and scores below 50 render red ("bad"). When the file has no rows to score, the badge renders as "unknown".

**Rationale:** Three bands match the user's coarse decision: ship it, look at it, or send it back. Tighter thresholds would make the green band rare and reduce its signal; coarser thresholds would let visibly broken files sit in the green band.

**Technical detail:** Implemented in `qualityBand(score)` in `apps/web_ui/dashboard-utils.js` (`>= 80 → 'good'`, `>= 50 → 'warn'`, otherwise `'bad'`; `null` → `'unknown'`).

### What does the "Schema Deviations" dashboard section mean?
<!-- scenario: trust-the-data; topic: data-quality-policy -->

**Situation:** EITI templates have evolved across versions, and submitters sometimes use column headers that match an earlier template's wording. The v2.0 and v2.1 templates also have a known fault on Part 5: the Sector column auto-fills from the wrong source column on Part 3, so the Sector cell ends up holding a company registration number or a company type string instead of a real sector value.

**Decision:** When the tool accepts a column under a header variant (for example "Full company name" mapped to the canonical "company"), or repairs a Part 5 Sector cell by looking the company name up in Part 3, it surfaces what it did in a "Schema Deviations" dashboard section without blocking the import. The status badge at the top of the page stays "Ready" for these cases. The single exception is the ambiguous-sector case — two or more Part 3 rows for the same company name with conflicting sectors — which bumps the badge to "Needs review" because the tool used a last-written-wins choice the operator should reconcile in the source file.

**Rationale:** The data lands correctly in the database either way: variant headers map to canonical fields, recovered sectors are the operator's intended value. Surfacing the deviations gives the operator a record of what the tool auto-resolved, which they may want to flag for next year's submission (use the canonical header) or pass to the report's data-entry team (reconcile ambiguous sectors at source). Bumping the badge only for the ambiguous case matches the rule that "Needs review" means there is something the operator should look at — the other deviations are informational and need no action.

**Technical detail:** The Sector fault is the v2.x template's VLOOKUP formula pulling from the wrong source column on Part 3. Backed by `ParserCode.NON_CANONICAL_HEADER_USED`, `VLOOKUP_SECTOR_RECOVERED`, and `VLOOKUP_SECTOR_AMBIGUOUS` (`packages/shared/src/shared/diagnostics.py`). Rendering goes through `formatSchemaDeviationSummary(findings, extractedData)` in `apps/web_ui/dashboard-utils.js`, called from the dashboard component between the "Cross-table Checks" and "Validation Errors" sections. The "Needs review" bump uses the `isSchemaDeviationActionable(finding)` predicate, the single source of truth for which codes warrant operator attention.

### How is the "Expectations Met" percentage computed for Company Assessment files?
<!-- scenario: trust-the-data; topic: data-quality-policy -->

**Situation:** A Company Assessment file lists EITI expectations (typically eight to ten) for each supporting company. Each expectation cell carries one of four values: Met, Not Met, Partially Met, or N/A. N/A means "this expectation doesn't apply to this company" — for example, a company in extraction doesn't need the production-licence expectation.

**Decision:** The dashboard's "Expectations Met" headline percentage is the share of *applicable* expectations that were met: `Met ÷ (Met + Not Met + Partially Met)`, rounded to the nearest whole percent. N/A cells are counted separately and excluded from this denominator. Partially Met cells count toward the denominator but not the numerator. When every cell is N/A — a legitimate but rare case — the headline shows nothing rather than a divide-by-zero artefact.

**Rationale:** Including N/A in the denominator would dilute the metric in a way operators don't expect. A company where eight of nine expectations don't apply but the one applicable was met would read as roughly 11% met, when the operator-meaningful answer is 100% of applicable expectations met. Excluding N/A makes cross-country comparisons about coverage quality rather than about how many expectations each country chose to omit. Treating Partially Met as not-met in the numerator (but counted in the denominator) reflects the strict-met rate; the per-bucket card row still shows the Partially Met count separately so a country with high partial coverage isn't invisible.

**Technical detail:** Computed by `computeCoverageHeadline({ met, notMet, partial })` in `apps/web_ui/dashboard-utils.js`, called from the coverage card render in `apps/web_ui/components/dashboard.js`. The function returns `{ applicable, pct }` or `null` (when applicable is zero). Bucket counts come from `computeCoverageStats` in `apps/web_ui/stats.js`, which walks the per-year `assessment_data_{year}` tables and classifies each expectation cell against the canonical Met/Not Met/Partially Met/N/A lists in the wire-side `CoverageStatsConfig`.

### Are template placeholders treated as data?
<!-- scenario: trust-the-data; topic: data-quality-policy -->

**Situation:** A submitter sometimes leaves the EITI template's instructional text in a data cell — either a literal placeholder like `<insert company name>` or one of the instruction phrases the template ships with, such as "add new rows as necessary", "if yes, please specify name", or "other sectors, if applicable".

**Decision:** The importer detects both shapes and flags the cell. The review tab proposes to drop the cell (treat it as if the submitter had left it blank), and the submitter is asked to provide a real value. The placeholder text never lands in the EITI database.

**Rationale:** Importing instructional scaffolding as if it were data would corrupt the EITI database silently. A row whose Company column reads "add new rows as necessary" would look like a real entity and flow through name-matching as a new company. Catching both the angle-bracket placeholder shape and the specific instruction phrases the template ships with stops that at the front door.

**Technical detail:** Detection lives in `packages/parser/src/parser/domain/schemas/validation_helpers.py` in `validate_template_values`, with the instruction-phrase list in `TEMPLATE_INSTRUCTIONS`. The validator rejects both shapes as `INVALID_DATATYPE` errors whose message carries the marker `"template placeholder"` or `"template instruction"`. The cleaner picks those up via `PlaceholderRemovalRule` in `packages/cleaner/src/cleaner/rules.py`, which keys on those marker substrings and emits a `PLACEHOLDER_REMOVED` cleaning finding whose effect is to drop the cell.

### Can a user fix a misspelled value in the tool?
<!-- scenario: fix-problems-before-import; topic: data-quality-policy -->

**Situation:** A cell carries a value that doesn't match the list of valid options for that field — for example, the Sector column contains "Minning" when only Oil, Gas, Mining, Oil & Gas, and Other are allowed.

**Decision:** The review tab shows a dropdown of the valid options so the user can pick the right one without having to look up what's allowed. For close typos, the tool also pre-fills a suggestion: if "Minning" is close enough to "Mining" by fuzzy match, the review tab offers a one-click accept of "Mining" rather than making the user open the dropdown.

**Rationale:** A user reviewing a 200-row file shouldn't have to memorise the allowed values for every column. Surfacing the valid options as a dropdown makes the fix obvious; auto-suggesting the closest match makes the common typo case zero-click. The fuzzy-match threshold is deliberately tuned so any wrong suggestion is still visible to the user in the review tab before they confirm, since the option list is short (three to six choices per field). A second safety net suppresses the suggestion when the two best matches are too close to call: if the runner-up scores within 10 WRatio points of the top match, the auto-fix is withheld and the cell falls through to the dropdown so the operator picks deliberately.

**Technical detail:** Candidate extraction lives in `_extract_enum_candidates` in `packages/parser/src/parser/validation/row_validator.py`, which regex-parses Pydantic's enum error `ctx.expected` string to pull the valid members. The auto-suggestion lives in `EnumCorrectionRule` in `packages/cleaner/src/cleaner/rules.py`, which uses rapidfuzz `WRatio` with `ENUM_CORRECTION_THRESHOLD = 80` and a `ENUM_CORRECTION_RUNNER_UP_GAP = 10` safety net. The threshold sits below the entity-matching threshold of 86 because the candidate set is small. The runner-up gap was calibrated on the public 91-file PortalJS corpus: a gap of 10 blocks 54 silent mis-corrections while preserving 2,515 legitimate fuzzy auto-fixes.

### When a cell matches both a curated alias and a fuzzy candidate, which one wins?
<!-- scenario: fix-problems-before-import; topic: data-quality-policy -->

**Situation:** A cell carries a value the tool can resolve in two different ways. The curated EN/FR/ES alias dictionaries map known drift values to their canonical form — for example, the Sector column entry `"Oil and gas"` is mapped to `"Oil & Gas"` because that EN spelling shows up across many country files. Separately, the fuzzy-match rule scores the cell against the valid options for the column — `"Oil and gas"` against the Sector list scores `"Oil"` at 90% because `Oil` is a substring of the cell. The two rules would otherwise both fire and propose conflicting fixes (curated `"Oil & Gas"`, fuzzy `"Oil"`) for the same cell.

**Decision:** The curated alias always wins. When a cell value is found in the alias dictionary AND the alias's target is one of the valid options for that column, the fuzzy-match rule sits out for that cell. The review tab shows one proposed fix — the curated one — and the operator clicks once to accept.

**Rationale:** The alias dictionary is a deliberate, human-edited list of "this spelling means that canonical value". The fuzzy match is an algorithm guessing at which option is closest. When both apply to the same cell, the algorithm can pick the wrong option because the cell happens to contain a substring of one of the choices — exactly what happens with `"Oil and gas"` scoring `"Oil"` over `"Oil & Gas"`. Letting the algorithm overwrite the curated answer would silently land the wrong value in the database for a cell the tool was designed to handle correctly. The rule "curated source of truth wins over algorithmic guess" matches how reviewers reason about the same situation.

**Technical detail:** EnumCorrectionRule in `packages/cleaner/src/cleaner/rules.py` checks each cell against the per-language alias lookups in `shared.sdf_vocabulary` (`EN_ALIAS_LOOKUP`, `FR_ALIAS_LOOKUP`, `ES_ALIAS_LOOKUP`) before running the rapidfuzz match. If the casefold-normalised cell value resolves to a target AND that target is in the cell's candidate list, the rule emits nothing — AliasResolutionRule will handle the cell and emit `RESOLVED_*_ALIAS`. The candidate-membership guard is the same one AliasResolutionRule itself uses; both rules agree on "this cell's column accepts this canonical value" before either acts. Without this defer, the mapper's override dict — keyed by cell coordinate, written in cleaner-rule order — would last-write-wins on whichever rule appended its finding most recently, and the fuzzy rule runs after the alias rule so the wrong value would silently overwrite the right one.

### Which commodity taxonomy does the tool treat as canonical?
<!-- scenario: trust-the-data; topic: data-quality-policy -->

**Situation:** Country files report commodities in many forms — full HS-code values like `"Aluminium ores and concentrates (2606)"`, short names like `"Bauxite"`, non-English variants like `"Pétrole brut"`, regional abbreviations like `"Coltan"`, and bare ore names like `"Iron"`. The same physical commodity arrives under different labels across countries, languages, and reporting years.

**Decision:** The canonical reference is the World Customs Organization's Harmonized System (HS) 2022 nomenclature. The `Commodity` enum carries the full WCO heading text and 4-digit code (for example `"Aluminium ores and concentrates (2606)"`, `"Iron ores and concentrates (2601)"`, `"Crude oil (2709)"`). Country variants resolve through per-language alias dictionaries before reaching the database; the aggregated database column always carries the HS-aligned canonical value. The `metadata_commodities` table is pre-seeded at API startup with one row per `Commodity` member so junction tables can FK-reference commodities by id and the review-UI dropdown carries plain-language descriptions for non-expert reviewers.

**Rationale:** HS is the only globally-recognised commodity taxonomy used across customs administrations. Anchoring on it gives cross-country aggregations a stable schema regardless of which spelling or translation the submitter typed. Pre-seeding the dimension also means the importer no longer auto-creates `metadata_commodities` rows from cell text, so a typo in one country file can't leak into the canonical commodity list and pollute aggregations for every country thereafter.

**Technical detail:** Canonical members live in `Commodity` in `packages/shared/src/shared/sdf_vocabulary.py`. Plain-language descriptions and HS reference codes live in the adjacent `COMMODITY_METADATA: dict[str, CommodityMetadata]` constant; the derived `HS_CODE_TO_CANONICAL` maps a bare 4-digit code back to its canonical value. Alias dictionaries are EN/FR/ES `AliasSet` instances in `COMMODITY_TRANSLATIONS`. Resolution runs in the cleaner via `AliasResolutionRule`. `ImporterService.seed_canonical_dimensions` runs once per API process from the FastAPI lifespan after `init_target_db`; it verifies the table shape via PRAGMA introspection (drops + recreates under `Env.LOCAL`/`Env.TEST` on divergence, raises "schema migration required" under `Env.PROD`) and upserts via `ON CONFLICT(standardized_commodity_code) DO UPDATE` so surrogate ids survive vocabulary patches.

### How does tabular reporting handle multi-commodity cells?
<!-- scenario: trust-the-data; topic: data-quality-policy -->

**Situation:** A row in the Companies table is a single company that may operate across several commodities (so multiple commodity values in one cell is legitimate). A row in the Projects table is a single project that produces one commodity (so multiple commodities in one cell is a reporting deviation from the template).

**Decision:** The Companies-sheet `commodities` field is typed as a list and validated per-element. The parser segments the cell on `,;`, ` and `, ` et `, ` y `, `&`, `/` and validates each token against the `Commodity` enum, emitting one finding per misspelled or unknown token. Resolved tokens accumulate into the `clean_company_commodities` junction table downstream. The Projects-sheet `commodities` field stays single-value. When two or more canonical commodities are detected in a single Projects cell, the tool emits `MULTI_VALUE_IN_SINGLE_FIELD` and the operator must split the source row before the file can import. Compound detection is alias-aware: `"Iron Ore, Gold Ore"` resolves both tokens via aliases and triggers the same code as `"Iron (2601), Gold (7108)"`.

**Rationale:** Companies are inherently multi-commodity, and representing that as a list at parse time avoids the operator having to pre-split joint cells. Projects represent one commodity per row by template intent ("Commodities (one commodity/row)" is the column header). Auto-splitting Projects rows would invent rows the country did not submit and break the audit trail back to the source file.

**Technical detail:** `segment_commodity_list` runs as the BeforeValidator on the Companies `commodities` field (`packages/parser/src/parser/domain/schemas/v2p0.py` and `v2p1.py`). It NFKC-normalises, normalises spacing around `(`, protects canonical values that themselves contain a separator (e.g. the Niobium 2615 heading) so the splitter does not shred them, then splits on the separator class. Sentinel cells (`"Not applicable"`, `"Not available"` and their accepted variants) pass through unchanged so Pydantic's `NotApplicable` / `NotAvailable` union arm matches. `detect_compound_commodity` lives in the same module and routes through `MULTI_VALUE_IN_SINGLE_FIELD` via `_map_pydantic_errors` in `packages/parser/src/parser/validation/row_validator.py`. Per-token findings carry a `token_index: int | None` field on the Finding model so the mapper override key and the per-cell review UI can address one token at a time.

### How does 'Not available' / 'Not applicable' interact with list-typed cells?
<!-- scenario: trust-the-data; topic: data-quality-policy -->

**Situation:** A list-typed cell (Companies commodities, Projects affiliated companies) can carry separator-laced noise — empty tokens between commas, a stray `-` or `n/a` between two real tokens — that should not produce per-token validation findings of its own.

**Decision:** Per-token noise is dropped silently by the cleaner. A token that is empty/whitespace-only, a dash, or a canonical NA/NV variant is treated as no-data inside the list and produces a `NOISE_TOKEN_REMOVED` cleaning finding with `proposed_value=None` so the mapper skips writing a junction row for it. The cell as a whole — when the entire cell text is a sentinel — passes through to the field's `NotApplicable` / `NotAvailable` union arm exactly as for scalar fields, so a list-typed Companies row with `"Not applicable"` in the commodities column imports as a structural inapplicability marker, not as a one-element list of the sentinel string.

**Rationale:** Per-token validation on list-typed cells produces useful findings on real misspellings but would also produce noise on the small operator artefacts of comma-separator typing. Filtering inside the list keeps the per-token signal clean. Honouring the whole-cell sentinel keeps the field's typed contract intact — the list and the sentinel are different states of the same field.

**Technical detail:** `ListTokenNoiseFilterRule` in `packages/cleaner/src/cleaner/rules.py` consumes per-token `INVALID_DATATYPE` findings (where `token_index is not None`) and emits `CleaningCode.NOISE_TOKEN_REMOVED`. It runs BEFORE `AliasResolutionRule` so noise tokens don't trip alias or fuzzy correction first. Whole-cell sentinels short-circuit inside `segment_commodity_list` in `packages/parser/src/parser/domain/schemas/validation_helpers.py` and `segment_company_list` next to it.

The coverage classifier in `packages/shared/src/shared/correction_gate.py::coverage_class` distinguishes the dropping intent of `NOISE_TOKEN_REMOVED` from the repairing intent of fixing cleanings (`RESOLVED_EN_ALIAS`, `ENUM_CORRECTED`, etc.). A `NOISE_TOKEN_REMOVED` at token N covers ONLY token N — it does NOT cover cell-level validations or sibling-token validations on the same cell. A fixing cleaning at token N covers same-coord validation AND any cell-level INVALID_DATATYPE that Pydantic emitted when the bad token first failed a `list[T] | Sentinel` union arm. The distinction matters for cells with mixed shapes (one bad token plus noise on the same cell): the noise removal does not paper over the bad token, and the operator still sees an actionable review prompt.

### How does the tool handle 'Not available' and 'Not applicable' cells?
<!-- scenario: trust-the-data; topic: data-quality-policy -->

**Situation:** A submitter writes the literal string "Not available" or "Not applicable" in a cell where the column expects a number (a payment value, an in-kind volume) or one of a fixed set of options (a sector).

**Decision:** The importer accepts these as legitimate values. "Not available" means "the data should have been there but wasn't provided"; "Not applicable" means "this field doesn't apply in this row's context". The exact text the submitter wrote ("Not available", "Not applicable", or "Blank" for free-text columns where empty is legitimate) is preserved as part of the imported record so an auditor can later see what the country actually declared. For analytical purposes — totals, averages, anything that aggregates numbers — the same value is reported as missing rather than as a string, so a payment cell reading "Not available" doesn't poison the sum.

**Rationale:** Aggregations need to treat these cells as missing numbers, otherwise totals become nonsense. But the imported record has to preserve what the country actually said, so an auditor can tell "the country said the field was inapplicable" apart from "the value was genuinely missing". Keeping a raw copy and a clean copy of the same data, with a small audit table tracking which cells were substituted, achieves both.

**Technical detail:** The three sentinel string values live in `packages/shared/src/shared/diagnostics.py` (`NotAvailable.NV = "Not available"`, `NotApplicable.NA = "Not applicable"`, `Blank.BLANK = "Blank"`, collected in `SENTINEL_VALUES`). Fields that may legitimately be missing are typed as a union with `NotAvailable` or `NotApplicable`; free-text fields use the `FreeText` alias that maps `None` to `Blank.BLANK`. The raw ledger preserves the sentinel string. The clean tables — the analysis-ready surface — replace any sentinel with SQL `NULL` via a `CASE WHEN col NOT IN ('Not available', 'Not applicable', 'Blank') THEN CAST(col AS REAL) ELSE NULL END` guard generated by `SENTINELS_SQL` in `packages/shared/src/shared/families/_substrate.py`. A row in the `clean_flags` audit table (`CleanFlags` in `packages/shared/src/shared/db_models.py`, columns `source_table`, `field_name`, `row_index`, `original_value`) records the original ledger value for every substituted cell.

### Why is a blank data field always treated as missing rather than legitimate?
<!-- scenario: trust-the-data; topic: data-quality-policy -->

**Situation:** Some data points — ASM employment headcounts, investment-by-sector figures, GDP shares — aren't tracked by every country. When such a cell is empty in the uploaded file, the tool has no way to tell whether the country doesn't collect the metric at all or whether it was simply forgotten in this submission.

**Decision:** A blank data cell is always recorded as "Not available" — meaning data should have been there — never as a legitimate empty. The review tab pre-fills "Not available" on blanks where that's allowed for the field. The only fields that can carry a true empty are free-text columns like comments, where an empty cell genuinely means "the submitter had nothing to add".

**Rationale:** The tool has no information that distinguishes "the country doesn't track this" from "the country forgot to report it" — both arrive as the same empty cell. Auto-marking the cell "Not applicable" would claim a structural reason the tool can't actually verify; leaving it empty in the database would erase the difference between an unknown gap and a deliberate omission. Treating every blank as a data gap keeps the substitution visible in the review tab, where a human reviewer can override it to "Not applicable" if that's the right call.

**Technical detail:** The auto-fill rule is `MapToNotAvailableRule` in `packages/cleaner/src/cleaner/rules.py`; it fires only on `ParserCode.BLANK_CELL`, which is itself only emitted when the field's type union explicitly contains `NotAvailable` (see `blank_cell_code_for` in `packages/parser/src/parser/validation/row_validator.py`). The free-text carve-out is the `Annotated[str | Blank, BeforeValidator(_none_to_blank)]` alias in `packages/parser/src/parser/domain/schemas/validation_helpers.py`.

### Which blank cells block import and which don't?
<!-- scenario: fix-problems-before-import; topic: data-quality-policy -->

**Situation:** A data cell is blank. The tool has to decide whether the import can proceed (with an auto-fill or a user pick from the review tab) or whether the source file has to be corrected first.

**Decision:** Three cases, decided by what the field is allowed to contain:

- If the field is allowed to be "Not available", the cell is auto-filled with "Not available" and the user can accept silently — no block.
- If the field is strictly typed (a required number or a required choice) and accepts no missing-value marker at all, there is no legal way to fill it. The user must fix the source file or escalate via the FLAGGED feedback action.
- If the field is allowed to be "Not applicable" but not "Not available" — for example an in-kind volume that only applies when payment was made in kind — the review tab offers "Not applicable" in the dropdown. The user can pick it, enter a real value, or escalate.

When a field is allowed to be both "Not available" and "Not applicable", the cell defaults to "Not available" and the reviewer can override to "Not applicable".

**Rationale:** Whether a blank blocks import is a domain question that depends on what the field means: a strictly-typed payment value cannot be silently filled, while an optional headcount can. Locking each behaviour to a different flag code lets the dashboard surface the right action without re-deriving the rule, and prevents the auto-fill from guessing between the two missing-value markers when both are legal.

**Technical detail:** The three parser codes are `BLANK_CELL` (non-blocking, auto-fills via `MapToNotAvailableRule`), `BLANK_CELL_BLOCKING` (no sentinel legal), and `BLANK_CELL_DEPENDENT` (`NotApplicable` legal but not `NotAvailable`). The code is derived by `blank_cell_code_for(model, field_name)` in `packages/parser/src/parser/validation/row_validator.py`, which calls `get_args` on the field's annotation and returns `BLANK_CELL` if `NotAvailable` is in the union, `BLANK_CELL_DEPENDENT` if `NotApplicable` is in it, and `BLANK_CELL_BLOCKING` otherwise. The dependent-case candidate is pulled by `_extract_enum_candidates` from the Pydantic enum error on the union.

### How does the tool distinguish a blank cell from a wrongly-typed value?
<!-- scenario: fix-problems-before-import; topic: data-quality-policy -->

**Situation:** A cell fails the importer's checks. Downstream — the auto-fill rules, the review tab, and the gate that decides whether to block import — needs to know whether the failure is "the cell was empty" or "the cell had something in it that didn't fit the column".

**Decision:** The two cases are flagged differently:

- If the cell is empty (truly blank, or contained only whitespace), it's flagged as a blank cell, and the rules in the previous entry decide whether it blocks, auto-fills, or requires a user pick.
- If the cell had a non-empty value that didn't fit, it's flagged as an invalid value. The auto-correction rules then have a chance to repair it — by fuzzy-matching a misspelled choice against the valid list, by normalising variant spellings like "n/a" to the canonical "Not available", or by recognising and dropping template scaffolding like `<insert company name>`.

**Rationale:** Empty cells and wrongly-filled cells have different causes (forgotten data versus wrong vocabulary), different auto-corrections apply to each, and the reviewer's action is different (look up the missing data versus confirm the proposed correction). Giving them distinct flags keeps that distinction visible from upload to import and prevents auto-fill logic from running on cells that aren't actually empty.

**Technical detail:** The dispatch lives in `_map_pydantic_errors` in `packages/parser/src/parser/validation/row_validator.py`: blank cells route to `blank_cell_code_for(...)`; cells where the BeforeValidator raised `CompoundValueError` route to `MULTI_VALUE_IN_SINGLE_FIELD`; cells whose text is a wrong-sentinel variant on the field's accepted set route to `WRONG_SENTINEL` (with the accepted sentinel injected into `candidates` for the cleaner); everything else falls through to `INVALID_DATATYPE`. Whitespace-to-`None` normalisation happens in `validate_template_values` in `packages/parser/src/parser/domain/schemas/validation_helpers.py`. The cleaner repair rules — `PlaceholderRemovalRule`, `StandardizeNotAvailableRule`, `StandardizeNotApplicableRule`, `WrongSentinelCorrectionRule` (cross-sentinel NA↔NV correction), three per-language `AliasResolutionRule` instances (deterministic EN/FR/ES alias resolution against the lookups in `packages/shared/src/shared/sdf_vocabulary.py`), `EnumCorrectionRule`, and `MapToNotAvailableRule` — live in `packages/cleaner/src/cleaner/rules.py` and run in that order so deterministic standardisation precedes fuzzy fallback.

### Who decides whether a blank cell becomes 'Not applicable' or 'Not available'?
<!-- scenario: cross-cutting; topic: data-quality-policy -->

**Situation:** A cell is blank. Something has to decide whether to record it as "Not available" (data should have been there) or "Not applicable" (the field doesn't apply in this row's context).

**Decision:** "Not applicable" is only set automatically when another field in the same row makes the cell structurally inapplicable, because that judgement requires knowing the rest of the row. For example, on a v2.1 company-revenue row, the importer pre-fills the in-kind volume and unit as "Not applicable" whenever the row reports that payment was not made in kind; the same logic pre-fills the project name as "Not applicable" when the row is neither levied on a project nor reported by a project. The auto-fill on a plain blank cell, applied later in the run, only ever fills "Not available" — and only on fields where "Not available" is allowed. The auto-fill never sets "Not applicable" on its own.

**Rationale:** Marking a cell "Not applicable" is a claim about *why* the cell is empty: the field structurally doesn't apply given the rest of the record. Only the early row-level check has the whole row in hand, so only that check can defensibly make the claim. The later auto-fill sees individual flagged cells one at a time, without the rest of the row, so its safe behaviour is conservative: a non-blocking blank means "this data is missing", not "this data doesn't belong here".

**Technical detail:** The row-aware logic lives in `@model_validator(mode="before")` methods on the row models — see `cascade` on `CompanyRevenueRowV2P1` in `packages/parser/src/parser/domain/schemas/v2p1.py` and the shared helper `cascade_metadata_row_na` in `packages/parser/src/parser/domain/schemas/validation_helpers.py`. The "Not available" auto-fill is `MapToNotAvailableRule` in `packages/cleaner/src/cleaner/rules.py`, gated on `f.code == ParserCode.BLANK_CELL` — it never matches `BLANK_CELL_DEPENDENT` or `BLANK_CELL_BLOCKING`.

### Which rows reach the database from an API extract upload?
<!-- scenario: trust-the-data; topic: data-quality-policy -->

**Situation:** The EITI API publishes a single spreadsheet that bundles every kind of revenue row together — government agency payments, company payments, and a small number of rows tagged as projects or with no organisation type at all. When the user uploads this file, the tool has to decide which of those rows become entries in the database.

**Decision:** Rows tagged as agency revenues become government-revenue records. Rows tagged as company revenues become company-payment records, and the company itself is also added to the list of reporting companies. Rows tagged as project revenue, and rows with no tag at all, are silently dropped — no entry, no error message, no warning on the dashboard.

**Rationale:** The reconciliation the tool computes has exactly two sides — what government agencies received, and what companies paid. Project-attributed and untagged rows do not fit either side, and in the reference file from EITI they are a rounding error: eighteen rows in eighty-one thousand, or 0.02% of the file. Showing each one as a finding would flood the dashboard with non-actionable noise on every import.

**Technical detail:** The three header-search schemas in `packages/parser/src/parser/domain/schemas/api_extract_v1.py` each declare a `row_filter` callable that inspects each row's `organisation.type` cell. The agency schema admits rows whose value is `"agency"`; the company-revenue and company-metadata schemas admit rows whose value is `"company"`. Everything else is rejected before the row reaches Pydantic validation, so no findings are produced for the dropped rows.

---

## 2. Currency & Financial Calculations

### What direction is the exchange rate?
<!-- scenario: reconcile-government-vs-companies; topic: currency-financial-calculations -->

**Situation:** When a v2.x file is uploaded, the About sheet carries a row labelled "Exchange rate used: 1 USD =" with a number next to it. The tool needs to know which way that rate goes before it can convert any row.

**Decision:** The tool reads the rate exactly as written and treats it as "1 USD = X local currency units". A row already in the reporting currency is divided by the rate to get its USD value; a row tagged as USD in a non-USD file is multiplied by the rate to get its local-currency value. For example, if a v2.1 file from Armenia declares "1 USD = 484.0" AMD and a row reports 484,000 AMD of revenue, the USD column shows 1,000.

**Rationale:** The convention matches the literal phrasing on the EITI template, so the value the submitter typed is the value the tool uses with no inversion step in between. If the tool flipped the rate silently, a stray typo in either direction would be invisible to the submitter checking the dashboard against their file.

**Technical detail:** The v2.0 and v2.1 schemas in `packages/parser/src/parser/domain/schemas/v2p0.py` and `packages/parser/src/parser/domain/schemas/v2p1.py` map the header `("Exchange rate used: 1 USD =", 2)` to the field `exchange_rate_used`. The conversion direction is implemented once in `convert()` in `packages/shared/src/shared/currency_conversion.py` and hand-mirrored in `convertRow` in `apps/web_ui/stats.js`: a local-currency row produces `val / exchange_rate` for the USD side, a USD row produces `val * exchange_rate` for the local side. The clean-SQL CASE WHEN in `packages/shared/src/shared/families/_sdf_clean_sql.py` encodes the same arithmetic at materialisation time.

### What happens when the exchange rate is zero?
<!-- scenario: reconcile-government-vs-companies; topic: currency-financial-calculations -->

**Situation:** The About sheet's exchange-rate cell is present but holds `0` (or a blank that gets read as zero). Without rejecting this, the tool would divide every row's local-currency value by zero.

**Decision:** Zero is treated as "rate not provided". The tool never records it, the v1 historical-rates fallback is still given a chance to fire, and the USD totals fall back to N/A on the dashboard with the notice "USD totals not available — no exchange rate in file".

**Rationale:** A literal zero is never a meaningful exchange rate — no currency has ever traded at zero against the dollar — so the only situations producing it are a submitter who typed nothing, a template default that leaked through, or a parsing edge case. Treating it as missing produces the same visible behaviour as if the cell had been left blank, which is what the data actually means.

**Technical detail:** `sanitize_rate` in `packages/shared/src/shared/currency_conversion.py` rejects zero, non-finite, and non-positive values at the data-ingestion seam; both engines call it on the About-sheet rate before assigning `exchange_rate`. Because `exchange_rate` stays `None`, the v1 fallback block immediately below runs unchanged for v1 submissions.

### How does the tool sanitize the exchange rate?
<!-- scenario: reconcile-government-vs-companies; topic: currency-financial-calculations -->

**Situation:** The exchange-rate cell can carry zero, infinity, NaN, or a negative number — values that look numeric but are not a meaningful FX rate.

**Decision:** A single `sanitize_rate` function at the data-ingestion seam (`shared.currency_conversion.sanitize_rate`) rejects 0, non-finite (±Inf, NaN), and non-positive values; it returns `SanitizedRate | None` so the type system propagates the absence of a rate from there forward. The parser's Pydantic schemas wrap the rate field with a `BeforeValidator` calling the sanitizer, and the stats engines call it on the About-sheet cell + the v1 archive entry before passing to the universal rule. Downstream consumers therefore see only positive finite rates or None.

**Rationale:** Without the sanitisation, an infinite rate divides every revenue figure down to 0 and a NaN rate spreads NaN through every total — both outcomes look like real dashboard output but are wrong by orders of magnitude. Centralising the check on a NewType (`SanitizedRate`) and consuming it everywhere prevents per-call-site re-implementations from drifting.

**Technical detail:** `sanitize_rate` lives at `packages/shared/src/shared/currency_conversion.py`. The Pydantic seam is `sanitize_rate_cell` in `packages/parser/src/parser/domain/schemas/validation_helpers.py`, used as `Annotated[SanitizedRate | None, BeforeValidator(sanitize_rate_cell)]` on `v1.exchange_rate`, `v2p0.exchange_rate_used`, and `v2p1.exchange_rate_used`. The JS engine mirrors the same predicate in `sanitizeRate` in `apps/web_ui/stats.js`.

### How are nonsensical exchange rates handled?
<!-- scenario: reconcile-government-vs-companies; topic: currency-financial-calculations -->

**Situation:** The exchange-rate cell holds something that can technically be read as a number but that is not a real number — values like `1e309` (which overflows to infinity) or `"nan"` will silently corrupt every USD total downstream.

**Decision:** Both are rejected the moment the rate is first read. The rate is only accepted if it is strictly greater than zero and is a finite, real number — anything infinite or NaN is thrown out. A rejected rate is treated identically to no rate at all: USD totals become N/A and the v1 fallback path is still eligible to fire.

**Rationale:** Without this check, an infinite rate divides every revenue figure down to 0, and a NaN rate spreads NaN through every total. Both outcomes look like real numeric output on the dashboard but are wrong by orders of magnitude. Catching them once at the boundary is cheaper than auditing every arithmetic step downstream.

**Technical detail:** `sanitize_rate` in `packages/shared/src/shared/currency_conversion.py` and its JS sibling `sanitizeRate` in `apps/web_ui/stats.js` apply the same predicate: reject if the value is `None`/`null`, not finite (`+Inf`, `-Inf`, `NaN`), or non-positive. The parser schemas wrap the rate field with `BeforeValidator(sanitize_rate_cell)` so unsanitised rates cannot even land on a parsed row; the stats engines call the function on About-sheet and v1-archive rates before any consumer uses them.

### In what currencies are totals displayed?
<!-- scenario: reconcile-government-vs-companies; topic: currency-financial-calculations -->

**Situation:** Every revenue figure in an EITI file is reported in the country's local currency, but the dashboards EITI International and external analysts use need USD so countries can be compared.

**Decision:** Every total — government revenue, company payments, reconciliation gap — is computed twice: once in the reporting currency and once in USD. On the dashboard, USD is rendered as the large primary figure with "USD" underneath, and the local-currency total appears below it as a smaller secondary line prefixed by the ISO3 code (for instance "AMD 484,000,000"). If only the local total can be computed — typically a v1 file with no exchange rate — the local figure is promoted to the primary slot and the USD line is dropped entirely.

**Rationale:** Stripping the local figure would mean any submitter trying to reconcile the dashboard against their source file has to reverse the conversion in their head. Stripping the USD figure would mean any cross-country aggregation has to fetch and apply rates separately. Carrying both side by side lets a single dashboard view serve both audiences without either having to re-derive anything.

**Technical detail:** The dual totals live in the `ReportStats` dataclass in `apps/cli/src/cli/stats.py` as `total_gov_revenue_local`/`_usd`, `total_company_payments_local`/`_usd`, and `reconciliation_gap_local`/`_usd`. The dashboard rendering rule lives in `renderFinancialValue` in `apps/web_ui/components/dashboard.js`: it renders USD primary plus a local secondary line when `mainCurrency !== 'USD' && mainCurrency !== 'Unknown'`, falls back to local-only when USD is null but local is computable, and emits an N/A card with a contextual notice when neither is available.

### What happens to a total if some rows cannot be converted?
<!-- scenario: reconcile-government-vs-companies; topic: currency-financial-calculations -->

**Situation:** A v2.x company payments table contains one row in EUR alongside thirty rows in the reporting currency. The tool only has the USD-to-local rate from the About sheet, so it cannot convert that one EUR row.

**Decision:** Per-side totals are partial-aggregate: each total sums the rows the universal USD-conversion rule could resolve on that side, and the dashboard renders an annotation badge ("Partial: N rows unresolvable") so the reviewer sees the gap honestly. The total itself is only N/A when the entire source table is missing or empty — never because individual rows could not convert. Per-row unresolvable reasons (third_currency, rate_missing, value_missing, currency_missing) land on `clean_currency_resolution` after import for operator triage.

**Rationale:** The earlier all-or-nothing rule turned a table with one EUR row into a single dashboard "N/A" with no indication of scale: reviewers could not tell whether twenty-nine of thirty rows reconciled or none of them did. Partial sums plus a per-side row count surface the gap with proportion: the reviewer sees the recoverable total and the count of rows it could not include, decides whether the gap is small enough to accept or worth fixing at the source, and uses the audit table to drill in.

**Technical detail:** `_sum_gov_revenues` / `_sum_company_payments` in `apps/cli/src/cli/stats.py` and `sumGovRevenues` / `sumCompanyPayments` in `apps/web_ui/stats.js` call `shared.currency_conversion.convert` (Python) or its hand-mirrored JS sibling, sum the rows that returned a non-None side, and count the rows that did not into `unresolvable_*_local_count` / `unresolvable_*_usd_count`. The dashboard's `renderPartialBadge` in `apps/web_ui/components/dashboard.js` emits the `card-notice` "Partial: N rows unresolvable" when the USD-side count is positive. Post-import, the clean-SQL `build_currency_resolution_sql` builder writes one `clean_currency_resolution` row per NULL-USD clean row carrying the matching `UnresolvableReason` value.

### How does the tool validate the totals block's courtesy USD figure?
<!-- scenario: reconcile-government-vs-companies; topic: currency-financial-calculations -->

**Situation:** EITI v2.x templates carry both a reporting-currency total row and a courtesy USD-converted total row, computed by the submitter using the About-sheet exchange rate. Data rows are denominated in ONE currency, so the courtesy USD row is an orphan from the per-currency comparison's perspective — the data table sum for "USD" is zero in a typical non-USD-reporting file even when every figure on the page is correct.

**Decision:** The crosschecker validates the courtesy row by deriving the expected USD figure from the reporting-currency data sum using the same rate convention (`convert_total` in `shared.currency_conversion`), then comparing to the in-file courtesy figure with a two-tier tolerance: an absolute floor (default 1 currency unit) and a relative band (default 1%), whichever is larger. Mismatches surface as `GOV_COURTESY_TOTAL_MISMATCH` / `COMP_COURTESY_TOTAL_MISMATCH`. When the About-sheet rate is missing or the courtesy row is in a third currency the universal rule cannot resolve, the check emits an informational `*_COURTESY_NOT_VALIDATABLE` finding so operators see that the courtesy row was not verified, rather than a silent skip. When the reporting currency itself is missing, `NO_REPORTING_CURRENCY` already covers the state and the courtesy check stays silent — one finding code per state.

**Rationale:** Pre-fix the courtesy USD row was treated as an in-bucket comparison with the (zero) data sum and fired a spurious `GOV_TOTAL_MISMATCH "computed sum is 0.00"` on 70 of 132 v2 corpus files (any non-USD-reporting file). Treating the courtesy row as out-of-bucket and validating it via the universal rate convention makes the rule honest: the submitter's conversion is checked against the tool's, and remediation targets the courtesy cell or the rate, not the data table. Keeping the dedicated finding code separate from `*_TOTAL_MISMATCH` preserves the remediation playbook for the original in-bucket case. The two-tier tolerance accommodates rate-conversion rounding that accumulates across many rows on large submissions while still catching meaningful drift on small ones.

**Technical detail:** The closure in `_make_totals_consistency_check` (`packages/shared/src/shared/families/sdf.py`) reads the About anchor once per call via the `_read_about_for_courtesy` helper, which delegates to `resolve_revenue_stats` (the same `StatsCurrency` registration the stats engines consume) and sanitises the cell value via `sanitize_rate_cell`. The per-spec `_CourtesySpec` (`mismatch_code`, `not_validatable_code`, `absolute_tolerance`, `relative_tolerance`) is opt-in: every v2.x `_TotalsSpec` carries one and `test_v2_totals_specs_register_courtesy` enforces the wiring at PR time; v1 specs stay `courtesy=None` since scalar comparison has no per-currency orphans.

### Why might a row be uncomputable?
<!-- scenario: reconcile-government-vs-companies; topic: currency-financial-calculations -->

**Situation:** A v2.x revenue row has a per-row currency column. The file's About sheet declares one exchange rate, which links the reporting currency and USD. The row's currency might not be either of those two.

**Decision:** Empty per-row currency cells canonicalise to the declaration's reporting currency before the universal USD rule fires; the clean-SQL `COALESCE(NULLIF(TRIM(...), ''), sdf.reporting_currency)` expression performs the substitution at materialisation. A row tagged USD in a non-USD-reporting file resolves USD-side as-is (the rate is irrelevant) and resolves local-side if the rate is present. A row whose canonical currency equals the reporting currency resolves both sides when the rate is present. A row in any third currency — for example, an EUR-denominated payment in a file reporting AMD with a USD/AMD rate — is marked unresolvable on both sides and records `UnresolvableReason.THIRD_CURRENCY` in `clean_currency_resolution`.

**Rationale:** Converting a third currency requires a second exchange rate (EUR-USD or EUR-AMD) that the file does not provide. The tool refuses to invent one or pull from a live rates feed because the EITI methodology is that the file declares its own conversion basis. Recording the row as unresolvable with a typed reason lets the dashboard show a partial total + count and the audit table drill operators into "which rows, and why".

**Technical detail:** The rule itself lives in `shared.currency_conversion.convert` (Python — the canonical source) and is hand-mirrored as `convertRow` in `apps/web_ui/stats.js`. The clean-SQL CASE WHEN in `shared/families/_sdf_clean_sql.py` encodes the same six cases. The contract test in `tests/unit/test_stats_contract.py` + `tests/js/contract.test.js` pins parity across all three implementations against a locked fixture; the in-memory SQLite tests in `tests/unit/test_sdf_clean_sql_usd.py` lock the clean-SQL encoding row-for-row.

### When the per-row currency column is empty, what does the tool do?
<!-- scenario: reconcile-government-vs-companies; topic: currency-financial-calculations -->

**Situation:** The v2.x revenue tables include a per-row currency column. In real EITI files the column is regularly empty on rows the operator considers implied by the About sheet — the same way a spreadsheet leaves a sticky header blank when the next row repeats the previous value.

**Decision:** Empty per-row currency cells are canonicalised to the declaration's reporting currency before the universal rule fires. The clean-SQL projection writes the canonical currency to `clean_*.currency_code` and the rule consults the canonical value when computing the USD column. A row whose canonical currency lands NULL (because both the source cell and the About-sheet reporting currency are empty) records `UnresolvableReason.CURRENCY_MISSING` in `clean_currency_resolution`.

**Rationale:** Treating an empty cell as "third currency that cannot be resolved" would produce avoidable third_currency unresolvables on the great majority of well-formed files. The implicit-reporting-currency convention is how submitters and EITI reviewers already read these tables; encoding it once at the clean tier means every downstream consumer (views, stats engines, dashboards, API) sees the canonical value without re-implementing the convention.

**Technical detail:** The canonicalisation expression is `COALESCE(NULLIF(TRIM(l.{currency_col}), ''), sdf.reporting_currency)` — a single expression reused by `_canonical_currency_expr` in `shared/families/_sdf_clean_sql.py` for both the projected `currency_code` column and the USD CASE WHEN. The stats engines call `_canonical_row_currency` (Python) / `canonicalRowCurrency` (JS) before invoking the universal rule so the pre-import preview matches what materialisation will write.

### What happens when the reporting currency is USD?
<!-- scenario: reconcile-government-vs-companies; topic: currency-financial-calculations -->

**Situation:** The About sheet's reporting-currency cell contains "USD" — the country has chosen to denominate its declaration directly in dollars.

**Decision:** Each row's value is taken as its own USD value and its own local value at the same time, with no conversion step. The local total and USD total are therefore identical. The dashboard skips the secondary local line because the two figures would be the same, so only one figure with "USD" beneath it appears.

**Rationale:** Conversion is unnecessary in this case. Showing "USD 100,000,000" and immediately below it "USD 100,000,000" gives the reader no extra information and looks like a rendering bug.

**Technical detail:** In `convert()` in `packages/shared/src/shared/currency_conversion.py`, the `row_currency == "USD"` and `row_currency == reporting_currency` branches both special-case `reporting_currency == "USD"` and return `ConversionResult(value, value, None)` — same value on both sides, no rate consulted. A USD-reporting file with no rate therefore produces normal totals, not N/A. The dashboard suppression is `const isLocalDifferent = stats.mainCurrency !== 'USD' && stats.mainCurrency !== 'Unknown'` in `apps/web_ui/components/dashboard.js`; when this is false, the `card-secondary` line is omitted.

### How is the reconciliation gap computed?
<!-- scenario: reconcile-government-vs-companies; topic: currency-financial-calculations -->

**Situation:** EITI files report government revenue and company payments separately. These two sides should match if every payment is properly accounted for. The dashboard needs a single figure that tells the reviewer whether they do.

**Decision:** The gap equals total government revenue minus total company payments. A positive gap means the government side reported more than the company side; a negative gap means the opposite. The gap percentage is the gap divided by total government revenue, expressed as a percentage — so the government figure is the reference. Both are computed independently in the local pair and in the USD pair.

**Rationale:** Subtracting in this direction matches the EITI reconciliation methodology, which uses the government-side figure as the reference and asks "how much of what the government said it received are companies confirming?". The percentage is more useful than the absolute gap for cross-country comparison because it cancels out the scale difference between, say, Nigeria's oil revenues and Chad's mining revenues.

**Technical detail:** In `apps/cli/src/cli/stats.py`, the gap is computed at the end of `compute_stats` only when both sides on a given currency pair are non-None: `stats.reconciliation_gap_local = stats.total_gov_revenue_local - stats.total_company_payments_local` and likewise for USD. The percentage path also guards against `base != 0.0` — a country reporting literally zero government revenue would otherwise trigger ZeroDivisionError, and a bare-truthy check would have silently dropped the percentage in that case. The same logic lives in `computeStats` in `apps/web_ui/stats.js`.

**Note on partial-aggregate asymmetry:** Under the partial-aggregate semantics, each side's total is a sum of the rows the universal USD rule could resolve on that side; rows it could not resolve are counted into `unresolvable_*_count`. The gap can therefore compare row populations that aren't identical — one side may have excluded 5 third-currency rows the other side fully resolved. The tool does NOT null the gap when either side has unresolvable rows; the partial gap is shown alongside the per-side badge counts so the operator sees both the figure and the proportion it covers. Nulling the gap whenever either side was partial would reintroduce the all-or-nothing behaviour the partial-aggregate refactor (BUG-029) was designed to remove — an unresolvable EUR row in a 30-row company-payments table would hide the gap for the other 29 rows on both sides. The badge counts (`unresolvable_gov_*_count`, `unresolvable_comp_*_count`) on `ReportStats` carry the missing context.

### Which currency is used for the reconciliation gap percentage?
<!-- scenario: reconcile-government-vs-companies; topic: currency-financial-calculations -->

**Situation:** The percentage is a ratio, so mathematically it could be derived from either the local pair or the USD pair. The two pairs are not numerically identical in practice — each USD figure is the local figure divided by the rate, and the small rounding involved means the two ratios can differ by a tiny amount.

**Decision:** The percentage is computed from the local pair if both sides are available locally; only if one of the local sides is N/A does it fall back to the USD pair. The reported percentage is therefore the same number regardless of whether the user is looking at the local or USD totals on the dashboard.

**Rationale:** The local pair has not been through a division step, so it carries no conversion-rounding noise. Using it as the basis means a "5.0% gap" on the dashboard reflects exactly what falls out of the file's own numbers, not an artefact of how the conversion arithmetic rounds at the edges. The USD fallback only kicks in when the local total is missing — typically a row in a third currency the tool cannot resolve.

**Technical detail:** In `compute_stats` in `apps/cli/src/cli/stats.py`: `gap = stats.reconciliation_gap_local; base = stats.total_gov_revenue_local`, then `if gap is None or base is None: gap = stats.reconciliation_gap_usd; base = stats.total_gov_revenue_usd`. The percentage is a single scalar `reconciliation_gap_pct` on `ReportStats` — there is no separate `_local` and `_usd` version. Mirrored in `apps/web_ui/stats.js`.

### When is the reconciliation gap considered concerning?
<!-- scenario: reconcile-government-vs-companies; topic: currency-financial-calculations -->

**Situation:** The reconciliation gap percentage appears on the dashboard as a coloured card. The reviewer needs a quick visual cue separating "looks fine" from "needs attention" without having to interpret the raw percentage.

**Decision:** If the gap percentage is between -10% and +10%, the card is rendered green. Outside that band, it is rendered red. When the gap percentage cannot be computed at all — one side missing on both currency pairs — no colour is applied.

**Rationale:** EITI reconciliation reports treat single-digit-percent discrepancies as ordinary noise from reporting calendars, in-kind versus cash recognition, and rounding. Crossing ten percent typically signals either a real reporting gap that warrants investigation or a structural mismatch in how the two sides are tabulated. The threshold gives the reviewer one fewer thing to remember during triage.

**Technical detail:** The threshold is applied at render time in `apps/web_ui/components/dashboard.js`: `const gapColor = stats.reconciliationGapPct != null ? (Math.abs(stats.reconciliationGapPct) <= 10 ? 'success' : 'error') : '';`. The threshold is not configurable from the stats config — changing it requires a code change in the dashboard component.

### How is currency handled for v1 files without per-row currency?
<!-- scenario: compare-across-versions; topic: currency-financial-calculations -->

**Situation:** A v1 EITI Summary Data Template is older than the per-row currency columns introduced in v2.0. Every revenue and payment row in a v1 file is just a number — there is no column saying which currency it's in.

**Decision:** Every row in a v1 file is treated as already being in the reporting currency declared in the About sheet. The local total is therefore always computable from any v1 file that has a reporting currency and at least one numeric row. The USD total requires an exchange rate — either from the About sheet (rare for v1) or from the historical-rates fallback table.

**Rationale:** With no per-row currency column there is no way to detect a mixed-currency v1 file, and in practice these files predate the multinational-USD-payment situation that motivated the per-row column. Treating every row as reporting-currency mirrors how the submitter implicitly thought about the file when they filled it in.

**Technical detail:** In the `STATS_REGISTRY` entry for `summary_v1`, `StatsCurrency.gov_per_row` and `StatsCurrency.comp_per_row` are both `None`. The stats engines read those nulls into `gov_currency_field` and `comp_currency_field` and so never try to look up a per-row currency on a v1 row; `_canonical_row_currency` then canonicalises the absent cell to the reporting currency, and `convert()` routes the row through its `row_currency == reporting_currency` branch. The currency-quality crosscheck in `packages/shared/src/shared/families/sdf.py` skips v1 entirely on the same signal (via its `has_row_currencies` guard).

### Where does the tool get exchange rates for old v1 files?
<!-- scenario: compare-across-versions; topic: currency-financial-calculations -->

**Situation:** V1 files never include an exchange rate in the About sheet, but EITI's own API export has rates for 96% of historical declarations.

**Decision:** The tool ships with a committed lookup table of historical exchange rates, extracted from EITI's API export and keyed by country and year. When a v1 file's About sheet has no rate, the stats computation looks up the rate by the file's country code and reporting-period end year. The dashboard (in the browser) and the server-side computation read from the same lookup source.

**Rationale:** Historical exchange rates are stable and available from EITI's own data. A static, committed table avoids runtime dependency on external services and guarantees that the dashboard and the server can't drift apart.

**Technical detail:** Lookup file `v1_exchange_rates.json`, keyed by `{iso3}_{year}`. `compute_stats` resolves the rate using `country_iso3` + `end_date` year. The same JSON is served to the browser via the `/stats-config` endpoint, so Python and JS share one source. The SDF mapper consults the same archive at import time (`packages/shared/src/shared/families/sdf.py::build_sdf_metadata_findings`), so the rate that ends up in `metadata_summary_data_files.exchange_rate_used` is the same value the pre-import preview displayed.

**Note on re-import behaviour:** The archive is committed to the repo and treated as static for any given release. If the archive is edited (a corrected rate for a previously-covered country-year) and a v1 declaration that was previously imported is then re-imported, the mapper writes the new rate to `metadata_summary_data_files.exchange_rate_used` and the clean SQL recomputes every USD value for that declaration on the new rate. No operator-visible finding fires to call out the change — the import report records a new event but does not compare the new rate against any previous value. Operators who re-import a v1 declaration after an archive edit should expect USD totals to move; if a numeric reconciliation depends on the old rate, capture the dashboard before the re-import.

### Which currency does the v1 dashboard prioritize?
<!-- scenario: reconcile-government-vs-companies; topic: currency-financial-calculations -->

**Situation:** A v1 file from a country with no entry in the historical rates table — or from a year before the EITI export covers — has a computable local total but no USD total at all.

**Decision:** When the USD total is N/A and the local total is a real number, the dashboard promotes the local figure to the primary (large) slot with the ISO3 currency code (for instance "AMD") underneath it. No "N/A" notice appears, no USD line, no warning. When the USD total is available — whether from a v2.x About-sheet rate, a v1 About-sheet rate, or the historical-rates fallback — USD is the primary figure with the local total as the secondary line.

**Rationale:** Showing "N/A" when there is a real, computable, useful number in the file is misleading — the reviewer is doing in-country review against the source document and the local-currency total is exactly the figure they want to see. The USD figure is only valuable for cross-country comparison; suppressing the local total to enforce that hierarchy would actively damage the in-country review case.

**Technical detail:** The fall-through is in `renderFinancialValue` in `apps/web_ui/components/dashboard.js`. The first branch handles `usdVal !== null` and renders USD primary with optional local secondary. The second branch handles `localVal !== null` (with USD null) and renders local as primary. Only when both are null does the function emit an N/A card, and the notice text is chosen based on whether `mainCurrency` is `"Unknown"` versus whether `exchangeRateUsed` is null.

### What happens to 'Not available' revenue rows in aggregations?
<!-- scenario: trust-the-data; topic: currency-financial-calculations -->

**Situation:** A revenue cell in the ledger contains the literal string "Not available", "Not applicable", or "Blank" — the value was accepted from the source file, no correction was needed, and now the import is producing the analysis-ready clean tables.

**Decision:** Rows whose revenue value is one of these three strings are excluded entirely from the analysis-ready table — they do not appear at all, and they do not appear as empty rows either. The full row is still preserved in the raw ledger with the original wording, so nothing is lost from the audit trail.

**Rationale:** A "Not available" payment behaves differently from a zero payment, and aggregations downstream — totals, averages, sector breakdowns — should not treat them as the same thing. Carrying the marker through as an empty row would still let it count as a row in row-count tallies, skewing per-country counts. Dropping the row from the analysis-ready table is the most defensible aggregation behaviour: the row is preserved in the raw ledger with the original wording, but only rows with a real numeric payment make it into the analysis-ready table.

**Technical detail:** The clean-table inserts live in the per-family files under `packages/shared/src/shared/families/` (`SDF_CLEAN_QUERY_SPECS_V1` / `_V2P0` / `_V2P1` in `sdf.py`, `COMPANY_ASSESSMENT_CLEAN_QUERY_SPECS` in `company_assessment.py`) — each ships declarative `CleanQuerySpec` instances dispatched through per-shape generators in `_sdf_clean_sql.py` + `_ca_clean_sql.py`. The sentinel list is `SENTINELS_SQL = "'Not available', 'Not applicable', 'Blank'"` in `packages/shared/src/shared/families/_substrate.py`, applied at two points in every generated query: a `CASE WHEN ... NOT IN (...)` guard on the numeric cast (so a sentinel that slipped past the WHERE clause would still produce NULL rather than coerce to 0.0), and a `WHERE l.<value_col> NOT IN (...)` filter that drops the row. The sentinel substitutions are also recorded in the `clean_flags` table for traceability — the raw ledger keeps the original string regardless.

---

## 3. Workflow & Status

### What are the possible statuses of a file?
<!-- scenario: submit-a-report; topic: workflow-status -->

**Situation:** After upload, the dashboard shows a status banner with one of three labels — SUCCESS, NEEDS_REVIEW, or BLOCKED — indicating what the user has to do next.

**Decision:** The banner reflects how serious the problems with the file are. If anything in the file can't be reviewed inside the tool — a missing piece the dashboard can't offer a fix for — the file is BLOCKED, meaning the user has to correct the Excel file itself and re-upload. If there are problems but every one of them can be resolved in the review tab, the file is NEEDS_REVIEW. If nothing was flagged at all, the file is SUCCESS and can move straight to confirmation. The three labels map to the three actions available to the user: proceed, review and correct, or send the file back to the submitter.

**Rationale:** Folding everything into one of three actionable labels keeps the dashboard's first impression about what the user needs to do, not about what the tool found. A diagnostic banner with five or six categories would force the user to interpret severity themselves before knowing whether to keep going.

**Technical detail:** The classification is computed in the browser by `updateStatusBanner` in `apps/web_ui/components/dashboard.js`. It filters `context.findings` by category, then applies `classifyFinding` to validation findings to split them into "fixable" and "source_only" buckets. The status is not stored on the server — it's derived live from whatever findings the pipeline produced for that session. The same classification feeds the colored quality bands shown on the dashboard cards.

### What does the tool do when an internal check crashes?
<!-- scenario: trust-the-data; topic: workflow-status -->

**Situation:** One of the tool's internal steps — the part that tidies cells, the part that matches companies and agencies, the part that runs cross-checks between sections, or the part that maps the file's data onto the EITI database — crashes partway through processing a file.

**Decision:** The crashed step records a single problem describing what went wrong and steps aside. The rest of the tool keeps going. The user still reaches the dashboard, still sees everything the other steps produced, and can still review and import the file. The only two crashes that stop the whole run are the steps that identify which template the file uses and the step that extracts the tables — without those, nothing further can be attempted.

**Rationale:** Each step fills a different slice of the dashboard. If one step dies, the other slices are still useful and the user can decide whether to proceed. Aborting the whole run on a single crash would force a blind retry without knowing whether the surviving steps would have flagged anything worth seeing.

**Technical detail:** Each service's `run` method wraps its body in a try/except that returns a report containing one `SERVICE_ERROR` finding (`CrosscheckCode.SERVICE_ERROR`, `EnrichmentCode.SERVICE_ERROR`, `CleaningCode.SERVICE_ERROR`, `MappingCode.SERVICE_ERROR`) — see `packages/cleaner/src/cleaner/cleaner_service.py`, `packages/crosschecker/src/crosschecker/crosschecker_service.py`, `packages/enricher/src/enricher/enricher_service.py`, `packages/mapper/src/mapper/mapper_service.py`. The crosschecker also isolates each individual check inside the service so one check crashing doesn't suppress the others. The pipeline executor in `packages/pipeline/src/pipeline/executor.py` only escalates to `ERROR_UNKNOWN` when a service raises out of `run` entirely (the safety net) or to `ERROR_DATA` when a service emits a code in the definition's `terminal_codes` set — currently `DetectionCode.SERVICE_ERROR`, `ParserCode.FILE_OPEN_ERROR`, `ParserCode.BLOCK_PARSING_ERROR`, `ImporterCode.MISSING_DECLARATION_UUID`, `ImporterCode.DB_WRITE_FAILURE`, and the two duplicate/unrecognized codes from detection.

### What information is expected to finalize a data import?
<!-- scenario: submit-a-report; topic: workflow-status -->

**Situation:** The tool has finished its checks and pauses at the confirmation step. The import tab shows a "Responsible User" dropdown, a comments box, and Confirm Import / Reject buttons.

**Decision:** The user must pick a name from the dropdown and click Confirm Import. Comments are optional. Picking a name and confirming writes the file into the EITI database and records who made the call alongside the data. Clicking Reject closes the file out without writing anything; it's the equivalent action for a reviewer who has decided the file shouldn't be imported at all.

**Rationale:** The import step is the only point at which anything is written to the EITI database. Requiring a named user and an explicit click means every row that lands in the database is attributable to a person who made the call — no implicit imports, no "the tool decided." Reject is offered as a peer action so a reviewer can close out a file that shouldn't be imported without leaving it hanging open.

**Technical detail:** The CONFIRMING interrupt's POST endpoint is `POST /sessions/confirm` in `apps/api/src/api/session_endpoints.py` (`confirm_sessions`). It builds an `AuditStamp` from the request fields (`AuditStamp` is defined in `packages/shared/src/shared/diagnostics.py`) and passes it to the importer via `executor.resume`'s `user_input` dict, where it's set as `context.audit_stamp`. The user list shown in the dropdown comes from the `allowed_users` setting (`packages/shared/src/shared/settings.py`). Confirm sends `action: "confirm"` with the picked user's full name, email, role, and channel; Reject sends `action: "reject"` and writes the session to REJECTED (terminal). When `action == "confirm"`, the request body's `full_name`, `email`, and `role` must be non-default — the audit stamp records a real operator identity instead of falling back to a phantom admin.

### Who is held accountable for an import or deletion?
<!-- scenario: audit-who-did-what; topic: workflow-status -->

**Situation:** A change to the EITI database is about to land — either a confirmed import of a new declaration or the deletion of an existing one.

**Decision:** Both changes carry the responsible user's full name, email, role, and the way they reached the tool (the dashboard in a browser, the command-line version, a direct edit on the live database, or a direct call into the tool's interface) along with any free-text comments they typed in. Imports collect that information at the confirmation step; deletions collect it on the delete request. Both writes also leave a permanent record of the action alongside the data change, so the EITI database always carries a trail of who touched what and when.

**Rationale:** The EITI database is the operational record everyone downstream queries. The only changes into it are imports and deletions, and both need to be attributable: if data shows up wrong six months later, the trail is the answer to "who put this here." The way the user reached the tool is recorded because the importer can be driven from the command line as well as from the dashboard, and the two have different review flows.

**Technical detail:** `AuditStamp` is defined in `packages/shared/src/shared/diagnostics.py` and uses `EmailStr` validation so a malformed email is rejected at the boundary. The channel values are `importer_web_ui`, `importer_cli`, `datasette_manual`, and `api_direct`. Import-time stamps are persisted to `metadata_import_events` in the target DB by the importer service. Deletion stamps are written by `TargetDbManager.delete` in `packages/shared/src/shared/session/target_db_manager.py`, and the API also writes a `SUBMISSION_DELETED` session event with a fresh session_id so the operational event log keeps the deletion as a peer record alongside imports.

### Can a finding be modified or removed from a session?
<!-- scenario: audit-who-did-what; topic: workflow-status -->

**Situation:** Each step of the tool produces findings — validation errors, auto-fills, entity matches, consistency warnings — and later steps and the review tab read them.

**Decision:** No. Once a finding is recorded, it stays. The list only grows. When the user makes a correction in the review tab, that correction is added as a new entry next to the original finding, not on top of it. When the user escalates a finding to the dev team, that escalation is also added as a new entry. The original problem the tool first detected always remains visible at confirmation time.

**Rationale:** Everything the user reviewed has to match exactly what the tool will act on at import time. If a later step could quietly drop or rewrite an earlier finding, the dashboard the user signed off on could disagree with what actually gets written. Keeping the history append-only means the audit trail after the fact is a complete account of what each step did and what the user said about it.

**Technical detail:** `PipelineContext.findings` is declared as a `list[Finding | ParsingError | DetectionResult]` in `packages/shared/src/shared/pipeline_context.py`, and the only mutation site in the executor is `context.findings.extend(report.findings)` (`packages/pipeline/src/pipeline/executor.py`). Pydantic `extra="forbid"` on the model prevents accidental phantom fields. User corrections come in as new findings with code `USER_CHOICE`; escalations come in as new findings with code `FLAGGED`. The mapper's precedence rule (USER_CHOICE wins over cleaner overrides wins over extracted data) is enforced by reading the list and building override maps rather than rewriting earlier entries.

### What takes priority: the user's correction or the tool's suggestion?
<!-- scenario: fix-problems-before-import; topic: workflow-status -->

**Situation:** The tool has proposed an auto-fix for a cell (for example, turning "n/a" into "Not available"), and the user has also picked a value for that same cell in the review dropdown.

**Decision:** The user's pick wins. When the tool assembles the row that will land in the EITI database, the user's explicit pick takes priority over any auto-fix at the same cell, and the auto-fix takes priority over the original Excel value. Cells the tool was told to skip entirely (template placeholders) are dropped before any of this happens.

**Rationale:** Auto-fixes are rules of thumb — fine when nobody contradicts them, but a reviewer who looked at the cell and made a different choice has more context than the rule did. Inverting that order would let an automatic fix silently overwrite the user's explicit decision, which is exactly the kind of silent change the strict-review design was built to prevent.

**Technical detail:** The precedence is implemented in the mapper service's correction-collection step at `packages/mapper/src/mapper/mapper_service.py` (the `_OVERRIDE_CODES` tuple is ordered `USER_CHOICE` first, then the cleaning codes `ENUM_CORRECTED`, `STANDARDIZED_TO_NOT_AVAILABLE`, `STANDARDIZED_TO_NOT_APPLICABLE`, `BLANK_TO_NOT_AVAILABLE`). Findings with no `(table_name, table_row_index, field_name)` triple are ignored — the override map only applies to coordinate-anchored corrections. `PLACEHOLDER_REMOVED` cells are filtered out before the override map is built.

### What do the Restart and Cancel & Start Over buttons do?
<!-- scenario: submit-a-report; topic: workflow-status -->

**Situation:** The dashboard offers a "Restart" button in the header (always visible while a file is open) and a "Cancel & Start Over" button inside the template-confirmation dialog that appears when the tool isn't sure which template version a file uses.

**Decision:** Both buttons do the same thing — they abandon the file outright. The tool forgets everything it had already worked out for that file — the extracted tables, the findings, the template guesses — and returns the user to the upload zone. There is no undo. If the file was part of a multi-upload batch, the same click abandons every file in the batch that wasn't already finished; files that were already imported, rejected, or otherwise closed out are left alone.

**Rationale:** "Restart" is the user's mental model — throw it out and start clean — and that maps directly to a destructive abandon rather than a rewind. Letting go of the file immediately also frees up the duplicate-upload lock on its contents, so a colleague trying to upload the same file is unblocked right away instead of waiting for a timeout.

**Technical detail:** Both Web UI buttons call `killSession()` which POSTs to `/sessions/kill` with `{session_ids: [<sid>]}` (`apps/web_ui/app.js` and `apps/web_ui/index.html`). The endpoint handler in `apps/api/src/api/session_endpoints.py` delegates to `BatchManager.kill_sessions` (`packages/shared/src/shared/session/batch_manager.py`), which writes `SessionState.CANCELLED` for every listed non-terminal session and then purges its cached `PipelineContext`. The same endpoint, with every member session_id in the list, handles batch-level cancellation. Cancelling also takes the session out of the recovery sweep's attention and frees the duplicate-upload slot.

### Can a batch be confirmed if some members are still under review?
<!-- scenario: submit-a-report; topic: workflow-status -->

**Situation:** A multi-file upload (or a single file that splits into several declarations) produces a batch in which each file progresses through the tool independently. The user clicks "Confirm batch" while some files are ready to confirm and others are still mid-review.

**Decision:** The bulk confirm is rejected unless every file in the batch has reached a decided state — meaning each file has either been approved at its own review step, rejected, abandoned, imported, or otherwise closed out. If anything is still pending review, the tool refuses the bulk confirm and tells the user which files are still pending. Once everything has been decided, one click confirms the subset that's ready and leaves the rest alone. The "Confirm batch" button is greyed out until all files in the batch reach a decided state.

**Rationale:** Each file in a batch is an independent declaration — there's no business reason to require all-or-nothing import across them. But forcing the user to make a per-file decision before bulk-committing prevents partial-state surprises: every file in the batch has to be explicitly approved or set aside before the user can commit the approved subset in one click.

**Technical detail:** `POST /sessions/confirm` with each member's session_id partitioned across `confirm_session_ids` and `reject_session_ids` (plus the operator's audit stamp in the body) delegates to `BatchManager.bulk_confirm` in `packages/shared/src/shared/session/batch_manager.py`. The gate set `_BATCH_GATE_STATES` is `TERMINAL_STATES | {CONFIRMING, CONFIRMED, IMPORTED, EXPIRED, SUBMISSION_DELETED, STALE}` and applies to the confirm side only — reject sessions bypass the gate. The atomic write only transitions confirm sessions at `CONFIRMING` to `CONFIRMED` and reject sessions at non-terminal states to `REJECTED`; already-decided sessions come back in the response's `already_terminal` list. The pre-flight failure raises `BatchHasPendingMembers`, which the endpoint translates into a 409 response with the pending list.

### Why does the tool accept a list of files for cancel and confirm?
<!-- scenario: submit-a-report; topic: workflow-status -->

**Situation:** An operator uploads files for review. They want to confirm or cancel some of them — sometimes one file, sometimes everything they uploaded, sometimes a subset.

**Decision:** Both the cancel and confirm actions accept a list of files in one request. The operator (or the dashboard on their behalf) names which files the action applies to. The list can have one file or many.

**Rationale:** Operators acting on one file pass a single-element list; operators acting on a whole batch pass every session_id; operators acting on a subset — for example, confirming five files but holding three for further review — pass just the IDs they want to act on. All three intents (one, all, subset) use one mental model and one HTTP request. Without the list, the subset case would require one HTTP request per file, fanning out a single operator decision into many calls.

**Technical detail:** `POST /sessions/kill` accepts `{session_ids: list[str]}` and writes `CANCELLED` events for every listed non-terminal session, returning the cancelled list and any sessions that were already terminal. `POST /sessions/confirm` accepts `{confirm_session_ids: list[str], reject_session_ids: list[str], full_name, email, role, comments, channel}` — both decisions ride one request so a batch commits in a single round-trip. The confirm endpoint applies one operator audit stamp across every confirm session. The endpoint is atomic: if any confirm session fails the pre-flight gate or the confirmation-time content-hash recheck, no events are written and the response carries the failing session(s) for the caller to address. The 409 in-flight dedup response's `release_actions` list points at `POST /sessions/kill`; each action carries the `session_ids` body the caller submits as-is to release the slot.

### What happens when one upload covers several country-year cohorts?
<!-- scenario: submit-a-report; topic: workflow-status -->

**Situation:** A file the user is uploading covers more than one country-year cohort — either a wide template that spans several cohorts in its rows, or a single-cohort file the user has chosen to import alongside others. The user picks which cohorts to import at the cohort-selection step and confirms.

**Decision:** The tool splits the upload into one independent declaration per selected cohort. Each cohort runs through the rest of the import process on its own — review, confirm, import — exactly as if it had been uploaded as a single-cohort file. The original multi-cohort upload is grouped with its per-cohort children in a batch so the user sees and acts on them together: confirm all, cancel all, or work through them one at a time.

**Rationale:** A declaration is one country and one reporting year, so a file that covers several cohorts can't be a single declaration. Splitting into one declaration per cohort means each child runs through the same review-and-confirm flow as any other upload — no separate code path. The batch keeps the cohorts visible as a unit so the user can act on the group with one click instead of chasing each cohort independently.

**Technical detail:** The split happens on transition out of `SELECTION_CONFIRMING`. Each selected cohort becomes a child session attached to a `COHORT_FANOUT` batch that records the parent's `session_id`; the parent terminates `DISPATCHED`. Children skip the identification phase — cohort classification was already settled by the parent — and pick up the scalar pipeline from `PARSED`. The shape of the cohort filter depends on the family: single-cohort SDF carries no filter (the cohort identity lives in the About-sheet metadata, not in row columns); row-keyed fat-file submissions (API Extract) carry a row-level predicate that scopes extraction to rows whose columns match the cohort; sheet-keyed fat-file submissions (Company Assessment) carry a sheet-name filter that restricts which year-suffixed sheets the extractor materialises. The per-family choice between row-level, sheet-level, or no filter is declared on the family's cohort contract; the parser dispatches on it at extraction time.

### What happens when an upload covers more cohorts than the importer can process at once?
<!-- scenario: submit-a-report; topic: workflow-status -->

**Situation:** The importer processes a limited number of cohorts at the same time — a number the system administrator configures. When an uploaded file is detected to contain many cohorts (some templates can hold dozens of country-year combinations in one file), the operator picks which ones to import on the cohort-selection screen.

**Decision:** If the operator ticks more cohorts than the limit, the screen shows an orange banner explaining the limit and how many to untick. The Confirm button stays disabled while the selection is over the limit. The banner clears and Confirm re-enables as soon as the selection drops back within the limit. The operator is never silently blocked — they always see why they can't continue and what to do about it.

**Rationale:** A hard-block dialog would interrupt the operator with no path to resolve in the moment. A silent submit-and-fail would waste the operator's time and leave them guessing why nothing happened. An advisory banner with a disabled Confirm gives the operator the information they need to act, in the place where they're already acting.

**Technical detail:** The limit is `Settings.max_concurrent_pipelines` (default 10), the same value that sizes the server's pipeline concurrency gate. The importer refreshes its understanding of the limit automatically — an administrator changing the limit while the operator is working updates what they see without a reload. The server enforces the same limit as a safety net: `POST /sessions/{session_id}/selection-confirmation` returns HTTP 413 with a `CapExceededDetail` body if the `selected_cohorts` list exceeds the configured limit.

### How is the review screen organised?
<!-- scenario: submit-a-report; topic: workflow-status -->

**Situation:** A user reviewing an uploaded file (or several uploaded files together) needs to move between three different views of the same data — a high-level dashboard, the per-table data itself, and a list of issues to act on. The screen also has to hold a list of files (one row per uploaded file) so the user can switch between them without losing context. The shape of this navigation has to stay recognisable when the user switches views, otherwise every lens-switch feels like landing on a new screen.

**Decision:** The review screen is laid out as three vertical columns inside the Review tab. From left to right:

1. **Files pane** — one row per uploaded file with the filename, processing status, and a small radial indicator that fills as the file moves through the pipeline. An "All files" row pinned at the top opens the cross-file view. When the user has uploaded several files and the tool has finished checking every one of them, the rows are grouped by status (files with fixable issues at the top, then files with source-only issues, then clean files); a smooth animation rearranges the rows when the grouping becomes available.

2. **Inner-nav pane** (middle column) — a list of jump targets within the active view. For the Dashboard it lists the dashboard's sections ("About the data", "About this report"). For Details it lists the tables in the file with a status dot per table (green if no errors, orange if all errors are dropdown-fixable, red if some require editing the Excel file). For Issues it lists the kinds of issue the file has, grouped by error code, with a count per code. Clicking an entry scrolls or filters the content pane to match.

3. **Content pane** (right column) — the active view's content. The view toggle (Dashboard / Details / Issues) at the top of this pane switches between the three lenses; the content fills the rest of the column.

The Import tab carries the same three-column shape so the user doesn't experience a layout change when they move from reviewing to confirming.

**Rationale:** Three columns that don't change shape between lenses give the user a stable mental map of the screen. Where everything is doesn't depend on which view they're currently in. The Files pane is always on the left, the within-view navigation is always in the middle, and the content is always on the right. When the user switches between Dashboard and Details, the size and position of their navigation doesn't change — only what it contains.

The grouping shuffle in the Files pane communicates "the tool just finished checking all the files; now they're organised by what needs your attention first" without needing a separate banner or status message. Files with the most actionable issues land at the top of the pane so the user doesn't have to scan down the list to find where to start.

The Dashboard's section anchors and the Issues' code buckets occupy the middle pane even though they're not strictly necessary navigation — the Dashboard is short enough to scroll without help, the Issues list is filtered by clicking. They're there to keep the column shape consistent. The cost is some whitespace in the middle column when the cross-file Dashboard is open (no per-section jumps exist for it), accepted as the price for a stable layout.

**Technical detail:** The three slots are HTML siblings inside `<div class="workspace">` — `<aside id="files-pane">`, `<aside id="inner-nav">`, `<main id="content-pane">`. The Import tab mirrors the shape with `#files-pane-import`, `#inner-nav-import`, `#import-content-pane`. The lens-toggle (`#view-toggle`) and lens mounts (`#view-dashboard`, `#view-details`, `#view-issues`) live inside the content pane. `apps/web_ui/components/inner-nav.js` is the shared menu primitive every lens calls via `renderMenu({ mode: 'jump' | 'radio', items, onActivate })`; `showLens` in `apps/web_ui/app.js` dispatches to the per-lens populator. The Files pane grouping uses the View Transitions API (`document.startViewTransition`) where supported (Chrome 111+, Safari 18+, Firefox 144+) for the flat-to-grouped shuffle, with a CSS opt-out for `prefers-reduced-motion: reduce` that flattens the transition to an instant swap. ADR-020 (`docs/adr/020-workspace-three-pane-structure.md`) records the structural decisions and the architectural tests that enforce them.

### How does the multi-file workspace remember what I was doing?
<!-- scenario: submit-a-report; topic: workflow-status -->

**Situation:** A user uploads several files at once. The workspace lets them switch between files in the Files pane on the left, see the data in three different lenses (Dashboard for context, Details for per-table data, Issues for actionable findings), and work across all files at once when "All files" is selected. The user expects the workspace to feel coherent — switches between files don't lose work, a page reload comes back to where they were, and when something goes wrong the tool tells them how to fix it without taking over the screen.

**Decision:** Three behaviours together make the workspace feel like one place to work, not three:

1. **The workspace lands on "All files" by default.** When the tool has finished checking every uploaded file, the operator sees the cross-file Dashboard — one quality summary card per file. Picking a specific file in the Files pane drills into that file's single-file view; clicking "All files" again returns to the cross-file view. The last-clicked file is remembered across page reloads, so closing the tab and reopening it lands the user on the same file they had been working on.

2. **The Issues lens works across files when "All files" is selected.** Every actionable finding from every file shows up in one list, grouped by what kind of finding it is. The user fixes them in one place; each fix is saved against the file the finding came from, not against whichever file happens to be the most recently clicked. Picking the same kind of finding's fix in the Issues lens, the per-file Dashboard, or the per-file Details lens all read and write the same correction state — so a choice made in one view shows up in the others.

3. **Errors interrupt the user only when there's something they have to do inside a dialog box.** A file already imported, two files in the same upload that share content, or a confirm that arrived just after the file's state changed all show as a banner the user reads and decides what to do about. When another session somewhere else in the system is holding the same file open — the only error where the user has to pick which other session to cancel — a dialog opens with the choices.

**Rationale:** A user working with several files at once shouldn't have to remember which file they were last looking at. Defaulting to the cross-file view also reinforces what's new: the workspace is for a batch, not just a single file. Per-file correction state means the user can fix the same kind of finding across several files without their picks bleeding from one file into another — a behaviour that would silently corrupt the import if the user assumed each file's choices were independent.

The banner-vs-dialog split keeps the user's flow intact for the common cases (read, decide, move on) and reserves the disruptive dialog overlay for the one case where the user has to pick from a list of options the rest of the UI doesn't offer anywhere. Without that rule, every error would default to a dialog because "this seems important" reads as "interrupt", and the user would learn to dismiss dialogs without reading.

**Technical detail:** "All files" is the default selection in batch mode — `state.activeFile` is `null` after the upload's gate releases. Single-file mode keeps `activeFile` equal to the only session's id. The `import_active` localStorage key extends to `{kind, id, activeFile}`; legacy entries without the field parse cleanly. On the first `pollBatch` tick after a reload, a persisted `activeFile` that isn't in the current batch falls back to `null`. The per-file correction store is `state.corrections: Map<sessionId, Map<>>` plus the same shape for `state.entityCorrections`; every `AppOps` correction method takes the session id explicitly. Banner-vs-dialog routing for the five 409 conflict kinds follows ADR-017 (`docs/adr/017-modal-vs-banner-surface-rule.md`): four kinds go to a banner via `showErrorBanner({title, lines})` — `CommittedPriorDuplicate` (upload-time, from `DuplicateUploadResponse`), `WithinUploadDuplicate` (upload-time, from the same response), `CommittedPriorConflict` (confirm-time, from `ConflictsResponse`), and `BatchPendingMembersConflict` (confirm-time, from the same response); the fifth kind `InflightSiblingConflict` (confirm-time) opens `components/release-actions-modal.js`. The two `committed_prior`-named shapes (Duplicate and Conflict) carry the same fields but appear in different response schemas — `wire.d.ts` keeps them distinct so the modal/banner consumers narrow on the response's discriminator without ambiguity.

### Can the user start reviewing one file while others are still being processed?
<!-- scenario: submit-a-report; topic: workflow-status -->

**Situation:** A user uploads several files at once. Each file goes through parsing, mapping, and analysis at its own pace — a clean file finishes in a few seconds; a file with many warnings or a large workbook can take longer. The user wants to start reviewing the file that finished first while the slower ones are still being processed.

**Decision:** Yes. The Files pane shows each file's progress as it advances; clicking any file that has reached the Review stage opens that file's Dashboard, Details, or Issues view. The user can pick Confirm or Reject for each file, fix corrections on each file's findings, and switch between files freely while the slower files continue processing in the background.

The Submit batch button at the top of the Review tab does not light up until every file in the batch has reached a reviewable state. Until then, every per-file decision the user has made is held client-side; the user can refresh the page without losing their picks. Once the last file finishes processing, the button activates and the user submits the whole batch in one go.

**Rationale:** Forcing the user to wait for the slowest file before they can do anything is wasteful — for a batch of ten files where nine finished in five seconds and the tenth takes a minute, that is a minute of dead time the user has nothing to do. Letting the user work on the ready files in parallel converts that minute into productive review time. The Submit gate at the end keeps the batch atomic: every file is submitted together so the audit log records one batch decision rather than ten micro-decisions.

**Technical detail:** Each file's state is polled at one-second cadence via `pollBatch` against `/batches/{id}`. The Files pane is always populated; rows become clickable once their state passes the threshold defined by `_READY_STATES` in `apps/web_ui/app-utils.js`. Per-file decisions live in `apps/web_ui/decision-cache.js`, keyed by `(stage, sessionId)` and persisted to `localStorage` so a page reload restores them. The Submit batch button reads `deriveTabPhase` from `app-utils.js`: it activates when `members.every(m => STAGE_1_DONE.has(m.latest_state))`. The bulk POST to `/sessions/review` carries `confirm_session_ids` + `reject_session_ids` + `corrections_by_session` in one transaction; the server's `correction_gate.validate_corrections_cover_fixable` runs per-session before any database write.

### How does the workspace adapt to a phone screen?
<!-- scenario: submit-a-report; topic: workflow-status -->

**Situation:** The same review tool is used at a desk on a wide screen and on a phone in the field. The three-column desktop layout (Files pane on the left, per-lens menu in the middle, content on the right) does not fit horizontally on a phone in portrait orientation, but the user still needs to switch between files, navigate within a file, and submit the batch.

**Decision:** On a phone screen (narrower than about 480 pixels), the layout shifts to one column. The Files pane is hidden by default; the user opens it by tapping a Files button in the workspace header at the top of the screen, picks the file they want, and the panel slides closed automatically. Within a file's view, the per-lens menu (table jump list, finding-code buckets) becomes a horizontal scrolling strip at the top of the content area. At the Stage 2 Import step, the Confirm button stays pinned to the bottom of the screen so the user can submit without scrolling through the whole batch summary first.

On a tablet in portrait (between about 480 and 768 pixels), the Files pane stays visible alongside the content; only the per-lens menu shifts to the horizontal strip above content. On wider screens, the layout is the desktop three-column shape.

**Rationale:** A phone in portrait has roughly 390-412 pixels of width — barely enough for a single column of readable content. A persistent Files pane at that width would either crowd the content out or be too narrow to read filenames in. The toggle-to-open pattern matches the convention every mobile operator already knows from messaging and file-browser apps. Keeping the Confirm button always visible at Stage 2 means the user can submit a ten-file batch without scrolling past every file card to find the action — the button is where the thumb already is.

**Technical detail:** Three CSS tiers gate the layout: `@media (max-width: 479px)` (compact), `@media (max-width: 767px)` (hybrid), and the default at ≥768px. The `.workspace` element uses `grid-template-areas` to rearrange its three slots per tier. The Files pane drawer is the same `<aside id="files-pane">` element at every viewport; a `matchMedia('(max-width: 479px)')` change listener applies `role="dialog"` + `aria-modal="true"` to it only at the compact tier, and `setFilesDrawerOpen(target, open)` in `apps/web_ui/app.js` is the sole writer to the `.files-pane-drawer-open` class. The sticky Confirm button uses `position: sticky; bottom: 0; padding-bottom: env(safe-area-inset-bottom)`, paired with `viewport-fit=cover` on the `<meta name="viewport">` tag so iOS devices with a home indicator render the padding correctly. ADR-020 (`docs/adr/020-workspace-three-pane-structure.md`) records the architectural details including the keyboard tab-order shift the workspace-header restructure introduces.

---

## 4. Template Recognition

### How does the tool identify which template a file uses?
<!-- scenario: submit-a-report; topic: template-recognition -->

**Situation:** An uploaded Excel file needs to be recognised as one of the known EITI templates — v1, v2.0, or v2.1 — before the tool can read it.

**Decision:** The tool inspects each file from three angles and produces an overall fit score for every known template version. First, it looks at the Introduction sheet for an explicit version statement (for example, text like "Version 2.1"). Second, it checks whether the sheets the template expects (About, Companies, Government_revenues_table, and so on) are actually present in the workbook. Third, it checks whether the tables, headers, and labels each version is built around appear where they should. The version with the best overall fit wins.

**Rationale:** A single rigid rule — for example, "the Introduction text must say Version 2.1 exactly" — would reject any file where the submitter renamed a sheet, edited the Introduction, or rebuilt the workbook from scratch. Combining several pieces of evidence lets the tool still recognise a file when one signal is missing or has drifted, which matches what real submissions look like.

**Technical detail:** Scoring lives in `score_templates` in `packages/parser/src/parser/identification/matcher.py`. Each `SubmissionDefinition` in `packages/parser/src/parser/domain/submissions/registry.py` supplies its `FingerprintRules.version_string` regex and its `schemas` sequence; the schemas whose `used_in_identification` flag is set feed the structural signal. The three-signal weighting is 50 / 20 / 80 on a 0-150 scale. The dispatcher inside `score_templates` picks one of `check_standard_table`, `check_kvp`, or `check_fixed_columns` per schema type.

### When does a template version qualify as a candidate?
<!-- scenario: submit-a-report; topic: template-recognition -->

**Situation:** After comparing the file against every known template version, the tool has a fit score for each one. It has to decide which of those versions are credible enough to be treated as possible matches for this file.

**Decision:** A template version is kept as a possible match only if its fit is strong enough to clear a minimum bar. Anything below that bar is dropped from consideration — the tool will not show it to the user or offer it for confirmation.

**Rationale:** The bar lets the tool tolerate files that have drifted away from the template (renamed sheets, edited Introduction text, partial column coverage) without accepting unrelated workbooks that happen to share a sheet name or two. Setting it too high would force a re-upload every time a submitter touched the boilerplate; setting it too low would surface bogus options and force the user through needless confirmation prompts.

**Technical detail:** The threshold is the literal `if final_score >= 40` check in `score_templates` in `packages/parser/src/parser/identification/matcher.py`. The resulting list flows out as `MatchResult.candidates` and drives the `SUBMISSION_DETECTED` vs `SUBMISSION_AMBIGUOUS` branch in `DetectorService.build_detection_findings`.

### What happens when more than one template could fit?
<!-- scenario: submit-a-report; topic: template-recognition -->

**Situation:** Two or more template versions look like plausible matches for the same file — for example, a v2.0 file whose About sheet has been edited to look like v2.1, or a v2.1 file with some sheets renamed back to v2.0 names.

**Decision:** The tool does not pick a version on its own. It pauses the run and shows the user a template-confirmation step listing every plausible version. The user picks the right one before the tool reads the rest of the file. If the top two options are very close to each other, the tool also clears its own internal "best guess" so the confirmation screen does not pre-tick a version on the user's behalf.

**Rationale:** Each template version has its own structure and its own rules for what each cell should contain. Picking the wrong one would interpret cells against the wrong rules and silently store data in the wrong shape — the user would not see an obvious error, just rows that look subtly off. A human pick is cheap (a single click) compared to the cost of unwinding a bad import.

**Technical detail:** Near-tie detection is the `NEAR_TIE_THRESHOLD = 10` block in `score_templates` in `packages/parser/src/parser/identification/matcher.py`. The interrupt is registered in `packages/pipeline/src/pipeline/factory.py` (`interrupts.add(SessionState.SELECTION_CONFIRMING)`) and gated in `packages/pipeline/src/pipeline/transition.py`, which checks for `SUBMISSION_AMBIGUOUS` among the detector's findings.

### When does the tool skip the template-confirmation step?
<!-- scenario: submit-a-report; topic: template-recognition -->

**Situation:** The tool has finished looking at the file and needs to decide whether to pause for an explicit user pick or continue straight into reading the data.

**Decision:** The tool skips the confirmation step only when all three of the following are true: there is exactly one plausible template version, the file covers exactly one country-year submission, and that country-year has never been imported before. If any of those is not true — more than one template fits, the file covers several country-year submissions, or any of them has already been imported — the tool pauses so the user can pick the template and choose which country-year submissions to import.

**Rationale:** Skipping confirmation is reserved for the cleanest case, where there is genuinely nothing for the user to choose between. The moment more than one option exists — template, country-year, or "new vs already imported" — silently continuing could write data the user did not intend (the wrong template's rules, an extra country-year, or overwriting a prior import). Forcing an explicit pick in those cases turns each ambiguity into a deliberate decision.

**Technical detail:** The gating logic lives in `check_transition` in `packages/pipeline/src/pipeline/transition.py`. It counts `DetectionCode.COHORT_NEW` and `DetectionCode.COHORT_DUPE` findings, checks for `SUBMISSION_AMBIGUOUS`, and computes `needs_selection = (new_count != 1) or (dupe_count > 0)`. The `SELECTION_CONFIRMING` interrupt fires unless detection is unambiguous and `needs_selection` is false.

### What happens if the tool can't identify the template?
<!-- scenario: submit-a-report; topic: template-recognition -->

**Situation:** No known template version is a plausible match for the file — every version the tool knows about falls short of the minimum fit bar.

**Decision:** The tool stops the run with an error and tells the user the file does not match any known EITI template. It does not try to read the data, run consistency checks, or attempt an import.

**Rationale:** Every step after recognition is wired to a specific template's structure. Without a recognised template there is no agreed-upon shape to read the file against, no way to translate its cells into the dashboard's columns, and no way to produce meaningful checks. Carrying on would produce junk findings and waste effort on a file that needs to go back to the submitter.

**Technical detail:** `SUBMISSION_UNRECOGNIZED` is registered as a terminal finding code in `packages/pipeline/src/pipeline/factory.py` (in the `terminal_codes` set alongside `DUPLICATE_SUBMISSION` and `FILE_OPEN_ERROR`). The detector emits it from `build_detection_findings` in `packages/parser/src/parser/identification/detector_service.py` when `result.candidates` is empty.

### How does the tool handle a table found on the wrong sheet?
<!-- scenario: submit-a-report; topic: template-recognition -->

**Situation:** While comparing a file against a template, the tool finds an expected table — say, the Companies table — but on a different sheet from the one the template expects. Or it finds an expected About-style sheet whose name has been changed (for example, "1_About" renamed to "Part 1 - About").

**Decision:** The table or sheet still counts as found, so the template stays in the running, but it earns only half the credit it would have earned from a clean placement. The tool also records a note on the report shown to the user, saying that the table or sheet was found but had moved or been renamed.

**Rationale:** Submitters routinely edit the templates — sheets get renamed, tables get copy-pasted between workbooks. Refusing to recognise a moved table would push too many real submissions into the "unrecognised" path. Halving the credit keeps the moved table as evidence without letting it overwhelm the choice between v2.0 and v2.1, which differ in exactly where some tables live and would otherwise be indistinguishable.

**Technical detail:** The penalty is the `score *= 0.5  # 50% penalty for wrong sheet` line in `check_standard_table` and the matching `score *= 0.5  # 50% penalty for renamed sheet` line in `check_kvp`, both in `packages/parser/src/parser/identification/matcher.py`.

### What language does the database accept for incoming files?
<!-- scenario: submit-a-report; topic: template-recognition -->

**Situation:** Some implementing countries publish their EITI summary data in French or Spanish — for example, Chad submits FR-only files, Mexico publishes both EN and SP variants of each year. The parser's templates, dropdown vocabulary, and table names are all defined in English.

**Decision:** The database is English-canonical. The tool reads English files directly. Files in French or Spanish are not accepted into the database without first being converted to the English form of the same template. The original-language file is preserved on PortalJS (the upstream catalog) as the source-of-truth artefact; the tool stores the English-form version of the data.

**Rationale:** The parser, cleaner aliases, and downstream consumers (dashboards, crosschecker, exports) all assume one canonical vocabulary. Supporting multi-language input directly inside the parser would require every schema, validator, and lookup to be language-aware — a structural change that affects every consumer. Keeping the database English-canonical and converting files at the curation boundary means each subsystem stays simple and the conversion is auditable as a single artefact (the manifest of EN ↔ FR/ES translations).

**Technical detail:** A French- or Spanish-language file is converted to its English form by `tools/corpus_build/normalize_localized.py apply --lang <fr|es>`, driven by the manifest at `tools/corpus_build/translations/v2.toml`. The normalizer renames sheets, rewrites known label cells, and freezes VLOOKUP formulas with their cached values. The cleaner's `FR_ALIAS_LOOKUP` and `ES_ALIAS_LOOKUP` in `packages/shared/src/shared/sdf_vocabulary.py` cover localized data values (enum dropdowns, country names) that the normalizer doesn't touch. Both layers must agree: a new FR/ES label belongs in the manifest; a new FR/ES data-value spelling belongs in the cleaner's `*_TRANSLATIONS` tables.

---

## 5. Entity Resolution

### How does the tool match a name to an existing entity?
<!-- scenario: trust-the-data; topic: entity-resolution -->

**Situation:** A company, government agency, or project name extracted from the file needs to be linked to an existing record in the EITI entity database — for example, matching "Statoil ASA" in a Norwegian file to its existing record.

**Decision:** The tool tidies up both the name in the file and each candidate name in the EITI database the same way — removing accents (so "Petróleos" and "Petroleos" become the same), trimming whitespace, putting everything in upper case. If a tidied-up name in the file is identical to a tidied-up name in the database, the tool treats it as an exact spelling match and links the two silently. If no exact spelling match exists, the tool looks for close-but-not-exact spellings — also ignoring common company suffixes like INC, LTD, SA, GMBH so they do not dominate the comparison. Any close matches are surfaced to the user for confirmation; the tool never links them on its own. A name with no exact match and no close matches is treated as a brand-new entity.

**Rationale:** Comparing names letter-by-letter would treat trivial differences — accents, casing, trailing spaces — as different entities and fill the database with duplicates of the same company. Automatically accepting close matches would do the opposite damage: quietly link a near-miss to the wrong record, leaving the file pointing at the wrong entity with no easy way to spot or fix it later. Routing close matches to the user for confirmation keeps both failure modes off the table.

**Technical detail:** Normalisation, classification, and the matching helpers live in `packages/shared/src/shared/families/_enrichment_helpers.py` (re-exported via `shared.families`). `classify_match` is the core comparator; `normalize` strips accents and uppercases; `_SUFFIX_PATTERN` removes corporate suffixes before fuzzy matching; reference names shorter than 4 characters after suffix stripping are excluded (the `_MIN_FUZZY_NAME_LENGTH` constant) to prevent abbreviations like "INC." from matching everything. The fuzzy comparator is rapidfuzz WRatio with a threshold of 86/100. Reference records come from `DatasetteSource` (which hits the public EITI Datasette at `soe-database.eiti.org`) in dev/test environments and from `LocalDbSource` (the deployment's target DB) in staging/prod.

### What identifier is given to a brand-new entity?
<!-- scenario: trust-the-data; topic: entity-resolution -->

**Situation:** A company, agency, or project name in the file matched no existing record in the EITI entity database — and any close matches the tool surfaced were either rejected by the reviewer or never decided on.

**Decision:** The tool mints a fresh stable identifier for the new entity locally, tagged with its category (company, government entity, or project). That identifier is attached to every row in the file that mentions the entity, and a new entry is added to the relevant reference list (companies, government entities, or projects) carrying the name, the country, and the reporting date.

**Rationale:** Every row in the dashboard needs to point at some entity record, including for entities the EITI database has never seen. Minting the identifier locally keeps the tool self-contained — it does not have to call out to a central system to register the entity — while still producing something unique enough that a later cleanup pass can match it up with the official record once the entity is registered upstream.

**Technical detail:** The mapper writes one row to `metadata_companies`, `metadata_gov_entities`, or `metadata_projects` for every entity reaching the database — entities recognised against the EITI registry (EXACT, SINGLE_CANDIDATE) and entities the operator newly introduced (NEW, AMBIGUOUS without a confirmed candidate). `emit_entity_metadata_findings` in `packages/mapper/src/mapper/mapper_service.py` runs in two passes: first it mints a UUID4 entity ID for every unmatched entity (the operator-typed name becomes the row's name; the new UUID becomes the row's ID); then it emits one CELL_MAPPED finding per metadata-table column for every entity — the entity ID and entity name from the candidate, plus every column declared on the family's `metadata_writes` (country, effective date, headquarters, LEI, sectors, etc.). The field-to-entity-type mapping comes from each family's `CohortField` declarations in `shared/families/{family}.py` — every entity-bearing field carries `role=EntityCreation(entity_type=..., metadata_target=..., metadata_writes=...)` (see ADR-024). The mapper reads `mapper.entity_fields` (a tuple of `CohortField` derived at construction from every CohortField whose role is an `EntityCreation` variant). Identifiers are UUID4s prefixed by entity type — `eiti_id_company:<uuid>`, `eiti_id_government:<uuid>`, `eiti_id_project:<uuid>` — defined as `EntityType` in `packages/shared/src/shared/diagnostics.py`. Unresolved AMBIGUOUS findings (those where the reviewer never confirmed a candidate) get the same UUID4 treatment as NEW ones.

### Why is a company matched globally but agencies and projects per-country?
<!-- scenario: trust-the-data; topic: entity-resolution -->

**Situation:** When the tool looks up existing entity records to compare the file's names against, it has to decide what slice of the EITI database to pull — every entity of that type across all countries, or only those linked to the file's reporting country.

**Decision:** For companies, the tool pulls every company in the EITI database, regardless of country, and compares the file's names against that global list. For government agencies and projects, the tool pulls only those linked to the file's reporting country.

**Rationale:** Companies routinely operate in more than one country — a multinational that reports in Norway one year may report in Nigeria the next, and the user should not have to maintain a duplicate record per country. Government agencies and project names, by contrast, are bound to a single jurisdiction: the "Ministry of Petroleum" in one country has no relationship to the "Ministry of Petroleum" in another, and matching across countries would produce spurious links. Limiting agencies and projects to one country also keeps the candidate list a manageable size — a global agency list runs into tens of thousands of names.

**Technical detail:** The branch is the `use_country = country if category != "companies" else None` line in `_fetch_reference_data` in `packages/enricher/src/enricher/enricher_service.py`. The Datasette-side SQL templates in `packages/enricher/src/enricher/datasette_source.py` (`_SQL_COMPANIES`, `_SQL_AGENCIES`, `_SQL_PROJECTS`) build a `WHERE iso_alpha3_code = :p0` clause only when a country is passed.

### How is a declaration uniquely identified?
<!-- scenario: avoid-duplicate-imports; topic: entity-resolution -->

**Situation:** Every imported declaration needs a stable identifier — something the tool can use to recognise that two uploads describe the same country-year submission, even if the file content differs.

**Decision:** The tool builds a declaration's identifier from two ingredients: the country's ISO3 code and the reporting period's start year. The same country plus the same year always produces the same identifier, so a re-upload of Norway 2021 always resolves to the same declaration no matter how the file was edited in between.

**Rationale:** A predictable identifier means the duplicate check, the import step, and the "has this country-year already been imported?" check all arrive at the same identifier from the same inputs without needing to coordinate through a shared counter or lookup. It also lets the rule "a re-import replaces the prior rows" work — the new write targets exactly the same record as the old one. A random, one-off identifier would make every re-upload look like a fresh declaration.

**Technical detail:** The namespace is the fixed `DECLARATION_NAMESPACE` UUID at the top of `packages/shared/src/shared/diagnostics.py`. The derivation is `uuid5(DECLARATION_NAMESPACE, f"{country_iso3}:{year}")` in three places that must agree: `DetectorService.build_detection_findings` (emits the finding), `_sdf_existence_key` in `packages/parser/src/parser/domain/submissions/registry.py` (looks up duplicates in the target DB), and the mapper (writes the row).

### What does the tool treat as a single submission for duplicate detection?
<!-- scenario: avoid-duplicate-imports; topic: entity-resolution -->

**Situation:** A file is uploaded. The tool needs to figure out which already-imported declaration, if any, the file conflicts with.

**Decision:** The tool checks each part of the file separately to see whether it has already been imported. A standard SDF file contains a single country-year submission, so there is only one thing to check. A fat file (a validation extract or an API extract that bundles many country-years in one workbook) contains many country-year submissions, and the tool checks each one against the database on its own. For every country-year it finds in the file, it tells the user whether it is new to the database or already imported.

**Rationale:** A fat file covering fifty country-year submissions might have forty-eight the database has never seen and two that were already imported. Treating the whole workbook as one unit would force the user to either delete the two prior imports or rebuild the file without them before proceeding. Checking each country-year separately lets the user import the forty-eight new ones in one go and decide explicitly what to do with the two overlapping ones.

**Technical detail:** `CohortSchema` in `packages/parser/src/parser/domain/submissions/models.py` is generic over `CohortT` — each submission narrows it (`SDFCohort` in `packages/parser/src/parser/domain/submissions/registry.py` is a TypedDict with `country_iso3` and `year`). The classification loop is `DetectorService._classify_cohorts` in `packages/parser/src/parser/identification/detector_service.py`, which calls `TargetDbManager.exists()` per cohort. The matcher invokes `cohort_schema.extractor(ctx)` inside `identify_template` and wraps the result in `list(...)` so lazy iterators don't escape the workbook's scope. Per-cohort findings are `COHORT_DETECTED`, `COHORT_NEW`, and `COHORT_DUPE`.

### Why does the tool block re-uploads of the same data from the EITI API?
<!-- scenario: avoid-duplicate-imports; topic: entity-resolution -->

**Situation:** An operator uploads the EITI API export for Cameroon 2001 in January. In June, a new export is generated from the same data — different file (new timestamp, possibly different row order) but the same Cameroon 2001 declaration.

**Decision:** The tool blocks the second upload and marks it as a duplicate. The operator is told that the Cameroon 2001 declaration is already imported, even though the file bytes differ from the January upload.

**Rationale:** A declaration in the database is identified by the country and reporting year, not by which file produced it. Two EITI API exports for the same country and year describe the same declaration — importing the second one would create a duplicate row with stale data. The same rule applies to the standard summary data file format: re-uploading the SDF for Cameroon 2001 from a different submitter still resolves to the same declaration and is blocked the same way.

**Technical detail:** Declaration identity is derived from `(country_iso3, year)` via `uuid5(DECLARATION_NAMESPACE, "iso3:year")`. The same UUID derivation is applied at three layers: when DetectorService announces the cohort, when the mapper writes the `metadata_summary_data_files` row, and when `TargetDbManager.exists_many` checks for prior imports. API extract files declare cohorts by `(iso2, year)`; `iso2_to_iso3` normalizes the alpha-2 code to alpha-3 before the UUID derivation, so an API extract for `CM` and an SDF for `CMR` resolve to the same declaration UUID. The mapper writes a `metadata_summary_data_files` row for API extract submissions even though they have no About sheet — identity comes from `PipelineContext.cohort_metadata` (a family-specific TypedDict keyed by canonical names like `country_iso3` and `cohort_year`), populated by the selection-confirmation endpoint during cohort fan-out via `cohort_contract.context_fields(cohort)`.

### What happens when the user uploads a file that's already imported?
<!-- scenario: avoid-duplicate-imports; topic: entity-resolution -->

**Situation:** The tool has finished checking, for each country-year submission in the file, whether the database already holds a matching declaration.

**Decision:** Three outcomes are possible, depending on how many of the country-year submissions in the file are new and how many are already imported:
- Every country-year is already imported: the tool stops with an error and tells the user. To proceed, the user has to explicitly delete the prior import and re-upload.
- A mix of new and already-imported, or several new country-year submissions in one file: the tool pauses and asks the user to pick which country-year submissions to import.
- Exactly one country-year submission, and it is new to the database: the tool continues silently.

**Rationale:** When everything in the file is already imported, it almost always means the user uploaded the wrong file or forgot a prior import existed — stopping loudly forces a deliberate decision (re-importing means delete-then-upload) rather than silently overwriting. Mixed cases need the user in the loop because the right answer depends on intent: a corrected re-import of the already-imported ones, skipping them, or cancelling entirely. Silent continuation is reserved for the cleanest case where there is nothing to choose between.

**Technical detail:** The all-DUPE branch is the `if classification.new_count == 0 and classification.dupe_count > 0` block in `DetectorService.run` in `packages/parser/src/parser/identification/detector_service.py`; `DUPLICATE_SUBMISSION` is in the pipeline's `terminal_codes` set in `packages/pipeline/src/pipeline/factory.py`. The mixed/multi-new branch is gated by `needs_selection = (new_count != 1) or (dupe_count > 0)` in `check_transition` in `packages/pipeline/src/pipeline/transition.py`. The terminal status returned is `ERROR_DATA`.

### Why isn't a re-upload of a fat file blocked at the file level when one of its country-year submissions already imported?
<!-- scenario: avoid-duplicate-imports; topic: entity-resolution -->

**Situation:** The user uploads a fat file — a validation extract, an EITI API extract, or any file that bundles many country-year submissions in one workbook. The tool imports some of the country-year submissions successfully and stops on others (a parsing error in one cohort, a user-cancelled review, a network blip during enrichment). The user fixes the underlying issue and re-uploads the same file to retry the remaining country-year submissions.

**Decision:** The tool accepts the re-upload at the file level. It then checks each country-year submission in the file separately against the database (see "What does the tool treat as a single submission for duplicate detection?") and tells the user which ones are already imported and which ones are new. The user picks the country-year submissions they want to import. The successfully-imported country-year submissions from the prior attempt are visible as duplicates the user can choose to skip; the previously-failed ones are new and proceed normally.

**Rationale:** A file-level "have I seen these bytes before?" block would refuse the legitimate retry workflow. The user uploaded the file twice on purpose — the first time imported half the data, the second time is meant to finish the job. Forcing the user to either delete the prior partial imports (destructive) or rebuild the file without the imported country-year submissions (manual Excel surgery) just to get past the file-level duplicate check would penalise the normal failure-recovery path. The country-year-level check is the right granularity: it catches genuine re-imports of identical declarations regardless of file shape, and it lets multi-submission files participate in the same retry workflow as single-submission ones.

**Technical detail:** Every `metadata_import_events` row carries a `fanout_member` boolean (`True` if the import was one of N produced by cohort fan-out from a single uploaded file, `False` for a scalar one-file-one-import). `TargetDbManager.find_active_import_by_hash` filters on `event_type = FILE_IMPORT AND fanout_member = 0`, so file-level hash dedup only catches scalar re-uploads; fan-out members are passed through to `TargetDbManager.exists_many`, which checks each cohort by its family-specific identifier column. `ImporterService` sets `fanout_member` from `context.fanout_strategy != FanoutStrategy.NONE` at write time (`packages/importer/src/importer/import_service.py`). The single-cohort scalar SDF file gets `fanout_member=False` and remains subject to file-level hash dedup; every cohort child of a fat file gets `fanout_member=True` and falls through to cohort-level dedup.

### Why doesn't the tool guess on close matches?
<!-- scenario: trust-the-data; topic: entity-resolution -->

**Situation:** The tool has a close-but-not-exact spelling match between an entity name in the file and a record in the EITI database — close enough to look credible, but not identical. The tool has to decide whether to accept that match automatically or ask the user.

**Decision:** Close matches above the tool's similarity bar are always surfaced to the user for confirmation, never accepted on the tool's own. If the user picks one of the suggested records during review, that record is used. If the user does not pick anything (or rejects all the suggestions), the tool treats the name as a brand-new entity and mints a fresh identifier for it.

**Rationale:** The two failure modes are not equally recoverable. Treating "Statoil ASA" as new when the EITI database already has it is fixable: the new entity gets its own identifier, and a later cleanup pass can merge it with the correct record by name comparison. Linking "Statoil ASA" to the wrong company on the strength of a close match corrupts the link silently — the row points at the wrong entity, no rule will catch it, and there is no automated way to find and fix it afterwards. The asymmetry makes "ask the user when in doubt" the conservative default.

**Technical detail:** The threshold is `DEFAULT_THRESHOLD = 86` in `packages/shared/src/shared/families/_enrichment_helpers.py` (re-exported via `shared.families`); the comment there explains it's a noise plateau from shared corporate suffixes. The UUID4 fallback for unresolved AMBIGUOUS findings is the `if f.code == EnrichmentCode.AMBIGUOUS: ... if coord in resolved_coords: continue` block in `emit_entity_metadata_findings` in `packages/mapper/src/mapper/mapper_service.py` — only AMBIGUOUS findings the user explicitly resolved during review are skipped; the rest fall through to the same UUID4 assignment as NEW.

### How does the tool classify government entities by type?
<!-- scenario: trust-the-data; topic: entity-resolution -->

**Situation:** Government revenue rows in v2.x EITI Summary files carry an `Agency type` cell — Central / state / local government, state-owned enterprise, or other. The tool needs to store that classification alongside the entity so downstream queries can aggregate revenue by tier of government.

**Decision:** The five `Agency type` values are a closed vocabulary maintained as the `AgencyType` StrEnum in the codebase. Every government entity row in `metadata_gov_entities` carries an integer foreign-key column `entity_type_id` pointing at one row in the vocab table `metadata_gov_entity_types`. The vocab table is seeded at API startup from the StrEnum members; the mapper emits the raw enum value (e.g. "Central government") on the metadata-row write, and the importer resolves it to the integer id at INSERT time. v1 files have no `Agency type` column — their government entity rows leave `entity_type_id` NULL.

**Rationale:** Storing the type as an integer FK keeps the entity table small and makes downstream JOINs cheap, while the vocab table holds the human-readable label. The five values are stable but not external standards — they're EITI-curated — so an integer-surrogate FK is correct (a natural-key FK on the string value would create rename-cascade risk if the EITI vocabulary ever updates a label). Adding a sixth type is a one-line StrEnum extension; the seeder picks it up on next API restart.

**Technical detail:** The FK relationship is declared at the schema level via PEP 593 `Annotated[int | None, FK("metadata_gov_entity_types", "type_name")]` on `MetadataGovEntities.entity_type_id` in `packages/shared/src/shared/db_models.py`. The importer's reflection cache `get_fk_registry()` in `packages/shared/src/shared/sql_helpers.py` walks every registered model at first call, collects every FK annotation, and the `_resolve_fk_values` step in `packages/importer/src/importer/import_service.py` looks up the integer id for every FK column before `_coerce_row` runs. The seeder `_seed_metadata_gov_entity_types` in `packages/shared/src/shared/session/target_db_engine.py` runs once per process lifespan and is idempotent (INSERT OR IGNORE keyed on the UNIQUE `type_name` column).

### Do an EITI summary file and an API extract for the same country-year share a declaration?
<!-- scenario: avoid-duplicate-imports; topic: entity-resolution -->

**Situation:** The same country-year submission can reach the tool through two routes — a Summary Data Template the country filed directly, or an EITI API extract that bundles many country-year submissions in one file. The two routes use different country codes: the Summary Data Template carries the three-letter ISO code (NOR, AGO), and the API extract carries the two-letter ISO code (NO, AO). The duplicate-detection rule has to decide whether a Summary Data Template for Norway 2024 and an API extract that includes Norway 2024 are the same declaration or two separate ones.

**Decision:** Both routes land on the same declaration. If the user uploads the Summary Data Template for Norway 2024 and then later uploads an API extract that includes Norway 2024, the duplicate-detection rule (see "What does the tool treat as a single submission for duplicate detection?") recognises the second upload as a re-import of the first. To hold both representations side by side, the user has to delete the prior one before re-uploading.

**Rationale:** A country-year is one declaration, no matter which file route delivered the data. Storing them as separate database rows would mean a query for "what did Norway disclose for 2024?" returns two answers, splitting downstream reports. Forcing a delete-and-replace decision keeps the database to one row per declaration and puts the choice of which version to keep in the user's hands.

**Technical detail:** Both submission types compute the declaration's unique identifier with the same formula: `uuid5(DECLARATION_NAMESPACE, f"{iso3}:{year}")`. The Summary Data Template schema reads `iso3` directly from the About sheet. The API extract schema reads `iso2` from the row data and translates it to `iso3` through a static map (`iso2_to_iso3` in `packages/parser/src/parser/domain/country_resolver.py`) before passing it to the same formula — so the resulting UUID matches. Country codes the map cannot resolve (Kosovo's `XK`, deprecated codes) are dropped at extraction time and logged via the `api_extract_cohorts_dropped` event.

### Government entities and projects are deduplicated by the pipeline
<!-- scenario: trust-the-data; topic: entity-resolution -->

**Situation:** When an EITI report names a company, a government agency, or a project, the tool consults an alias manifest to assign each reference a stable identifier. All three entity types in the manifest come from the dedup pipeline — Splink probabilistic clustering, GLEIF cross-check where applicable, and operator-reviewed cluster verdicts.

**Decision:** A reconciliation step compares the EITI staff's hand-curated alias list against the pipeline's clustering. Curator entries whose name appears in the pipeline's clustering (above a similarity threshold and with matching country) inherit the pipeline's identifier so future references resolve consistently. Curator entries that don't match a pipeline cluster appear in a per-pipeline-run review queue — an operator confirms them, drops them, or adds them as a manual override.

**Rationale:** Three benefits drive this shape. Government agencies and projects get the same precision discipline as companies (Splink scoring, GLEIF cross-check for agencies, cluster review). When a new EITI report introduces a previously-unseen agency or project, the pipeline clusters it with existing references — a frozen hand-list could only describe what it had been taught about. The entity identifier is deterministic across pipeline runs (the same cluster always produces the same identifier), so downstream consumers see stable values.

**Technical detail:** Identifiers are `eiti_<type>_<uuid5>` where the uuid5 hashes the cluster's member set under a fixed namespace — same cluster, same id. The reconciliation script is `tools/dedup/scripts/reconcile_curator_entries.py`; it uses `enricher.dedup_norm.normalize_entity_name` + `rapidfuzz.fuzz.ratio` at threshold 90.0 (the same value rule 28 uses for name-similarity decisions) and writes orphan entries to `<pipeline_run_dir>/curator-reconciliation-queue.csv` with `source=curator_disagreement`. The CSV reflects the current run's orphans only — re-running the script against the same run_dir replaces the file (matching the markdown report's regenerate-each-run semantic). Matching requires both name similarity above the threshold AND country agreement: a curator entry tagged for a specific country (for example, country='NO') only matches a pipeline cluster whose canonical country is the same; pipeline clusters with no country evidence don't match country-tagged curator entries. Methodology and per-entity-type calibration tables live in `docs/guides/dedup-pipeline.md` §9.7 and §11.

### Which source files feed the dedup pipeline?
<!-- scenario: trust-the-data; topic: entity-resolution -->

**Situation:** The dedup pipeline produces the canonical alias manifest the importer reads to assign entity identifiers. The inventory builder (`tools/dedup/build_inventory.py`) reads from a specific set of source files; missing files would yield a half-empty manifest, and silent-skip would let the pipeline run on incomplete data without warning the operator.

**Decision:** Three corpora contribute entity rows: `api_v1` (the EITI API v1 fat-file revenue extract), `v2` (per-country-year SDF workbooks), and `ca` (the Company Assessment workbook). validation_data is excluded — its family declares no entity-creating columns, so parsing it would produce zero inventory rows. The required-files contract lives in `_REQUIRED_FILES` at the top of `build_inventory.py`; missing any required corpus causes `discover_source_files()` to raise `FileNotFoundError` rather than silently absent the missing corpus from the inventory.

**Rationale:** Silent skip on a missing corpus is a lying API: the function says it discovered the source files while quietly omitting them. Fail-loud surfaces operator configuration issues at script start instead of letting them propagate into a half-empty inventory the operator debugs hours later. The `_REQUIRED_FILES` declaration is the single source of truth — the architectural test (`test_arch_dedup_required_files_contract.py`) verifies that `discover_source_files()` iterates the declaration and that every Corpus enum member has a declaration entry, so adding a new corpus is one declarative change rather than a coordinated edit across multiple sites.

**Technical detail:** Canonical paths are `local/shared_files/Revenues_SDT 1.0.xlsx` (api_v1 — the EITI distribution original, name has a space), `local/v2/*.xlsx` (v2 corpus, one workbook per country-year report), and `local/ca/company_assessment_v1.xlsx` (ca workbook). The ca location matches `tools/corpus_harness/configs/ca.toml`'s `files_dir` so both the dedup pipeline and the corpus_harness read the same path; dev populates `local/ca/` by copying or symlinking from `apps/web_ui/public/examples/company_assessment_v1.xlsx`, which is the file the WebUI also serves as a sample download. The `Corpus` StrEnum in `build_inventory.py` enumerates the closed set (`API_V1`, `V2`, `CA`) and is enforced by the `corpus` field's enum constraint in `inventory-row.schema.json`; the `test_dedup_corpus_enum.py` test pins the two sides together so a one-sided change fails at PR time. The per-file degraded mode in `harvest_rows_from_file` (a single file failing identify/parse returns an empty row list + a status entry recorded in the run summary) is intentional and distinct from the source-file-missing case — one bad file shouldn't sink the whole inventory rebuild, but a missing required corpus should refuse to start.

---

## 6. Consistency Rules

### Why does the tool warn about Part 5 entities missing from Part 3?
<!-- scenario: trust-the-data; topic: consistency-rules -->

**Situation:** Part 5 (company payments) names companies, government agencies, and projects in each row. Part 3 (reporting entities) is where those same entities are registered with their full details. If a Part 5 row names a company, agency, or project that doesn't appear in Part 3, it's either a typo in the payments table or a missing Part 3 registration.

**Decision:** For each Part 5 row, the tool reads the company, agency, and project values and looks them up against the Part 3 entries. Each unmatched name produces a warning the reviewer has to acknowledge, pointing at the specific row and naming whether it's the company, the agency, or the project that's unregistered. The reference list is rebuilt per file from the Part 3 Companies, Government_agencies, and Projects tables (v2.1) or their v2.0 equivalents (Companies, Government_agencies, Companies15-as-projects). For v1 there is only a single Part 3 company list, so the agency and project checks don't run.

**Rationale:** Part 5 reconciles per-entity payments against the Part 3 register. An entity in Part 5 but not in Part 3 either won't reconcile at all or will reconcile against a registration that doesn't exist — both indicate the file was edited inconsistently. The warning lets the reviewer either add the registration in the source file or correct the Part 5 spelling before import.

**Technical detail:** `_check_part5_references` in `packages/crosschecker/src/crosschecker/crosschecker_service.py` consumes per-version configs from `packages/pipeline/src/pipeline/profiles/summary_v1.py`, `summary_v2p0.py`, and `summary_v2p1.py`. The roles produce `UNREGISTERED_COMPANY`, `UNREGISTERED_AGENCY`, and `UNREGISTERED_PROJECT` finding codes. Sentinel strings ("Not available", "Not applicable") are filtered via `is_real_string` before set membership so they never produce 'unregistered company "Not available"' findings.

### Why does the tool warn about revenue streams in Part 5 not found in Part 4?
<!-- scenario: trust-the-data; topic: consistency-rules -->

**Situation:** Part 4 (government revenues) is where each revenue stream is named once, alongside its GFS classification and the agency that collected it. Part 5 rows then attribute company payments to those streams. A stream name in Part 5 with no matching entry in Part 4 means the two sides of the reconciliation are looking at different stream vocabularies.

**Decision:** The tool builds the reference list from the Part 4 government revenues table's revenue-stream column. For each Part 5 row, the revenue stream value is checked against that list; any miss produces a warning the reviewer has to acknowledge, citing the row and the unrecognised stream name. "Not available" and "Not applicable" cells are skipped so they don't surface as missing streams.

**Rationale:** Reconciliation groups payments by revenue stream and sums each side. If Part 5 reports a payment against "Corporate income tax" while Part 4 calls the same stream "Corporate tax", they reconcile as two distinct streams with zero match. The warning lets the reviewer harmonise the names in the source file before reconciliation produces nonsense gaps.

**Technical detail:** `_check_part5_references` reads `revenue_stream_name` from the Part 4 government revenues table (`government_revenues_v1` for v1, `Government_revenues_table` for v2.0/v2.1). Misses emit `MISSING_REVENUE_STREAM` findings against the offending Part 5 row. Sentinel filtering uses `is_real_string` in `packages/crosschecker/src/crosschecker/crosschecker_service.py`.

### Are entity names compared case-sensitively?
<!-- scenario: trust-the-data; topic: consistency-rules -->

**Situation:** The same entity often appears with minor capitalisation differences across parts of the same file — "ABC Mining Ltd" in Part 3, "ABC Mining LTD" in Part 5.

**Decision:** No. Both sides are lower-cased before comparison, and whitespace at the start or end of the cell is trimmed. There is no other matching — no accent stripping, no whitespace collapse inside the name, no fuzzy match. Only case and outer whitespace are ignored.

**Rationale:** Capitalisation differences are noise. Anything beyond case folding (accent normalisation, fuzzy matching) risks merging entities that genuinely differ. Case folding catches the common typo class without introducing false positives.

**Technical detail:** `_check_part5_references` in `packages/crosschecker/src/crosschecker/crosschecker_service.py` builds `ref_lower = {n.lower() for n in ref_set}` and compares against `name.strip().lower()`. Note that case-insensitivity here is the consistency-check rule and is separate from the enricher's entity-resolution normalisation, which also handles Unicode transliteration.

### What happens when a required table is found but empty?
<!-- scenario: trust-the-data; topic: consistency-rules -->

**Situation:** The tool located the government-revenues table or the company-payments table on the right sheet, with the expected header in the expected place, but no data rows follow. This is different from a missing table (where the sheet or the header can't be found at all) — those are reported separately during file reading.

**Decision:** The tool produces a warning the reviewer has to acknowledge, naming which table was found empty and stating that the corresponding side of the reconciliation can't be computed. The check applies the same way to v1, v2.0, and v2.1 — every EITI summary file is expected to have both a government-revenue table and a company-payments table with rows in them.

**Rationale:** A zero-row table sums to zero silently, and reconciliation would then show a 100% gap or a meaningless "0 vs 0 match". Surfacing the empty table as its own warning tells the reviewer the tool ran end to end but found nothing in the table — a different problem to fix in the source file than a parsing failure.

**Technical detail:** `_check_table_completeness` in `packages/crosschecker/src/crosschecker/crosschecker_service.py` emits `GOV_REVENUE_TABLE_EMPTY` / `COMP_PAYMENTS_TABLE_EMPTY`. Table names are read from `TABLE_KEYS` in `packages/shared/src/shared/submission_metadata.py`, keyed by SubmissionID. The check is deliberately silent on missing tables to avoid duplicating upstream parser findings (`SHEET_NOT_FOUND`, `BLOCK_PARSING_ERROR`).

### When does the tool flag a currency-declaration contradiction?
<!-- scenario: reconcile-government-vs-companies; topic: consistency-rules -->

**Situation:** In v2.0 and v2.1, every government-revenues row and every company-payments row carries its own currency code. The About sheet separately declares the file's overall reporting currency. A handful of rows in a different currency is normal — multinational extractive companies routinely pay royalties or signature bonuses in USD even when the country reports in its local currency. But if every row on a side uses the same non-reporting currency, the About declaration contradicts the data and one of the two is wrong.

**Decision:** For each side (government revenues, company payments), the tool aggregates currency usage across all non-sentinel rows and reports two tiers of finding, both informational:

- **Contradiction** — every non-sentinel row on a side uses the same non-reporting currency. The tool emits one finding on the About-sheet `reporting_currency` cell describing the mismatch. The finding is informational (CROSSCHECK), not blocking — per-row currencies are authoritative at import time. The operator can amend the About declaration or accept the row currencies as the source of truth.
- **Dominance signal** — at least 80% (but not 100%) of rows on a side use one non-reporting currency. The tool emits a warning naming the affected table and the dominant currency. Also informational.

Rows whose currency cell is blank or carries a sentinel ("Not applicable", "Not available") are excluded from the percentage calculation — the tier is over rows with real currency data.

**Rationale:** Downstream aggregations sum on the per-row currency, not on the About declaration. A fully-mismatched About is metadata drift the operator should see in review but doesn't change what the database stores. Blocking on the contradiction broke files where the operator's About declaration was stale but the per-row data was correct — the gate forced a source-side edit that didn't actually change any imported value. The earlier per-row mismatch rule produced thousands of warnings across the v2 corpus, dominated by legitimate multinational USD payments on local-currency-reporting files; the aggregate predicate still surfaces the two distinct shapes (every-row vs most-but-not-all) so reviewers can act on them, just without import-time enforcement.

**Technical detail:** `_make_currency_quality_check` and `_evaluate_currency_dominance` in `packages/shared/src/shared/families/sdf.py` produce two finding codes. Both `CURRENCY_DECLARATION_MISMATCH` and `CURRENCY_MOSTLY_NON_REPORTING` land with `category=FindingCategory.CROSSCHECK` and never block. The contradiction finding lands on `(table_name="about", table_row_index=0, field_name="reporting_currency")` as the review anchor; the dominance finding lands on the affected revenue table. Thresholds live on two module-level constants — `_CURRENCY_CONTRADICTION_THRESHOLD = 1.0` and `_CURRENCY_DOMINANCE_THRESHOLD = 0.80`. Production-value currency (Part 3 Projects `currency` and v2.1 `cost_currency`) is intentionally out of scope — only revenue tables are checked.

### Which v2 fields auto-fill 'Not available' as a last-resort fallback?
<!-- scenario: trust-the-data; topic: data-quality-policy -->

**Situation:** After every alias rule, sentinel correction, cross-table cascade, and heuristic transform has run, a subset of v2 cells still arrive empty in the review tab. The tool has two choices: leave them blocking so the operator must edit the source file, or auto-fill 'Not available' so the file can import with the cells marked as undisclosed.

**Decision:** A curated list of v2 fields auto-fills 'Not available' on any blank cell that survives the cleaning pipeline. The list covers production columns (`production_volume`, `production_value`, `unit`, `currency`), project-flag columns (`reported_by_project`, `levied_on_project`, `project_name`), legal/reference columns (`legal_agreement_ref_num`), descriptive type columns (`company_type`, `agency_type`, `sector`), revenue-stream descriptors (`revenue_stream_name`, `government_entity`), and revenue value columns (`revenue_value`) — value cells flow through with `payment_value` / `revenue_value` set to SQL NULL in the clean tables. The list excludes identifying columns (`company_id`, `company_name`, `full_name_of_agency`); on those a blank still blocks import unless the legacy-archive flag is on. The cleaner emits `FILLED_NV_AS_FALLBACK` on every fallback fill so the dashboard and validation reports can render fallback-filled NV distinctly from operator-confirmed NV (which carries `BLANK_TO_NOT_AVAILABLE` on fields whose NV acceptance is the field's primary semantic intent).

**Rationale:** Without the fallback, files with a handful of operator-left-blank cells stay blocked despite the rest of the data being clean. The tool already has six cleaning stages that try to recover real values from upstream signals, cross-table evidence, and within-file modal patterns — once those exhaust, the remaining blank is either operator omission or genuinely unknown. Marking the cell 'Not available' is the honest answer in both cases, and the distinct audit code preserves the difference between operator intent and tool inference. Identifying columns are excluded because filling 'Not available' on `company_id` breaks downstream joins to the company registry. Revenue value columns ARE included because the clean-tier CASE-WHEN translates the sentinel to SQL NULL — aggregations skip NULL naturally so row counts stay honest about what was reported.

**Technical detail:** The (table, field) pairs eligible for the fallback live in `FALLBACK_NV_FIELDS` in `packages/shared/src/shared/diagnostics.py`. Each pair's row-model schema in `packages/parser/src/parser/domain/schemas/v2p0.py` / `v2p1.py` carries `| NotAvailable` in its union; this widening turns what would have been `BLANK_CELL_BLOCKING` or `BLANK_CELL_DEPENDENT` into the non-blocking `BLANK_CELL` code so `MapToNotAvailableRule` (in `packages/cleaner/src/cleaner/rules.py`) can fire on it. The rule consults `FALLBACK_NV_FIELDS` at emit time and uses `CleaningCode.FILLED_NV_AS_FALLBACK` for the audit code instead of the primary-intent `BLANK_TO_NOT_AVAILABLE`. Operator-confirmed NV (cell text "Not available" / "Non communiqué" etc.) is normalised separately by `StandardizeNotAvailableRule` and emits `STANDARDIZED_TO_NOT_AVAILABLE` — three distinct codes for three distinct provenances.

### How does the tool handle files where the operator left identifying fields blank?
<!-- scenario: trust-the-data; topic: data-quality-policy -->

**Situation:** A subset of corpus files leave identifying entity fields blank — operator's `company_name`, `company_id`, `project_name`, or `government_entity`. Under strict validation these surface as `BLANK_CELL_BLOCKING` and the file cannot import. While the historical EITI archive is being backfilled, blocking on these breaks ~21 files even though their financial data is otherwise complete.

**Decision:** A single feature flag, `accept_legacy_archive_imports` (in `shared.settings`), gates a lenient cleaner pathway. When the flag is on (the default during archive backfill), the cleaner's `MintAnonymousEntityRule` proposes a synthetic explicit placeholder for each blank identifying cell — `"Anonymous"` for the name field, paired with a sentinel `eiti_id` of the form `eiti_<type>_00000000-0000-0000-0000-000000000000` (RFC 4122 nil UUID, same shape as regular `eiti_<type>_<uuid4>` cluster ids). The enricher resolves the synthetic name via a pre-seeded manifest alias to the sentinel eiti_id, so import succeeds with a clearly marked anonymous row. When the flag is off (future default), the cleaner does not propose, the cell stays `BLANK_CELL_BLOCKING`, and the file requires source-side correction.

**Rationale:** The cells are genuinely anonymous — the operator did not disclose the entity. The synthetic placeholder is honest about that and keeps the file importable so its financial totals reach analytics. Using a fixed sentinel eiti_id per type means every anonymized row aggregates to one row in `metadata_companies` / `metadata_projects` / `metadata_gov_entities`, which is the right semantics: "all undisclosed payments by anonymous companies in this declaration" is a meaningful number, while inventing per-row distinct IDs would fake traceability that doesn't exist. The flag gating preserves a clean removal path: once the archive is fully imported, flip the default, delete the rule, and reject future submissions that leave identifying fields blank.

**Technical detail:** Flag defined at `packages/shared/src/shared/settings.py:Settings.accept_legacy_archive_imports`. Cleaner rule at `packages/cleaner/src/cleaner/rules.py:MintAnonymousEntityRule`. Sentinel aliases at `packages/enricher/src/enricher/resources/entity-aliases.toml` (entries with `eiti_id = "eiti_company_00000000-0000-0000-0000-000000000000"` etc.). Emission code is `CleaningCode.FILLED_ANONYMOUS_PLACEHOLDER`. All transitional code in this scope carries the `# LEGACY_ARCHIVE_UPLOAD` marker for grep-driven cleanup.

### What happens when a v2 Projects-sheet row has a company name in its project_name cell?
<!-- scenario: trust-the-data; topic: data-quality-policy -->

**Situation:** About 1,100 v2 Projects/Companies15 rows across the historical EITI corpus carry a company name in the project_name cell — the operator typed the company (often with a trailing Companies-House ID like `(00140141)` or a legal-form suffix like `Limited` / `GmbH` / `SARL`) where the project name belonged. The cell is recognisably a company identifier, not a project description.

**Decision:** A parser-side transform (`reroute_company_in_project_name`) detects the company shape via two signals — a trailing UK Companies-House ID pattern, or a trailing legal-form suffix from the shared `LEGAL_FORM_SUFFIXES` list — and moves the value to the `affiliated_companies` cell on the same row. When `affiliated_companies` is blank, the moved value becomes the operator (prepended); when populated, it's appended as a partner. Tokens already present in `affiliated_companies` (NFKC + casefold match) are dropped silently. `project_name` becomes blank; under `accept_legacy_archive_imports`, `MintAnonymousEntityRule` then mints `"Anonymous project"` so the row imports.

**Rationale:** Without the transform, the company-shaped cell either survives as a fake project (polluting the projects dimension) or blocks import. Rerouting preserves the actual operator intent (the company belongs in the affiliations) and lets the existing anonymous-project pathway handle the now-empty project_name. The legal-form suffix list is shared with `enricher.dedup_norm` so a single source of truth governs what counts as "company-shaped" across the parser and the dedup pipeline. An inline exemption set (currently the Mongolian feasibility-study description and "Joint Venture") catches the small set of false positives where a legitimate project description happens to end in a legal-form word.

**Technical detail:** Transform at `packages/parser/src/parser/transforms/company_in_project_name_reroute.py`, registered at index 5 of `_V2_TRANSFORMS` in `packages/parser/src/parser/domain/submissions/registry.py` (immediately after `drop_empty_identity_rows` — droppers run before mutators). Detection patterns: `_CHID_PATTERN` matches `\(\d{6,10}[A-Z]?\)$` (literal parens required); `_SUFFIX_PATTERN` is built from `shared.legal_form_suffixes.LEGAL_FORM_SUFFIXES` (the consumer sorts longest-first at build time so multi-token suffixes match before single words). Emits `Finding(code=ParserCode.COMPANY_NAME_IN_PROJECT_NAME_REROUTED, category=FindingCategory.SCHEMA_DEVIATION)` per row modified, with structured `metadata = {"signal": <chid|suffix:<word>>, "disposition": <prepended|appended|duplicate dropped>, "moved_to_field": "affiliated_companies"}` for downstream consumers that want filterable diagnostic fields without regex-parsing the prose. Classified `NON_VALIDATION` in `tests/unit/test_parser_code_disposition_coverage.py` so the operator sees an informational note but no actionable button. Architectural invariant pinned in `tests/unit/test_project_name_not_in_legacy_fallback_nv.py`: `(Projects, project_name)` and `(Companies15, project_name)` must NOT appear in `FALLBACK_NV_FIELDS` or `LEGACY_FALLBACK_NV_FIELDS`, otherwise `MapToNotAvailableRule` would race against `MintAnonymousEntityRule` and the row would NV-fill instead of minting the anonymous-project placeholder. When `accept_legacy_archive_imports` flips to False (post-archive-import), the cleared `project_name` cell becomes `BLANK_CELL_BLOCKING` and the row blocks pending operator review — flag-removal PRs must revisit the transform's downstream contract.

### What happens to a list-typed cell where every comma-separated token is unrecognised?
<!-- scenario: trust-the-data; topic: data-quality-policy -->

**Situation:** Under the legacy-archive flag the cleaner tries to recover list-typed cells (`commodities` on Companies / Companies15 / Projects). When SOME tokens are recognised and others are noise, the cleaner drops the noise and keeps the canonical tokens. When EVERY token is unrecognised the cell would otherwise drop to an empty list — the row imports with no commodities and the operator can't tell whether the cell was blank, fully bad, or never reported.

**Decision:** When every token in a list-typed cell is unrecognised (no alias hit, no fuzzy match, no enum correction), the cleaner fills the whole cell with 'Not available' and the mapper writes that value to the column. The operator sees a single NV row in the junction table rather than a phantom-empty list, and the audit log distinguishes "fully unrecoverable cell" from "operator left it blank" via the `FILLED_NV_AS_FALLBACK` emission code.

**Rationale:** Producing an empty list and reporting "0 commodities" for a row whose commodities the tool couldn't parse fakes coverage data that doesn't exist. NV is the honest answer ("we have no commodity coverage on this row"). The same code (`FILLED_NV_AS_FALLBACK`) is already used by the per-cell fallback rule above, so the dashboard's "fallback NV vs operator-confirmed NV" split applies uniformly. Restricted to the legacy-archive flag because the rule is part of the archive-backfill tolerance; under strict validation the row would block.

**Technical detail:** `LegacyDropInvalidListTokenRule.apply` in `packages/cleaner/src/cleaner/rules.py` emits the cell-level `FILLED_NV_AS_FALLBACK` finding (with `token_index=None` and `proposed_value="Not available"`) in the all-bad branch. The mapper's list-branch override consumption in `packages/mapper/src/mapper/mapper_service.py` consults the cell-level coordinate key BEFORE per-token reassembly, so the NV fill preempts the bad-token list rather than getting silently swallowed by the per-token loop.

### What happens when the alias manifest declares two different EITI ids for the same operator-typed name?
<!-- scenario: trust-the-data; topic: data-quality-policy -->

**Situation:** The curator-maintained alias manifest (`packages/enricher/src/enricher/resources/entity-aliases.toml`) maps operator-typed names to canonical EITI ids. Two entries that share `(entity_type, normalized alias, country)` but point at different `eiti_id`s would cause the matcher to silently assign rows to whichever entry it hits last — a hard-to-detect data correctness bug.

**Decision:** The manifest loader raises at startup if any `(entity_type, normalized alias, country)` group resolves to two or more distinct `eiti_id`s. Same-`eiti_id` duplicates are benign and pass silently — they reflect a curator re-asserting a name variant from a different source. Divergent-`eiti_id` duplicates require the curator to pick one canonical id or rename one alias before the API will start.

**Rationale:** Silent wrong-entity assignment poisons every downstream aggregate (per-entity payment totals, junction table FK joins, dashboard slice-and-dice). The cost of fixing the data after the fact is much higher than the cost of failing the gate at boot. Restricting the raise to the divergent-id case keeps the rule narrow — same-id dupes pass, so curators can layer alias hints from multiple sources without coordination.

**Technical detail:** `_load_alias_resource` in `packages/enricher/src/enricher/alias_manifest_source.py` tracks `(entity_type, NFKC-normalized casefolded alias, country) → eiti_id` and raises `ValueError` on divergence. The normalization mirrors the matcher's normalize-keyed lookup, so the loader catches the same shape the matcher would silently mis-resolve. mtime-keyed memoization ensures a curator edit re-evaluates the check on the next `AliasManifestSource()` construction without requiring a restart.

**Technical detail:** The blocking-vs-informational distinction is `category=FindingCategory.VALIDATION` vs `category=FindingCategory.CROSSCHECK` on `Finding` emission in `_make_currency_quality_check`. Switching the 100% case from blocking to informational is a one-line change — flip the category on the emission site and rename the code accordingly. The change does not require updating the threshold constants, the dominance helper, or the test fixtures.

### What happens to currency checks if the reporting currency is missing?
<!-- scenario: reconcile-government-vs-companies; topic: consistency-rules -->

**Situation:** The About sheet doesn't declare a reporting currency, but the file is v2.0 or v2.1 so each row in Part 4 and Part 5 still carries its own currency cell.

**Decision:** The tool produces a single warning the reviewer has to acknowledge — "no reporting currency on the About sheet" — and skips the aggregate currency check entirely. No declaration-mismatch or dominance findings are produced.

**Rationale:** Without a reference currency on the About sheet, there is nothing to compare each row against. The single warning tells the reviewer exactly which field needs to be filled in the source file. In practice this rarely fires — the parser typings require a valid `reporting_currency` value on the About row, so a blank cell surfaces as a parser-level validation error before the crosschecker runs. The crosscheck finding is the safety net for any path that bypasses the parser-level check.

**Technical detail:** The single finding code is `NO_REPORTING_CURRENCY`, emitted by `_make_currency_quality_check` in `packages/shared/src/shared/families/sdf.py` against the About table. The aggregate-tier predicate is guarded behind a presence check on the About-sheet currency value.

### Do consistency warnings block import?
<!-- scenario: trust-the-data; topic: consistency-rules -->

**Situation:** The tool has produced consistency warnings — unregistered Part 5 entities, mismatched revenue streams, currency dominance signals, empty tables, or totals discrepancies.

**Decision:** As a rule, no. Consistency warnings set the file's status to NEEDS_REVIEW but never to BLOCKED. Only structural problems in the source file (a missing required cell, a wrongly-typed value) block import. The reviewer acknowledges each consistency warning in the review screen and can then proceed to Confirm Import. The single exception is the currency-declaration contradiction — when every row on a revenue side uses one non-reporting currency, the About declaration is treated as a wrongly-typed value and blocks (see "When does the tool flag a currency-declaration contradiction?").

**Rationale:** Consistency warnings often have legitimate explanations — an entity registered under a slightly different spelling, a deliberate currency mix in a country's reconciliation, a known data quirk the country team wants to import anyway. Forcing the country team to re-export the source file for every unregistered-name warning would block routine work for cases that don't actually require correction. Leaving the gate to a human reviewer matches the warning's actual meaning: "worth a look", not "definitely wrong". The currency-contradiction exception is the case where the declared reporting currency does not appear in the data at all — silently importing rows under a fictitious declaration would commit a wrong number into the database.

**Technical detail:** Most crosschecker findings carry `FindingCategory.CROSSCHECK` and raise session status to `NEEDS_REVIEW`. `FindingCategory.VALIDATION` errors raise it to `BLOCKED` — that's where parser-emitted per-cell validation findings land, plus the crosschecker's `CURRENCY_DECLARATION_MISMATCH` finding. Status arbitration happens in the session-status logic in the API layer; gating is enforced by `correction_gate.validate_corrections_cover_fixable` in `packages/shared/src/shared/correction_gate.py`.

### What does the tool do with 'Total' rows already in the file?
<!-- scenario: trust-the-data; topic: consistency-rules -->

**Situation:** EITI templates include pre-computed total rows alongside the data tables. In v2.0 and v2.1 these appear as labels like "Total in USD" / "Total in EUR" sitting below the government revenues and company payments tables; in v1 the government revenues sheet carries "TOTAL, disclosed by government" and "TOTAL, reconciled" single-row aggregates.

**Decision:** The tool extracts each in-file total as its own value, then independently sums the matching data rows from the same table (grouped by currency for v2.0/v2.1, a single overall sum for v1) and compares the two. If the difference is more than 1.0 unit of the currency, the tool produces a warning the reviewer has to acknowledge, naming the table and the gap. Differences of 1.0 or less are accepted silently.

**Rationale:** Excel's SUMIF rounding drifts by sub-cent amounts between the pre-computed cell and a fresh sum over the same rows. A strict equality check would flag every file. The 1.0-unit tolerance absorbs that rounding noise while still catching genuine inconsistencies — a stale total left behind after a row was edited, or a SUMIF whose range no longer covers the full table.

**Technical detail:** `TotalsSpec` in `packages/crosschecker/src/crosschecker/crosschecker_service.py` (tolerance defaults to 1.0); per-version configs in `packages/pipeline/src/pipeline/profiles/summary_v1.py`, `summary_v2p0.py`, `summary_v2p1.py`. Extraction schemas: `GOV_TOTALS_SCHEMA_V1` (HeaderSearch) in `packages/parser/src/parser/domain/schemas/v1.py`; `GOV_TOTALS_SCHEMA_V2P0` / `COMP_TOTALS_SCHEMA_V2P0` (KvpScan, pattern `^total in (.+)`) in `v2p0.py`; same shape in `v2p1.py`. Findings emit as `GOV_TOTAL_MISMATCH` / `COMP_TOTAL_MISMATCH`.

---

### What happens to spreadsheet rollup-row labels that appear in the entity-name column?

<!-- scenario: submit-a-report; topic: entity-resolution -->

**Situation:** EITI report templates leave the entity-name column open for free text. Some operators populate it with rollup-row labels — `"Companies with aggregate information (US$)"`, `"Other companies"`, `"Aggregate Companies in New Soles (iii)"`, `"Various ministries"`, `"Various (see footnote)"`, or a bare `"TOTAL"` — rather than a specific company name. The row's financial figures are the sum of multiple payers the operator chose not to itemise; the label describes the rollup, not a legal entity.

**Decision:** The entity-name normalisation layer detects these labels and returns the empty string, the same signal it uses for placeholders and sentinels. Callers (the inventory builder, the dedup pipeline, the runtime alias lookup) treat empty output as "skip this row" — the row never gets an entity ID, never participates in dedup clustering, never surfaces in the enricher manifest. The row's financial figures still import; only the entity column is empty, which the cleaner handles via its standard blank-cell pathway.

**Rationale:** Treating a rollup-row label as a company name caused two failure modes downstream: the dedup pipeline merged rollup labels across reports (the same phrasing reappeared each year), producing a synthetic "Companies with aggregate information (US$)" cluster; and the enricher minted an eiti_id for that synthetic cluster, which then surfaced in dashboards as if it were a real company. Filtering at normalisation is the earliest seam where the rollup-row shape is still recognisable — once the name moves into clustering, the original cell context is lost.

The pattern set is deliberately conservative — only phrases that real corporate names don't use as their leading tokens. `"TotalEnergies"`, `"Sub-Total Resources Ltd"`, `"Other Companies Holdings"`, `"Aggregate Industries UK"`, `"Small Producers Cooperative"`, and any `"X Aggregates"` quarry name pass through unchanged because each pattern either anchors at end-of-string (with optional parenthesised note) or requires a specific rollup-context continuation word. `"Various"` is recognised only when followed by a fixed list of rollup continuations (ministries, companies, states, agencies, entities, payers, reporting, departments), end-of-string, or punctuation; a hypothetical `"Various Foods Ltd"` passes through.

**Technical detail:** `is_aggregate_label()` and `_AGGREGATE_LABEL_PATTERNS` in `packages/enricher/src/enricher/dedup_norm.py`. Wired into `normalize_entity_name` step 2 alongside `is_placeholder()` and `is_sentinel()`. Negative-triangulation tests against real corporate names live in `tests/unit/test_dedup_norm.py::TestIsAggregateLabel`. Distinct from the in-file numeric-total crosscheck above: that compares values across rows within one file; this filters cell contents at name lookup.

---

### What does the tool do with a Headquarters cell that carries both city and country?

<!-- scenario: trust-the-data; topic: consistency-rules -->

**Situation:** The Company Assessment template's `Headquarters` column is a free-text cell operators populate as `"<city>, <country>"` (e.g. `"London, UK"`, `"Pittsburgh, Pennsylvania, USA"`, `"Lagos (Nigeria)"`). Two pieces of information live in one cell.

**Decision:** Both the city and the country survive end-to-end. The parser splits the cell into a structured `HeadquartersLocation` carrying `city` and `country`. The dashboard reads both sub-slots — the country drives region grouping; the city renders alongside for display. The canonical company row stores them in two columns (`hq_country_iso3`, `hq_city`).

The crosscheck between Company reference and Assessment data fires on the COUNTRY sub-slot only: two rows declaring the same company at `"London, UK"` and `"Bristol, UK"` are NOT a mismatch (same country); two rows at `"London, UK"` and `"London, USA"` are.

When the country sub-slot cannot resolve (e.g. `"Denver, CO USA"`, `"Bogor, Atlantis"`), the tool flags `INVALID_HEADQUARTERS_COUNTRY` and the cleaner re-walks the cell more aggressively against the country-alias table. When a unique country resolves (`"USA"` inside `"CO USA"`), the cleaner proposes the resolved ISO-3 against the country sub-slot only — the city stays whatever the operator typed. When nothing resolves (prose like `"Irving, Texas (headquarters moving to Houston in June 2023)"`), the operator picks from the country dropdown in the review tab.

**Rationale:** The pre-compound shape collapsed the cell to a single ISO-3 token and discarded the city. Three downstream effects: the dashboard's per-region heatmap had nothing to render city-level context; row-level Pydantic failures (e.g. `type = "Public"` not in `CompanyType`) dropped the resolved country back to the raw composite string and the heatmap silently fell back to grey; the crosschecker compared on the raw cell text and false-positived city-only divergences. Preserving both sub-slots fixes all three.

**Technical detail:** `HeadquartersLocation` + `parse_headquarters_location` in `packages/parser/src/parser/domain/schemas/validation_helpers.py`. Row-failure preservation via the BeforeValidator augmentation block in `packages/parser/src/parser/validation/row_validator.py`. Sub-slot dispatch via `CohortField.sub_slot` in `packages/shared/src/shared/families/_cohort_field.py`. Cleaner rule: `HeadquartersCountryResolutionRule` in `packages/cleaner/src/cleaner/rules.py`. Architecture rationale: ADR-026.

---

## 7. Import Behavior

### What happens if the user re-imports a declaration?
<!-- scenario: submit-a-report; topic: import-behavior -->

**Situation:** A user confirms an import for a country and reporting year that already has data in the EITI database. Either the prior import was deleted, or the user explicitly chose to re-import after being warned about the collision.

**Decision:** The previous version of that declaration is removed from the EITI database before the new version is written. Country, currency, company, agency, and project records that already existed are kept — only the revenue figures and the file-summary record are replaced.

**Rationale:** Re-import is a replacement, not an addition. Writing the new figures on top of the old ones would double every total in the dashboard. Wiping the prior figures first means importing the same file twice produces the same totals as importing it once — the second import has no extra effect.

**Technical detail:** Implemented in `packages/importer/src/importer/import_service.py` step 6 (ledger `DELETE FROM <ledger_table> WHERE eiti_id_declaration = :uuid` against every registered ledger table) and step 8 (`_generate_clean_tables`, which deletes per-declaration clean rows then re-runs every `CleanQuerySpec` on the submission's `clean_query_specs` tuple). The per-declaration DELETE makes the clean projection re-import-idempotent even when the underlying INSERT topology is INSERT OR IGNORE against an auto-increment PK.

### What happens to reference data from multiple files of the same country?
<!-- scenario: cross-cutting; topic: import-behavior -->

**Situation:** Two declarations from the same country are imported. Both files mention the same currency, the same GFS codes, and some of the same controlled-vocabulary rows.

**Decision:** Shared reference values (country, currency, GFS code) and shared name-dedup vocabularies (sector, commodity) are written once. The second file's copies are silently skipped rather than duplicated. The file-summary record is the one exception: when the same declaration is re-imported, its file-summary record is overwritten rather than skipped.

**Rationale:** Each file carries its own copy of the reference rows it needs — there's no separate "load the reference data once" step. Allowing each file to act self-contained while still converging on a single entry per real-world reference value keeps the dashboard's lists clean.

**Technical detail:** Reference and name-dedup writes use `INSERT OR IGNORE`. Reference tables (`metadata_countries`, `metadata_currencies`, `metadata_gfs_codes`, `metadata_submission_types`) dedupe on their natural-key primary key; name-dedup tables (`metadata_sectors`, `metadata_commodities`) dedupe on their unique business keys. The `metadata_summary_data_files` row is the only metadata write that uses upsert (`ON CONFLICT DO UPDATE` on `eiti_id_declaration`) because a re-import legitimately replaces that record. Canonical entity tables (`metadata_companies`, `metadata_gov_entities`, `metadata_projects`) take a different path — see the next decision — because multiple sources legitimately contribute attributes to the same canonical entity row.

### What happens to a company across multiple submissions and over time?
<!-- scenario: cross-cutting; topic: import-behavior -->

**Situation:** "AcmeCorp" appears on Norway's 2022 SDF (declaring `hq_country_iso3=NOR`), on UK's 2023 SDF (declaring no HQ), and on a Company Assessment file from 2024 (declaring `headquarters=GBR`, `legal_entity_id=ABC123`, `sectors=["Mining"]`).

**Decision:** One canonical `metadata_companies` row is maintained per company business key (`eiti_id_company`). Each submission's contribution updates the row using SCD2 close+open semantics: identical re-writes are no-ops; material differences close the previous row and open a new one with the merged attributes (incoming non-null values win; existing values for columns the incoming row leaves null are preserved). Historical state is therefore queryable — operators can ask "what did we know about AcmeCorp in 2023?".

**Rationale:** Canonical entities exist independently of any single file (a company is a real-world thing, not a per-file disclosure). Multiple submissions legitimately contribute different attributes to the same entity over time. SCD2 lets all contributions co-exist without overwriting or fragmenting the entity; it also survives file deletion — deleting one submission removes that submission's ledger rows but the canonical entity row stays so other submissions referencing it continue to resolve. Per-import disclosure tables (subsidiary relationships, validation events) use a different mechanism — see the Subsidiaries decision below.

**Technical detail:** Implemented in `packages/importer/src/importer/import_service.py::_apply_scd2_writes` — the SCD2 close+open helper called from `_write_metadata_rows` for every table in `_ENTITY_TABLES`. Business keys are declared in `_ENTITY_BUSINESS_KEYS`. The `tests/unit/test_metadata_companies_scd2_invariant.py` invariants pin: no double-current; merge preserves existing where incoming is null; idempotent re-write is no-op; close+open under material diff; deterministic timestamps under frozen clock. ADR-025 codifies which metadata tables qualify for SCD2 (canonical entities) vs which use the per-import composite UNIQUE mechanism (disclosure rows).

For SCD2 to actually merge a submission's contribution, the mapper must emit a `MappingCode.CELL_MAPPED` finding targeting the entity's `id_field` (e.g. `metadata_companies.eiti_id_company`). The emission is universal: `MapperService.emit_entity_metadata_findings` in `packages/mapper/src/mapper/mapper_service.py` hardcodes the `EntityCreation.metadata_target.id_field` write so every family participates uniformly — no per-family closure branching. The architectural test `tests/unit/test_every_minted_entity_id_lands_in_metadata_row.py` discovers every family in `FAMILY_REGISTRIES` with an entity-creating CohortField and asserts the emission contract — a future family that mints UUIDs but skips this step fails CI rather than silently importing every company with `eiti_id_company=''` (the empty-business-key SCD2 collision shape).

### What is kept when a declaration is deleted?
<!-- scenario: audit-who-did-what; topic: import-behavior -->

**Situation:** A user deletes a declaration from the data management tab.

**Decision:** The declaration's revenue figures are removed from the EITI database, so the dashboard no longer shows that declaration's data. A record is kept in an audit log of who deleted what and when — the deleter's name, email, role, channel, and a tally of how many rows were removed. The original file-summary record is also kept, marked as deleted, so the same file can be re-uploaded later without being mistakenly blocked as a duplicate.

**Rationale:** The data itself goes — the deleter explicitly asked for that. The audit trail stays so a future operator can answer "who deleted the Afghanistan 2014 declaration, when, and why" without consulting external logs. Keeping the file-summary record marked as deleted also lets the duplicate-upload check correctly allow a re-upload of the same file after deletion.

**Technical detail:** Implemented in `TargetDbManager._do_delete` at `packages/shared/src/shared/session/target_db_manager.py`. Clean-table and ledger rows for the `eiti_id_declaration` are hard-deleted in FK order (clean tables first, then ledger tables). The `metadata_summary_data_files` row is soft-deleted (`is_deleted = 1`) rather than removed, and a `metadata_import_events` row with `event_type = submission_deletion` is written carrying the responsible user's name, email, role, channel, and a `log_summary` of how many rows were deleted from each table. The `metadata_users` row for the deleter is inserted alongside it. The hash lookup that enforces upload dedup filters with `NOT EXISTS (SELECT 1 FROM metadata_summary_data_files WHERE import_event_id = ie.id AND is_deleted = 1)` so soft-deleted prior imports do not block a fresh upload.

### What happens to a Validation Data Query upload's rows when the operator deletes it?
<!-- scenario: submit-a-report; topic: import-behavior -->

**Situation:** An operator uploads a Validation Data Query export and later deletes that upload from the data management tab.

**Decision:** Deleting an upload removes the validation rows that upload contributed. If a country-year (e.g. Liberia 2017) was uploaded by another file that is still active, that other upload's rows are preserved. If the deleted upload was the only source for a country-year, the validation rows for that country-year are removed from the database; re-uploading the same file restores them.

**Rationale:** Each upload owns the rows it created — the delete cascade keys on `validation_file_id` rather than the cross-import validation key. This keeps deletion semantics symmetric with other families (SDF, Company Assessment): an operator deleting their upload removes their data; another operator's concurrent upload of the same cohort is untouched.

**Technical detail:** The durable rows live in `metadata_validations`, `metadata_validation_scores`, and `metadata_validation_links`. Each row carries a `validation_file_id` foreign key to `metadata_validation_files`. The delete cascade walks `family.cascade_metadata_models` and runs `DELETE WHERE validation_file_id = :uuid` for the deleted upload only. Rows whose `validation_file_id` points at any other active upload are unaffected. `metadata_validation_requirements` is hand-curated and pre-seeded at `init_target_db`; it is never written to during an import and is unaffected by deletion.

### What happens to a Company Assessment upload's subsidiary disclosures when the operator deletes it?
<!-- scenario: submit-a-report; topic: import-behavior -->

**Situation:** An operator uploads a Company Assessment file containing Subsidiaries sheets that disclose parent → subsidiary relationships across years. The operator later deletes the upload.

**Decision:** Each upload owns the subsidiary relationship rows it created. Deleting an upload removes those rows. Re-importing a different file's same-year cohort starts fresh (cohort dedup blocks same-year re-imports until the prior is deleted). If two distinct Company Assessment files legitimately disclose the same subsidiary in the same year (one country's file and another country's file both list AcmeCorp → AcmeSub for 2023), both upload's rows co-exist — the natural key is `(assessment_file_id, parent_company_name, child_company_name, assessment_year)` so distinct uploads produce distinct rows.

**Rationale:** Subsidiary disclosures are per-import events, not canonical entities — they describe what one file said at one point in time. Symmetric with the Validation Data Query family's per-import deletion: the operator who deleted their file removes their data; another operator's concurrent upload is untouched. A composite UNIQUE on the natural per-import key rejects accidental within-file duplicate disclosure rows; the importer surfaces those as `DUPLICATE_RELATIONSHIP_ROW_IN_FILE` findings without crashing the import.

**Technical detail:** `metadata_company_relationships` is registered in COMPANY_ASSESSMENT's `cascade_metadata_models`. The delete cascade walks `family.cascade_metadata_models` and runs `DELETE WHERE assessment_file_id = :uuid` for the deleted upload only. The composite UNIQUE index is declared via `MetadataCompanyRelationships.__unique_indexes__` over `(assessment_file_id, parent_company_name, child_company_name, assessment_year)`. ADR-025 codifies why this table is per-import rather than SCD2 (the row identity is the disclosure event, not the canonical relationship).

### A Validation Data Query export surfaces 100+ country-year cohorts in a single file
<!-- scenario: submit-a-report; topic: import-behavior -->

**Situation:** An operator uploads a Validation Data Query export to the EITI Data Importer. The file represents many country-year EITI Board validation decisions in one workbook.

**Decision:** The cohort grain is per `(country, decision_year)` — every EITI Board decision in the file gets its own selectable cohort row. A typical export surfaces 100+ cohorts spanning roughly 50 countries. When the picker shows 10 or more cohorts and at least one cohort carries a recognisable country code, cohorts are grouped under per-country headers with an expand/collapse toggle; selecting a country header selects every year for that country. Cohorts without a recognisable country code fall into a sentinel `"Other"` group rendered last.

**Rationale:** Each country-year decision is independent and can be re-uploaded or deleted on its own — coarser grain (per-country, per-file) would make it impossible to update a single year without re-publishing the whole export. The grouping UX matches the operator's mental model ("import all of Liberia") while preserving per-year granularity for the cases where a single year is being corrected.

### What does the user have to do to delete a declaration?
<!-- scenario: audit-who-did-what; topic: import-behavior -->

**Situation:** The user clicks "Delete" on a declaration in the data management tab.

**Decision:** Two-step confirmation. First the user fills in their identity (full name, email, role, channel) and clicks "Delete permanently". Then the browser asks a second time with a native confirmation dialog. Without both — a filled-in identity and an accepted browser dialog — nothing happens.

**Rationale:** Deletion permanently removes a declaration's data from the EITI database. Requiring a deliberate identity entry plus a browser confirmation keeps a misclick from wiping a declaration, and the identity captured at the first step is what the audit log records.

**Technical detail:** Endpoint `delete_import` in `apps/api/src/api/imports_endpoints.py` requires a `DeleteRequest` body (`full_name`, `email`, `role`, `channel`). The browser-side flow issues a `confirm()` dialog before firing the `DELETE /imports/{record_id}` request. The endpoint constructs an `AuditStamp` and calls `TargetDbManager.delete`.

### Why might an import fail at the last step?
<!-- scenario: submit-a-report; topic: import-behavior -->

**Situation:** Every earlier step succeeded, the user confirmed, and the importer is running — but it can't determine which country and year the file belongs to.

**Decision:** If the country and year of the file can't be determined, the import fails and nothing is written to the EITI database. The session ends in an error state and the user sees a clear "couldn't identify this declaration" message. A separate kind of failure — a real database write problem partway through — is reported with the underlying database error text so an operator can investigate.

**Rationale:** Every imported row needs a country-and-year identifier to attach itself to. Without one, there is literally no record the tool could write. Failing loudly at this last step, before any data is written, is better than writing a partial declaration that an operator would have to clean up later.

**Technical detail:** The importer reads the declaration UUID from the `CELL_MAPPED` finding on the synthetic `about` table (`table_name == "about"`, `field_name == "declaration_uuid"`). If that finding is missing, it returns a single `MAPPING` finding with code `MISSING_DECLARATION_UUID` and writes nothing; the session lands in `ERROR_DATA`. A genuine database write failure further down (constraint violation, connection drop) is caught separately and produces a `DB_WRITE_FAILURE` finding with the underlying exception text. Logic in `ImporterService.run` and `_get_metadata_value` in `packages/importer/src/importer/import_service.py`. The UUID is a `uuid5(DECLARATION_NAMESPACE, f"{country_iso3}:{year}")` produced by the detector and surfaced as a `CELL_MAPPED` finding by the mapper.

### What kinds of duplicate uploads does the tool catch?
<!-- scenario: avoid-duplicate-imports; topic: import-behavior -->

**Situation:** A user uploads a file that may already exist in the system — either as a successful prior import, as an in-flight upload someone else is still working on, or as a different file claiming to be the same declaration.

**Decision:** Three checks, each catching a different kind of duplicate:

- **At upload.** The tool recognises a freshly-uploaded file whose exact bytes match an earlier successful import and blocks it, showing when that earlier import happened and which declaration it produced.
- **At identification.** Once the tool has read the file and identified which declaration(s) it carries, it checks whether those declarations are already in the EITI database. If every declaration in the file is already there, the upload is blocked. If only some are already there, the user is asked to choose which to keep.
- **At confirmation.** Just before the user finalises the import, the tool checks one more time — both for a prior successful import that may have just landed, and for another in-flight session somewhere else in the system that's working on the same file. Either match blocks the confirmation.

**Rationale:** Each check covers a different gap. The upload check is the cheapest and catches the common case before any parsing work. The identification check handles the semantic case — the file was edited but still represents the same declaration. The confirmation check is rare on a single-user team but closes a timing window the other two cannot.

**Technical detail:** Layers 1 and 3 use SHA-256 over the upload bytes, indexed on `metadata_import_events.file_sha256`. Layer 1: `POST /uploads` calls `TargetDbManager.find_active_import_by_hash` for each file in the request and rejects the whole upload with 409 if any matches — the response carries one `duplicates[]` entry per offending file. The match condition: a `file_import` event with `status = success` whose linked `metadata_summary_data_files` row is not soft-deleted. Layer 2: `DetectorService` runs the submission's `cohort_schema.extractor` over the workbook, emits one `COHORT_DETECTED` finding per cohort, then calls `TargetDbManager.exists` on each cohort's `existence_key`; cohorts are tagged `COHORT_DUPE` or `COHORT_NEW`; all-DUPE adds a terminal `DUPLICATE_SUBMISSION` finding and pushes the session to `ERROR_DATA`, any other mix routes to the `SELECTION_CONFIRMING` interrupt. Layer 3: `POST /sessions/confirm` re-runs `find_active_import_by_hash` per session in the request body and also calls `EventManager.find_active_sessions_by_hash` to detect in-flight peer sessions whose latest state is not in `DEDUP_INACTIVE_STATES`; conflicts are returned as a `conflicts[]` list (one entry per session per `kind`).

### Can the user re-upload the same file after deleting the prior import?
<!-- scenario: avoid-duplicate-imports; topic: import-behavior -->

**Situation:** A user deleted a declaration and re-uploads the exact same file.

**Decision:** Yes. The duplicate-upload check ignores files whose prior import has since been deleted. The user is not asked to alter the file — the same bytes go through.

**Rationale:** Deletion is the user's "let me try again" signal. Permanently blocking the same file would force the user to mutate the file just to satisfy the duplicate check, defeating the recovery path that the delete button exists for.

**Technical detail:** The hash lookup that backs Layers 1 and 3 ignores soft-deleted prior imports. `find_active_import_by_hash` joins `metadata_import_events` to `metadata_summary_data_files` and applies `NOT EXISTS (SELECT 1 FROM metadata_summary_data_files sdf_check WHERE sdf_check.import_event_id = ie.id AND sdf_check.is_deleted = 1)`. Since deletion flips `is_deleted` to 1 on the SDF row, the prior event is excluded and the new upload proceeds. Query in `TargetDbManager.find_active_import_by_hash` at `packages/shared/src/shared/session/target_db_manager.py`.

### Can the user retry the same file after an import failure?
<!-- scenario: avoid-duplicate-imports; topic: import-behavior -->

**Situation:** A user's earlier attempt to import the same file failed partway through — the import crashed or the final write failed.

**Decision:** Yes. The duplicate-upload check only blocks files whose previous import actually succeeded. After a failure, the same file can be re-uploaded without any modification.

**Rationale:** Retrying after a failure is a legitimate next step. Blocking it would force the user to alter the file just to get past the check — friction with no integrity benefit.

**Technical detail:** Layer 1 and Layer 3 only consider prior `metadata_import_events` rows with `status = success`. A failed attempt either never reached the importer (no event row written) or wrote an event with a non-success status; in both cases the hash lookup returns `None`. The `find_active_import_by_hash` query filters with `ie.status = :status` where `:status` is `ImportStatus.SUCCESS.value`. Defined in `packages/shared/src/shared/session/target_db_manager.py`.

### When is duplicate detection by file hash skipped?
<!-- scenario: operate-at-scale; topic: import-behavior -->

**Situation:** A developer is iterating on a test file on their laptop, repeatedly re-uploading the same file.

**Decision:** On a developer's local installation, every layer of duplicate-import protection is turned off so the same test file can be uploaded again and again without first wiping the database. On the dev, test, staging, and production servers the protection is always on at every layer, and there is no way for a caller to ask the server to skip it.

**Rationale:** On a developer's machine, the duplicate check is pure friction — every test upload would otherwise need a database reset, with no integrity benefit at a single-developer workstation. Servers enforce the check uniformly so no caller can quietly disable it. A single per-environment switch keeps the policy coherent: there is one knob, not several that could drift out of sync.

**Technical detail:** Gated by `Settings.dedup_imports` (`bool | None = None`, profile-driven). The LOCAL profile sets it to `False`; the DEV, TEST, STAGING, and PROD profiles set it to `True`. The flag controls two layers from one source:

- *Upload time.* `endpoints.upload` and `endpoints.confirm_sessions` guard their SHA-256-against-prior-imports body with `if settings.dedup_imports:` — when False, both branches no-op.
- *Identification time.* `DetectorService` accepts `dedup_imports` via its constructor (threaded through `PipelineFactory` from `settings.dedup_imports`). When False, the cohort classification block is skipped: COHORT_DETECTED findings still emit but NEW/DUPE classification and the terminal `DUPLICATE_SUBMISSION` finding do not. A re-upload of an already-imported declaration therefore advances past IDENTIFIED instead of dying with a terminal error.

There is no per-request bypass. Field defined in `packages/shared/src/shared/settings.py`. Consumed at the four `PipelineFactory(...)` call sites in `apps/api/src/api/session_endpoints.py`, the one in `packages/pipeline/src/pipeline/recovery.py`, and the two upload/confirmation gates in `session_endpoints.py`.

### What happens when a colleague's stuck session blocks the user from confirming a file?
<!-- scenario: avoid-duplicate-imports; topic: import-behavior -->

**Situation:** A user is ready to confirm a file, but somewhere else in the system a colleague has the same file in an open session they walked away from. Without intervention, the user would be blocked from confirming until the colleague's session times out on its own.

**Decision:** The tool tells the user what's holding things up and offers a way to cancel the colleague's stuck session (and any associated batch) so the user can retry their own confirmation immediately. The dashboard surfaces this as a "Cancel that session and retry" modal; the command-line tool surfaces it as the same prompt.

**Rationale:** Without an explicit way out, the only option would be to wait for the abandoned session to time out — operationally unacceptable when legitimate work is held up. An automatic release based on idle detection would need infrastructure the tool doesn't have yet, so the discoverable manual release is the interim answer.

**Technical detail:** At `POST /sessions/confirm`, after the per-session committed-import check, the endpoint calls `EventManager.find_active_sessions_by_hash` to find every other session whose `UPLOADED` event carries the same SHA-256 and whose latest state is not in `DEDUP_INACTIVE_STATES` (terminal + IMPORTED + EXPIRED + SUBMISSION_DELETED + STALE). If any are found, the 409 body's `conflicts[]` entry for that session has `kind: "inflight_sibling"` and carries `sibling_session_ids`, `sibling_batch_ids`, and a `release_actions` list — one entry per sibling session, plus one per sibling batch. Every entry points at `POST /sessions/kill` with a ready-to-submit `body` (either `{session_ids: [<sid>]}` or `{session_ids: [<every member of the batch>]}`). The caller picks an entry and POSTs the carried body as-is. Sibling lookup in `EventManager.find_active_sessions_by_hash` at `packages/shared/src/shared/session/event_manager.py`. Response shape assembled in `confirm_sessions` at `apps/api/src/api/session_endpoints.py`. The kill endpoint writes a `CANCELLED` event and deletes the cached `PipelineContext` for every listed non-terminal session, which releases the hash slot immediately. The CLI surfaces the choice via a `questionary` prompt.

### Where does the website read from — the clean tables, the metadata tables, or something else?
<!-- scenario: cross-cutting; topic: import-behavior -->

**Situation:** The EITI website needs to show payment lists, country-by-sector breakdowns, SOE lists, and assessment results. Each of these is a join across several lower-level tables. If every page wrote its own SQL, the same joins would be reimplemented many times, and a column rename in a lower table would silently break some pages without breaking others.

**Decision:** The website (and any other consumer — CLI reports, dashboards, embedded views) reads only from `view_*` tables. It never queries `clean_*`, `metadata_*`, or `ledger_*` directly. The view definitions in `view_queries.py` are the *only* place that knows how to join the lower tiers into a consumer-shaped result.

**Rationale:** Two reasons. First, when a column moves between lower-tier tables — for example, `is_supporting_company` moved from `metadata_companies` to `clean_company_annual_details` because we realised the flag varies year-to-year — only the view's SELECT changes. Every consumer keeps working. Second, the joins themselves are non-trivial (USD conversion math, sector fan-out, GROUP_CONCAT'd sectors) and live in one place. A bug fix in the view propagates to every consumer at once.

**Technical detail:** Views are declared in `schema/eiti_db_v1_6.dbml` and materialised in `packages/shared/src/shared/view_queries.py`. The `create_views()` function runs at startup (`init_target_db`) and uses DROP-then-CREATE so the SQL always matches what's in code. A view the DBML declares but no consumer reads remains unbuilt; the list lives in `PLANNED_UNBUILT_VIEWS` in `tests/unit/test_view_queries.py` with a one-line rationale per entry. To add a consumer that needs a planned-unbuilt view, materialise it in `view_queries.py` and remove the entry from the planned list. See `docs/concepts/schema.md` for the design model behind the four-tier split.

---

## 8. Version Differences

### Does v1 use Excel's named tables?
<!-- scenario: compare-across-versions; topic: version-differences -->

**Situation:** Excel files can declare formal named tables with explicit row and column boundaries. v2.0 and v2.1 templates use this feature for their Part 3, 4, and 5 tables (Companies, Government_agencies, Government_revenues_table, Gov_revs_comp_proj, and so on). The v1 template (Version 1.1, March 2015) was authored before that convention was adopted, so its tables are just ranges of cells without formal boundaries.

**Decision:** The tool reads every v1 table by scanning for a landmark cell value — "GFS codes" in column B, "Legal name" in column H, "Conversion rate" on the About sheet — and walking outward from there. No v1 table is read through Excel's named-table feature, because the metadata to do so isn't in the file. For v2.0 and v2.1 the tool tries the named-table metadata first and only falls back to landmark scanning if it's missing.

**Rationale:** v1 files don't carry the named-table metadata regardless of country or year, so landmark scanning is the only path that will find anything. Building it that way also keeps v1 reading tolerant of the minor layout drift seen in real files (Gabon and CAR files truncate the "GFS Descriptions" header, for example) without coupling v1 to a feature its template never used.

**Technical detail:** v1 schemas live in `packages/parser/src/parser/domain/schemas/v1.py` and use `HeaderSearchSchema`, `KeyValuePairsSchema`, `PivotHeaderSchema`, or `PivotTableSchema` — never `NamedTableSchema` / `NamedTableColumnsSchema`. Locator dispatch in `packages/parser/src/parser/extraction/excel_reader.py` maps `NAMED_TABLE` → `NamedTableLocator` (v2.x) and `HEADER_SEARCH` → `HeaderSearchLocator` (v1).

### Does v1 collect data on projects and agencies?
<!-- scenario: compare-across-versions; topic: version-differences -->

**Situation:** v2.0 and v2.1 templates have a dedicated Government_agencies table on Part 3 and a separate projects table (Companies15 in v2.0, Projects in v2.1). v1's revenue sheet is a single tab ("3. Revenues") with companies sitting as column headers; there is no agency table, no project table, and no notion of a project entity anywhere in the template.

**Decision:** For v1 files the tool only registers companies as Part 3 entities. Agency names are read from the column on the revenue sheet that records which agency collected each row, not from a separate Part 3 list. Projects are skipped entirely — there is no project list to read, no project-related warning to produce, and no project rows in the cleaned dataset.

**Rationale:** The data simply doesn't exist in a v1 file. Wiring agency or project checks for v1 would produce a constant stream of "Part 3 agencies table not found" warnings on every v1 file, drowning the real signal.

**Technical detail:** v1 profile config in `packages/pipeline/src/pipeline/profiles/summary_v1.py` (notably `enrichment_sources["projects"] = None`, `project_table=None`, and the absence of `part3_agencies`/`part3_projects` keys in `crosscheck_entities`). `TABLE_KEYS["summary_v1"]["projects"]` is `null` in `packages/shared/src/shared/stats_config.json`. The Part 5 reference scan only checks the `company` and `stream` roles for v1.

### Does v1 declare currency per row?
<!-- scenario: compare-across-versions; topic: version-differences -->

**Situation:** In v2.0 and v2.1, each Part 4 and Part 5 row carries its own currency code, so a single file can mix payments reported in different currencies. v1 has no such column on either side — the only currency declaration anywhere in a v1 file is the About sheet's "ISO currency code".

**Decision:** For v1, the tool treats the About-sheet currency as the currency of every row. The per-row currency-mismatch check doesn't run at all on v1 files, so no per-row currency warnings are ever produced. The totals check for v1 compares one overall sum (not one sum per currency, as it does for v2.0 and v2.1).

**Rationale:** v1 files genuinely have only one currency per declaration. A per-row check would have nothing to compare against; running it would either produce noise or invent currencies that aren't in the file. Treating the About-sheet currency as the single source of truth matches how v1 reports actually compute their totals.

**Technical detail:** In `packages/shared/src/shared/stats_config.json`, `currency_field.summary_v1` is `{"gov": null, "comp": null}` for both sides. The currency-quality closure built by `_make_currency_quality_check` in `packages/shared/src/shared/families/sdf.py` short-circuits via its `has_row_currencies` guard when both fields are null. The v1 totals spec omits `group_by`, producing a scalar comparison.

### How is the v1 revenue sheet shaped compared to v2?
<!-- scenario: compare-across-versions; topic: version-differences -->

**Situation:** v2.x records company payments as one row per (company, revenue stream) pair on a dedicated Part 5 sheet, with separate columns for company, revenue stream, amount, and currency. v1 puts companies as column headers (row 4 of the "3. Revenues" sheet, starting at column I) and the GFS revenue streams as rows; each cell where a row meets a column is a single payment amount — a cross-tab shape rather than a list.

**Decision:** When the tool reads a v1 file it walks the cross-tab and, for every cell that has a payment, produces one flat row carrying the GFS code and description, the revenue stream name, the agency from the row, the company name from the column header, and the payment amount from the cell. Blank cells are skipped so a sparse cross-tab doesn't produce zero-payment rows. The result is a list of payments shaped the same way as v2.0 and v2.1's Part 5 — so reconciliation, warnings, and the dashboard all read the three versions the same way.

**Rationale:** Forcing every later step to handle the cross-tab shape would scatter v1-specific logic through reconciliation, the cleaned tables, and the dashboard. Reshaping to a row-per-payment list at the reading stage contains the version-specific shape work in one place and lets every later step stay version-agnostic.

**Technical detail:** `COMPANY_REVENUE_SCHEMA_V1` and `discover_company_columns` in `packages/parser/src/parser/domain/schemas/v1.py`; `PivotTableLocator` and `PivotTableReader` in `packages/parser/src/parser/extraction/location_strategies.py`. Each emitted row carries `gfs_code`, `gfs_description`, `revenue_stream_name`, `government_agency` (from the row), `company_name` (from the column header on row 4), and `revenue_value` (the cell value). Company metadata (id, sector, commodities) lives in the same pivot header and is extracted separately by `COMPANY_HEADER_SCHEMA_V1` (PivotHeaderSchema) into `companies_v1`.

### Why does v2.0 reference internal Excel table names that don't match the data?
<!-- scenario: compare-across-versions; topic: version-differences -->

**Situation:** The v2.0 template (July 2019) ships with two internal Excel table identifiers that don't match what they actually contain. The projects table on "Part 3 - Reporting entities" is named Companies15 in the workbook — not Projects — and the Part 5 company-data table on "Part 5 - Company data" is named Table10 rather than the descriptive Gov_revs_comp_proj used in v2.1. These are the literal labels stored inside the .xlsx file and what any tool reading the workbook sees.

**Decision:** The tool uses those literal Excel labels exactly as they appear in v2.0 files. v2.1 renamed both tables to Projects and Gov_revs_comp_proj respectively, and the tool uses those new labels for v2.1 files. The mismatch is contained to v2.0: every place that mentions a v2.0 table refers to it by its v2.0 label, and v2.1 reads cleanly.

**Rationale:** Renaming the Excel tables inside files the tool receives isn't an option — the .xlsx as submitted is what it is. Matching the labels exactly is the only way the tool can find the tables in the file. The cost is that internal references for v2.0 carry names that don't describe their contents, which is documented where the names appear and stays confined to v2.0.

**Technical detail:** Quirky names declared in `packages/parser/src/parser/domain/schemas/v2p0.py` (notably `REPORTING_PROJECTS_SCHEMA_V2P0` with `table_name="Companies15"` and `COMPANY_REVENUE_SCHEMA_V2P0` with `table_name="Table10"`); routed through `packages/shared/src/shared/stats_config.json` (`TABLE_KEYS["summary_v2.0"]` has `comp: "Table10"`, `projects: "Companies15"`) and `packages/pipeline/src/pipeline/profiles/summary_v2p0.py` (`crosscheck_entities`, `enrichment_sources`, `gfs_table`, clean-query wiring). Lookup happens in `NamedTableLocator.locate` in `packages/parser/src/parser/extraction/location_strategies.py` via `sheet.tables.get(schema.table_name)`.

### How does the tool recover data from older or template-corrupted files?
<!-- scenario: trust-the-data; topic: version-differences -->

**Situation:** Country files commonly arrive with values that don't match the canonical vocabulary — typos, French/Spanish translations of canonical English values, sentinel-token variants like `"n/a"`, free-text comma-separated lists in cells the schema models as a single value, multiple canonicals packed into one cell, and template-induced errors where the source `.xlsx` itself produces wrong values via broken Excel formulas. The goal is to import as much real data as possible while keeping a clean audit trail of every substitution the tool made.

**Decision:** A layered set of recovery techniques runs before any value reaches the database. They apply uniformly across v1, v2.0, and v2.1; some are specific to v2.x where a template bug or a free-text list shape needs special handling. Each technique emits a finding that surfaces in the review UI's Auto-cleaned section, so an operator can audit the substitution before confirming.

- **v2.x VLOOKUP Sector recovery.** The v2.0 and v2.1 templates fill the Part 5 (Company revenues) Sector column with a VLOOKUP formula that pulls the wrong source column from Part 3 Companies — v2.0 generally lands company registration numbers there, v2.1 generally lands Company-Type strings. A parser-side transform runs after extraction and before validation: for each Part 5 row, the transform looks up the row's company name in Part 3 and substitutes the looked-up sector. Cells where Part 3 has no valid sector for that company fall through to `INVALID_DATATYPE` for operator review.
- **Per-language alias resolution.** Three dictionaries (`EN_ALIAS_LOOKUP`, `FR_ALIAS_LOOKUP`, `ES_ALIAS_LOOKUP`) map non-canonical text to canonical EN values. `"Bauxite"` resolves to `"Aluminium ores and concentrates (2606)"`; `"Pétrole brut"` resolves to `"Crude oil (2709)"`; `"Oil and gas"` resolves to the canonical `"Oil & Gas"` Sector. The substitution emits one of `RESOLVED_EN_ALIAS` / `TRANSLATED_FR_ALIAS` / `TRANSLATED_ES_ALIAS` so the dashboard can categorise the source language.
- **Sentinel normalisation.** Typed variants of "Not available" (`"not availble"`, `"not avaiable"`) and "Not applicable" (`"n/a"`, `"n.a."`, `"na"`, `"not aplicable"`) are coerced to the canonical sentinel when the field's union allows it. Cross-sentinel mismatches (`"Not applicable"` typed into a field that only accepts `"Not available"`, or vice versa) are corrected via the `WrongSentinelCorrectionRule`.
- **Fuzzy enum correction with gap-to-runner-up.** Misspellings within ~80 WRatio of a canonical enum value get auto-suggested, but only if the runner-up is at least 10 WRatio points behind. The gap check suppresses silent mis-correction when two candidates are too close to distinguish; those cells fall through to the dropdown.
- **List-typed cell segmentation.** Companies-sheet `commodities` and Projects-sheet `affiliated_companies` are typed as lists. The parser segments the cell on `,;`, ` and `, ` et `, ` y `, `&`, `/` and validates each token independently. Resolved tokens accumulate into the matching junction table. Noise tokens inside the list (empty, sentinel mid-list) are filtered by `ListTokenNoiseFilterRule` so they don't trip alias or fuzzy correction.
- **Compound-value detection on single-value fields.** When a field that the schema models as scalar carries two or more canonical values separated by `,;`, the tool emits `MULTI_VALUE_IN_SINGLE_FIELD`. The operator must split the source row before the file can import. Compound detection is alias-aware: `"Iron Ore, Gold Ore"` (alias-only) and `"Iron (2601), Gold (7108)"` (canonical-only) both trigger the same code.
- **Template placeholder and instruction removal.** Cells containing template guidance like `"add commodities here, volume"` or `<placeholder>` syntax are dropped via `PlaceholderRemovalRule` so they don't import as data.
- **Pre-seeded canonical dimensions.** `metadata_commodities` is pre-seeded at API startup with one row per `Commodity` enum member. The importer no longer auto-creates `metadata_commodities` rows from cell text, so a typo in one country file can't leak into the canonical commodity list and pollute aggregations for every country thereafter.

**Rationale:** EITI receives files from many countries across many years, with template bugs, language differences, and operator typing styles that pre-date the current taxonomy. Refusing to import anything that doesn't match exactly would leave most public data uningested. Each recovery technique encodes a specific class of known issue and surfaces the substitution in the review UI, so the operator decides at the confirmation step whether the tool's interpretation matches the country's intent.

**Technical detail:** The VLOOKUP transform lives in `packages/parser/src/parser/transforms/v2_vlookup_sector_fixup.py` and is registered on `SubmissionDefinition.transforms` for `SUMMARY_V2_0` and `SUMMARY_V2_1` in `packages/parser/src/parser/domain/submissions/registry.py`. It emits `Finding(category=SCHEMA_DEVIATION, code=ParserCode.VLOOKUP_SECTOR_RECOVERED)` per recovered cell. Sector fields on `CompanyRevenueRow` in `v2p1.py` and `CompanyRevenueRowV2P0` in `v2p0.py` are typed `Sector | NotApplicable | NotAvailable` with a `detect_compound_sector` BeforeValidator. The transform retires when EITI ships a corrected template AND the recovery rate drops to zero across ≥6 months of imports. Alias dictionaries live in `packages/shared/src/shared/sdf_vocabulary.py` (`COMMODITY_TRANSLATIONS`, `SECTOR_TRANSLATIONS`, etc.); the `AliasResolutionRule` lives in `packages/cleaner/src/cleaner/rules.py` alongside `EnumCorrectionRule`, `ListTokenNoiseFilterRule`, `PlaceholderRemovalRule`, `WrongSentinelCorrectionRule`, `StandardizeNotAvailableRule`, `StandardizeNotApplicableRule`, and `MapToNotAvailableRule`. Segmentation helpers are `segment_commodity_list` and `segment_company_list` in `packages/parser/src/parser/domain/schemas/validation_helpers.py`; compound detection is `detect_compound_commodity` / `detect_compound_sector` in the same module. `ImporterService.seed_canonical_dimensions` in `packages/importer/src/importer/import_service.py` pre-seeds `metadata_commodities` from the FastAPI lifespan; per-token findings carry a `Finding.token_index: int | None` field so the mapper override key and the per-cell review UI can address one token at a time.

**VLOOKUP ambiguity sub-case.** When two or more Part 3 Companies rows normalise to the same company name with different Sector values, the transform pre-scans Part 3 before the recovery loop and emits one `Finding(code=ParserCode.VLOOKUP_SECTOR_AMBIGUOUS)` per Part-3 row that participates in any ambiguous group. Recovery still proceeds — last-write-wins per spreadsheet ordering — but the operator sees the ambiguity flagged in review so the substitution is auditable. The behavior is deterministic for any single uploaded file; re-uploads with reordered Part 3 rows could yield different sectors, which the ambiguity findings make visible.

---

## Cross-Cutting

### How are numeric IDs from Excel handled?
<!-- scenario: trust-the-data; topic: cross-cutting -->

**Situation:** Excel stores any cell whose content looks like a number as a number, including columns that are meant to hold identifiers. A company ID typed as `12345` in the file arrives as `12345.0`, and a project reference typed as `7890` arrives as `7890.0`.

**Decision:** Identifier columns run through a cleanup step that recognises whole numbers and strips the trailing ".0" before storing them as text — so `12345.0` becomes `"12345"`. Identifiers that mix letters and digits, like `"AB123"`, pass through unchanged. This cleanup applies to every ID column the tool reads: company ID, legal agreement reference number, the generic ID field, and (in v2.x where the "Full project name" is really a project code) the project name.

**Rationale:** Without the cleanup, the same underlying identifier would appear in the database sometimes as `"12345"` and sometimes as `"12345.0"`, depending on how it was typed in the file. Lookups and joins on the float-shaped rows would silently fail — a real bug that costs hours to track down once it lands in production data. Stripping the ".0" at the boundary keeps the rest of the tool free of defensive checks for "is this string really an integer dressed up as a float?".

**Technical detail:** The normalizer is `normalize_id_column` in `packages/parser/src/parser/domain/schemas/validation_helpers.py`, exposed as `NormID = Annotated[str, BeforeValidator(normalize_id_column)]` in the same file. Field declarations in `packages/parser/src/parser/domain/schemas/v2p0.py` and `v2p1.py` use `NormID` (sometimes combined with `NotAvailable` or `NotApplicable` in a union) for the ID-shaped columns: `id_number`, `company_id`, `legal_agreement_ref_num`, and `project_name`.

### What happens to abandoned sessions?
<!-- scenario: operate-at-scale; topic: cross-cutting -->

**Situation:** A user uploads a file, walks away in the middle of review or confirmation, and never comes back. Without cleanup the file, its extracted contents, and its history would sit on the server indefinitely.

**Decision:** Once a day, the tool sweeps files that haven't been touched in 30 days. Each abandoned file is marked as expired, then its extracted contents, the uploaded source file, and its history are removed. After that the file is no longer eligible to be picked up by the recovery sweep and no longer blocks a colleague from uploading the same file.

**Rationale:** Abandoned uploads accumulate quietly — the extracted contents of a parsed Excel file can be large, and stale half-reviewed files sit on the recovery sweep's list forever. A timeout on how long inaction is preserved keeps disk usage and the recovery scan tractable without imposing a tight per-file lifetime. Marking each one as expired before removing it means the history still records that the file existed and was cleaned up, rather than silently disappearing.

**Technical detail:** The TTL is `Settings.cache_ttl_days` (default 30, `packages/shared/src/shared/settings.py`) and the loop runs every `cleanup_interval_hours` (default 24). The mark step is `EventManager.mark_expired_sessions` in `packages/shared/src/shared/session/event_manager.py`; the sweep step is in `CacheManager._run_cleanup` (`packages/shared/src/shared/session/cache_manager.py`). The `EXPIRED` state is included in `DEDUP_INACTIVE_STATES` so it stops blocking content-hash duplicate detection.

### What does the tool require before letting the user move past review?
<!-- scenario: fix-problems-before-import; topic: cross-cutting -->

**Situation:** The user has reached the review step. The dashboard shows validation problems — some with a proposed fix already filled in, some with a dropdown of candidate values, some with neither. The user clicks "Submit corrections" to continue.

**Decision:** Every validation problem has to be addressed before the tool will continue. A problem is addressed when one of three things is true: the tool already proposed a fix for it, the tool proposed a fix for the same cell elsewhere, or the user picked a value from the dropdown. A problem with a dropdown but no pick and no proposed fix is not addressed — the tool refuses to continue and tells the user how many problems are still uncovered. The user has to either pick a value or escalate the problem to the dev team before they can move on.

**Rationale:** An earlier version of the tool let a problem through as soon as it had candidates attached — the user didn't actually have to pick. That let blank cells with "Not applicable" pre-listed as a candidate slip past review with no decision, and the row went into the EITI database with nothing in that column. The strict gate makes every dropdown-fixable cell a required review action: no value lands in the EITI database that nobody explicitly approved.

**Technical detail:** The gate lives in `review_post` in `apps/api/src/api/session_endpoints.py`. It builds a `covered_coords` set from cleaner findings with `proposed_value` and from `USER_CHOICE` findings (both already in `context.findings` and freshly submitted in `request.corrections`), then checks every `VALIDATION` finding without its own `proposed_value`. Findings on strict-typed fields carry no candidates and no cleaner coverage — those are source-only errors that must be fixed in the Excel file or escalated via FLAGGED. Uncovered findings result in a 422 response with the uncovered count.

### How does the user escalate a finding the tool can't resolve?
<!-- scenario: fix-problems-before-import; topic: cross-cutting -->

**Situation:** A user is reviewing a file and hits a problem they can't resolve — something the tool can't fix in the dashboard, an auto-fix they think is wrong, or anything else the dev team should look at. They need a way to flag it without going ahead with a broken import.

**Decision:** The user marks the problem via a flag dialog in the dashboard. Each flag records what the user is flagging (a wrong auto-fix, a genuine error, or something the tool couldn't offer a fix for) and an optional comment. Flags can be saved and re-saved while the user keeps reviewing — ticking and unticking boxes doesn't commit anyone to anything. When the user is done and explicitly submits the flag set as feedback to the dev team, the file is closed out as an error (terminal) and won't proceed to import. There is no "dismiss and keep going" path.

**Rationale:** Saving notes and giving up on a file are two different gestures. Saving flag notes shouldn't commit the user to anything — they can change their minds, untick everything, and continue. Submitting feedback is the explicit "I'm done with this file, the dev team needs to see why" action. Keeping the flags after the file is closed means the dev team can look at flagged problems later, even once the file's working data has been cleaned up.

**Technical detail:** Flag rows live in the `metadata_feedback_flags` table in the target DB (defined in `packages/shared/src/shared/db_models.py`). The interim save and the terminal submit endpoints are `post_flags` and `submit_feedback` in `apps/api/src/api/session_endpoints.py`. Interim saves use replace-on-POST: the body is the full flag list, so re-POSTing an empty list clears them. Submit emits one structlog warning per flag, transitions the session to `ERROR_DATA` (terminal), and returns 422. `FlagTarget` (values `AUTO_CORRECTION`, `ERROR`, `SOURCE_ONLY`) and `FeedbackCode` are defined in `packages/shared/src/shared/diagnostics.py`; the relevant `FeedbackCode` values are `USER_CHOICE` (for the manual-fix path) and `FLAGGED` (for the escalation path).
