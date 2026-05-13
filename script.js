/* eslint-env browser */
(() => {
  const SOURCE = './decision-log.md';
  const THEMES = ['system', 'light', 'dark'];
  const THEME_LABELS = { system: 'Auto', light: 'Light', dark: 'Dark' };

  // === Theme ===

  function applyTheme(t) {
    if (!THEMES.includes(t)) t = 'system';
    document.documentElement.dataset.theme = t;
    const label = document.getElementById('theme-label');
    if (label) label.textContent = THEME_LABELS[t];
    try { localStorage.setItem('theme', t); } catch {}
  }

  function cycleTheme() {
    const cur = localStorage.getItem('theme') || 'system';
    const idx = THEMES.indexOf(cur);
    applyTheme(THEMES[(idx + 1) % THEMES.length]);
  }

  function initTheme() {
    const stored = (() => { try { return localStorage.getItem('theme'); } catch { return null; } })();
    applyTheme(stored || 'system');
    const btn = document.getElementById('theme-toggle');
    if (btn) btn.addEventListener('click', cycleTheme);
  }

  // === Tabs ===

  function currentTab() {
    return location.hash === '#/pending' ? 'pending' : 'decided';
  }

  function applyTab(tab) {
    document.body.dataset.tab = tab;
    document.querySelectorAll('.tab').forEach((a) => {
      const on = a.dataset.tab === tab;
      a.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    // After switching tabs, scroll to top of content (unless a sub-hash is set)
    if (!location.hash.includes('#section-') && !location.hash.includes('#entry-')) {
      window.scrollTo({ top: 0, behavior: 'auto' });
    }
  }

  function initTabs() {
    applyTab(currentTab());
    window.addEventListener('hashchange', () => applyTab(currentTab()));
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
    splitIntoSections(main);
    structureFields(main);
    buildToc();
    setupScrollSpy();
    updateLastModified();
    updatePendingBadge();
  }

  // Hide markdown's own h1 and the intro paragraphs.
  function hideIntro(main) {
    const firstH2 = main.querySelector('h2');
    if (!firstH2) return;
    let node = main.firstElementChild;
    while (node && node !== firstH2) {
      node.classList.add('intro-hidden');
      node = node.nextElementSibling;
    }
  }

  // Wrap section 0 in .pending-view and the rest in .decided-view.
  function splitIntoSections(main) {
    const h2s = [...main.querySelectorAll('h2')];
    if (h2s.length === 0) return;

    const pendingH2 = h2s.find((h) => /^\s*0\./.test(h.textContent));
    const otherH2s = h2s.filter((h) => h !== pendingH2);

    // Build wrappers
    const pendingWrap = pendingH2 ? document.createElement('section') : null;
    if (pendingWrap) {
      pendingWrap.className = 'pending-view';
      pendingH2.parentNode.insertBefore(pendingWrap, pendingH2);
      collectUntilNextH2(pendingH2, pendingWrap);
    }

    if (otherH2s.length > 0) {
      const decidedWrap = document.createElement('section');
      decidedWrap.className = 'decided-view';
      otherH2s[0].parentNode.insertBefore(decidedWrap, otherH2s[0]);
      // Move all remaining h2 blocks into decidedWrap
      let next = otherH2s[0];
      while (next) {
        const after = nextH2(next);
        collectUntilNextH2(next, decidedWrap);
        next = after;
      }
      // Mark the first decided h2 as "is-first" so it doesn't draw a border above
      const firstH2 = decidedWrap.querySelector('h2');
      if (firstH2) firstH2.classList.add('is-first');
    }
  }

  function nextH2(node) {
    let n = node.nextElementSibling;
    while (n && n.tagName !== 'H2') n = n.nextElementSibling;
    return n;
  }

  // Move node and all following siblings up to (but excluding) the next h2 into target.
  function collectUntilNextH2(startH2, target) {
    const blocks = [startH2];
    let n = startH2.nextElementSibling;
    while (n && n.tagName !== 'H2') {
      blocks.push(n);
      n = n.nextElementSibling;
    }
    blocks.forEach((b) => target.appendChild(b));
  }

  // === Field structuring ===
  // Each `### entry` has labelled paragraphs (Situation/Decision/etc.). Convert
  // them into a <dl class="fields"> with the label as <dt>, body as <dd>.
  // Handles both source styles: blank-line-separated paragraphs and collapsed
  // paragraphs that contain multiple "<strong>Label:</strong>" markers.

  function structureFields(root) {
    const h3s = [...root.querySelectorAll('h3')];
    for (const h3 of h3s) {
      const blocks = [];
      let n = h3.nextElementSibling;
      while (n && n.tagName !== 'H2' && n.tagName !== 'H3') {
        blocks.push(n);
        n = n.nextElementSibling;
      }

      // Determine field-start positions inside each block.
      // A field-start is a <p> whose innerHTML starts with <strong>Word(s):</strong>.
      // Build a sequence of items: either { field, label, intro:<DocumentFragment> }
      // or { extra:<Element> } that belong to the previous field.
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
          // Remove the original block — its content is now in the items
          block.remove();
        } else {
          items.push({ extra: block });
        }
      }

      // Assemble fields and trailing extras
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

      // Build the dl
      const dl = document.createElement('dl');
      dl.className = 'fields';
      for (const f of fields) {
        const dt = document.createElement('dt');
        dt.textContent = f.label;
        const dd = document.createElement('dd');
        f.content.forEach((c) => dd.appendChild(c));
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

  // === TOC + scroll spy ===

  function slugify(text) {
    return text.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');
  }

  function buildToc() {
    const list = document.getElementById('toc-list');
    list.innerHTML = '';
    const decided = document.querySelector('.decided-view');
    if (!decided) return;
    const headings = [...decided.querySelectorAll('h2')];
    headings.forEach((h, i) => {
      if (!h.id) h.id = `section-${slugify(h.textContent) || i}`;
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = `#${h.id}`;
      a.textContent = h.textContent;
      li.appendChild(a);
      list.appendChild(li);
    });
  }

  function setupScrollSpy() {
    const links = [...document.querySelectorAll('#toc-list a')];
    const byId = new Map(links.map((a) => [a.getAttribute('href').slice(1), a]));
    const headings = [...document.querySelectorAll('.decided-view h2')];
    if (headings.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting);
        if (visible.length === 0) return;
        visible.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        links.forEach((a) => a.classList.remove('is-active'));
        const a = byId.get(visible[0].target.id);
        if (a) a.classList.add('is-active');
      },
      { rootMargin: '-25% 0px -65% 0px', threshold: 0 }
    );
    headings.forEach((h) => observer.observe(h));
  }

  function updatePendingBadge() {
    const pendingEntries = document.querySelectorAll('.pending-view h3').length;
    const badge = document.getElementById('pending-count');
    if (!badge) return;
    if (pendingEntries > 0) {
      badge.textContent = String(pendingEntries);
      badge.hidden = false;
    }
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

  initTheme();
  initTabs();
  loadAndRender();
})();
