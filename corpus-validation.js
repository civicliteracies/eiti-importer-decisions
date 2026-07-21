/* Corpus-validation coverage matrix. Loads coverage.json (same-origin, per the
   page CSP) and renders the SDF-vs-API grid. Mirrors the decision-log page's
   fetch-then-render pattern. */
(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  let DATA, STATUS, NAMES, SINCE, UNEXPLAINED, YEARS, rows;
  let sortKey = "pattern", statusKey = "all", showUnexplained = false;
  const patternRank = { "API-only": 0, "SDF-only": 1, "SDF+API": 2 };
  const statusOf = c => STATUS[c] || "Member";
  const nameOf = c => NAMES[c] || c;
  const byName = (a, b) => nameOf(a.country).localeCompare(nameOf(b.country));

  function build() {
    YEARS = DATA.years;
    rows = DATA.countries.map(c => {
      const s = new Set(c.sdf_years), a = new Set(c.api_years);
      const cells = YEARS.map(y => {
        const inS = s.has(y), inA = a.has(y);
        return inS && inA ? "both" : inS ? "sdf" : inA ? "api" : "empty";
      });
      const span = arr => (arr.length ? arr[arr.length - 1] - arr[0] + 1 : 0);
      const all = [...s, ...a];
      const unexplained = UNEXPLAINED[c.country] || [];
      return {
        ...c, cells, status: statusOf(c.country), since: SINCE[c.country],
        unexplained, hasUnexplained: unexplained.length > 0,
        firstYear: all.length ? Math.min(...all) : 9999,
        span: Math.max(span(c.sdf_years), span(c.api_years)),
      };
    });
  }

  function stats() {
    const t = DATA.totals;
    const items = [
      { n: t.countries, k: "countries" },
      { n: `${t.both} / ${t.sdf_only} / ${t.api_only}`, k: "both / SDF-only / API-only" },
      { n: `${YEARS[0]}–${YEARS[YEARS.length - 1]}`, k: "reporting years" },
    ];
    $("stats").innerHTML = items.map(s =>
      `<div class="stat"><span class="n">${s.n}</span><span class="k">${s.k}</span></div>`).join("");
  }

  function rangeHTML(cls, arr) {
    const tag = cls === "sdf" ? "SDF" : "API";
    if (!arr.length) return `<span class="rg ${cls}"><span class="tag mono">${tag}</span><span class="none mono">—</span></span>`;
    return `<span class="rg ${cls}"><span class="tag mono">${tag}</span><span class="mono">${arr[0]}–${arr[arr.length - 1]}</span></span>`;
  }
  const pillHTML = cov => cov === "SDF-only" ? `<span class="pill sdf">SDF only</span>`
    : cov === "API-only" ? `<span class="pill api">API only</span>` : "";
  const statusTag = st => st === "Withdrawn" ? `<span class="stag delisted">withdrawn</span>`
    : st === "Suspended" ? `<span class="stag susp">suspended</span>` : "";

  function render() {
    let list = rows.filter(r =>
      (statusKey === "all" || r.status === statusKey) &&
      (!showUnexplained || r.hasUnexplained));
    if (sortKey === "name") list.sort(byName);
    else if (sortKey === "span") list.sort((a, b) => b.span - a.span || byName(a, b));
    else if (sortKey === "first") list.sort((a, b) => a.firstYear - b.firstYear || byName(a, b));
    else list.sort((a, b) => patternRank[a.coverage] - patternRank[b.coverage] || a.firstYear - b.firstYear || byName(a, b));

    document.querySelector("#grid thead").innerHTML =
      `<tr><th class="corner">${list.length} countries</th>${YEARS.map(y => `<th class="yr"><span class="yy mono">${String(y).slice(2)}</span></th>`).join("")}</tr>`;

    document.querySelector("#grid tbody").innerHTML = list.map(r => {
      const lab = `<td class="lab"><div class="lab-top"><span class="cname">${nameOf(r.country)}</span><span class="iso mono">${r.country}</span>${pillHTML(r.coverage)}${statusTag(r.status)}</div><div class="ranges">${rangeHTML("sdf", r.sdf_years)}${rangeHTML("api", r.api_years)}<span class="rg jn"><span class="tag mono">joined</span><span class="mono">${r.since}</span></span></div></td>`;
      const cells = r.cells.map((v, i) => {
        const yr = YEARS[i];
        const desc = v === "both" ? "both sources" : v === "sdf" ? "SDF only" : v === "api" ? "API only" : "no declaration";
        const j = yr === r.since;
        return `<td class="cell ${v}${j ? " join" : ""}"><span class="dot" title="${nameOf(r.country)} ${yr} · ${desc}${j ? " · joined EITI" : ""}"></span></td>`;
      }).join("");
      return `<tr>${lab}${cells}</tr>`;
    }).join("");
  }

  function wire() {
    $("sortSel").addEventListener("change", e => { sortKey = e.target.value; render(); });
    $("statusSel").addEventListener("change", e => { statusKey = e.target.value; render(); });
    $("unexpBtn").addEventListener("click", e => {
      showUnexplained = !showUnexplained;
      e.currentTarget.setAttribute("aria-pressed", String(showUnexplained));
      render();
    });
  }

  fetch("coverage.json")
    .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(j => {
      ({ DATA, STATUS, NAMES, SINCE, UNEXPLAINED } = j);
      build(); stats(); wire(); render();
      const c = $("content"); if (c) c.setAttribute("aria-busy", "false");
    })
    .catch(() => {
      const m = $("matrix-wrap");
      if (m) m.innerHTML = '<p class="note">Could not load coverage data.</p>';
    });
})();
