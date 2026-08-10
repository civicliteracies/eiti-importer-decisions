/* Import-progress page. Loads import-progress.json (same-origin, per the page CSP) and renders
   the per-format snapshot + the coverage timeline. Every timeline dot is data-driven — a real
   file-import moment — and leads with the data: per import type, "+N → imported/total" with the new
   file ids. A short caption is rendered BELOW the data as context, never a title above it.

   render(data, doc) is pure over its inputs (no fetch, no globals) so a test can drive it against
   a fixture; the IIFE at the bottom wires fetch → render in the browser. It is a classic script
   (CSP: script-src 'self'), so the module.exports guard is how the test imports render. */

/**
 * @typedef {{imported: number, total: number, updated: string}} TypeSnapshot
 * @typedef {{key: string, label: string, imported: number, total: number,
 *            added: number|null, ids: string[]}} TimelineGroup
 * @typedef {{date: string, groups: TimelineGroup[], caption: string}} TimelineEntry
 * @typedef {{version: number, types: Record<string, TypeSnapshot>,
 *            timeline: TimelineEntry[]}} ImportProgress
 */
(() => {
  "use strict";

  // Map (not a plain object) so a data value of "__proto__"/"constructor" can't resolve to an
  // inherited Object.prototype member. Snapshot card labels + display order.
  /** @type {Map<string, string>} */
  const TYPE_LABELS = new Map([
    ["summary_v1", "Summary Data v1"],
    ["api_extract_v1", "API extract v1"],
    ["summary_v2", "Summary Data v2"],
    ["company_assessment", "Company assessment"],
    ["validation_data", "Validation data"],
  ]);
  const TYPE_ORDER = ["summary_v1", "api_extract_v1", "summary_v2", "company_assessment", "validation_data"];

  /** @param {string} type @returns {string} */
  const labelFor = (type) => TYPE_LABELS.get(type) ?? type;

  /**
   * A colour-coded format badge. The colour comes from a per-type CSS class; only a known key
   * gets one (so a stray data value falls back to the neutral badge, never an injected class).
   * @param {Document} doc
   * @param {TimelineGroup} group
   * @returns {HTMLElement}
   */
  const typeTag = (doc, group) => {
    const known = TYPE_LABELS.has(group.key);
    return el(doc, "span", known ? `type-tag t-${group.key}` : "type-tag", group.label);
  };

  /**
   * @param {Document} doc
   * @param {string} tag
   * @param {string} [className]
   * @param {string} [text]
   * @returns {HTMLElement}
   */
  const el = (doc, tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };

  /**
   * @param {Document} doc
   * @param {HTMLElement} container
   * @param {Record<string, TypeSnapshot>} types
   */
  const renderSnapshot = (doc, container, types) => {
    const frag = doc.createDocumentFragment();
    for (const type of TYPE_ORDER) {
      const snap = types[type];
      if (!snap) continue;
      const complete = snap.total > 0 && snap.imported >= snap.total;
      const card = el(doc, "div", complete ? "card complete" : "card");
      card.setAttribute("aria-label", `${snap.imported} of ${snap.total} ${labelFor(type)} imported`);

      card.appendChild(el(doc, "p", "card-k", labelFor(type)));
      const n = el(doc, "p", "card-n");
      n.appendChild(el(doc, "span", undefined, String(snap.imported)));
      n.appendChild(el(doc, "span", "sep", "/"));
      n.appendChild(el(doc, "span", "tot", String(snap.total)));
      n.setAttribute("aria-hidden", "true");
      card.appendChild(n);

      const bar = el(doc, "div", "bar");
      const fill = el(doc, "div", "bar-fill");
      fill.style.width = snap.total > 0 ? `${Math.round((snap.imported / snap.total) * 100)}%` : "0%";
      bar.appendChild(fill);
      card.appendChild(bar);
      frag.appendChild(card);
    }
    container.textContent = "";
    container.appendChild(frag);
  };

  // A diff can span a bulk source (hundreds of country-years); list a sample of ids, then a
  // "+N more" count, so the timeline stays legible without hiding the scale.
  const CHIP_CAP = 18;

  // For the chip hover title: expand the ISO3 country code + the 2-letter language code a reader may
  // not recognise (the one per-file metadata value the chip suffix carries today). The set is the
  // EITI member countries in the data; an unknown code falls back to itself, so a future country
  // still renders (just without the long-form name on hover).
  /** @type {Record<string, string>} */
  const COUNTRY = {AFG:"Afghanistan", AGO:"Angola", ALB:"Albania", ARG:"Argentina", ARM:"Armenia", AZE:"Azerbaijan", BFA:"Burkina Faso", CAF:"Central African Rep.", CIV:"Côte d'Ivoire", CMR:"Cameroon", COD:"DR Congo", COG:"Congo", COL:"Colombia", DEU:"Germany", DOM:"Dominican Republic", ECU:"Ecuador", ETH:"Ethiopia", GAB:"Gabon", GBR:"United Kingdom", GHA:"Ghana", GIN:"Guinea", GTM:"Guatemala", GUY:"Guyana", HND:"Honduras", IDN:"Indonesia", IRQ:"Iraq", KAZ:"Kazakhstan", KGZ:"Kyrgyzstan", LBR:"Liberia", MDG:"Madagascar", MEX:"Mexico", MLI:"Mali", MMR:"Myanmar", MNG:"Mongolia", MOZ:"Mozambique", MRT:"Mauritania", MWI:"Malawi", NER:"Niger", NGA:"Nigeria", NLD:"Netherlands", NOR:"Norway", PER:"Peru", PHL:"Philippines", PNG:"Papua New Guinea", SEN:"Senegal", SLB:"Solomon Islands", SLE:"Sierra Leone", STP:"São Tomé & Príncipe", SUR:"Suriname", SYC:"Seychelles", TCD:"Chad", TGO:"Togo", TJK:"Tajikistan", TLS:"Timor-Leste", TTO:"Trinidad & Tobago", TZA:"Tanzania", UGA:"Uganda", UKR:"Ukraine", USA:"United States", ZMB:"Zambia"};
  /** @type {Record<string, string>} */
  const LANGUAGE = { EN: "English", FR: "French", ES: "Spanish", RU: "Russian" };

  /**
   * The hover title for a file chip: "Colombia · 2016 · Spanish" from "COL-2016·ES". Falls back to
   * the chip text itself for a code with no country-year shape (e.g. an assessment year).
   * @param {string} id @returns {string}
   */
  const chipTitle = (id) => {
    const m = /^([A-Z]{3})-(\d{4})(?:·([A-Z]{2}))?$/.exec(id);
    if (!m) return id;
    const iso = m[1] ?? "";
    const lang = m[3];
    const parts = [COUNTRY[iso] ?? iso, m[2] ?? ""];
    if (lang) parts.push(LANGUAGE[lang] ?? lang);
    return parts.join(" · ");
  };

  /**
   * A group's count: "+N imported → running/total", or just "running/total" when the delta is
   * unknown (a curated milestone). Every group carries imported/total; only ``added`` is optional.
   * @param {Document} doc
   * @param {TimelineGroup} group
   * @returns {HTMLElement}
   */
  const countLine = (doc, group) => {
    const line = el(doc, "span", "tl-count");
    if (group.added != null) line.appendChild(el(doc, "span", "tl-added", `+${group.added}`));
    line.appendChild(el(doc, "span", "tl-progress", `${group.imported}/${group.total}`));
    const delta = group.added != null ? `${group.added} more ${group.label} imported, ` : "";
    line.setAttribute("aria-label", `${delta}${group.imported} of ${group.total} total`);
    return line;
  };

  /**
   * @param {Document} doc
   * @param {HTMLElement} list
   * @param {TimelineEntry[]} timeline
   */
  const renderTimeline = (doc, list, timeline) => {
    const frag = doc.createDocumentFragment();
    for (const entry of timeline) {
      const groups = entry.groups ?? [];
      // A dot with groups is a real file-import step (gold node); a dot with none is a caption-only
      // marker (navy ring). Every group carries a count, so "has data" is simply "has any group".
      const item = el(doc, "li", groups.length ? "tl-item tl-diff" : "tl-item");
      item.appendChild(el(doc, "time", "tl-date", entry.date));

      // Data first: one row per type — coloured badge, the count, and the new file ids.
      for (const g of groups) {
        const row = el(doc, "div", "tl-group");
        row.appendChild(typeTag(doc, g));
        row.appendChild(countLine(doc, g));
        if (g.ids.length) {
          const chips = el(doc, "span", "tl-chips");
          for (const id of g.ids.slice(0, CHIP_CAP)) {
            const chip = el(doc, "span", "chip", id);
            const title = chipTitle(id);
            chip.title = title;
            chip.setAttribute("aria-label", title); // reach keyboard/touch/SR, not just mouse hover
            chips.appendChild(chip);
          }
          if (g.ids.length > CHIP_CAP) {
            chips.appendChild(el(doc, "span", "chip chip-more", `+${g.ids.length - CHIP_CAP} more`));
          }
          row.appendChild(chips);
        }
        item.appendChild(row);
      }

      // Caption below the data: a short sentence of context, never a title above.
      if (entry.caption) item.appendChild(el(doc, "p", "tl-caption", entry.caption));
      frag.appendChild(item);
    }
    list.textContent = "";
    list.appendChild(frag);
  };

  // The published write only changes the JSON on real progress, so the freshest honest date is the
  // newest timeline entry — "last recorded progress", not "last run".
  /** @param {TimelineEntry[]} timeline @returns {string} */
  const lastRecorded = (timeline) => timeline.reduce((max, e) => (e.date > max ? e.date : max), "");

  /**
   * @param {ImportProgress} data
   * @param {Document} doc
   */
  const render = (data, doc) => {
    const timeline = data.timeline ?? [];
    const asof = doc.getElementById("asof");
    if (asof) {
      const date = lastRecorded(timeline);
      if (date) {
        asof.textContent = `Last recorded progress: ${date}`;
        asof.hidden = false;
      }
    }
    const loading = doc.getElementById("loading");
    if (loading) loading.remove();
    const snapshot = doc.getElementById("snapshot");
    const list = doc.getElementById("timeline");
    if (snapshot) renderSnapshot(doc, snapshot, data.types ?? {});
    if (list) renderTimeline(doc, list, timeline);
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { render, lastRecorded };
    return;
  }

  /** @param {boolean} busy */
  const setBusy = (busy) => {
    const c = document.getElementById("content");
    if (c) c.setAttribute("aria-busy", String(busy));
  };

  fetch("import-progress.json")
    .then((r) => {
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    })
    .then((data) => {
      render(data, document);
      setBusy(false);
    })
    .catch((err) => {
      if (typeof console !== "undefined") console.error("import-progress: failed to load import-progress.json", err);
      const loading = document.getElementById("loading");
      if (loading) loading.remove();
      const list = document.getElementById("timeline");
      if (list) list.appendChild(el(document, "li", "note", "Could not load import-progress data."));
      setBusy(false);
    });
})();
