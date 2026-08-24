/* Blind-review widget for the calibration page (TASK-329.06.01).

   The per-item blind judgment, rendered by the hosted distributed page (calibration.js loads it
   under CSP script-src 'self'). Kept as its own module — not inlined into the page — so the review
   semantics (choices, question, blind-then-reveal, unsure) and keyboard map are unit-tested once in
   Node (tests/js/calibration-widget.test.js) rather than only through the DOM.

   Blindness invariant: the machine verdict is rendered ONLY inside the reveal, and the
   reveal appears ONLY after the reviewer has committed (decided != null) AND the shell
   permits it (opts.reveal). A caller that never passes reveal:true (the hosted scored
   items) never shows the machine answer at all.

   renderReviewItem / reviewItemKeydown are pure over their inputs (no globals, no I/O);
   the shells wire persistence + navigation. The module.exports guard is how the Node
   tests import them (classic script, so no ES modules). */

/**
 * @typedef {"merge"|"split"|"disposition"} Stratum
 * @typedef {{ choices: Record<Stratum, [string, string][]>, question: Record<Stratum, string>, unsure: string }} ReviewConfig
 * @typedef {{ item_id: string, stratum: string, country_iso3: string, names: string[],
 *   machine_verdict: string, machine_detail: (string|null) }} ReviewItem
 * @typedef {{ reveal?: boolean, onChoose?: (v: string) => void, onPrev?: () => void,
 *   onNext?: () => void, position?: number, total?: number }} RenderOpts
 * @typedef {{ item: (ReviewItem|null), onChoose?: (v: string) => void, onNext?: () => void,
 *   onPrev?: () => void }} KeyHandlers
 */

(function (/** @type {any} */ root) {
  "use strict";

  // Per-stratum review semantics — the single source of truth for BOTH tools.
  // value strings are exactly the calibration_core.Verdict values, so a reviewer verdict
  // compares directly against the frozen machine_verdict with no translation.
  /** @type {ReviewConfig} */
  var REVIEW_CONFIG = {
    choices: {
      merge: [["same", "All one entity"], ["different", "Not all one"]],
      split: [["same", "Same entity"], ["different", "Different entities"]],
      disposition: [["entity", "Real entity"], ["not_entity", "Junk / placeholder"]],
    },
    question: {
      merge: "The panel grouped these names as ONE entity. Are they all the same real entity?",
      split: "The panel kept these as SEPARATE entities. Are they actually the same real entity?",
      disposition: "Is this a real entity, or junk / a placeholder / an aggregate label?",
    },
    unsure: "unsure",
  };

  /**
   * Render one blind item into `container` (an element or a DOM-provider's created node).
   * @param {Document} doc
   * @param {HTMLElement} container - emptied and filled with the item card
   * @param {ReviewItem} item
   * @param {string|null} decided - the committed verdict for this item, or null
   * @param {RenderOpts} [opts]
   *   reveal: whether a committed item may show the machine answer (solo: true; hosted
   *   scored items: false; hosted practice items: true). Never reveals before a commit.
   */
  function renderReviewItem(doc, container, item, decided, opts) {
    opts = opts || {};
    var choices = REVIEW_CONFIG.choices[/** @type {Stratum} */ (item.stratum)];
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
    var question = REVIEW_CONFIG.question[/** @type {Stratum} */ (item.stratum)];
    q.textContent = question; // visible: the clean question
    // SR-only: prefix the item's position so a screen-reader user hears progress on every render.
    q.setAttribute("aria-label", "Item " + (opts.position || 0) + " of " + (opts.total || 0) + ". " + question);
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

    var choiceRow = doc.createElement("div");
    choiceRow.className = "choices";
    choices.forEach(function (pair, i) {
      var val = pair[0], label = pair[1];
      var b = doc.createElement("button");
      b.textContent = "[" + (i + 1) + "] " + label;
      b.setAttribute("data-verdict", val);
      if (decided === val) b.classList.add("primary");
      b.onclick = function () { if (opts.onChoose) opts.onChoose(val); };
      choiceRow.appendChild(b);
    });
    card.appendChild(choiceRow);

    var unsureRow = doc.createElement("div");
    unsureRow.className = "unsure-row";
    var unsureBtn = doc.createElement("button");
    unsureBtn.className = "unsure";
    unsureBtn.setAttribute("data-verdict", REVIEW_CONFIG.unsure);
    unsureBtn.textContent = "[u] Unsure / can’t determine";
    if (decided === REVIEW_CONFIG.unsure) unsureBtn.classList.add("primary");
    unsureBtn.onclick = function () { if (opts.onChoose) opts.onChoose(REVIEW_CONFIG.unsure); };
    unsureRow.appendChild(unsureBtn);
    card.appendChild(unsureRow);

    // Reveal: only when committed AND the shell allows it. This is the blindness gate —
    // an unrevealed item never renders machine_verdict anywhere in the DOM.
    var reveal = doc.createElement("div");
    reveal.className = "reveal";
    reveal.setAttribute("data-testid", "reveal");
    reveal.setAttribute("role", "status"); // live region: announce agree/disagree when it appears post-commit
    reveal.setAttribute("aria-live", "polite");
    if (decided != null && opts.reveal) {
      reveal.classList.add("show");
      var machine = item.machine_verdict;
      var detail = item.machine_detail && item.machine_detail !== "entity"
        ? " (" + item.machine_detail + ")" : "";
      var verdictSpan = doc.createElement("span");
      verdictSpan.className = "verdict";
      var panelLine = doc.createElement("div");
      if (decided === REVIEW_CONFIG.unsure) {
        reveal.classList.add("neutral");
        verdictSpan.textContent = "— Marked unsure (excluded from the agreement rate)";
      } else {
        var agree = decided === machine;
        reveal.classList.add(agree ? "agree" : "disagree");
        verdictSpan.textContent = agree ? "✓ You agree with the panel" : "✗ You disagree with the panel";
      }
      panelLine.textContent = "Panel said: " + machine + detail;
      reveal.appendChild(verdictSpan);
      reveal.appendChild(panelLine);
    }
    card.appendChild(reveal);

    var nav = doc.createElement("div");
    nav.className = "nav";
    var prev = doc.createElement("button");
    prev.textContent = "← Prev";
    prev.onclick = function () { if (opts.onPrev) opts.onPrev(); };
    var pos = doc.createElement("span");
    pos.className = "chip";
    pos.textContent = (opts.position || 0) + " / " + (opts.total || 0);
    var next = doc.createElement("button");
    next.textContent = "Next →";
    next.onclick = function () { if (opts.onNext) opts.onNext(); };
    nav.appendChild(prev); nav.appendChild(pos); nav.appendChild(next);
    card.appendChild(nav);

    container.appendChild(card);
    // Move focus into the freshly-rendered card so a keyboard/SR user isn't dropped to <body> on every
    // choice/nav action. focus() on a detached node (jsdom tests) is a harmless no-op.
    q.focus();
  }

  /**
   * Translate a keydown into a review action. Pure: returns the action name it took (or
   * null), calling the matching handler. 1/2 = the two stratum choices; u/3 = unsure;
   * Enter/n/ArrowRight = next; p/ArrowLeft = prev. Choice keys are ignored when there is
   * no live item (handlers.item == null).
   */
  function reviewItemKeydown(/** @type {KeyboardEvent} */ e, /** @type {KeyHandlers} */ handlers) {
    handlers = handlers || { item: null };
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
    var choices = REVIEW_CONFIG.choices[/** @type {Stratum} */ (handlers.item.stratum)];
    if (key === "1" && choices[0]) { if (handlers.onChoose) handlers.onChoose(choices[0][0]); return "choose"; }
    if (key === "2" && choices[1]) { if (handlers.onChoose) handlers.onChoose(choices[1][0]); return "choose"; }
    if (key === "u" || key === "3") { if (handlers.onChoose) handlers.onChoose(REVIEW_CONFIG.unsure); return "unsure"; }
    return null;
  }

  var api = { REVIEW_CONFIG: REVIEW_CONFIG, renderReviewItem: renderReviewItem, reviewItemKeydown: reviewItemKeydown };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api; // Node tests import here (classic script, script-src 'self')
  } else {
    root.CalibrationReviewWidget = api; // browser global for both shells
  }
})(typeof window !== "undefined" ? window : this);
