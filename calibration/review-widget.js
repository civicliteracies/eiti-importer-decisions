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

   Untrusted text: names and item details are written with textContent, never innerHTML, so a name, a
   fact, a quote or a judge's answer cannot inject markup. A quote's link is rendered only for an https
   URL, with rel="noopener noreferrer".

   renderReviewItem / reviewItemKeydown / validateReviewConfig are pure over their inputs (no globals,
   no I/O); the shells wire persistence and navigation. The module.exports guard is how the Node tests
   import them (classic script, so no ES modules). */

/**
 * @typedef {[string, string]} Choice - [value, label]; the value is what a verdict cell stores
 * @typedef {{ question: string, choices: Choice[] }} FollowUp
 * @typedef {{ question: string, choices: Choice[], followUp?: Record<string, FollowUp> }} KindConfig
 * @typedef {{ kinds: Record<string, KindConfig>, unsure: string }} ReviewConfig
 * @typedef {{ text: string, url: string }} Quote
 * @typedef {{ name: string, answer: string }} Judge
 * @typedef {{ facts?: string[], quotes?: Quote[], judges?: Judge[] }} ItemDetails
 * @typedef {{ item_id: string, stratum: string, country_iso3: string, names: string[],
 *   details?: ItemDetails, machine_verdict?: string, machine_detail?: (string|null) }} ReviewItem
 * @typedef {{ verdict: string, detail: (string|null) }} Decided
 * @typedef {(verdict: string, detail: (string|null)) => void} ChooseFn
 * @typedef {(verdict: (string|null)) => void} PendingFn
 * @typedef {{ reveal?: boolean, pending?: (string|null), onChoose?: ChooseFn, onPending?: PendingFn,
 *   onPrev?: () => void, onNext?: () => void, position?: number, total?: number }} RenderOpts
 * @typedef {{ item: (ReviewItem|null), config: ReviewConfig, pending?: (string|null), onChoose?: ChooseFn,
 *   onPending?: PendingFn, onNext?: () => void, onPrev?: () => void }} KeyHandlers
 * @typedef {{ verdict: string, label: string, followUp: FollowUp }} PendingStep
 */

(function (/** @type {any} */ root) {
  "use strict";

  // Keys 1…9 choose; a step offering more choices than there are digit keys could not be answered
  // from the keyboard.
  var MAX_CHOICES = 9;

  /** @param {any} obj @param {string} key @returns {boolean} */
  function own(obj, key) { return obj != null && Object.prototype.hasOwnProperty.call(obj, key); }

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
    kc.choices.forEach(function (c) { if (c[0] === verdict) label = c[1]; });
    return { verdict: verdict, label: label, followUp: fu };
  }

  /** @param {Choice[]} choices @param {string|null} value @returns {string|null} */
  function labelOf(choices, value) {
    var found = null;
    choices.forEach(function (c) { if (c[0] === value) found = c[1]; });
    return found;
  }

  /** @param {string} where @param {any} choices @param {string} unsure @returns {string|null} */
  function checkChoices(where, choices, unsure) {
    if (!Array.isArray(choices) || choices.length < 1 || choices.length > MAX_CHOICES) {
      return where + ": choices must hold 1 to " + MAX_CHOICES + " entries";
    }
    /** @type {Record<string, true>} */
    var seen = {};
    for (var i = 0; i < choices.length; i++) {
      var c = choices[i];
      if (!Array.isArray(c) || c.length !== 2 || typeof c[0] !== "string" || !c[0] || typeof c[1] !== "string" || !c[1]) {
        return where + ": choice " + (i + 1) + " must be a [value, label] pair of non-empty strings";
      }
      if (c[0] === unsure) return where + ": choice value " + JSON.stringify(c[0]) + " is the unsure value";
      if (own(seen, c[0])) return where + ": choice value " + JSON.stringify(c[0]) + " appears twice";
      seen[c[0]] = true;
    }
    return null;
  }

  /**
   * Check a page's review config against the shape the widget renders. Pages call it once at startup
   * (CalibrationApp.create refuses a config it rejects), so a malformed config fails before any item
   * is shown rather than as a card with no way to answer it.
   * @param {any} config
   * @returns {{ ok: true } | { ok: false, reason: string }}
   */
  function validateReviewConfig(config) {
    if (!config || typeof config !== "object") return { ok: false, reason: "config must be an object" };
    if (typeof config.unsure !== "string" || !config.unsure) return { ok: false, reason: "unsure must be a non-empty string" };
    var kinds = config.kinds;
    if (!kinds || typeof kinds !== "object" || !Object.keys(kinds).length) return { ok: false, reason: "kinds must define at least one kind" };
    var names = Object.keys(kinds);
    for (var k = 0; k < names.length; k++) {
      var name = /** @type {string} */ (names[k]);
      var kc = kinds[name];
      var where = "kind " + JSON.stringify(name);
      if (!kc || typeof kc.question !== "string" || !kc.question) return { ok: false, reason: where + ": question must be a non-empty string" };
      var bad = checkChoices(where, kc.choices, config.unsure);
      if (bad) return { ok: false, reason: bad };
      if (kc.followUp == null) continue;
      if (typeof kc.followUp !== "object") return { ok: false, reason: where + ": followUp must be an object keyed by choice value" };
      /** @type {string[]} */
      var values = kc.choices.map(function (/** @type {any} */ c) { return c[0]; });
      var keys = Object.keys(kc.followUp);
      for (var f = 0; f < keys.length; f++) {
        var value = /** @type {string} */ (keys[f]);
        var fwhere = where + " followUp " + JSON.stringify(value);
        if (values.indexOf(value) === -1) return { ok: false, reason: fwhere + ": not one of the kind's choice values" };
        var fu = kc.followUp[value];
        if (!fu || typeof fu.question !== "string" || !fu.question) return { ok: false, reason: fwhere + ": question must be a non-empty string" };
        var fbad = checkChoices(fwhere, fu.choices, config.unsure);
        if (fbad) return { ok: false, reason: fbad };
      }
    }
    return { ok: true };
  }

  /** The link target for a quote's url: the parsed URL when it is https, else null. @param {any} url @returns {string|null} */
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
    var pending = stepFor(kc, o.pending);
    var question = pending ? pending.followUp.question : kc.question;
    var choices = pending ? pending.followUp.choices : kc.choices;
    var onChoose = o.onChoose, onPending = o.onPending;
    container.textContent = "";

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

    var names = doc.createElement("div");
    names.className = "names";
    item.names.forEach(function (n) {
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

    var unsureRow = doc.createElement("div");
    unsureRow.className = "unsure-row";
    var unsureBtn = doc.createElement("button");
    unsureBtn.className = "unsure";
    unsureBtn.setAttribute("data-verdict", config.unsure);
    unsureBtn.textContent = "[u] Unsure / can’t determine";
    if (decided && decided.verdict === config.unsure) unsureBtn.classList.add("primary");
    unsureBtn.onclick = function () { if (onChoose) onChoose(config.unsure, null); };
    unsureRow.appendChild(unsureBtn);
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
    card.appendChild(nav);

    container.appendChild(card);
    // Move focus into the freshly-rendered card so a keyboard/SR user isn't dropped to <body> on every
    // choice/nav action. focus() on a detached node (jsdom tests) is a harmless no-op.
    q.focus();
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
    if (!/^[1-9]$/.test(key)) return null;
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
    renderReviewItem: renderReviewItem,
    reviewItemKeydown: reviewItemKeydown,
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api; // Node tests import here (classic script, script-src 'self')
  } else {
    root.CalibrationReviewWidget = api; // browser global for the page shells
  }
})(typeof window !== "undefined" ? window : this);
