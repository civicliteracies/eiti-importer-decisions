// @ts-check
/* Pipeline page. Two concerns, one classic script (CSP: script-src 'self', no inline handlers):
   (1) renderStats(data, doc) — PURE: fills the stats story from dedup-stats.json (a projection of the
       committed manifest); testable against a fixture via the module.exports guard, which early-returns
       before ANY browser side effect (fetch, pan/zoom, observers).
   (2) an inline-SVG DAG pan/zoom controller (wheel zoom, drag pan), transforming #stage-root via a
       transform attribute — CSP-safe (not inline CSS). */

/**
 * @typedef {{ label: string, entities: number }} TypeInfo
 * @typedef {{ canonical: string, type: string, type_label: string, mentions: number,
 *             distinct_names: number, countries: string[], spellings: string[] }} Example
 * @typedef {{ key: string, label: string, a: string, b: string }} VarKind
 * @typedef {{ schema_version: number,
 *   totals: { entities: number, mentions: number, distinct_name_forms: number, by_type: Record<string, TypeInfo> },
 *   base_rate: { single_spelling: number, varied: number, single_pct: number, varied_pct: number, avg_distinct_names: number },
 *   extremes: { most_mentioned: Example, most_names: Example, most_countries: Example },
 *   hard_calls: { splits: number, kept_apart: number, multinationals: number },
 *   variation_kinds: VarKind[] }} Stats
 */
(function () {
  "use strict";

  // ---- pure helpers (safe to run under test import) --------------------------------------------

  /** @param {number} n */
  function commas(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  /** DOM-node builder shared across the render functions (matches the sibling import-progress page's
   * `el`). Never innerHTML, so data values can't be interpreted as markup.
   * @param {Document} doc @param {string} tag @param {string} [className] @param {string} [text] */
  function el(doc, tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /** A mono spelling chip.
   * @param {Document} doc @param {string} text */
  function chip(doc, text) {
    return el(doc, "span", "s-chip", text);
  }

  /** A chip for `b` with the run that differs from `a` wrapped in a <mark class="d"> — a diff view.
   * The delta is `b` minus its common prefix and suffix with `a`: honest (shows the actual differing
   * region), cheap, and `<mark>` carries the "highlighted" meaning to assistive tech, not colour alone.
   * @param {Document} doc @param {string} a @param {string} b */
  function diffChip(doc, a, b) {
    const max = Math.min(a.length, b.length);
    let pre = 0;
    while (pre < max && a[pre] === b[pre]) pre++;
    let suf = 0;
    while (suf < max - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
    const head = b.slice(0, pre), mid = b.slice(pre, b.length - suf), tail = b.slice(b.length - suf);
    const s = el(doc, "span", "s-chip");
    if (head) s.appendChild(doc.createTextNode(head));
    if (mid) s.appendChild(el(doc, "mark", "d", mid));
    if (tail) s.appendChild(doc.createTextNode(tail));
    return s;
  }

  /** @param {Document} doc */
  function badge(doc) {
    const b = el(doc, "span", "s-badge", "✓");
    b.setAttribute("aria-hidden", "true");
    return b;
  }

  /** @param {Document} doc */
  function arrowSpan(doc) {
    const a = el(doc, "span", "s-arrow", "→");
    a.setAttribute("aria-hidden", "true");
    return a;
  }

  /** @param {Document} doc @param {string} id @param {string} text */
  function setText(doc, id, text) {
    const n = doc.getElementById(id);
    if (n) n.textContent = text;
  }

  /**
   * Fill the stats story. Pure over (data, doc): no fetch, no globals, no animation — final values are
   * written straight in, so the section is correct even with JS-only / no observers. Enhancement
   * (count-up, staggered reveal) is layered separately in the browser wiring below.
   * @param {Stats} data @param {Document} doc
   */
  function renderStats(data, doc) {
    const t = data.totals, br = data.base_rate, ex = data.extremes, hc = data.hard_calls;

    setText(doc, "st-entities-inline", commas(t.entities));
    setText(doc, "st-mentions", commas(t.mentions));
    setText(doc, "st-entities", commas(t.entities));

    // Beat 1 — segmented type bar (lane colours), each segment labelled with its count.
    const bar = doc.getElementById("st-typebar");
    const barKey = doc.getElementById("st-typebar-key");
    if (bar) {
      bar.textContent = "";
      if (barKey) barKey.textContent = "";
      const order = ["company", "gov_entity", "project"];
      /** @type {Record<string, string>} */
      const cls = { company: "seg-co", gov_entity: "seg-gov", project: "seg-prj" };
      /** @type {string[]} */
      const parts = [];
      for (const key of order) {
        const info = t.by_type[key];
        if (!info) continue;
        const label = commas(info.entities) + " " + info.label;
        parts.push(label);
        // the bar segment is a pure coloured proportion; the count lives in the always-visible key
        // below (never truncates on narrow screens) and in the bar's accessible name.
        const seg = el(doc, "div", "seg " + (cls[key] ?? ""));
        seg.style.flexGrow = String(info.entities);
        bar.appendChild(seg);
        if (barKey) {
          const item = el(doc, "span", "tk-item");
          item.appendChild(el(doc, "span", "tk-sw " + (cls[key] ?? "")));
          item.appendChild(el(doc, "span", "tk-lab", label));
          barKey.appendChild(item);
        }
      }
      bar.setAttribute("aria-label", "Entities by type: " + parts.join(", "));
    }

    // Beat 2 — the 100-cell waffle: varied_pct cells amber, the rest hollow. Distinction by fill, not hue.
    const waffle = doc.getElementById("st-waffle");
    if (waffle) {
      waffle.textContent = "";
      for (let k = 0; k < 100; k++) {
        const cell = doc.createElement("span");
        cell.className = k < br.varied_pct ? "cell vary" : "cell one";
        waffle.appendChild(cell);
      }
    }
    setText(
      doc, "st-baserate-cap",
      commas(br.single_spelling) + " written one way · " + commas(br.varied) +
        " vary · average " + br.avg_distinct_names + " spellings each"
    );

    // Beat 3 — the extremes, three distinct record cards.
    const records = doc.getElementById("st-records");
    if (records) {
      records.textContent = "";
      records.appendChild(recordCard(doc, "Most disclosed", commas(ex.most_mentioned.mentions), "mentions", ex.most_mentioned));
      records.appendChild(recordCard(doc, "Most names", String(ex.most_names.distinct_names), "spellings", ex.most_names));
      records.appendChild(recordCard(doc, "Most countries", String(ex.most_countries.countries.length), "countries", ex.most_countries));
    }

    // Beat 4 — the typology: each kind a miniature convergence with diff-highlighted chips.
    const typ = doc.getElementById("st-typology");
    if (typ) {
      typ.textContent = "";
      for (const k of data.variation_kinds) {
        const row = doc.createElement("div");
        row.className = "typ-row";
        const lab = doc.createElement("span");
        lab.className = "typ-lab";
        lab.textContent = k.label;
        row.appendChild(lab);
        const forms = doc.createElement("span");
        forms.className = "typ-forms";
        forms.appendChild(diffChip(doc, k.b, k.a));
        forms.appendChild(diffChip(doc, k.a, k.b));
        row.appendChild(forms);
        typ.appendChild(row);
      }
    }

    // Beat 5 — the hard calls: bespoke glyph + number + gloss (not KPI tiles).
    const hard = doc.getElementById("st-hardcalls");
    if (hard) {
      hard.textContent = "";
      hard.appendChild(hardCard(doc, "split", commas(hc.splits), "split back apart",
        "one name that turned out to be two organisations"));
      hard.appendChild(hardCard(doc, "apart", commas(hc.kept_apart), "kept apart on purpose",
        "look-alikes that must stay separate — a parent and its subsidiary"));
      hard.appendChild(hardCard(doc, "world", commas(hc.multinationals), "reconciled across countries",
        "one company, disclosed in several countries"));
    }
  }

  /** @param {Document} doc @param {string} label @param {string} num @param {string} unit @param {Example} ex */
  function recordCard(doc, label, num, unit, ex) {
    const card = el(doc, "div", "record");
    card.appendChild(el(doc, "p", "rec-eyebrow", label));
    const big = el(doc, "p", "rec-num");
    big.appendChild(el(doc, "span", "rec-n", num));
    big.appendChild(el(doc, "span", "rec-u", " " + unit));
    card.appendChild(big);
    card.appendChild(el(doc, "p", "rec-name", ex.canonical));
    if (ex.countries && ex.countries.length > 1) {
      const pills = el(doc, "div", "rec-countries");
      for (const c of ex.countries) pills.appendChild(el(doc, "span", "cc", c));
      card.appendChild(pills);
    }
    const forms = el(doc, "div", "rec-forms");
    for (const sp of ex.spellings) forms.appendChild(chip(doc, sp));
    forms.appendChild(arrowSpan(doc));
    forms.appendChild(badge(doc));
    card.appendChild(forms);
    return card;
  }

  /** @param {Document} doc @param {string} glyph @param {string} num @param {string} headline @param {string} gloss */
  function hardCard(doc, glyph, num, headline, gloss) {
    const card = el(doc, "div", "hard hard-" + glyph);
    const g = el(doc, "span", "hard-glyph", glyph === "split" ? "⋔" : glyph === "apart" ? "|" : "◎");
    g.setAttribute("aria-hidden", "true");
    card.appendChild(g);
    card.appendChild(el(doc, "p", "hard-num", num));
    card.appendChild(el(doc, "p", "hard-head", headline));
    card.appendChild(el(doc, "p", "hard-gloss", gloss));
    return card;
  }

  // ---- test seam: hand the pure functions to the unit test, then stop (no browser side effects) ----
  // The classic-script CSP means no ESM export; the module.exports guard is how the test imports the
  // pure functions (same shape as import-progress.js), and never runs in the browser.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { renderStats, diffChip, commas };
    return;
  }

  // ---- browser wiring (never runs under test) --------------------------------------------------
  /** @param {() => void} fn */
  function ready(fn) {
    if (document.readyState !== "loading") fn();
    else document.addEventListener("DOMContentLoaded", fn);
  }

  ready(function () {
    const reduced = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    initStats(reduced);
    initPanZoom(reduced);
    countSteps();
  });

  /** @param {boolean} reduced */
  function initStats(reduced) {
    const section = document.getElementById("stats");
    if (!section) return;
    fetch("dedup-stats.json", { credentials: "omit" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("stats " + r.status))))
      .then((data) => {
        renderStats(data, document);
        section.hidden = false;
        if (!reduced) enhance(section);
      })
      .catch((err) => {
        // leave the section hidden; the static hero + DAG + walkthrough still tell the story
        console.error("dedup-pipeline: failed to load dedup-stats.json", err);
      });
  }

  // count-up on the fold numbers + staggered waffle reveal, triggered as each beat scrolls in.
  // Gated behind .anim: without an observer (or under reduced-motion, where this isn't called) the
  // beats simply stay visible with their final values — the animation is pure enhancement.
  /** @param {HTMLElement} section */
  function enhance(section) {
    if (!("IntersectionObserver" in window)) return;
    section.classList.add("anim");
    const beats = section.querySelectorAll(".beat");
    const io = new IntersectionObserver((entries, obs) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add("in-view");
        if (e.target.id === "beat-fold") countUp(e.target);
        if (e.target.id === "beat-baserate") staggerWaffle(e.target);
        obs.unobserve(e.target);
      }
    }, { threshold: 0.35 });
    beats.forEach((b) => io.observe(b));
  }

  /** @param {Element} beat */
  function countUp(beat) {
    beat.querySelectorAll("[data-count]").forEach((node) => {
      const target = Number(String(node.textContent).replace(/,/g, ""));
      if (!target) return;
      const dur = 1100, t0 = performance.now();
      /** @param {number} t */
      const step = (t) => {
        const p = Math.min(1, (t - t0) / dur);
        const eased = 1 - Math.pow(1 - p, 3);
        node.textContent = commas(Math.round(target * eased));
        if (p < 1) requestAnimationFrame(step);
      };
      node.textContent = "0";
      requestAnimationFrame(step);
    });
  }

  /** @param {Element} beat */
  function staggerWaffle(beat) {
    beat.querySelectorAll(".waffle .cell").forEach((cell, i) => {
      /** @type {HTMLElement} */ (cell).style.transitionDelay = (i * 8) + "ms";
      cell.classList.add("lit");
    });
  }

  function countSteps() {
    const svg = document.getElementById("dag");
    const out = document.getElementById("st-steps");
    if (!svg || !out) return;
    const steps = svg.querySelectorAll('[data-kind="proc"], [data-kind="rev"], [data-kind="gate"]').length;
    out.textContent = String(steps);
  }

  // ---- DAG pan/zoom (unchanged behaviour from the original page) --------------------------------
  /** @param {boolean} reduced */
  function initPanZoom(reduced) {
    const svgEl = document.getElementById("dag");
    const stageEl = document.getElementById("stage-root");
    const vpEl = document.getElementById("viewport");
    const zin = document.getElementById("zin");
    const zout = document.getElementById("zout");
    const zfit = document.getElementById("zfit");
    if (!svgEl || !stageEl || !vpEl || !zin || !zout || !zfit) return;
    // rebind as non-null (and svg as an SVGSVGElement) so the nested closures below don't re-widen.
    const svg = /** @type {SVGSVGElement} */ (/** @type {unknown} */ (svgEl));
    const stage = stageEl;
    const vp = vpEl;

    let s = 1, tx = 0, ty = 0;
    const MIN = 0.8, MAX = 8, VBW = 1360;
    /** @param {number} v @param {number} a @param {number} b */
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const apply = () => stage.setAttribute("transform", "translate(" + tx + " " + ty + ") scale(" + s + ")");

    /** @param {number} clientX @param {number} clientY */
    function toUser(clientX, clientY) {
      const m = svg.getScreenCTM();
      if (!m) return { x: clientX, y: clientY };
      const pt = svg.createSVGPoint();
      pt.x = clientX; pt.y = clientY;
      const p = pt.matrixTransform(m.inverse());
      return { x: p.x, y: p.y };
    }
    /** @param {number} clientX @param {number} clientY @param {number} factor */
    function zoomAt(clientX, clientY, factor) {
      const ns = clamp(s * factor, MIN, MAX);
      if (ns === s) return;
      const p = toUser(clientX, clientY);
      tx = p.x - (p.x - tx) * (ns / s);
      ty = p.y - (p.y - ty) * (ns / s);
      s = ns; apply();
    }
    /** @param {number} f */
    function centerZoom(f) { const r = vp.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, f); }
    function fit() {
      const m = svg.getScreenCTM();
      if (!m) { s = 1; tx = 0; ty = 0; apply(); return; }
      const r = vp.getBoundingClientRect();
      const pad = 26;
      const want = (r.width - 2 * pad) / (m.a * VBW);
      s = clamp(want, 1, 4.4);
      const contentW = m.a * VBW * s;
      tx = (r.left + (r.width - contentW) / 2 - m.e) / m.a;
      ty = (r.top + pad - m.f) / m.a;
      apply();
    }

    vp.addEventListener("wheel", (e) => {
      if (e.deltaY === 0) return;
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.12 : 1 / 1.12);
    }, { passive: false });

    /** @type {Map<number, {x:number,y:number}>} */
    const pts = new Map();
    let pinch = 0;
    vp.addEventListener("pointerdown", (e) => {
      vp.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 1) vp.classList.add("grabbing");
    });
    vp.addEventListener("pointermove", (e) => {
      const prev = pts.get(e.pointerId);
      if (!prev) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 1) {
        const a = toUser(prev.x, prev.y), b = toUser(e.clientX, e.clientY);
        tx += b.x - a.x; ty += b.y - a.y; apply();
      } else if (pts.size === 2) {
        const it = pts.values(), p1 = it.next().value, p2 = it.next().value;
        if (!p1 || !p2) return;
        const d = Math.hypot(p1.x - p2.x, p1.y - p2.y);
        if (pinch) zoomAt((p1.x + p2.x) / 2, (p1.y + p2.y) / 2, d / pinch);
        pinch = d;
      }
    });
    /** @param {PointerEvent} e */
    function endPtr(e) {
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = 0;
      if (!pts.size) vp.classList.remove("grabbing");
    }
    ["pointerup", "pointercancel", "lostpointercapture"].forEach((ev) => vp.addEventListener(ev, /** @type {EventListener} */ (endPtr)));
    vp.addEventListener("dblclick", (e) => zoomAt(e.clientX, e.clientY, 1.5));
    zin.addEventListener("click", () => centerZoom(1.25));
    zout.addEventListener("click", () => centerZoom(0.8));
    zfit.addEventListener("click", fit);

    if (!reduced) {
      svg.classList.add("anim");
      svg.querySelectorAll(".node").forEach((n, i) => {
        /** @type {SVGElement} */ (n).style.animationDelay = (0.15 + i * 0.04) + "s";
        n.classList.add("in");
      });
    }
    fit();
  }
})();
