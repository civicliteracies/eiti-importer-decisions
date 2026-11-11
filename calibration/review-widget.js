/* Review widget shared by the hosted review pages.

   The per-item judgment, rendered by a review page's shell (calibration.js loads it under CSP
   script-src 'self'). Every page passes its own ReviewConfig: the question, the choices and the layout
   for each item kind (keyed by item.stratum), and the unsure value. Kept as its own module, not inlined
   into a page, so the review semantics (choices, follow-up step, blind-then-reveal, unsure, the
   proposal) and the keyboard map are unit-tested once in Node (tests/js/calibration-widget.test.js)
   rather than only through the DOM.

   Layouts: a kind's `layout` is how its items are laid out. "names" shows an item's names and details
   with the choices under them; "partition" asks how an item's members group; "comparison" shows two or
   more records side by side, the proposal the item carries, the research behind it and the decision
   beside them. A kind that declares no layout is read from its shape (layoutOf): partition when it
   carries `partition`, names otherwise. That reading serves the EITI dashboard's decision-review page,
   whose published config declares no layout.

   Blindness invariant (names and partition items): the machine verdict is rendered ONLY inside the
   reveal, and the reveal appears ONLY after the reviewer has committed (decided != null), the shell
   permits it (opts.reveal), and the item carries a machine_verdict. A caller that never passes
   reveal:true (the hosted scored items) never shows the machine answer at all. A names or partition
   item carries no `proposal` (validateReviewItem refuses one), so these pages stay blind by their
   items' shape.

   Verification (comparison items): a comparison item carries the agents' proposal, and the card shows
   it with its rationale, the records and the research on one screen before any answer. The proposed
   choice is preselected when the proposal has one (proposedOf): Enter accepts it on an unanswered item
   once the reviewer's saved answers are known (opts.saved), and is "next" everywhere else. Every string
   on the card is the publisher's (the config's and the item's) except the card's own controls,
   headings and lead-ins, and the sentence for each closed value it branches on (a proposal's
   `together`, a citation's `status`, the saved answers' state).

   Two-step choice: a choice whose value has a followUp in its kind's config does not commit. The widget
   calls onPending(value), and the shell renders again with opts.pending = value, which shows the
   follow-up question and its choices in place of the first step. Only the follow-up answer commits, as
   onChoose(value, followUpValue); a value with no follow-up commits at once as onChoose(value, null).
   Unsure commits from either step as onChoose(unsure, null). The pending value is the caller's state,
   passed back in on every render and keydown, so both functions stay pure over their inputs. A
   comparison kind has no follow-up step.

   Partition kind: a kind whose config carries `partition` instead of `choices` asks how an item's
   members (item.members) group: each member is its own project or the same project as one that is.
   The answer is a partition, a map from each member's id to the id of the member that is its project
   (itself for one that is), kept a partition by construction: a member can be joined only to a member
   that is its own project, and the members joined to a member follow it when it is joined to another
   (joinMember). The draft is the caller's state, passed back in on every render as opts.draft and
   updated through onDraft; the save button commits onChoose(partition.verdict, null, draft). A partition
   kind that names a `note` label shows a note box: what is typed reaches the caller through onNote, comes
   back as opts.note on every render, and is saved with the next commit of the item, a partition or unsure.

   Flags: a comparison kind may declare `flags`, the closed set of [value, label] marks a reviewer can
   set beside an answer (a research gap, say), with a note box beside them. The flags set reach the
   caller through onFlags and come back as opts.flags (currentFlags reads them, toggleFlag changes
   them); the note through onNote and opts.note. Both are saved with the item's answer; on an answered
   item the shell saves them in place.

   Layout of the choices: a names step lays out its choices from their labels (choiceLayout), so no
   page configures it. Short labels sit side by side in equal columns; when one is too long for its
   column, or a choice carries a meaning ([value, name, meaning]), every choice is a full-width row of
   the list, its key beside its label. The unsure choice closes the same group in either layout. Keys
   and focus are the same in both.

   Untrusted text: names, item details, records, claims, rationales and citations are written with
   textContent, never innerHTML, so no string of an item can inject markup. A link is rendered only for
   an https URL, with rel="noopener noreferrer".

   renderReviewItem / reviewItemKeydown / validateReviewConfig are pure over their inputs (no globals,
   no I/O); the shells wire persistence and navigation. The module.exports guard is how the Node tests
   import them (classic script, so no ES modules). */

/**
 * @typedef {[string, string] | [string, string, string]} Choice - [value, label] or [value, name, meaning];
 *   the value is what a verdict cell stores, a triple is laid out as its name over its meaning
 * @typedef {[string, string]} Flag - [value, label]; the value is what a verdict cell's `flags` stores
 * @typedef {"names" | "comparison" | "partition"} Layout
 * @typedef {{ question: string, choices: Choice[] }} FollowUp
 * @typedef {{ verdict: string, own: string, joinedTo: string, save: string, note?: string }} PartitionConfig - the
 *   verdict a partition answer commits, the labels of "its own project", "same project as" and the save
 *   button, and of the note box when the page offers one
 * @typedef {[string, string]} UnsureChoice - [name, meaning]: how a comparison kind words its unsure choice
 * @typedef {{ question: string, layout?: "names" | "comparison", choices: Choice[], flags?: Flag[],
 *   followUp?: Record<string, FollowUp>, partition?: undefined, unsure_choice?: UnsureChoice,
 *   source_details?: string }} ChoiceKind - a comparison kind words its unsure choice and the summary
 *   of its collapsed source rows (both required there, refused elsewhere)
 * @typedef {{ question: string, layout?: "partition", partition: PartitionConfig, choices?: undefined,
 *   flags?: undefined, followUp?: undefined, unsure_choice?: undefined, source_details?: undefined }} PartitionKind
 * @typedef {ChoiceKind | PartitionKind} KindConfig - a choice kind (choices) or a partition kind (partition)
 * @typedef {{ kinds: Record<string, KindConfig>, unsure: string }} ReviewConfig
 * @typedef {{ id: string, label: string, facts?: string[] }} ItemMember
 * @typedef {Record<string, string>} Partition - each member's id to the id of the member that is its project
 * @typedef {{ text: string, url: string }} Quote
 * @typedef {{ facts?: string[], quotes?: Quote[] }} ItemDetails
 * @typedef {{ role: string, kind: string, name: string, key: string, countries: string[] }} Subject - a
 *   record the question is about: its role in the question, the kind of record it is, its name, its
 *   key and the countries it names (none for a record that names none)
 * @typedef {{ label: string, value: (string|string[]), link?: string }} Field - one stated field of a record
 * @typedef {"identity" | "fact" | "source"} RowGroup - how the card treats a concept's row: an identity
 *   row is never tinted, a fact row is tinted when every cell reads the same, a source row is collapsed
 * @typedef {{ concept: string, group: RowGroup, cells: Field[][] }} ConceptRow - one concept of the
 *   comparison, each subject's fields for it in subject order (a cell may be empty)
 * @typedef {{ kind: string, name: string, key: string, fields: Field[] }} OtherRecord - a record the
 *   evidence cites that is none of the subjects
 * @typedef {"verified" | "refused"} CitationStatus
 * @typedef {{ url: string } | { withheld: string }} QuotePage - the page a quote was found on, or the
 *   sentence saying why it is not linked
 * @typedef {{ kind: "quote", status: CitationStatus, quote: string, page: QuotePage, reason: (string|null) }} QuoteCitation
 * @typedef {{ kind: "value", status: CitationStatus, record: string, label: string, value: string, reason: (string|null) }} ValueCitation
 * @typedef {{ kind: "row", status: CitationStatus, record: string, sentence: string, reason: (string|null) }} RowCitation
 * @typedef {QuoteCitation | ValueCitation | RowCitation} Citation - a claim's citation as verify checked it;
 *   `record` is the key of a subject or of an other record; `reason`, the sentence saying why verify
 *   refused it, is present exactly when it is refused
 * @typedef {{ id: string, statement: string, evidence: Citation[] }} Claim
 * @typedef {{ claims: Claim[] } | { none: string }} Research - the research about the question: its
 *   claims (one at least), or the publisher's sentence saying the section holds none
 * @typedef {{ record: string, label: string }} WeighedFact
 * @typedef {{ choice: string } | { unsettled: string }} Answer - a judge's answer: one of the kind's choice
 *   values (never the unsure value), named on the card as the config names it, or the publisher's
 *   sentence for an answer that found the evidence insufficient
 * @typedef {{ answer: Answer, rationale: string, cited: string[], facts: WeighedFact[] }} OpusSaid
 * @typedef {{ answer: Answer, probability: number, probabilities: [string, number][] }} JevSaid -
 *   Jev's answer, the probability it gave that answer, and its probabilities as [label, probability] pairs
 * @typedef {{ said: OpusSaid } | { missing: string }} OpusArm
 * @typedef {{ said: JevSaid } | { missing: string }} JevArm
 * @typedef {"same" | "doubted" | "differ" | "one" | "off_pin"} Together - what the judges' answers are
 *   together: both the same choice, one at least insufficient, two different choices, one judge
 *   answering, or both answering with Jev's answer not counted
 * @typedef {{ by: "judges", together: Together, opus: OpusArm, jev: JevArm }
 *   | { by: "rule", rule: string, proposed: string }
 *   | { by: "none" }} Proposal - who proposes the item's answer: the two judges (their answer when they
 *   are the same, read by proposedOf), a rule (its sentence and its answer), or nothing
 * @typedef {"loading" | "known" | "unknown"} SavedState - whether the reviewer's saved answers to the
 *   item are known: loading until they are read, unknown when they could not be
 * @typedef {{ item_id: string, stratum: string, subjects: Subject[], comparison: ConceptRow[],
 *   others: OtherRecord[], register: string[], research: Research, proposal: Proposal, why: string,
 *   notices: string[] }} ComparisonItem - a comparison kind's item; its subjects name their countries
 * @typedef {{ item_id: string, stratum: string, country_iso3?: string, names?: string[],
 *   details?: ItemDetails, members?: ItemMember[], prior?: Partition, machine_verdict?: string,
 *   machine_detail?: (string|null), subjects?: Subject[], comparison?: ConceptRow[], others?: OtherRecord[],
 *   register?: string[], research?: Research, proposal?: Proposal, why?: string, notices?: string[] }} ReviewItem -
 *   a names kind's item names its `names` and a partition kind's lists its `members` and the partition
 *   its review starts from (`prior`), each with its `country_iso3`; a comparison kind's is a
 *   ComparisonItem; validateReviewItem holds an item to its kind
 * @typedef {{ verdict: string, detail: (string|null), partition?: undefined, note?: string, flags?: string[] }} ChoiceDecided
 * @typedef {{ verdict: string, detail: null, partition: Partition, note?: string, flags?: undefined }} PartitionDecided
 * @typedef {ChoiceDecided | PartitionDecided} Decided
 * @typedef {(verdict: string, detail: (string|null), partition?: Partition) => void} ChooseFn
 * @typedef {(verdict: (string|null)) => void} PendingFn
 * @typedef {(draft: Partition, memberId: string) => void} DraftFn
 * @typedef {(flags: string[]) => void} FlagsFn
 * @typedef {{ reveal?: boolean, pending?: (string|null), draft?: (Partition|null), focusMember?: (string|null),
 *   note?: (string|null), flags?: (string[]|null), stay?: boolean, saved?: SavedState,
 *   onRetryLoad?: () => void, onChoose?: ChooseFn, onPending?: PendingFn, onDraft?: DraftFn,
 *   onNote?: (note: string) => void, onFlags?: FlagsFn,
 *   onPrev?: () => void, onNext?: () => void, position?: number, total?: number }} RenderOpts
 * @typedef {{ item: (ReviewItem|null), config: ReviewConfig, pending?: (string|null), decided?: (Decided|null),
 *   flags?: (string[]|null), saved?: SavedState, onChoose?: ChooseFn, onPending?: PendingFn, onFlags?: FlagsFn, onNext?: () => void,
 *   onPrev?: () => void }} KeyHandlers
 * @typedef {{ verdict: string, label: string, followUp: FollowUp }} PendingStep
 */

(function (/** @type {typeof globalThis & { CalibrationReviewWidget?: typeof import("./review-widget.js") }} */ root) {
  "use strict";

  // Keys 1…9 choose; a step offering more choices than there are digit keys could not be answered
  // from the keyboard.
  var MAX_CHOICES = 9;

  // A step's choices sit side by side when, laid out in equal columns, each column holds its "[N] "
  // key and the step's longest label on one line: the step's choice count times (the longest label +
  // KEY_CHARS) characters fits ROW_CHARS, about what one line of the card holds at its widest.
  var ROW_CHARS = 80;
  var KEY_CHARS = 4;

  // The layouts a kind's config may declare (KindConfig.layout).
  var LAYOUTS = ["names", "comparison", "partition"];

  // The closed sets a comparison item's values come from, which the card words one case each: what
  // the judges' answers are together (Proposal.together), the statuses verify gives a citation, and a
  // comparison row's group.
  var TOGETHER = ["same", "doubted", "differ", "one", "off_pin"];
  var CITATION_STATUSES = ["verified", "refused"];
  var ROW_GROUPS = ["identity", "fact", "source"];

  // A list value of the comparison shows this many entries, then "and N more".
  var LIST_SHOWN = 3;

  /** @param {unknown} obj @param {string} key @returns {boolean} */
  function own(obj, key) { return obj != null && Object.prototype.hasOwnProperty.call(obj, key); }

  /** @param {unknown} v @returns {v is Record<string, unknown>} */
  function isObject(v) { return v != null && typeof v === "object"; }

  /** @param {unknown} v @returns {v is unknown[]} */
  function isList(v) { return Array.isArray(v); }

  /**
   * The config of one item kind. Throws on a kind the config does not define: rendering an item with
   * no question and no choices would leave the reviewer stuck on a card they cannot answer.
   * @param {ReviewConfig} config @param {string} kind @returns {KindConfig}
   */
  function kindFor(config, kind) {
    var kc = own(config.kinds, kind) ? config.kinds[kind] : undefined;
    if (!kc) throw new Error("review config has no kind " + JSON.stringify(kind));
    return kc;
  }

  /**
   * A kind's layout: the one its config declares, else the one its shape implies (partition for a kind
   * carrying `partition`, names otherwise), which is how the EITI dashboard's decision-review page,
   * whose config declares no layout, is read.
   * @param {KindConfig} kc @returns {Layout}
   */
  function layoutOf(kc) {
    if (kc.layout) return kc.layout;
    return kc.partition ? "partition" : "names";
  }

  /**
   * The layout of the kind `kind` of a config. Throws on a kind the config does not define.
   * @param {ReviewConfig} config @param {string} kind @returns {Layout}
   */
  function kindLayout(config, kind) { return layoutOf(kindFor(config, kind)); }

  /**
   * An item's flags as they stand: the ones the reviewer has set and not yet saved (`flags`), else the
   * saved answer's, else none.
   * @param {string[]|null|undefined} flags @param {Decided|null|undefined} decided @returns {string[]}
   */
  function currentFlags(flags, decided) {
    if (flags != null) return flags;
    return (decided && decided.flags) || [];
  }

  /**
   * `set` with the flag `value` toggled, in the order the kind declares its flags.
   * @param {KindConfig} kc @param {string[]} set @param {string} value @returns {string[]}
   */
  function toggleFlag(kc, set, value) {
    var on = set.indexOf(value) === -1;
    return (kc.flags || []).map(function (f) { return f[0]; }).filter(function (v) {
      return v === value ? on : set.indexOf(v) !== -1;
    });
  }

  /**
   * The choice a comparison item's proposal preselects: the judges' when their answers are the same
   * (Opus's choice, which is Jev's), or the rule's; null when nothing is proposed (the judges have no
   * agreed answer, or nothing answered). validateReviewItem holds both judges to a choice under "same".
   * @param {ReviewItem} item @returns {string|null}
   */
  function proposedOf(item) {
    var p = item.proposal;
    if (!p) return null;
    switch (p.by) {
      case "rule": return p.proposed;
      case "judges": {
        if (p.together !== "same" || !("said" in p.opus)) return null;
        var answer = p.opus.said.answer;
        return "choice" in answer ? answer.choice : null;
      }
      default: return null;
    }
  }

  /**
   * The follow-up step for a first-step value, or null when the value commits on its own.
   * @param {KindConfig} kc @param {string|null|undefined} verdict @returns {PendingStep|null}
   */
  function stepFor(kc, verdict) {
    if (verdict == null || !kc.followUp || !own(kc.followUp, verdict)) return null;
    var fu = kc.followUp[verdict];
    if (!fu) return null;
    var label = verdict;
    if (kc.choices) kc.choices.forEach(function (c) { if (c[0] === verdict) label = c[1]; });
    return { verdict: verdict, label: label, followUp: fu };
  }

  /** @param {Choice[]} choices @param {string|null} value @returns {string|null} */
  function labelOf(choices, value) {
    var found = null;
    choices.forEach(function (c) { if (c[0] === value) found = c[1]; });
    return found;
  }

  /**
   * How a step lays out its choices: "row" when every label fits one line of an equal column, else
   * "list", one full-width row per choice.
   * @param {Choice[]} choices @returns {"row"|"list"}
   */
  function choiceLayout(choices) {
    var longest = 0;
    var meant = false;
    choices.forEach(function (c) {
      longest = Math.max(longest, c[1].length);
      if (c.length === 3) meant = true;
    });
    return !meant && choices.length * (longest + KEY_CHARS) <= ROW_CHARS ? "row" : "list";
  }

  /**
   * Fill a choice button with its key and its label, as two spans the list layout aligns: the text
   * reads "[key] label". A choice's meaning, when it has one, follows its name inside the label span,
   * on a line of its own.
   * @param {Document} doc @param {HTMLElement} button @param {string} key @param {string} label @param {string} [meaning]
   */
  function keyedLabel(doc, button, key, label, meaning) {
    var k = doc.createElement("span");
    k.className = "key";
    k.textContent = "[" + key + "]";
    var l = doc.createElement("span");
    l.className = "label";
    l.textContent = label;
    if (meaning) l.appendChild(el(doc, "span", "meaning", meaning));
    button.appendChild(k);
    button.appendChild(doc.createTextNode(" "));
    button.appendChild(l);
  }

  /** A new element with a class and a text, both optional. @param {Document} doc @param {string} tag @param {string|null} [cls] @param {string} [text] @returns {HTMLElement} */
  function el(doc, tag, cls, text) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  /** @param {string} where @param {unknown} choices @param {string} unsure @returns {string|null} */
  function checkChoices(where, choices, unsure) {
    if (!isList(choices) || choices.length < 1 || choices.length > MAX_CHOICES) {
      return where + ": choices must hold 1 to " + MAX_CHOICES + " entries";
    }
    /** @type {Record<string, true>} */
    var seen = {};
    for (var i = 0; i < choices.length; i++) {
      var c = choices[i];
      if (!isList(c) || (c.length !== 2 && c.length !== 3) || !c.every(nonEmpty)) {
        return where + ": choice " + (i + 1) + " must be a [value, label] pair or a [value, name, meaning] triple of non-empty strings";
      }
      var value = /** @type {string} */ (c[0]); // every entry is a non-empty string, checked above
      if (value === unsure) return where + ": choice value " + JSON.stringify(value) + " is the unsure value";
      if (own(seen, value)) return where + ": choice value " + JSON.stringify(value) + " appears twice";
      seen[value] = true;
    }
    return null;
  }

  /** @param {unknown} v @returns {v is string} */
  function nonEmpty(v) { return typeof v === "string" && v.length > 0; }

  /** @param {unknown} v @returns {v is string[]} */
  function isStrings(v) { return isList(v) && v.every(function (x) { return typeof x === "string"; }); }

  /** @param {string} where @param {unknown} flags @param {string[]} values the kind's choice values @returns {string|null} */
  function checkFlags(where, flags, values) {
    if (!isList(flags) || !flags.length) return where + ": flags must be a non-empty list";
    /** @type {Record<string, true>} */
    var seen = {};
    for (var i = 0; i < flags.length; i++) {
      var f = flags[i];
      if (!isList(f) || f.length !== 2 || !f.every(nonEmpty)) return where + ": flag " + (i + 1) + " must be a [value, label] pair of non-empty strings";
      var value = /** @type {string} */ (f[0]);
      if (own(seen, value)) return where + ": flag value " + JSON.stringify(value) + " appears twice";
      if (values.indexOf(value) !== -1) return where + ": flag value " + JSON.stringify(value) + " is a choice value";
      seen[value] = true;
    }
    return null;
  }

  /** @param {string} where @param {unknown} partition @param {string} unsure @returns {string|null} */
  function checkPartition(where, partition, unsure) {
    if (!isObject(partition)) return where + ": partition must be an object";
    var keys = ["verdict", "own", "joinedTo", "save"];
    for (var i = 0; i < keys.length; i++) {
      var key = /** @type {string} */ (keys[i]);
      if (typeof partition[key] !== "string" || !partition[key]) return where + ": partition." + key + " must be a non-empty string";
    }
    if (partition.verdict === unsure) return where + ": partition.verdict is the unsure value";
    if (partition.note !== undefined && (typeof partition.note !== "string" || !partition.note)) return where + ": partition.note must be a non-empty string";
    return null;
  }

  /**
   * `source` read as a partition of the members `ids`, or null when it is none: every member mapped to
   * a member that maps to itself.
   * @param {string[]} ids @param {unknown} source @returns {Partition|null}
   */
  function asPartition(ids, source) {
    if (!isObject(source)) return null;
    /** @type {Partition} */
    var out = {};
    for (var i = 0; i < ids.length; i++) {
      var id = /** @type {string} */ (ids[i]);
      var target = own(source, id) ? source[id] : undefined;
      if (typeof target !== "string" || ids.indexOf(target) === -1 || source[target] !== target) return null;
      out[id] = target;
    }
    return out;
  }

  /**
   * The partition an item starts from: the committed answer's, else the partition on file the item
   * carries (`prior`), else every member its own project. A source that is no partition of the
   * item's members (a stale committed answer) is passed over.
   * @param {ReviewItem} item @param {Decided|null} decided @returns {Partition}
   */
  function partitionOf(item, decided) {
    var ids = (item.members || []).map(function (m) { return m.id; });
    var start = asPartition(ids, decided ? decided.partition : undefined) || asPartition(ids, item.prior);
    if (start) return start;
    /** @type {Partition} */
    var out = {};
    (item.members || []).forEach(function (m) { out[m.id] = m.id; });
    return out;
  }

  /**
   * `partition` with `memberId` joined to the project of `targetId` (its own project when `targetId` is
   * `memberId`): the members joined to `memberId` follow it, so every member stays mapped to a member
   * that is its own project.
   * @param {Partition} partition @param {string} memberId @param {string} targetId @returns {Partition}
   */
  function joinMember(partition, memberId, targetId) {
    var project = targetId === memberId ? memberId : (partition[targetId] || targetId);
    /** @type {Partition} */
    var out = {};
    Object.keys(partition).forEach(function (id) {
      out[id] = id === memberId || partition[id] === memberId ? project : /** @type {string} */ (partition[id]);
    });
    return out;
  }

  /** Whether two partitions map every member alike. @param {Partition} a @param {Partition} b @returns {boolean} */
  function samePartition(a, b) {
    var ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every(function (k) { return a[k] === b[k]; });
  }

  /**
   * Check an item against the kind the config gives it: its item_id is a string; a comparison kind's
   * item is a ComparisonItem (checkComparisonItem), which carries no country_iso3 (its subjects name
   * their countries); a names or partition kind's carries its country_iso3 as a string, a names item
   * at least one name, a partition item two members or more with distinct non-empty ids and labels and
   * its `prior`, when present, a partition of them. Only a comparison item carries a proposal. A page
   * refuses a data set holding an item that fails, rather than show a card no answer fits.
   * @param {unknown} item @param {ReviewConfig} config @returns {{ ok: true } | { ok: false, reason: string }}
   */
  function validateReviewItem(item, config) {
    if (!isObject(item)) return { ok: false, reason: "item must be an object" };
    var where = "item " + JSON.stringify(item.item_id);
    if (typeof item.item_id !== "string") return { ok: false, reason: where + ": item_id must be a string" };
    var stratum = item.stratum;
    var kc = typeof stratum === "string" && own(config.kinds, stratum) ? config.kinds[stratum] : undefined;
    if (!kc) return { ok: false, reason: where + ": the config defines no kind " + JSON.stringify(stratum) };
    var layout = layoutOf(kc);
    if (layout === "comparison") {
      var bad = checkComparisonItem(item, kc);
      return bad ? { ok: false, reason: where + ": " + bad } : { ok: true };
    }
    if (typeof item.country_iso3 !== "string") return { ok: false, reason: where + ": country_iso3 must be a string" };
    if (item.proposal !== undefined) return { ok: false, reason: where + ": only a comparison item carries a proposal" };
    if (layout === "names") {
      var names = item.names;
      var namesOk = isList(names) && names.length > 0 && names.every(function (n) { return typeof n === "string"; });
      return namesOk ? { ok: true } : { ok: false, reason: where + ": names must be a non-empty list of strings" };
    }
    var members = item.members;
    if (!isList(members) || members.length < 2) return { ok: false, reason: where + ": a partition item lists two members or more" };
    /** @type {Record<string, true>} */
    var seen = {};
    /** @type {string[]} */
    var ids = [];
    for (var i = 0; i < members.length; i++) {
      var m = members[i];
      if (!isObject(m) || typeof m.id !== "string" || !m.id || typeof m.label !== "string" || !m.label) {
        return { ok: false, reason: where + ": member " + (i + 1) + " needs a non-empty id and label" };
      }
      if (own(seen, m.id)) return { ok: false, reason: where + ": member id " + JSON.stringify(m.id) + " appears twice" };
      seen[m.id] = true;
      ids.push(m.id);
    }
    if (item.prior !== undefined && !asPartition(ids, item.prior)) {
      return { ok: false, reason: where + ": prior is no partition of the item's members" };
    }
    return { ok: true };
  }

  /** @param {string} where @param {unknown} f @returns {string|null} */
  function checkField(where, f) {
    if (!isObject(f) || !nonEmpty(f.label)) return where + " needs a non-empty label";
    var v = f.value;
    if (!(typeof v === "string" || (isStrings(v) && v.length > 0))) return where + ": value must be a string or a non-empty list of strings";
    if (f.link !== undefined && typeof f.link !== "string") return where + ": link must be a string";
    return null;
  }

  /** @param {string} where @param {unknown} fields @returns {string|null} */
  function checkFields(where, fields) {
    if (!isList(fields)) return where + " must be a list of fields";
    for (var i = 0; i < fields.length; i++) {
      var bad = checkField(where + " field " + (i + 1), fields[i]);
      if (bad) return bad;
    }
    return null;
  }

  /**
   * Check a citation: its kind and status; a reason exactly when it is refused; for a quote, its page
   * or the sentence withholding it; for a cited value or row, a record key naming a subject or an
   * other record (`keys`).
   * @param {string} where @param {unknown} c @param {string[]} keys @returns {string|null}
   */
  function checkCitation(where, c, keys) {
    if (!isObject(c)) return where + " must be an object";
    if (typeof c.status !== "string" || CITATION_STATUSES.indexOf(c.status) === -1) return where + ": status must be one of " + CITATION_STATUSES.join(", ");
    var refused = c.status === "refused";
    if (refused ? !nonEmpty(c.reason) : c.reason !== null) return where + ": a citation carries a reason exactly when it is refused";
    if (c.kind === "quote") {
      if (!nonEmpty(c.quote)) return where + ": quote must be a non-empty string";
      var page = c.page;
      var pageOk = isObject(page) && (Object.keys(page).length === 1) && (nonEmpty(page.url) || nonEmpty(page.withheld));
      return pageOk ? null : where + ": page must be { url } or { withheld }";
    }
    if (c.kind !== "value" && c.kind !== "row") return where + ": kind must be quote, value or row";
    if (typeof c.record !== "string" || keys.indexOf(c.record) === -1) return where + ": record " + JSON.stringify(c.record) + " names no record of the item";
    if (c.kind === "value") return nonEmpty(c.label) && typeof c.value === "string" ? null : where + ": a cited value needs a label and a string value";
    return nonEmpty(c.sentence) ? null : where + ": a cited row needs its sentence";
  }

  /** @param {unknown} v @returns {boolean} */
  function isProbability(v) { return typeof v === "number" && v >= 0 && v <= 1; }

  /**
   * Check a judge's answer: one of the kind's choice values (`values`, never the unsure value), or the
   * publisher's non-empty sentence for an answer that found the evidence insufficient; nothing else.
   * @param {string} where @param {unknown} answer @param {string[]} values @returns {string|null}
   */
  function checkAnswer(where, answer, values) {
    if (!isObject(answer) || Object.keys(answer).length !== 1) return where + " must be { choice } or { unsettled }";
    if ("choice" in answer) return typeof answer.choice === "string" && values.indexOf(answer.choice) !== -1 ? null : where + ".choice " + JSON.stringify(answer.choice) + " is no choice of the kind";
    if ("unsettled" in answer) return nonEmpty(answer.unsettled) ? null : where + ".unsettled must be a non-empty sentence";
    return where + " must be { choice } or { unsettled }";
  }

  /**
   * Check one judge's arm of a proposal: what it said, or the text saying why it said nothing. What it
   * said carries its answer (checkAnswer) and no label of its own, the card naming a choice as the
   * config does; Opus's its rationale, the claims it cites and the facts it weighed (each a record key
   * of `keys`); Jev's the probability it gave its answer and its probabilities as [label, probability]
   * pairs.
   * @param {string} where @param {unknown} arm @param {"opus"|"jev"} judge @param {string[]} values
   * @param {string[]} keys @returns {string|null}
   */
  function checkJudge(where, arm, judge, values, keys) {
    if (!isObject(arm)) return where + " must be an object";
    if (arm.said === undefined) return nonEmpty(arm.missing) ? null : where + " needs what it said or a missing text";
    var said = arm.said;
    if (!isObject(said)) return where + ".said must be an object";
    if (said.label !== undefined || said.choice !== undefined) return where + ".said carries its answer, not a choice or a label of its own";
    var bad = checkAnswer(where + ".said.answer", said.answer, values);
    if (bad) return bad;
    if (judge === "jev") {
      var probs = said.probabilities;
      var pairsOk = isList(probs) && probs.length > 0 && probs.every(function (pr) {
        return isList(pr) && pr.length === 2 && nonEmpty(pr[0]) && isProbability(pr[1]);
      });
      if (!pairsOk) return where + ".said.probabilities must be [label, probability] pairs, each probability from 0 to 1";
      return isProbability(said.probability) ? null : where + ".said.probability must be a number from 0 to 1";
    }
    if (typeof said.rationale !== "string" || !isStrings(said.cited)) return where + ".said needs a rationale and the claims it cites";
    var facts = said.facts;
    if (!isList(facts)) return where + ".said.facts must be a list";
    for (var i = 0; i < facts.length; i++) {
      var f = facts[i];
      if (!isObject(f) || !nonEmpty(f.label) || typeof f.record !== "string" || keys.indexOf(f.record) === -1) {
        return where + ".said fact " + (i + 1) + " needs a label and a record of the item";
      }
    }
    return null;
  }

  /**
   * The answer of a judge's arm that checkJudge has held, or null when the judge gave none.
   * @param {unknown} arm @returns {Answer|null}
   */
  function heldAnswer(arm) {
    return isObject(arm) && isObject(arm.said) ? /** @type {Answer} */ (arm.said.answer) : null;
  }

  /**
   * Whether the judges' two answers fit what the proposal says they are together: "same", two equal
   * choices; "differ", two unequal choices; "doubted", two answers, one at least insufficient; "one",
   * exactly one answer; "off_pin", two answers of any kind. Null when they fit, else why not.
   * @param {Together} together @param {Answer|null} opus @param {Answer|null} jev @returns {string|null}
   */
  function checkTogether(together, opus, jev) {
    var both = opus != null && jev != null;
    var opusChoice = opus != null && "choice" in opus ? opus.choice : null;
    var jevChoice = jev != null && "choice" in jev ? jev.choice : null;
    var choices = opusChoice != null && jevChoice != null;
    var where = "proposal.together " + JSON.stringify(together);
    switch (together) {
      case "same": return choices && opusChoice === jevChoice ? null : where + " needs both judges answering one choice";
      case "differ": return choices && opusChoice !== jevChoice ? null : where + " needs both judges answering different choices";
      case "doubted": return both && !choices ? null : where + " needs both judges answering, one at least insufficient";
      case "one": return (opus == null) !== (jev == null) ? null : where + " needs exactly one judge answering";
      case "off_pin": return both ? null : where + " needs both judges answering";
      default: throw new Error("no shape for together " + JSON.stringify(together));
    }
  }

  /**
   * Check a comparison item's proposal: the judges' (each arm checked, their answers fitting
   * `together`, checkTogether; no proposed value, which proposedOf reads from their answers), a rule's
   * (its sentence and its proposed value, one of the kind's choice values: Enter accepts it, and an
   * unsure answer closes its question for good), or none.
   * @param {unknown} p @param {string[]} values the kind's choice values @param {string[]} keys @returns {string|null}
   */
  function checkProposal(p, values, keys) {
    if (!isObject(p)) return "proposal must be an object";
    switch (p.by) {
      case "none":
        return p.proposed === undefined ? null : "a proposal by none proposes no value";
      case "rule":
        if (!nonEmpty(p.rule) || p.proposed === undefined) return "a rule's proposal names its rule and its proposed value";
        return typeof p.proposed === "string" && values.indexOf(p.proposed) !== -1 ? null : "proposal.proposed " + JSON.stringify(p.proposed) + " is no choice of the kind";
      case "judges": {
        if (p.proposed !== undefined) return "the judges' proposal carries no proposed value: it is their answer when they are the same";
        if (typeof p.together !== "string" || TOGETHER.indexOf(p.together) === -1) return "proposal.together must be one of " + TOGETHER.join(", ");
        var bad = checkJudge("proposal.opus", p.opus, "opus", values, keys) || checkJudge("proposal.jev", p.jev, "jev", values, keys);
        if (bad) return bad;
        return checkTogether(/** @type {Together} */ (p.together), heldAnswer(p.opus), heldAnswer(p.jev));
      }
      default:
        return "proposal.by must be judges, rule or none";
    }
  }

  /**
   * Check a comparison item's research: its claims (one at least, with distinct ids, each citation
   * naming the item's records, `keys`), or the publisher's sentence saying it holds none.
   * @param {unknown} research @param {string[]} keys @returns {string|null}
   */
  function checkResearch(research, keys) {
    if (!isObject(research) || Object.keys(research).length !== 1) return "research must be { claims } or { none }";
    if ("none" in research) return nonEmpty(research.none) ? null : "research.none must be a non-empty sentence";
    var claims = research.claims;
    if (!isList(claims) || !claims.length) return "research.claims must be a non-empty list";
    /** @type {string[]} */
    var ids = [];
    for (var k = 0; k < claims.length; k++) {
      var claim = claims[k];
      if (!isObject(claim) || !nonEmpty(claim.id) || typeof claim.statement !== "string" || !isList(claim.evidence)) return "claim " + (k + 1) + " needs an id, a statement and its evidence";
      if (ids.indexOf(claim.id) !== -1) return "claim id " + JSON.stringify(claim.id) + " appears twice";
      ids.push(claim.id);
      for (var e = 0; e < claim.evidence.length; e++) {
        var ebad = checkCitation("claim " + JSON.stringify(claim.id) + " citation " + (e + 1), claim.evidence[e], keys);
        if (ebad) return ebad;
      }
    }
    return null;
  }

  /**
   * Check a comparison item: one subject or more, each named, with distinct keys and the countries it
   * names; a comparison whose every row has a group and one cell per subject; other records named,
   * with keys of their own; its research (checkResearch); a proposal (checkProposal); its why, notices
   * and register. A comparison item has no names and no country_iso3.
   * @param {Record<string, unknown>} item @param {KindConfig} kc @returns {string|null}
   */
  function checkComparisonItem(item, kc) {
    if (item.names !== undefined) return "a comparison item has subjects, not names";
    if (item.country_iso3 !== undefined) return "a comparison item has subjects naming their countries, not a country_iso3";
    var subjects = item.subjects;
    if (!isList(subjects) || !subjects.length) return "subjects must be a non-empty list";
    /** @type {string[]} */
    var keys = [];
    for (var i = 0; i < subjects.length; i++) {
      var s = subjects[i];
      if (!isObject(s) || !nonEmpty(s.role) || !nonEmpty(s.kind) || !nonEmpty(s.name) || !nonEmpty(s.key)) {
        return "subject " + (i + 1) + " needs a non-empty role, kind, name and key";
      }
      if (!isList(s.countries) || !s.countries.every(nonEmpty)) return "subject " + (i + 1) + ": countries must be a list of non-empty strings";
      if (keys.indexOf(s.key) !== -1) return "record key " + JSON.stringify(s.key) + " appears twice";
      keys.push(s.key);
    }
    var others = item.others;
    if (!isList(others)) return "others must be a list";
    for (var o = 0; o < others.length; o++) {
      var other = others[o];
      var ow = "other record " + (o + 1);
      if (!isObject(other) || !nonEmpty(other.kind) || !nonEmpty(other.name) || !nonEmpty(other.key)) return ow + " needs a non-empty kind, name and key";
      if (keys.indexOf(other.key) !== -1) return "record key " + JSON.stringify(other.key) + " appears twice";
      keys.push(other.key);
      var obad = checkFields(ow, other.fields);
      if (obad) return obad;
    }
    var rows = item.comparison;
    if (!isList(rows)) return "comparison must be a list";
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      if (!isObject(row) || !nonEmpty(row.concept)) return "comparison row " + (r + 1) + " needs a concept";
      var concept = "concept " + JSON.stringify(row.concept);
      if (typeof row.group !== "string" || ROW_GROUPS.indexOf(row.group) === -1) return concept + ": group must be one of " + ROW_GROUPS.join(", ");
      var cells = row.cells;
      if (!isList(cells) || cells.length !== subjects.length) return concept + " needs one cell per subject";
      for (var c = 0; c < cells.length; c++) {
        var cbad = checkFields(concept + " cell " + (c + 1), cells[c]);
        if (cbad) return cbad;
      }
    }
    var rbad = checkResearch(item.research, keys);
    if (rbad) return rbad;
    if (typeof item.why !== "string") return "why must be a string";
    if (!isStrings(item.notices)) return "notices must be a list of strings";
    if (!isStrings(item.register)) return "register must be a list of strings";
    var values = (kc.choices || []).map(function (ch) { return ch[0]; });
    return checkProposal(item.proposal, values, keys);
  }

  /**
   * Check a page's review config against the shape the widget renders. Pages call it once at startup
   * (CalibrationApp.create refuses a config it rejects), so a malformed config fails before any item
   * is shown rather than as a card with no way to answer it.
   * @param {unknown} config
   * @returns {{ ok: true } | { ok: false, reason: string }}
   */
  function validateReviewConfig(config) {
    if (!isObject(config)) return { ok: false, reason: "config must be an object" };
    var unsure = config.unsure;
    if (typeof unsure !== "string" || !unsure) return { ok: false, reason: "unsure must be a non-empty string" };
    var kinds = config.kinds;
    if (!isObject(kinds) || !Object.keys(kinds).length) return { ok: false, reason: "kinds must define at least one kind" };
    var names = Object.keys(kinds);
    for (var k = 0; k < names.length; k++) {
      var name = /** @type {string} */ (names[k]);
      var kc = kinds[name];
      var where = "kind " + JSON.stringify(name);
      if (!isObject(kc) || typeof kc.question !== "string" || !kc.question) return { ok: false, reason: where + ": question must be a non-empty string" };
      if ((kc.choices == null) === (kc.partition == null)) return { ok: false, reason: where + ": a kind has either choices or a partition" };
      var layout = kc.layout;
      if (layout !== undefined && (typeof layout !== "string" || LAYOUTS.indexOf(layout) === -1)) return { ok: false, reason: where + ": layout must be one of " + LAYOUTS.join(", ") };
      if (layout !== undefined && (layout === "partition") !== (kc.partition != null)) return { ok: false, reason: where + ": a kind has a partition exactly when its layout is partition" };
      if (kc.flags != null && layout !== "comparison") return { ok: false, reason: where + ": only a comparison kind offers flags" };
      var worded = isList(kc.unsure_choice) && kc.unsure_choice.length === 2 && kc.unsure_choice.every(nonEmpty) && nonEmpty(kc.source_details);
      if (layout === "comparison" && !worded) return { ok: false, reason: where + ": a comparison kind words its unsure choice ([name, meaning]) and its source details" };
      if (layout !== "comparison" && (kc.unsure_choice !== undefined || kc.source_details !== undefined)) return { ok: false, reason: where + ": only a comparison kind words its unsure choice and source details" };
      if (layout === "comparison" && kc.followUp != null) return { ok: false, reason: where + ": a comparison kind's choices commit at once, with no follow-up" };
      if (kc.partition != null) {
        var pbad = checkPartition(where, kc.partition, unsure);
        if (pbad) return { ok: false, reason: pbad };
        continue;
      }
      var bad = checkChoices(where, kc.choices, unsure);
      if (bad) return { ok: false, reason: bad };
      if (kc.flags != null) {
        // checkChoices has held the choices to pairs and triples of strings
        var flagBad = checkFlags(where, kc.flags, /** @type {Choice[]} */ (kc.choices).map(function (c) { return c[0]; }).concat([unsure]));
        if (flagBad) return { ok: false, reason: flagBad };
      }
      var followUp = kc.followUp;
      if (followUp == null) continue;
      if (!isObject(followUp)) return { ok: false, reason: where + ": followUp must be an object keyed by choice value" };
      // checkChoices has held the choices to pairs and triples of strings
      var values = /** @type {Choice[]} */ (kc.choices).map(function (c) { return c[0]; });
      var keys = Object.keys(followUp);
      for (var f = 0; f < keys.length; f++) {
        var value = /** @type {string} */ (keys[f]);
        var fwhere = where + " followUp " + JSON.stringify(value);
        if (values.indexOf(value) === -1) return { ok: false, reason: fwhere + ": not one of the kind's choice values" };
        var fu = followUp[value];
        if (!isObject(fu) || typeof fu.question !== "string" || !fu.question) return { ok: false, reason: fwhere + ": question must be a non-empty string" };
        var fbad = checkChoices(fwhere, fu.choices, unsure);
        if (fbad) return { ok: false, reason: fbad };
      }
    }
    return { ok: true };
  }

  /** The link target for a quote's url: the parsed URL when it is https, else null. @param {unknown} url @returns {string|null} */
  function httpsHref(url) {
    try {
      var u = new URL(String(url));
      return u.protocol === "https:" ? u.href : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * The item's facts and quotes, every string written with textContent. Null when the item
   * carries none.
   * @param {Document} doc @param {ItemDetails|undefined} details @returns {HTMLElement|null}
   */
  function renderDetails(doc, details) {
    if (!details) return null;
    var box = doc.createElement("div");
    box.className = "details";
    if (details.facts && details.facts.length) {
      var facts = doc.createElement("ul");
      facts.className = "facts";
      details.facts.forEach(function (f) {
        var li = doc.createElement("li");
        li.textContent = String(f);
        facts.appendChild(li);
      });
      box.appendChild(facts);
    }
    (details.quotes || []).forEach(function (q) {
      var quote = doc.createElement("blockquote");
      quote.className = "quote";
      var text = doc.createElement("p");
      text.textContent = String(q.text);
      quote.appendChild(text);
      var href = httpsHref(q.url);
      if (href) {
        var a = doc.createElement("a");
        a.href = href;
        a.rel = "noopener noreferrer";
        a.target = "_blank";
        a.textContent = new URL(href).hostname;
        quote.appendChild(a);
      }
      box.appendChild(quote);
    });
    return box.childNodes.length ? box : null;
  }

  /**
   * Render one item into `container` (an element or a DOM-provider's created node), in its kind's
   * layout.
   * @param {Document} doc
   * @param {HTMLElement} container - emptied and filled with the item card
   * @param {ReviewItem} item
   * @param {Decided|null} decided - the committed answer for this item, or null
   * @param {ReviewConfig} config - the page's review semantics, keyed by item.stratum
   * @param {RenderOpts} [opts]
   *   reveal: whether a committed item may show the machine answer (hosted scored items: false;
   *   practice items: true). Never reveals before a commit, nor for an item with no machine_verdict.
   *   pending: a first-step value awaiting its follow-up answer; shows that follow-up step.
   *   flags, note: a comparison item's flags and note not yet saved (else the committed answer's).
   *   stay: the render redraws the item shown (a flag set): the comparison card takes focus without
   *   scrolling, so the reviewer stays where they were reading.
   */
  function renderReviewItem(doc, container, item, decided, config, opts) {
    /** @type {RenderOpts} */
    var o = opts || {};
    var kc = kindFor(config, item.stratum);
    if (kc.partition) { renderPartitionItem(doc, container, item, decided, config, kc, o); return; }
    // validateReviewItem has held an item of a comparison kind to a ComparisonItem
    if (layoutOf(kc) === "comparison") { renderComparisonItem(doc, container, /** @type {ComparisonItem} */ (item), decided, config, kc, o); return; }
    var pending = stepFor(kc, o.pending);
    var question = pending ? pending.followUp.question : kc.question;
    var choices = pending ? pending.followUp.choices : kc.choices;
    var onChoose = o.onChoose, onPending = o.onPending;
    container.textContent = "";

    var head = renderHead(doc, item, question, o);
    var card = head.card, q = head.q;

    var names = doc.createElement("div");
    names.className = "names";
    (item.names || []).forEach(function (n) {
      var el = doc.createElement("div");
      el.className = "name";
      el.textContent = n; // textContent — never innerHTML — so an entity name can't inject markup
      names.appendChild(el);
    });
    card.appendChild(names);

    var details = renderDetails(doc, item.details);
    if (details) card.appendChild(details);

    if (pending) {
      var step = doc.createElement("div");
      step.className = "step";
      step.textContent = "Your answer: " + pending.label;
      card.appendChild(step);
    }

    // The choices and the unsure choice form one group, laid out from the step's labels.
    var answers = doc.createElement("div");
    answers.className = "answers layout-" + choiceLayout(choices);
    var choiceRow = doc.createElement("div");
    choiceRow.className = "choices";
    choices.forEach(function (pair, i) {
      var val = pair[0], label = pair[1], meaning = pair[2];
      var b = doc.createElement("button");
      var selected = false;
      var shownDetail = null;
      if (pending) {
        var first = pending.verdict;
        b.setAttribute("data-detail", val);
        selected = !!decided && decided.verdict === first && decided.detail === val;
        b.onclick = function () { if (onChoose) onChoose(first, val); };
      } else {
        b.setAttribute("data-verdict", val);
        var via = stepFor(kc, val);
        if (decided && decided.verdict === val) {
          selected = true;
          // A committed two-step answer names its follow-up on the first-step button it went through.
          if (via && decided.detail != null) shownDetail = labelOf(via.followUp.choices, decided.detail);
        }
        b.onclick = via
          ? function () { if (onPending) onPending(val); }
          : function () { if (onChoose) onChoose(val, null); };
      }
      keyedLabel(doc, b, String(i + 1), label + (shownDetail ? " · " + shownDetail : ""), meaning);
      if (selected) b.classList.add("primary");
      choiceRow.appendChild(b);
    });
    answers.appendChild(choiceRow);

    var unsureRow = renderUnsure(doc, decided, config, o);
    if (pending) {
      var back = doc.createElement("button");
      back.className = "secondary step-back";
      back.textContent = "[Esc] Change answer";
      back.onclick = function () { if (onPending) onPending(null); };
      unsureRow.appendChild(back);
    }
    answers.appendChild(unsureRow);
    card.appendChild(answers);

    // Reveal: only when committed AND the shell allows it AND there is a machine answer. This is the
    // blindness gate — an unrevealed item never renders machine_verdict anywhere in the DOM.
    var reveal = doc.createElement("div");
    reveal.className = "reveal";
    reveal.setAttribute("data-testid", "reveal");
    reveal.setAttribute("role", "status"); // live region: announce agree/disagree when it appears post-commit
    reveal.setAttribute("aria-live", "polite");
    var machine = item.machine_verdict;
    if (decided && o.reveal && machine != null) {
      reveal.classList.add("show");
      var machineDetail = item.machine_detail == null ? null : item.machine_detail;
      var detailText = machineDetail && machineDetail !== "entity" ? " (" + machineDetail + ")" : "";
      var verdictSpan = doc.createElement("span");
      verdictSpan.className = "verdict";
      var panelLine = doc.createElement("div");
      if (decided.verdict === config.unsure) {
        reveal.classList.add("neutral");
        verdictSpan.textContent = "— Marked unsure (excluded from the agreement rate)";
      } else {
        // A two-step answer agrees only when its follow-up matches too; elsewhere machine_detail is
        // descriptive context, not part of the answer.
        var agree = decided.verdict === machine
          && (!stepFor(kc, decided.verdict) || decided.detail === machineDetail);
        reveal.classList.add(agree ? "agree" : "disagree");
        verdictSpan.textContent = agree ? "✓ You agree with the panel" : "✗ You disagree with the panel";
      }
      panelLine.textContent = "Panel said: " + machine + detailText;
      reveal.appendChild(verdictSpan);
      reveal.appendChild(panelLine);
    }
    card.appendChild(reveal);

    card.appendChild(renderNav(doc, o));

    container.appendChild(card);
    // Move focus into the freshly-rendered card so a keyboard/SR user isn't dropped to <body> on every
    // choice/nav action. focus() on a detached node (jsdom tests) is a harmless no-op.
    q.focus();
  }

  /**
   * The card with its kind chip and its question, the question carrying the item's position for a
   * screen reader.
   * @param {Document} doc @param {ReviewItem} item @param {string} question @param {RenderOpts} o
   * @returns {{ card: HTMLElement, q: HTMLElement }}
   */
  function renderHead(doc, item, question, o) {
    var card = doc.createElement("div");
    card.className = "card";

    var chip = doc.createElement("span");
    chip.className = "chip";
    chip.textContent = item.stratum + " · " + item.country_iso3;
    card.appendChild(chip);

    var q = doc.createElement("div");
    q.className = "q";
    q.setAttribute("tabindex", "-1"); // focus target after each render — keeps keyboard/SR continuity
    q.textContent = question; // visible: the clean question
    // SR-only: prefix the item's position so a screen-reader user hears progress on every render.
    q.setAttribute("aria-label", "Item " + (o.position || 0) + " of " + (o.total || 0) + ". " + question);
    card.appendChild(q);
    return { card: card, q: q };
  }

  /** The unsure button's row. @param {Document} doc @param {Decided|null} decided @param {ReviewConfig} config @param {RenderOpts} o @returns {HTMLElement} */
  function renderUnsure(doc, decided, config, o) {
    var unsureRow = doc.createElement("div");
    unsureRow.className = "unsure-row";
    var unsureBtn = doc.createElement("button");
    unsureBtn.className = "unsure";
    unsureBtn.setAttribute("data-verdict", config.unsure);
    keyedLabel(doc, unsureBtn, "u", "Unsure / can’t determine");
    if (decided && decided.verdict === config.unsure) unsureBtn.classList.add("primary");
    unsureBtn.onclick = function () { if (o.onChoose) o.onChoose(config.unsure, null); };
    unsureRow.appendChild(unsureBtn);
    return unsureRow;
  }

  /** The previous / position / next row. @param {Document} doc @param {RenderOpts} o @returns {HTMLElement} */
  function renderNav(doc, o) {
    var nav = doc.createElement("div");
    nav.className = "nav";
    var prev = doc.createElement("button");
    prev.textContent = "← Prev";
    prev.onclick = function () { if (o.onPrev) o.onPrev(); };
    var pos = doc.createElement("span");
    pos.className = "chip";
    pos.textContent = (o.position || 0) + " / " + (o.total || 0);
    var nextBtn = doc.createElement("button");
    nextBtn.textContent = "Next →";
    nextBtn.onclick = function () { if (o.onNext) o.onNext(); };
    nav.appendChild(prev); nav.appendChild(pos); nav.appendChild(nextBtn);
    return nav;
  }

  // ---- the comparison card ---------------------------------------------------------------------

  /**
   * What a record key of a comparison item reads as on its card: a subject's role, an other record's
   * name. validateReviewItem holds every key a citation or a weighed fact names to one of the item's
   * records.
   * @param {ComparisonItem} item @param {string} key @returns {string}
   */
  function recordName(item, key) {
    for (var i = 0; i < item.subjects.length; i++) {
      var s = /** @type {Subject} */ (item.subjects[i]);
      if (s.key === key) return s.role;
    }
    for (var j = 0; j < item.others.length; j++) {
      var o = /** @type {OtherRecord} */ (item.others[j]);
      if (o.key === key) return o.name;
    }
    return key;
  }

  /**
   * The name the kind's config gives a choice value: the proposed answer's one source for the
   * proposal's headline and the Accept button. Null for a value that is no choice of the kind.
   * @param {KindConfig} kc @param {string|null} value @returns {string|null}
   */
  function choiceName(kc, value) {
    var found = null;
    (kc.choices || []).forEach(function (c) { if (c[0] === value) found = c[1]; });
    return found;
  }

  /**
   * A judge's answer as the card words it: a choice as the kind's config names it, an insufficient
   * answer as the publisher's sentence. validateReviewItem holds a judge's choice to the kind's choices.
   * @param {KindConfig} kc @param {Answer} answer @returns {string}
   */
  function answerText(kc, answer) {
    if ("unsettled" in answer) return answer.unsettled;
    return /** @type {string} */ (choiceName(kc, answer.choice));
  }

  /**
   * The line the card's status slot shows for a committed answer: saved, saved as unsure, or saved as a
   * correction of the proposal. Empty for an undecided item. The shell writes the same line when it
   * confirms a commit on the card, before the card advances.
   * @param {ReviewItem} item @param {Decided|null} decided @param {ReviewConfig} config @returns {string}
   */
  function savedText(item, decided, config) {
    if (!decided) return "";
    if (decided.verdict === config.unsure) return "✓ Saved as unsure";
    var proposed = proposedOf(item);
    return proposed != null && decided.verdict !== proposed ? "✓ Saved — you corrected the proposal" : "✓ Saved";
  }

  /** A probability as a whole percentage. @param {number} p @returns {string} */
  function percent(p) { return Math.round(p * 100) + "%"; }

  /**
   * `text` with each claim id Opus cites (`cited`) that names a claim of the research a link to that
   * claim. An id is matched as a whole token (no letter, digit or underscore either side) and with its
   * case, so a "C2" in a project's name is no claim c2.
   * @param {Document} doc @param {string} text @param {string[]} cited @param {Record<string, HTMLElement>} claimEls
   * @returns {DocumentFragment}
   */
  function withCitations(doc, text, cited, claimEls) {
    var frag = doc.createDocumentFragment();
    var ids = cited.filter(function (id) { return own(claimEls, id); }).sort(function (a, b) { return b.length - a.length; });
    if (!ids.length) { frag.appendChild(doc.createTextNode(text)); return frag; }
    var re = new RegExp("(?<![A-Za-z0-9_])(" + ids.map(function (id) { return id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }).join("|") + ")(?![A-Za-z0-9_])", "g");
    var last = 0, m;
    while ((m = re.exec(text))) {
      var id = /** @type {string} */ (m[1]);
      const target = /** @type {HTMLElement} */ (claimEls[id]); // const: the click handler reads it
      frag.appendChild(doc.createTextNode(text.slice(last, m.index)));
      var a = /** @type {HTMLAnchorElement} */ (el(doc, "a", "cite", id));
      a.href = "#claim-" + id;
      a.title = "Claim " + id + " in the research below";
      a.onclick = function (e) {
        e.preventDefault(); // the page's address carries its token fragment; a claim link must not replace it
        if (typeof target.scrollIntoView === "function") target.scrollIntoView({ block: "start" });
        target.focus();
      };
      frag.appendChild(a);
      last = m.index + m[0].length;
    }
    frag.appendChild(doc.createTextNode(text.slice(last)));
    return frag;
  }

  /**
   * The records header: the question, then each subject named by its role and kind, with the countries
   * it names (no country line when it names none).
   * @param {Document} doc @param {ComparisonItem} item @param {string} question @param {RenderOpts} o
   * @returns {{ card: HTMLElement, q: HTMLElement }}
   */
  function renderRecords(doc, item, question, o) {
    var card = el(doc, "section", "card cmp-records");
    var q = el(doc, "h2", "q cmp-q", question);
    q.setAttribute("tabindex", "-1"); // focus target after each render — keeps keyboard/SR continuity
    q.setAttribute("aria-label", "Item " + (o.position || 0) + " of " + (o.total || 0) + ". " + question);
    card.appendChild(q);
    var pair = el(doc, "div", "cmp-pair");
    item.subjects.forEach(function (s) {
      var rec = el(doc, "div", "cmp-rec");
      rec.appendChild(el(doc, "div", "cmp-kind", s.role + " · " + s.kind));
      rec.appendChild(el(doc, "div", "cmp-name", s.name));
      if (s.countries.length) rec.appendChild(el(doc, "div", "cmp-sub", s.countries.join(", ")));
      pair.appendChild(rec);
    });
    card.appendChild(pair);
    item.notices.forEach(function (n) { card.appendChild(el(doc, "p", "cmp-notice", n)); });
    return { card: card, q: q };
  }

  /**
   * One judge's position, as a box: its answer (answerText) or why it gave none, and Jev's
   * probabilities.
   * @param {Document} doc @param {KindConfig} kc @param {string} name @param {OpusArm|JevArm} arm @returns {HTMLElement}
   */
  function judgeBox(doc, kc, name, arm) {
    var box = el(doc, "div", "cmp-judge");
    box.appendChild(el(doc, "div", "cmp-judge-name", name));
    if (!("said" in arm)) { box.appendChild(el(doc, "div", "cmp-judge-missing", arm.missing)); return box; }
    box.appendChild(el(doc, "div", "cmp-judge-answer", answerText(kc, arm.said.answer)));
    if ("probabilities" in arm.said) {
      var row = el(doc, "div", "cmp-probs");
      arm.said.probabilities.forEach(function (pr) { row.appendChild(el(doc, "span", "cmp-prob", pr[0] + " " + percent(pr[1]))); });
      box.appendChild(row);
    }
    return box;
  }

  /**
   * What the judges' answers are together, as the card says it under "No agreed answer". Null when
   * they agree. One case per value of the closed set; validateReviewItem refuses any other.
   * @param {Together} together @returns {string|null}
   */
  function togetherSentence(together) {
    switch (together) {
      case "same": return null;
      case "doubted": return "A judge found the evidence insufficient";
      case "differ": return "The judges disagree";
      case "one": return "One judge answered";
      case "off_pin": return "Jev's answer is not counted";
      default: throw new Error("no sentence for together " + JSON.stringify(together));
    }
  }

  /**
   * The proposal: its answer and who gives it on one line, the judges' positions when they have no
   * agreed answer, Opus's rationale with its cited claims linked to the research, the facts it weighed
   * grouped by record, and why the question is on the page. The proposed answer reads as the config
   * names its choice.
   * @param {Document} doc @param {ComparisonItem} item @param {KindConfig} kc @param {Record<string, HTMLElement>} claimEls
   * @returns {HTMLElement}
   */
  function renderProposal(doc, item, kc, claimEls) {
    var p = item.proposal;
    var proposedName = choiceName(kc, proposedOf(item));
    var card = el(doc, "section", "card cmp-proposal" + (proposedName == null ? " open" : ""));
    card.appendChild(el(doc, "p", "cmp-eyebrow", "Proposed answer"));
    var head = el(doc, "div", "cmp-prop-head");
    card.appendChild(head);
    switch (p.by) {
      case "judges": {
        var opus = p.opus, jev = p.jev;
        var sentence = togetherSentence(p.together);
        if (sentence == null && proposedName != null && "said" in jev) {
          head.appendChild(el(doc, "span", "cmp-prop-answer", proposedName));
          head.appendChild(el(doc, "span", "cmp-prop-by", "Both judges agree"));
          head.appendChild(el(doc, "span", "cmp-prob", "Jev: " + answerText(kc, jev.said.answer) + ", " + percent(jev.said.probability)));
        } else {
          head.appendChild(el(doc, "span", "cmp-prop-answer", "No agreed answer"));
          head.appendChild(el(doc, "span", "cmp-prop-by", sentence || ""));
          var judges = el(doc, "div", "cmp-judges");
          judges.appendChild(judgeBox(doc, kc, "Opus", opus));
          judges.appendChild(judgeBox(doc, kc, "Jev", jev));
          card.appendChild(judges);
        }
        if ("said" in opus) {
          var rationale = el(doc, "p", "cmp-rationale");
          if (sentence != null) rationale.appendChild(el(doc, "strong", null, "Opus: "));
          rationale.appendChild(withCitations(doc, opus.said.rationale, opus.said.cited, claimEls));
          card.appendChild(rationale);
          var weighed = renderWeighed(doc, item, opus.said.facts);
          if (weighed) card.appendChild(weighed);
        }
        break;
      }
      case "rule":
        head.appendChild(el(doc, "span", "cmp-prop-answer", proposedName || ""));
        head.appendChild(el(doc, "span", "cmp-prop-by", p.rule));
        break;
      case "none":
        head.appendChild(el(doc, "span", "cmp-prop-answer", "No proposal"));
        card.appendChild(el(doc, "p", "cmp-rationale", "Nothing proposes an answer to this question: decide from the records and the research below, or mark it unsure."));
        break;
      default:
        throw new Error("no proposal by " + JSON.stringify(/** @type {{by: unknown}} */ (p).by));
    }
    if (item.why) card.appendChild(el(doc, "p", "cmp-why", "Why it is here: " + item.why));
    return card;
  }

  /**
   * "Facts it weighed — Project: name, country · Site: …": the labels of the facts, grouped by the
   * record each is of, in the order the records first appear. Null when it weighed none.
   * @param {Document} doc @param {ComparisonItem} item @param {WeighedFact[]} facts @returns {HTMLElement|null}
   */
  function renderWeighed(doc, item, facts) {
    if (!facts.length) return null;
    /** @type {string[]} */
    var order = [];
    /** @type {Record<string, string[]>} */
    var labels = {};
    facts.forEach(function (f) {
      var who = recordName(item, f.record);
      var list = own(labels, who) ? labels[who] : undefined;
      if (!list) { list = []; labels[who] = list; order.push(who); }
      if (list.indexOf(f.label) === -1) list.push(f.label);
    });
    var line = el(doc, "p", "cmp-weighed", "Facts it weighed — ");
    order.forEach(function (who, i) {
      if (i) line.appendChild(doc.createTextNode(" · "));
      line.appendChild(el(doc, "b", null, who + ": "));
      line.appendChild(doc.createTextNode((labels[who] || []).join(", ")));
    });
    return line;
  }

  /**
   * One field of a record, in a comparison cell or under an other record: its label when it is not the
   * concept's own name, then its value: a list shows LIST_SHOWN entries and "and N more", and a link
   * (Location's map) is followed only when it is https.
   * @param {Document} doc @param {Field} f @param {string|null} concept @returns {HTMLElement}
   */
  function renderField(doc, f, concept) {
    var v = el(doc, "div", "cmp-v");
    if (f.label !== concept) v.appendChild(el(doc, "span", "cmp-lbl", f.label));
    var href = f.link === undefined ? null : httpsHref(f.link);
    var value = f.value;
    if (href) {
      var a = /** @type {HTMLAnchorElement} */ (el(doc, "a", null, (isList(value) ? value.join(", ") : value) + " ↗"));
      a.href = href;
      a.rel = "noopener noreferrer";
      a.target = "_blank";
      v.appendChild(a);
    } else if (isList(value)) {
      var shown = value.slice(0, LIST_SHOWN), rest = value.slice(LIST_SHOWN);
      v.appendChild(doc.createTextNode(shown.join(", ")));
      if (rest.length) {
        const more = el(doc, "span", "cmp-rest hidden", ", " + rest.join(", ")); // const: the toggle below reads it
        const toggle = el(doc, "button", "cmp-more", "and " + rest.length + " more");
        toggle.setAttribute("aria-expanded", "false");
        toggle.onclick = function () {
          var open = more.classList.toggle("hidden") === false;
          toggle.textContent = open ? "show fewer" : "and " + rest.length + " more";
          toggle.setAttribute("aria-expanded", String(open));
        };
        v.appendChild(more);
        v.appendChild(doc.createTextNode(" "));
        v.appendChild(toggle);
      }
    } else {
      v.appendChild(doc.createTextNode(value));
    }
    return v;
  }

  /**
   * Whether a row is tinted as reading the same: a fact row whose every subject's cell holds a field,
   * the cells' values, stringified and case-folded and joined in order, all equal. An identity row (a
   * record's name) is never tinted: two records named alike is what the reviewer checks, not a sign
   * they agree.
   * @param {ConceptRow} row @returns {boolean}
   */
  function readsSame(row) {
    if (row.group !== "fact" || row.cells.length < 2) return false;
    var texts = row.cells.map(function (cell) {
      return cell.map(function (f) { return (isList(f.value) ? f.value.join(", ") : f.value).toLowerCase(); }).join("|");
    });
    var first = texts[0];
    return !!first && texts.every(function (t) { return t === first; });
  }

  /**
   * The comparison table: one row per concept, each subject a column; the source rows in a collapsed
   * group under it, summarised by the kind's `source_details`.
   * @param {Document} doc @param {ComparisonItem} item @param {KindConfig} kc @returns {HTMLElement}
   */
  function renderComparison(doc, item, kc) {
    var card = el(doc, "section", "card cmp-compare");
    card.appendChild(el(doc, "p", "cmp-eyebrow", "The records, field by field"));
    var cols = String(Math.min(item.subjects.length, 4));
    /** @param {ConceptRow[]} rows @param {boolean} withHead @returns {HTMLElement} */
    function table(rows, withHead) {
      var t = el(doc, "table", "cmp-table");
      t.setAttribute("data-cols", cols);
      if (withHead) {
        var thead = el(doc, "thead"), hr = el(doc, "tr");
        hr.appendChild(el(doc, "th", "cmp-concept"));
        item.subjects.forEach(function (s) {
          var th = el(doc, "th", null, s.role + " · " + s.kind);
          th.setAttribute("scope", "col");
          hr.appendChild(th);
        });
        thead.appendChild(hr);
        t.appendChild(thead);
      }
      var body = el(doc, "tbody");
      rows.forEach(function (row) {
        var tr = el(doc, "tr", readsSame(row) ? "same" : null);
        tr.setAttribute("data-group", row.group);
        var th = el(doc, "th", "cmp-concept", row.concept);
        th.setAttribute("scope", "row");
        tr.appendChild(th);
        row.cells.forEach(function (cell) {
          var td = el(doc, "td", cell.length ? null : "empty");
          if (!cell.length) td.setAttribute("aria-label", "none");
          cell.forEach(function (f) { td.appendChild(renderField(doc, f, row.concept)); });
          tr.appendChild(td);
        });
        body.appendChild(tr);
      });
      t.appendChild(body);
      return t;
    }
    var shown = item.comparison.filter(function (r) { return r.group !== "source"; });
    var collapsed = item.comparison.filter(function (r) { return r.group === "source"; });
    card.appendChild(table(shown, true));
    if (collapsed.length) {
      var details = el(doc, "details", "cmp-extra");
      details.appendChild(el(doc, "summary", null, kc.source_details || ""));
      details.appendChild(table(collapsed, false));
      card.appendChild(details);
    }
    return card;
  }

  /**
   * One citation as verify checked it: its found or refused mark, one case per status, and a refused
   * one's reason; a quote as a blockquote with its page (a link only when it is https) or the sentence
   * withholding it; a cited value or row through the record it is of.
   * @param {Document} doc @param {ComparisonItem} item @param {Citation} c @returns {HTMLElement}
   */
  function renderCitation(doc, item, c) {
    var li = el(doc, "li", c.status);
    switch (c.status) {
      case "verified": li.appendChild(el(doc, "span", "cmp-sr", "Found: ")); break;
      case "refused": li.appendChild(el(doc, "span", "cmp-sr", "Refused: ")); break;
      default: throw new Error("no mark for citation status " + JSON.stringify(c.status));
    }
    if (c.kind === "quote") {
      li.appendChild(el(doc, "blockquote", null, "“" + c.quote + "”"));
      var src = el(doc, "div", "cmp-src");
      var page = c.page;
      if ("url" in page) {
        var href = httpsHref(page.url);
        if (href) {
          var a = /** @type {HTMLAnchorElement} */ (el(doc, "a", null, new URL(href).hostname.replace(/^www\./, "")));
          a.href = href;
          a.rel = "noopener noreferrer";
          a.target = "_blank";
          src.appendChild(a);
        } else {
          src.appendChild(doc.createTextNode(page.url));
        }
      } else {
        src.appendChild(doc.createTextNode("Page not linked: " + page.withheld));
      }
      li.appendChild(src);
    } else {
      li.appendChild(doc.createTextNode(recordName(item, c.record) + " · " + (c.kind === "value" ? c.label + ": " + c.value : c.sentence)));
    }
    if (c.reason != null) li.appendChild(el(doc, "div", "cmp-reason", c.reason));
    return li;
  }

  /**
   * The research: each claim with its citations, or the publisher's sentence saying it holds none; then
   * the other records it cites and the site register. Fills `claimEls` with each claim's element by id,
   * so the rationale's citations can reach them.
   * @param {Document} doc @param {ComparisonItem} item @param {Record<string, HTMLElement>} claimEls @returns {HTMLElement}
   */
  function renderResearch(doc, item, claimEls) {
    var card = el(doc, "section", "card cmp-research");
    card.appendChild(el(doc, "p", "cmp-eyebrow", "The research"));
    var research = item.research;
    if ("none" in research) {
      card.appendChild(el(doc, "p", "cmp-help", research.none));
    } else {
      card.appendChild(el(doc, "p", "cmp-help", "Each claim the researcher made about these records, with its citations as the tool checked them: ✓ found in the stored page or source, ✗ refused."));
      research.claims.forEach(function (c) {
        var box = el(doc, "div", "cmp-claim");
        box.id = "claim-" + c.id;
        box.setAttribute("tabindex", "-1");
        var p = el(doc, "p");
        p.appendChild(el(doc, "span", "cmp-cid", c.id));
        p.appendChild(doc.createTextNode(c.statement));
        box.appendChild(p);
        var list = el(doc, "ul", "cmp-ev");
        c.evidence.forEach(function (e) { list.appendChild(renderCitation(doc, item, e)); });
        box.appendChild(list);
        card.appendChild(box);
        claimEls[c.id] = box;
      });
    }
    if (item.others.length) {
      card.appendChild(el(doc, "p", "cmp-eyebrow cmp-others-head", "Other records the research cited"));
      card.appendChild(el(doc, "p", "cmp-help cmp-others-help", "The researcher checked this question against these records too: a claim placing the project at one of them bears on this question."));
      var others = el(doc, "ul", "cmp-others");
      item.others.forEach(function (o) {
        var li = el(doc, "li");
        li.appendChild(el(doc, "span", "cmp-kind", o.kind));
        li.appendChild(el(doc, "strong", null, o.name));
        if (o.fields.length) {
          var fields = el(doc, "div", "cmp-other-fields");
          o.fields.forEach(function (f) { fields.appendChild(renderField(doc, f, null)); });
          li.appendChild(fields);
        }
        others.appendChild(li);
      });
      card.appendChild(others);
    }
    if (item.register.length) {
      card.appendChild(el(doc, "p", "cmp-eyebrow cmp-register-head", "Site register"));
      item.register.forEach(function (r) { card.appendChild(el(doc, "p", "cmp-help cmp-register", r)); });
    }
    return card;
  }

  /**
   * A choice of the decision panel: its key, its name over its meaning, "proposed" on the proposed one.
   * @param {Document} doc @param {string} key @param {string} value @param {string} name @param {string|undefined} meaning
   * @param {boolean} proposed @param {boolean} selected @param {() => void} onclick @returns {HTMLElement}
   */
  function decisionChoice(doc, key, value, name, meaning, proposed, selected, onclick) {
    var li = el(doc, "li");
    var b = el(doc, "button", "cmp-choice" + (proposed ? " proposed" : "") + (selected ? " primary" : ""));
    b.setAttribute("data-verdict", value);
    b.appendChild(el(doc, "span", "key", key));
    var txt = el(doc, "span", "cmp-txt");
    txt.appendChild(el(doc, "b", null, name));
    if (meaning) txt.appendChild(el(doc, "span", "meaning", meaning));
    b.appendChild(txt);
    if (proposed) b.appendChild(el(doc, "span", "cmp-tag", "proposed"));
    b.onclick = onclick;
    li.appendChild(b);
    return li;
  }

  /** A row of keyboard hints, each a key and what it does. @param {Document} doc @param {[string, string][]} hints @returns {HTMLElement} */
  function keyHints(doc, hints) {
    var p = el(doc, "p", "cmp-keys");
    hints.forEach(function (h, i) {
      if (i) p.appendChild(doc.createTextNode(" · "));
      p.appendChild(el(doc, "kbd", null, h[0]));
      p.appendChild(doc.createTextNode(" " + h[1]));
    });
    return p;
  }

  /**
   * The line saying where the reviewer's saved answers stand, when they are not known: loading, or
   * not read (with a retry). Null when they are known. One case per state.
   * @param {Document} doc @param {SavedState} saved @param {RenderOpts} o @returns {HTMLElement|null}
   */
  function savedLine(doc, saved, o) {
    switch (saved) {
      case "known": return null;
      case "loading": {
        var line = el(doc, "div", "cmp-load", "Loading your saved answers…");
        line.setAttribute("role", "status");
        return line;
      }
      case "unknown": {
        var banner = el(doc, "div", "cmp-load failed", "Your saved answers could not be read, so no proposal is offered to accept. Choose an answer, or try again.");
        banner.setAttribute("role", "alert");
        var retry = el(doc, "button", "secondary cmp-retry", "Try again");
        retry.onclick = function () { if (o.onRetryLoad) o.onRetryLoad(); };
        banner.appendChild(retry);
        return banner;
      }
      default: throw new Error("no line for saved answers " + JSON.stringify(saved));
    }
  }

  /**
   * The proposed choice the reviewer can accept with one key: the item's proposed value when the item is
   * unanswered and the reviewer's saved answers are known; null otherwise.
   * @param {ReviewItem} item @param {Decided|null|undefined} decided @param {SavedState|undefined} saved @returns {string|null}
   */
  function acceptable(item, decided, saved) {
    return !decided && (saved || "known") === "known" ? proposedOf(item) : null;
  }

  /**
   * Render a comparison item: the records header, the proposal, the comparison and the research in the
   * main column, the decision in a column beside them (a bottom dock and a sheet on a phone). The
   * proposed choice, when there is one, is marked, and offered as one-key accept on an unanswered item
   * once the reviewer's saved answers are known (opts.saved, "known" when not given). Flags and the
   * note are the caller's state (opts.flags, opts.note), else the committed answer's.
   * @param {Document} doc @param {HTMLElement} container @param {ComparisonItem} item @param {Decided|null} decided
   * @param {ReviewConfig} config @param {KindConfig} kc @param {RenderOpts} o
   */
  function renderComparisonItem(doc, container, item, decided, config, kc, o) {
    container.textContent = "";
    var onChoose = o.onChoose;
    var proposed = proposedOf(item);
    var accept = acceptable(item, decided, o.saved);
    var acceptName = choiceName(kc, accept);
    var unsureChoice = kc.unsure_choice || [config.unsure, ""];
    var root = el(doc, "div", "cmp");
    var main = el(doc, "div", "cmp-main");
    var load = savedLine(doc, o.saved || "known", o);
    if (load) main.appendChild(load);
    /** @type {Record<string, HTMLElement>} */
    var claimEls = {};
    var head = renderRecords(doc, item, kc.question, o);
    main.appendChild(head.card);
    var research = renderResearch(doc, item, claimEls); // first, so the rationale can link its claims
    main.appendChild(renderProposal(doc, item, kc, claimEls));
    main.appendChild(renderComparison(doc, item, kc));
    main.appendChild(research);
    root.appendChild(main);

    /** @param {string} value */
    function choose(value) { closeSheet(); if (onChoose) onChoose(value, null); }

    var aside = el(doc, "div", "cmp-aside");
    var panel = el(doc, "section", "card cmp-decision");
    panel.id = "cmp-decision";
    var panelHead = el(doc, "div", "cmp-panel-head");
    panelHead.appendChild(el(doc, "p", "cmp-eyebrow", "Your answer"));
    var close = el(doc, "button", "secondary cmp-close", "Close");
    close.onclick = function () { closeSheet(); };
    panelHead.appendChild(close);
    panel.appendChild(panelHead);

    var acceptBtn = /** @type {HTMLButtonElement} */ (el(doc, "button", "primary cmp-accept"));
    acceptBtn.setAttribute("data-accept", "");
    if (decided) {
      acceptBtn.textContent = "Next question";
      acceptBtn.appendChild(el(doc, "span", "key", "Enter"));
      acceptBtn.onclick = function () { if (o.onNext) o.onNext(); };
    } else if (accept != null && acceptName != null) {
      const value = accept; // const: its narrowing reaches the click handler
      acceptBtn.textContent = "Accept: " + acceptName;
      acceptBtn.appendChild(el(doc, "span", "key", "Enter"));
      acceptBtn.onclick = function () { choose(value); };
    } else {
      acceptBtn.textContent = "Choose an answer below";
      acceptBtn.disabled = true;
    }
    panel.appendChild(acceptBtn);

    var list = el(doc, "ul", "cmp-choices");
    (kc.choices || []).forEach(function (c, i) {
      list.appendChild(decisionChoice(doc, String(i + 1), c[0], c[1], c[2], c[0] === proposed, !!decided && decided.verdict === c[0],
        function () { choose(c[0]); }));
    });
    list.appendChild(decisionChoice(doc, "u", config.unsure, unsureChoice[0], unsureChoice[1], false,
      !!decided && decided.verdict === config.unsure, function () { choose(config.unsure); }));
    panel.appendChild(list);

    var flags = kc.flags || [];
    if (flags.length) {
      var set = currentFlags(o.flags, decided);
      var flagBox = el(doc, "div", "cmp-flags");
      flags.forEach(function (f, i) {
        var label = el(doc, "label", "cmp-flag");
        var box = /** @type {HTMLInputElement} */ (el(doc, "input"));
        box.type = "checkbox";
        box.setAttribute("data-flag", f[0]);
        box.checked = set.indexOf(f[0]) !== -1;
        box.onchange = function () { if (o.onFlags) o.onFlags(toggleFlag(kc, set, f[0])); };
        label.appendChild(box);
        var text = el(doc, "span", null, f[1]);
        if (i === 0) { text.appendChild(doc.createTextNode(" ")); text.appendChild(el(doc, "kbd", "cmp-flag-key", "f")); }
        label.appendChild(text);
        flagBox.appendChild(label);
      });
      var noteLabel = el(doc, "label", "note cmp-note", "Note (optional)");
      var noteBox = /** @type {HTMLTextAreaElement} */ (el(doc, "textarea"));
      noteBox.setAttribute("data-note", "");
      noteBox.rows = 2;
      noteBox.value = o.note != null ? o.note : (decided && decided.note) || "";
      noteBox.oninput = function () { if (o.onNote) o.onNote(noteBox.value); };
      noteLabel.appendChild(noteBox);
      flagBox.appendChild(noteLabel);
      panel.appendChild(flagBox);
    }

    var slot = el(doc, "div", "status-slot", savedText(item, decided, config));
    slot.setAttribute("role", "status");
    panel.appendChild(slot);
    panel.appendChild(renderNav(doc, o));
    /** @type {[string, string][]} */
    var hints = [];
    if (accept != null) hints.push(["Enter", "accept the proposal"]);
    hints.push(["1–" + (kc.choices || []).length, accept != null ? "another answer" : "answer"], ["u", "unsure"]);
    if (flags.length) hints.push(["f", "flag"]);
    hints.push(["n/p", "next/previous"]);
    if (accept == null) hints.push(["Enter", "next"]);
    panel.appendChild(keyHints(doc, hints));
    aside.appendChild(panel);
    root.appendChild(aside);

    // On a phone the decision panel is a bottom sheet the dock opens; it closes on Close, a tap outside
    // or Escape, and every render (an item change) starts it closed.
    var backdrop = el(doc, "div", "cmp-backdrop");
    backdrop.onclick = function () { closeSheet(); };
    root.appendChild(backdrop);
    var dock = el(doc, "div", "cmp-dock");
    var dockAccept = el(doc, "button", "primary cmp-dock-accept");
    var other = el(doc, "button", "cmp-dock-other", decided ? "Change answer" : "Other answer…");
    other.setAttribute("aria-controls", panel.id);
    other.onclick = function () { openSheet(); };
    if (decided) { dockAccept.textContent = "Next question"; dockAccept.onclick = function () { if (o.onNext) o.onNext(); }; }
    else if (accept != null && acceptName != null) { const value = accept; dockAccept.textContent = "Accept: " + acceptName; dockAccept.onclick = function () { choose(value); }; }
    else { dockAccept.textContent = "Choose an answer"; dockAccept.onclick = function () { openSheet(); }; }
    dock.appendChild(dockAccept);
    dock.appendChild(other);
    root.appendChild(dock);
    function openSheet() {
      panel.classList.add("open");
      backdrop.classList.add("open");
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-modal", "true");
      panel.setAttribute("aria-label", "Your answer");
      var first = /** @type {HTMLElement|null} */ (panel.querySelector(".cmp-choice"));
      if (first) first.focus();
    }
    function closeSheet() {
      if (!panel.classList.contains("open")) return;
      panel.classList.remove("open");
      backdrop.classList.remove("open");
      panel.removeAttribute("role");
      panel.removeAttribute("aria-modal");
      panel.removeAttribute("aria-label");
      other.focus();
    }
    panel.addEventListener("keydown", function (e) {
      if (e.key !== "Escape" || !panel.classList.contains("open")) return;
      e.preventDefault();
      e.stopPropagation(); // the sheet's Escape closes it, and is no review key
      closeSheet();
    });

    container.appendChild(root);
    head.q.focus({ preventScroll: !!o.stay });
  }

  /**
   * Render a partition item: each member with its evidence and a selector, its own project or the same
   * project as a member that is one, then the save button. The draft (opts.draft, else the committed
   * answer's partition, else every member its own project) is the caller's state; a change reports the
   * new draft through onDraft, and the save button commits it. The note (opts.note, else the committed
   * answer's) is the caller's state too. A partition item has no machine answer, so it never reveals one.
   * @param {Document} doc @param {HTMLElement} container @param {ReviewItem} item @param {Decided|null} decided
   * @param {ReviewConfig} config @param {KindConfig} kc @param {RenderOpts} o
   */
  function renderPartitionItem(doc, container, item, decided, config, kc, o) {
    var pc = /** @type {PartitionConfig} */ (kc.partition);
    var members = item.members || [];
    var draft = o.draft || partitionOf(item, decided);
    container.textContent = "";

    var head = renderHead(doc, item, kc.question, o);
    var card = head.card;
    var details = renderDetails(doc, item.details);
    if (details) card.appendChild(details);

    /** @type {HTMLElement|null} */
    var focusTarget = null;
    var list = doc.createElement("ol");
    list.className = "members";
    members.forEach(function (m, index) {
      var li = doc.createElement("li");
      li.className = "member";
      var name = doc.createElement("div");
      name.className = "name";
      name.id = "member-" + index + "-name";
      name.textContent = m.label;
      li.appendChild(name);
      if (m.facts && m.facts.length) {
        var facts = doc.createElement("ul");
        facts.className = "facts";
        facts.id = "member-" + index + "-facts";
        m.facts.forEach(function (f) {
          var fact = doc.createElement("li");
          fact.textContent = String(f);
          facts.appendChild(fact);
        });
        li.appendChild(facts);
      }
      var select = doc.createElement("select");
      select.setAttribute("data-member", m.id);
      // Named by the member's label and described by its evidence, so two members with one label
      // are told apart by what their reports say.
      select.setAttribute("aria-labelledby", name.id);
      if (m.facts && m.facts.length) select.setAttribute("aria-describedby", "member-" + index + "-facts");
      var ownProject = doc.createElement("option");
      ownProject.value = m.id;
      ownProject.textContent = pc.own;
      select.appendChild(ownProject);
      // A member can be joined only to a member that is its own project, so the answer stays a partition.
      members.forEach(function (t) {
        if (t.id === m.id || draft[t.id] !== t.id) return;
        var option = doc.createElement("option");
        option.value = t.id;
        option.textContent = pc.joinedTo + " " + t.label;
        select.appendChild(option);
      });
      select.value = draft[m.id] || m.id;
      select.onchange = function () { if (o.onDraft) o.onDraft(joinMember(draft, m.id, select.value), m.id); };
      li.appendChild(select);
      list.appendChild(li);
      if (o.focusMember === m.id) focusTarget = select;
    });
    card.appendChild(list);

    var choiceRow = doc.createElement("div");
    choiceRow.className = "choices";
    var save = doc.createElement("button");
    save.setAttribute("data-verdict", pc.verdict);
    save.textContent = pc.save;
    var committedNote = (decided && decided.note) || "";
    var note = o.note != null ? o.note : committedNote;
    var saved = !!decided && decided.verdict === pc.verdict && !!decided.partition && samePartition(decided.partition, draft) && note === committedNote;
    if (saved) save.classList.add("primary");
    save.onclick = function () { if (o.onChoose) o.onChoose(pc.verdict, null, draft); };
    choiceRow.appendChild(save);
    if (pc.note) {
      var noteLabel = doc.createElement("label");
      noteLabel.className = "note";
      noteLabel.textContent = pc.note;
      var noteBox = doc.createElement("textarea");
      noteBox.setAttribute("data-note", "");
      noteBox.rows = 2;
      noteBox.value = note;
      noteBox.oninput = function () {
        if (o.onNote) o.onNote(noteBox.value);
        // Typing does not re-render, which would lose the caret; the notice appears in place.
        if (!unsaved.parentNode) card.insertBefore(unsaved, unsureRow);
      };
      noteLabel.appendChild(noteBox);
      card.appendChild(noteLabel);
    }
    card.appendChild(choiceRow);
    var unsureRow = renderUnsure(doc, decided, config, o);
    // An answer being changed is not saved until the save button commits it; say so beside it.
    var unsaved = doc.createElement("div");
    unsaved.className = "unsaved";
    unsaved.setAttribute("role", "status");
    unsaved.textContent = "Not saved yet";
    if ((o.draft || note !== committedNote) && !saved) card.appendChild(unsaved);
    card.appendChild(unsureRow);
    card.appendChild(renderNav(doc, o));

    container.appendChild(card);
    (focusTarget || head.q).focus();
  }

  /**
   * Translate a keydown into a review action. Pure: returns the action name it took (or null), calling
   * the matching handler. 1…N choose the step's N choices ("pending" when the choice opens a follow-up,
   * "choose" when it commits); u = unsure; f toggles the kind's first flag ("flag"); Escape leaves a
   * follow-up step ("back"); Enter accepts the proposed choice of an unanswered item whose saved
   * answers are known ("accept") and is next otherwise; n/ArrowRight = next; p/ArrowLeft = prev. Choice keys are ignored
   * when there is no live item (handlers.item == null).
   * @param {KeyboardEvent} e
   * @param {KeyHandlers} handlers
   * @returns {"next"|"prev"|"choose"|"pending"|"unsure"|"back"|"accept"|"flag"|null}
   */
  function reviewItemKeydown(e, handlers) {
    var key = e.key;
    // A key pressed in a form field (a partition member's selector, a flag, the note) is that field's,
    // and Enter on a button or link activates it: neither is a review action.
    var target = /** @type {Element|null} */ (e.target instanceof Element ? e.target : null);
    var tag = target ? target.tagName : "";
    if (/^(SELECT|INPUT|TEXTAREA)$/.test(tag) || (key === "Enter" && /^(BUTTON|A)$/.test(tag))) return null;
    var item = handlers.item;
    var kc = item ? kindFor(handlers.config, item.stratum) : null;
    var pending = kc ? stepFor(kc, handlers.pending) : null;
    var proposed = item && !pending ? acceptable(item, handlers.decided, handlers.saved) : null;
    if (key === "Enter" && proposed != null) {
      if (e.preventDefault) e.preventDefault();
      if (handlers.onChoose) handlers.onChoose(proposed, null);
      return "accept";
    }
    if (key === "Enter" || key === "n" || key === "ArrowRight") {
      if (e.preventDefault) e.preventDefault();
      if (handlers.onNext) handlers.onNext();
      return "next";
    }
    if (key === "p" || key === "ArrowLeft") {
      if (e.preventDefault) e.preventDefault();
      if (handlers.onPrev) handlers.onPrev();
      return "prev";
    }
    if (!item || !kc) return null;
    if (key === "u") {
      if (handlers.onChoose) handlers.onChoose(handlers.config.unsure, null);
      return "unsure";
    }
    if (key === "f") {
      var first = (kc.flags || [])[0];
      if (!first) return null;
      if (handlers.onFlags) handlers.onFlags(toggleFlag(kc, currentFlags(handlers.flags, handlers.decided), first[0]));
      return "flag";
    }
    if (key === "Escape") {
      if (!pending) return null;
      if (handlers.onPending) handlers.onPending(null);
      return "back";
    }
    if (!/^[1-9]$/.test(key) || kc.partition) return null;
    var choices = pending ? pending.followUp.choices : kc.choices;
    var choice = choices[Number(key) - 1];
    if (!choice) return null;
    if (pending) {
      if (handlers.onChoose) handlers.onChoose(pending.verdict, choice[0]);
      return "choose";
    }
    if (stepFor(kc, choice[0])) {
      if (handlers.onPending) handlers.onPending(choice[0]);
      return "pending";
    }
    if (handlers.onChoose) handlers.onChoose(choice[0], null);
    return "choose";
  }

  var api = {
    MAX_CHOICES: MAX_CHOICES,
    choiceLayout: choiceLayout,
    validateReviewConfig: validateReviewConfig,
    validateReviewItem: validateReviewItem,
    layoutOf: layoutOf,
    kindLayout: kindLayout,
    currentFlags: currentFlags,
    proposedOf: proposedOf,
    savedText: savedText,
    partitionOf: partitionOf,
    joinMember: joinMember,
    renderReviewItem: renderReviewItem,
    reviewItemKeydown: reviewItemKeydown,
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api; // Node tests import here (classic script, script-src 'self')
  } else {
    root.CalibrationReviewWidget = api; // browser global for the page shells
  }
})(typeof window !== "undefined" ? window : this);
