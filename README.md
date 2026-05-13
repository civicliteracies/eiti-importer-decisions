# EITI Data Importer — Decision Log

Public mirror of the decision log for the EITI Data Importer project. The site
at [civicliteraci.es/eiti-importer-decisions](https://civicliteraci.es/eiti-importer-decisions/)
renders [`decision-log.md`](./decision-log.md) as a categorized, navigable
reference.

The log is the source of truth for **how the importer handles data** — every
entry documents a choice that affects what the tool does with submitted files.
The first section, *Pending Decisions*, lists choices that are open and what
would unblock them.

## How this repo stays in sync

`decision-log.md` is pushed automatically by a workflow in the private source
repository whenever the canonical decision log changes. A sanitization step
drops entries marked private and strips line-number references that would rot
quickly.

The site itself (`index.html`, `style.css`, `script.js`) is hand-maintained
here — only `decision-log.md` is overwritten by the mirror.

## Local preview

Opening `index.html` directly via `file://` will not work — the page fetches
`decision-log.md` over HTTP, and browsers block `file://` fetches. Serve the
directory over HTTP instead:

```bash
python3 -m http.server 8000
# then open http://localhost:8000/
```

Any static-file server works (`npx serve`, `caddy file-server`, etc.).

## License

Content (`decision-log.md`) and site assets are released under
[CC BY 4.0](./LICENSE).
