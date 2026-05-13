const SOURCE_URL = './decision-log.md';

const slugify = (text) =>
  text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');

async function loadAndRender() {
  const main = document.getElementById('content');
  let markdown;
  try {
    const res = await fetch(SOURCE_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    markdown = await res.text();
  } catch (err) {
    main.innerHTML = `<p class="loading">Could not load decision log: ${err.message}</p>`;
    main.removeAttribute('aria-busy');
    return;
  }

  marked.setOptions({ headerIds: false, mangle: false });
  main.innerHTML = marked.parse(markdown);
  main.removeAttribute('aria-busy');

  decorateHeadings(main);
  wrapPendingSection(main);
  buildToc(main);
  enableScrollSpy(main);
  updateLastModified();
}

function decorateHeadings(main) {
  for (const h of main.querySelectorAll('h2, h3')) {
    if (!h.id) h.id = slugify(h.textContent);
  }
}

function wrapPendingSection(main) {
  const h2s = Array.from(main.querySelectorAll('h2'));
  const pending = h2s.find((h) => /^\s*0\./.test(h.textContent));
  if (!pending) return;

  const wrapper = document.createElement('section');
  wrapper.className = 'pending';

  const nodes = [];
  let node = pending;
  while (node) {
    const next = node.nextElementSibling;
    if (node !== pending && (node.tagName === 'H2' || node.tagName === 'HR')) break;
    nodes.push(node);
    node = next;
  }
  pending.parentNode.insertBefore(wrapper, pending);
  nodes.forEach((n) => wrapper.appendChild(n));
}

function buildToc(main) {
  const list = document.getElementById('toc-list');
  const headings = main.querySelectorAll('h2');
  if (!headings.length) {
    document.getElementById('toc').hidden = true;
    return;
  }
  for (const h of headings) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `#${h.id}`;
    a.textContent = h.textContent;
    if (/^\s*0\./.test(h.textContent)) a.classList.add('is-pending');
    li.appendChild(a);
    list.appendChild(li);
  }
}

function enableScrollSpy(main) {
  const links = Array.from(document.querySelectorAll('#toc-list a'));
  const byId = new Map(links.map((a) => [a.getAttribute('href').slice(1), a]));
  const headings = Array.from(main.querySelectorAll('h2'));

  const observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        links.forEach((a) => a.classList.remove('is-active'));
        const a = byId.get(e.target.id);
        if (a) a.classList.add('is-active');
      }
    },
    { rootMargin: '-20% 0px -70% 0px', threshold: 0 }
  );

  headings.forEach((h) => observer.observe(h));
}

function updateLastModified() {
  const el = document.getElementById('updated');
  if (!el) return;
  const when = document.lastModified;
  if (when) el.textContent = `Last updated: ${new Date(when).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}`;
}

loadAndRender();
