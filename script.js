/* eslint-env browser */
(() => {
  const SOURCE = './decision-log.md';

  const TOPIC_ORDER = [
    'data-quality-policy',
    'currency-financial-calculations',
    'workflow-status',
    'template-recognition',
    'entity-resolution',
    'consistency-rules',
    'import-behavior',
    'version-differences',
    'cross-cutting',
  ];

  const TOPIC_LABELS = {
    'data-quality-policy': '1. Data Quality Policy',
    'currency-financial-calculations': '2. Currency & Financial Calculations',
    'workflow-status': '3. Workflow & Status',
    'template-recognition': '4. Template Recognition',
    'entity-resolution': '5. Entity Resolution',
    'consistency-rules': '6. Consistency Rules',
    'import-behavior': '7. Import Behavior',
    'version-differences': '8. Version Differences',
    'cross-cutting': 'Cross-Cutting',
  };

  const SCENARIO_ORDER = [
    'submit-a-report',
    'trust-the-data',
    'fix-problems-before-import',
    'reconcile-government-vs-companies',
    'avoid-duplicate-imports',
    'audit-who-did-what',
    'compare-across-versions',
    'operate-at-scale',
    'cross-cutting',
  ];

  const SCENARIO_LABELS = {
    'submit-a-report': 'Submit a report',
    'trust-the-data': 'Trust the data',
    'fix-problems-before-import': 'Fix problems before import',
    'reconcile-government-vs-companies': 'Reconcile government vs companies',
    'avoid-duplicate-imports': 'Avoid duplicate imports',
    'audit-who-did-what': 'Audit who did what',
    'compare-across-versions': 'Compare across versions',
    'operate-at-scale': 'Operate at scale',
    'cross-cutting': 'Cross-cutting',
  };

  // Module state
  let entries = [];
  let activeObserver = null;

  // === Technical-detail toggle ===

  function currentTech() {
    try { return localStorage.getItem('show-technical') === '1'; }
    catch { return false; }
  }

  function applyTech(on) {
    document.body.classList.toggle('show-technical', on);
    document.querySelectorAll('.tech-controls .view-toggle button').forEach((b) => {
      const isOn = (b.dataset.tech === 'show');
      const active = isOn === !!on;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-checked', active ? 'true' : 'false');
    });
    try { localStorage.setItem('show-technical', on ? '1' : '0'); } catch {}
  }

  function initTechToggle() {
    applyTech(currentTech());
    document.querySelectorAll('.tech-controls .view-toggle button').forEach((b) => {
      b.addEventListener('click', () => applyTech(b.dataset.tech === 'show'));
    });
  }

  // === Tabs ===

  function currentTab() {
    return location.hash === '#/pending' ? 'pending' : 'decided';
  }

  function applyTab(tab) {
    document.body.dataset.tab = tab;
    document.querySelectorAll('.tab').forEach((a) => {
      a.setAttribute('aria-selected', a.dataset.tab === tab ? 'true' : 'false');
    });
    if (!location.hash.includes('#section-') && !location.hash.includes('#entry-')) {
      window.scrollTo({ top: 0, behavior: 'auto' });
    }
  }

  function initTabs() {
    applyTab(currentTab());
    window.addEventListener('hashchange', () => applyTab(currentTab()));
  }

  // === Group-by toggle ===

  function currentView() {
    let stored = null;
    try { stored = localStorage.getItem('group-by'); } catch {}
    return stored === 'topic' ? 'topic' : 'scenario'; // default = scenario
  }

  function applyView(v) {
    if (v !== 'topic' && v !== 'scenario') v = 'scenario';
    try { localStorage.setItem('group-by', v); } catch {}
    document.querySelectorAll('.view-controls .view-toggle button').forEach((b) => {
      const on = b.dataset.view === v;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    const tocTitle = document.getElementById('toc-title');
    if (tocTitle) tocTitle.textContent = v === 'scenario' ? 'Scenarios' : 'Topics';
    if (entries.length > 0) {
      renderDecidedView(v);
      buildToc();
      setupScrollSpy();
    }
  }

  function initViewToggle() {
    applyView(currentView());
    document.querySelectorAll('.view-controls .view-toggle button').forEach((b) => {
      b.addEventListener('click', () => applyView(b.dataset.view));
    });
  }

  // === Markdown loading ===

  async function loadAndRender() {
    const main = document.getElementById('content');
    let markdown;
    try {
      const res = await fetch(SOURCE, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      markdown = await res.text();
    } catch (err) {
      main.innerHTML = `<p class="loading">Could not load decision log: ${err.message}</p>`;
      main.removeAttribute('aria-busy');
      return;
    }

    marked.setOptions({ headerIds: false, mangle: false, gfm: true });
    main.innerHTML = marked.parse(markdown);
    main.removeAttribute('aria-busy');

    hideIntro(main);
    attachMetadata(main); // before splitIntoSections — comments are still adjacent to h3 here
    splitIntoSections(main);
    structureFields(main);
    entries = collectEntries(main);
    applyView(currentView());
    updatePendingBadge();
    updateLastModified();
  }

  function hideIntro(main) {
    const firstH2 = main.querySelector('h2');
    if (!firstH2) return;
    let node = main.firstElementChild;
    while (node && node !== firstH2) {
      node.classList.add('intro-hidden');
      node = node.nextElementSibling;
    }
  }

  function splitIntoSections(main) {
    const h2s = [...main.querySelectorAll('h2')];
    if (h2s.length === 0) return;

    const pendingH2 = h2s.find((h) => /^\s*0\./.test(h.textContent));
    const otherH2s = h2s.filter((h) => h !== pendingH2);

    if (pendingH2) {
      const pendingWrap = document.createElement('section');
      pendingWrap.className = 'pending-view';
      pendingH2.parentNode.insertBefore(pendingWrap, pendingH2);
      collectUntilNextH2(pendingH2, pendingWrap);
    }

    if (otherH2s.length > 0) {
      const decidedWrap = document.createElement('section');
      decidedWrap.className = 'decided-view';
      otherH2s[0].parentNode.insertBefore(decidedWrap, otherH2s[0]);
      let next = otherH2s[0];
      while (next) {
        const after = findNextH2(next);
        collectUntilNextH2(next, decidedWrap);
        next = after;
      }
    }
  }

  function findNextH2(node) {
    let n = node.nextElementSibling;
    while (n && n.tagName !== 'H2') n = n.nextElementSibling;
    return n;
  }

  function collectUntilNextH2(startH2, target) {
    const blocks = [startH2];
    let n = startH2.nextElementSibling;
    while (n && n.tagName !== 'H2') {
      blocks.push(n);
      n = n.nextElementSibling;
    }
    blocks.forEach((b) => target.appendChild(b));
  }

  // === Metadata extraction (before section wrapping or field structuring) ===

  function attachMetadata(main) {
    for (const h3 of main.querySelectorAll('h3')) {
      let n = h3.nextSibling;
      while (n && n.nodeType !== Node.ELEMENT_NODE) {
        if (n.nodeType === Node.COMMENT_NODE) {
          const m = /scenario\s*:\s*([\w-]+)\s*;\s*topic\s*:\s*([\w-]+)/.exec(n.data);
          if (m) {
            h3.dataset.scenario = m[1];
            h3.dataset.topic = m[2];
            const toRemove = n;
            n = n.nextSibling;
            toRemove.remove();
            break;
          }
        }
        n = n.nextSibling;
      }
    }
  }

  function collectEntries(main) {
    const list = [];
    const decided = main.querySelector('.decided-view');
    if (!decided) return list;
    for (const h3 of decided.querySelectorAll('h3')) {
      const { scenario, topic } = h3.dataset;
      if (!scenario || !topic) continue;
      const dl =
        h3.nextElementSibling && h3.nextElementSibling.tagName === 'DL'
          ? h3.nextElementSibling
          : null;
      list.push({ title: h3.textContent, h3, dl, scenario, topic });
    }
    return list;
  }

  // === Field structuring ===

  function structureFields(root) {
    const h3s = [...root.querySelectorAll('h3')];
    for (const h3 of h3s) {
      const blocks = [];
      let n = h3.nextElementSibling;
      while (n && n.tagName !== 'H2' && n.tagName !== 'H3') {
        blocks.push(n);
        n = n.nextElementSibling;
      }

      const items = [];
      for (const block of blocks) {
        if (block.tagName === 'P' && /^<strong>[^:<]+:<\/strong>/.test(block.innerHTML.trim())) {
          const segments = splitFieldParagraph(block.innerHTML);
          if (segments.length === 0) {
            items.push({ extra: block });
            continue;
          }
          for (const seg of segments) {
            const p = document.createElement('p');
            p.innerHTML = seg.body;
            items.push({ field: true, label: seg.label, content: [p] });
          }
          block.remove();
        } else {
          items.push({ extra: block });
        }
      }

      const fields = [];
      let cur = null;
      for (const it of items) {
        if (it.field) {
          cur = { label: it.label, content: [...it.content] };
          fields.push(cur);
        } else if (cur) {
          cur.content.push(it.extra);
        }
      }

      if (fields.length === 0) continue;

      const dl = document.createElement('dl');
      dl.className = 'fields';
      for (const f of fields) {
        const dt = document.createElement('dt');
        dt.textContent = f.label;
        const dd = document.createElement('dd');
        f.content.forEach((c) => dd.appendChild(c));
        if (/^technical\s+detail$/i.test(f.label)) {
          dt.classList.add('field-technical');
          dd.classList.add('field-technical');
        }
        dl.appendChild(dt);
        dl.appendChild(dd);
      }
      h3.insertAdjacentElement('afterend', dl);
    }
  }

  function splitFieldParagraph(html) {
    const re = /<strong>([^:<]+):<\/strong>\s*/g;
    const matches = [];
    let m;
    while ((m = re.exec(html)) !== null) {
      matches.push({ label: m[1].trim(), bodyStart: m.index + m[0].length, labelStart: m.index });
    }
    if (matches.length === 0) return [];
    return matches.map((mi, i) => {
      const end = i + 1 < matches.length ? matches[i + 1].labelStart : html.length;
      return { label: mi.label, body: html.slice(mi.bodyStart, end).trim() };
    });
  }

  // === View rendering ===

  function renderDecidedView(view) {
    const decided = document.querySelector('.decided-view');
    if (!decided) return;
    const order = view === 'scenario' ? SCENARIO_ORDER : TOPIC_ORDER;
    const labels = view === 'scenario' ? SCENARIO_LABELS : TOPIC_LABELS;

    const groups = new Map(order.map((k) => [k, []]));
    for (const e of entries) {
      const key = e[view] || 'cross-cutting';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    }

    decided.innerHTML = '';
    let first = true;
    for (const k of order) {
      const items = groups.get(k);
      if (!items || items.length === 0) continue;
      const h2 = document.createElement('h2');
      h2.id = `section-${k}`;
      h2.textContent = labels[k] || k;
      if (first) {
        h2.classList.add('is-first');
        first = false;
      }
      decided.appendChild(h2);
      for (const e of items) {
        decided.appendChild(e.h3);
        if (e.dl) decided.appendChild(e.dl);
      }
    }
  }

  // === TOC + scroll spy ===

  function buildToc() {
    const list = document.getElementById('toc-list');
    if (!list) return;
    list.innerHTML = '';
    const decided = document.querySelector('.decided-view');
    if (!decided) return;
    const headings = [...decided.querySelectorAll('h2')];
    headings.forEach((h) => {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = `#${h.id}`;
      a.textContent = h.textContent;
      li.appendChild(a);
      list.appendChild(li);
    });
  }

  function setupScrollSpy() {
    if (activeObserver) {
      activeObserver.disconnect();
      activeObserver = null;
    }
    const links = [...document.querySelectorAll('#toc-list a')];
    const byId = new Map(links.map((a) => [a.getAttribute('href').slice(1), a]));
    const headings = [...document.querySelectorAll('.decided-view h2')];
    if (headings.length === 0) return;

    activeObserver = new IntersectionObserver(
      (intersections) => {
        const visible = intersections.filter((e) => e.isIntersecting);
        if (visible.length === 0) return;
        visible.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        links.forEach((a) => a.classList.remove('is-active'));
        const a = byId.get(visible[0].target.id);
        if (a) a.classList.add('is-active');
      },
      { rootMargin: '-25% 0px -65% 0px', threshold: 0 }
    );
    headings.forEach((h) => activeObserver.observe(h));
  }

  function updatePendingBadge() {
    const pendingEntries = document.querySelectorAll('.pending-view h3').length;
    const badge = document.getElementById('pending-count');
    if (badge && pendingEntries > 0) {
      badge.textContent = String(pendingEntries);
      badge.hidden = false;
    }
    const decidedEntries = document.querySelectorAll('.decided-view h3').length;
    const decidedBadge = document.getElementById('decided-count');
    if (decidedBadge && decidedEntries > 0) {
      decidedBadge.textContent = String(decidedEntries);
      decidedBadge.hidden = false;
    }
  }

  function initBackToTop() {
    const btn = document.getElementById('back-to-top');
    if (!btn) return;
    btn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
    const update = () => { btn.hidden = window.scrollY < 400; };
    window.addEventListener('scroll', update, { passive: true });
    update();
  }

  function updateLastModified() {
    const el = document.getElementById('updated');
    if (!el) return;
    const when = document.lastModified;
    if (!when) return;
    const d = new Date(when);
    el.textContent = `Last updated: ${d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}`;
  }

  // === Boot ===

  initTabs();
  initViewToggle();
  initTechToggle();
  initBackToTop();
  loadAndRender();
})();
