/* Blind-review widget shared by the hosted review pages.

   The per-item blind judgment, rendered by a review page's shell (calibration.js loads it under CSP
   script-src 'self'). Every page passes its own ReviewConfig: the question and the choices for each
   item kind (keyed by item.stratum), and the unsure value. Kept as its own module, not inlined into a
   page, so the review semantics (choices, follow-up step, blind-then-reveal, unsure) and the keyboard
   map are unit-tested once in Node (tests/js/calibration-widget.test.js) rather than only through the DOM.

   Blindness invariant: the machine verdict is rendered ONLY inside the reveal, and the reveal appears
   ONLY after the reviewer has committed (decided != null), the shell permits it (opts.reveal), and the
   item carries a machine_verdict. A caller that never passes reveal:true (the hosted scored items)
   never shows the machine answer at all.

   Two-step choice: a choice whose value has a followUp in its kind's config does not commit. The widget
   calls onPending(value), and the shell renders again with opts.pending = value, which shows the
   follow-up question and its choices in place of the first step. Only the follow-up answer commits, as
   onChoose(value, followUpValue); a value with no follow-up commits at once as onChoose(value, null).
   Unsure commits from either step as onChoose(unsure, null). The pending value is the caller's state,
   passed back in on every render and keydown, so both functions stay pure over their inputs.

   Partition kind: a kind whose config carries `partition` instead of `choices` asks how an item's
   members (item.members) group: each member is its own project or the same project as one that is.
   The answer is a partition, a map from each member's id to the id of the member that is its project
   (itself for one that is), kept a partition by construction: a member can be joined only to a member
   that is its own project, and the members joined to a member follow it when it is joined to another
   (joinMember). The draft is the caller's state, passed back in on every render as opts.draft and
   updated through onDraft; the save button commits onChoose(partition.verdict, null, draft).

   Untrusted text: names and item details are written with textContent, never innerHTML, so a name, a
   fact, a quote or a judge's answer cannot inject markup. A quote's link is rendered only for an https
   URL, with rel="noopener noreferrer".

   renderReviewItem / reviewItemKeydown / validateReviewConfig are pure over their inputs (no globals,
   no I/O); the shells wire persistence and navigation. The module.exports guard is how the Node tests
   import them (classic script, so no ES modules). */

/**
 * @typedef {[string, string]} Choice - [value, label]; the value is what a verdict cell stores
 * @typedef {{ question: string, choices: Choice[] }} FollowUp
 * @typedef {{ verdict: string, own: string, joinedTo: string, save: string }} PartitionConfig - the verdict
 *   a partition answer commits, and the labels of "its own project", "same project as" and the save button
 * @typedef {{ question: string, choices: Choice[], followUp?: Record<string, FollowUp>, partition?: undefined }} ChoiceKind
 * @typedef {{ question: string, partition: PartitionConfig, choices?: undefined, followUp?: undefined }} PartitionKind
 * @typedef {ChoiceKind | PartitionKind} KindConfig - a choice kind (choices) or a partition kind (partition)
 * @typedef {{ kinds: Record<string, KindConfig>, unsure: string }} ReviewConfig
 * @typedef {{ id: string, label: string, facts?: string[] }} ItemMember
 * @typedef {Record<string, string>} Partition - each member's id to the id of the member that is its project
 * @typedef {{ text: string, url: string }} Quote
 * @typedef {{ name: string, answer: string }} Judge
 * @typedef {{ facts?: string[], quotes?: Quote[], judges?: Judge[] }} ItemDetails
 * @typedef {{ item_id: string, stratum: string, country_iso3: string, names?: string[],
 *   details?: ItemDetails, members?: ItemMember[], prior?: Partition, machine_verdict?: string,
 *   machine_detail?: (string|null) }} ReviewItem - a choice kind's item names its `names`; a partition
 *   kind's lists its `members` and the partition its review starts from (`prior`); validateReviewItem
 *   holds an item to its kind
 * @typedef {{ verdict: string, detail: (string|null), partition?: undefined }} ChoiceDecided
 * @typedef {{ verdict: string, detail: null, partition: Partition }} PartitionDecided
 * @typedef {ChoiceDecided | PartitionDecided} Decided
 * @typedef {(verdict: string, detail: (string|null), partition?: Partition) => void} ChooseFn
 * @typedef {(verdict: (string|null)) => void} PendingFn
 * @typedef {(draft: Partition, memberId: string) => void} DraftFn
 * @typedef {{ reveal?: boolean, pending?: (string|null), draft?: (Partition|null), focusMember?: (string|null),
 *   onChoose?: ChooseFn, onPending?: PendingFn, onDraft?: DraftFn,
 *   onPrev?: () => void, onNext?: () => void, position?: number, total?: number }} RenderOpts
 * @typedef {{ item: (ReviewItem|null), config: ReviewConfig, pending?: (string|null), onChoose?: ChooseFn,
 *   onPending?: PendingFn, onNext?: () => void, onPrev?: () => void }} KeyHandlers
 * @typedef {{ verdict: string, label: string, followUp: FollowUp }} PendingStep
 */

(function (/** @type {typeof globalThis & { CalibrationReviewWidget?: typeof import("./review-widget.js") }} */ root) {
  "use strict";

  // Keys 1…9 choose; a step offering more choices than there are digit keys could not be answered
  // from the keyboard.
  var MAX_CHOICES = 9;

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

  /** @param {string} where @param {unknown} choices @param {string} unsure @returns {string|null} */
  function checkChoices(where, choices, unsure) {
    if (!isList(choices) || choices.length < 1 || choices.length > MAX_CHOICES) {
      return where + ": choices must hold 1 to " + MAX_CHOICES + " entries";
    }
    /** @type {Record<string, true>} */
    var seen = {};
    for (var i = 0; i < choices.length; i++) {
      var c = choices[i];
      if (!isList(c) || c.length !== 2 || typeof c[0] !== "string" || !c[0] || typeof c[1] !== "string" || !c[1]) {
        return where + ": choice " + (i + 1) + " must be a [value, label] pair of non-empty strings";
      }
      if (c[0] === unsure) return where + ": choice value " + JSON.stringify(c[0]) + " is the unsure value";
      if (own(seen, c[0])) return where + ": choice value " + JSON.stringify(c[0]) + " appears twice";
      seen[c[0]] = true;
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
   * Check an item against the kind the config gives it: its item_id and country_iso3 are strings; a
   * choice kind's item names at least one name; a partition kind's lists two members or more with
   * distinct non-empty ids and labels, and its `prior`, when present, is a partition of them. A page refuses a data set holding an item that
   * fails, rather than show a card no answer fits.
   * @param {unknown} item @param {ReviewConfig} config @returns {{ ok: true } | { ok: false, reason: string }}
   */
  function validateReviewItem(item, config) {
    if (!isObject(item)) return { ok: false, reason: "item must be an object" };
    var where = "item " + JSON.stringify(item.item_id);
    if (typeof item.item_id !== "string" || typeof item.country_iso3 !== "string") return { ok: false, reason: where + ": item_id and country_iso3 must be strings" };
    var stratum = item.stratum;
    var kc = typeof stratum === "string" && own(config.kinds, stratum) ? config.kinds[stratum] : undefined;
    if (!kc) return { ok: false, reason: where + ": the config defines no kind " + JSON.stringify(stratum) };
    if (!kc.partition) {
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
      if (kc.partition != null) {
        var pbad = checkPartition(where, kc.partition, unsure);
        if (pbad) return { ok: false, reason: pbad };
        continue;
      }
      var bad = checkChoices(where, kc.choices, unsure);
      if (bad) return { ok: false, reason: bad };
      var followUp = kc.followUp;
      if (followUp == null) continue;
      if (!isObject(followUp)) return { ok: false, reason: where + ": followUp must be an object keyed by choice value" };
      // checkChoices has held the choices to [value, label] pairs
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
   * The item's facts, quotes and judges, every string written with textContent. Null when the item
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
    if (details.judges && details.judges.length) {
      var judges = doc.createElement("ul");
      judges.className = "judges";
      details.judges.forEach(function (j) {
        var li = doc.createElement("li");
        var name = doc.createElement("span");
        name.className = "judge-name";
        name.textContent = String(j.name);
        var answer = doc.createElement("span");
        answer.className = "judge-answer";
        answer.textContent = String(j.answer);
        li.appendChild(name);
        li.appendChild(doc.createTextNode(": "));
        li.appendChild(answer);
        judges.appendChild(li);
      });
      box.appendChild(judges);
    }
    return box.childNodes.length ? box : null;
  }

  /**
   * Render one blind item into `container` (an element or a DOM-provider's created node).
   * @param {Document} doc
   * @param {HTMLElement} container - emptied and filled with the item card
   * @param {ReviewItem} item
   * @param {Decided|null} decided - the committed answer for this item, or null
   * @param {ReviewConfig} config - the page's review semantics, keyed by item.stratum
   * @param {RenderOpts} [opts]
   *   reveal: whether a committed item may show the machine answer (hosted scored items: false;
   *   practice items: true). Never reveals before a commit, nor for an item with no machine_verdict.
   *   pending: a first-step value awaiting its follow-up answer; shows that follow-up step.
   */
  function renderReviewItem(doc, container, item, decided, config, opts) {
    /** @type {RenderOpts} */
    var o = opts || {};
    var kc = kindFor(config, item.stratum);
    if (kc.partition) { renderPartitionItem(doc, container, item, decided, config, kc, o); return; }
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

    var choiceRow = doc.createElement("div");
    choiceRow.className = "choices";
    choices.forEach(function (pair, i) {
      var val = pair[0], label = pair[1];
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
      b.textContent = "[" + (i + 1) + "] " + label + (shownDetail ? " · " + shownDetail : "");
      if (selected) b.classList.add("primary");
      choiceRow.appendChild(b);
    });
    card.appendChild(choiceRow);

    var unsureRow = renderUnsure(doc, decided, config, o);
    if (pending) {
      var back = doc.createElement("button");
      back.className = "secondary step-back";
      back.textContent = "[Esc] Change answer";
      back.onclick = function () { if (onPending) onPending(null); };
      unsureRow.appendChild(back);
    }
    card.appendChild(unsureRow);

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
    unsureBtn.textContent = "[u] Unsure / can’t determine";
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

  /**
   * Render a partition item: each member with its evidence and a selector, its own project or the same
   * project as a member that is one, then the save button. The draft (opts.draft, else the committed
   * answer's partition, else every member its own project) is the caller's state; a change reports the
   * new draft through onDraft, and the save button commits it. A partition item has no machine answer,
   * so it never reveals one.
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
    var saved = !!decided && decided.verdict === pc.verdict && !!decided.partition && samePartition(decided.partition, draft);
    if (saved) save.classList.add("primary");
    save.onclick = function () { if (o.onChoose) o.onChoose(pc.verdict, null, draft); };
    choiceRow.appendChild(save);
    card.appendChild(choiceRow);
    // An answer being changed is not saved until the save button commits it; say so beside it.
    if (o.draft && !saved) {
      var unsaved = doc.createElement("div");
      unsaved.className = "unsaved";
      unsaved.setAttribute("role", "status");
      unsaved.textContent = "Not saved yet";
      card.appendChild(unsaved);
    }
    card.appendChild(renderUnsure(doc, decided, config, o));
    card.appendChild(renderNav(doc, o));

    container.appendChild(card);
    (focusTarget || head.q).focus();
  }

  /**
   * Translate a keydown into a review action. Pure: returns the action name it took (or null), calling
   * the matching handler. 1…N choose the step's N choices ("pending" when the choice opens a follow-up,
   * "choose" when it commits); u = unsure; Escape leaves a follow-up step ("back");
   * Enter/n/ArrowRight = next; p/ArrowLeft = prev. Choice keys are ignored when there is no live item
   * (handlers.item == null).
   * @param {KeyboardEvent} e
   * @param {KeyHandlers} handlers
   * @returns {"next"|"prev"|"choose"|"pending"|"unsure"|"back"|null}
   */
  function reviewItemKeydown(e, handlers) {
    var key = e.key;
    // A key pressed in a form field (a partition member's selector) is that field's, and Enter on a
    // button or link activates it: neither is a review action.
    var target = /** @type {Element|null} */ (e.target instanceof Element ? e.target : null);
    var tag = target ? target.tagName : "";
    if (/^(SELECT|INPUT|TEXTAREA)$/.test(tag) || (key === "Enter" && /^(BUTTON|A)$/.test(tag))) return null;
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
    if (!handlers.item) return null;
    var kc = kindFor(handlers.config, handlers.item.stratum);
    var pending = stepFor(kc, handlers.pending);
    if (key === "u") {
      if (handlers.onChoose) handlers.onChoose(handlers.config.unsure, null);
      return "unsure";
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
    validateReviewConfig: validateReviewConfig,
    validateReviewItem: validateReviewItem,
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
