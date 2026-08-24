/* Distributed calibration page shell (TASK-329.06.01).

   Wires the shared blind-review widget (review-widget.js) and the pure claim-lease core
   (calibration-core.js) to the GitHub Contents API. Reviewers open a link carrying a shared
   fine-grained token in the URL fragment, register a name, claim buckets (unavailable to others,
   except merge buckets that want two independent reviewers), label BLIND (scored items never reveal
   the panel answer — only the warm-up practice set does), and their verdicts auto-save to the
   private coordination repo. Resume by name from any device.

   Error handling: every GitHub call is classified (calibration-core.classifyError) into AUTH
   (401/403 → read-only), CAS (409/422 → refetch+retry), RETRYABLE (429/5xx/network → backoff+retry),
   or OTHER. A retry uses bounded backoff and a per-call timeout. Only a genuine AUTH failure switches
   the page to read-only; any other failure raises a distinct "not saved" banner WITHOUT disabling
   writes, and a save/complete is never reported as successful unless its write actually landed.

   Security: the token lives only in the link fragment (never sent to a server) and localStorage; it
   is never written into any published file. The reviewer name is validated (calibration-core) so it
   can't become an unsafe path segment, and path segments are URL-encoded. Independence between
   reviewers is honor-system — the UI never shows a peer's verdicts.

   CSP: connect-src 'self' https://api.github.com — scaffolds/buckets same-origin, coordination via
   the API only.

   Testability: the fetch/CAS layer is exported via the module.exports guard (browser runs boot();
   tests import ghGet/ghPut/withState/saveVerdict and stub global.fetch). */

(function () {
  "use strict";

  var OWNER = "civicliteracies";
  var REPO = "eiti-calibration";
  var API = "https://api.github.com/repos/" + OWNER + "/" + REPO + "/contents/";
  var STATE_PATH = "state.json";
  var TIMEOUT_MS = 15000;
  var MAX_TRIES = 5;
  var BACKOFF_MS = 400;
  // The two sibling classic scripts publish themselves onto window; typed `any` here (their strict
  // types live in their own files, checked via their own tests).
  var W = typeof window !== "undefined" ? /** @type {any} */ (window).CalibrationReviewWidget : undefined;
  var C = typeof window !== "undefined" ? /** @type {any} */ (window).CalibrationCoord : undefined;

  // Authored practice set — separate from the scored items, shown WITH the reveal so a reviewer
  // learns the task; never scored (not real scaffolds), so onboarding can't contaminate A/H.
  var PRACTICE = [
    { item_id: "practice-1", stratum: "merge", country_iso3: "XX",
      names: ["Ministry of Finance", "Min. of Finance", "MoF"], machine_verdict: "same", machine_detail: null },
    { item_id: "practice-2", stratum: "split", country_iso3: "XX",
      names: ["Ministry of Finance", "Ministry of Health"], machine_verdict: "different", machine_detail: null },
    { item_id: "practice-3", stratum: "disposition", country_iso3: "XX",
      names: ["Total revenue (all companies)"], machine_verdict: "not_entity", machine_detail: "aggregate" },
  ];

  // ---- token ------------------------------------------------------------------------------------
  var LS = typeof localStorage !== "undefined" ? localStorage : null; // null under a non-DOM test env
  function readToken() {
    var m = /(?:^|[#&])token=([^&]+)/.exec(location.hash || "");
    if (m && m[1]) {
      var tok = decodeURIComponent(m[1]);
      if (LS) LS.setItem("calib:token", tok);
      history.replaceState(null, "", location.pathname + location.search); // strip token from the address bar
      return tok;
    }
    return (LS && LS.getItem("calib:token")) || "";
  }
  var TOKEN = typeof window !== "undefined" && window.location ? readToken() : "";

  // ---- typed errors + GitHub Contents client ----------------------------------------------------
  /** @param {string} str */
  function b64encode(str) { return btoa(unescape(encodeURIComponent(str))); }
  /** @param {string} b64 */
  function b64decode(b64) { return decodeURIComponent(escape(atob(b64))); }

  /** @param {string} kind @param {number} status @param {string} message @returns {any} */
  function makeErr(kind, status, message) {
    var e = /** @type {any} */ (new Error(message));
    e.kind = kind; e.status = status;
    return e;
  }
  function timeoutSignal() {
    return (typeof AbortSignal !== "undefined" && AbortSignal.timeout) ? AbortSignal.timeout(TIMEOUT_MS) : undefined;
  }
  /** @param {number} ms @returns {Promise<void>} */
  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  var authFailed = false;
  var syncFailed = false;
  function markAuthFailed() { authFailed = true; renderBanner(); }

  // Classify + surface a sync failure WITHOUT disabling writes (unless it's a genuine AUTH failure).
  /** @param {any} err */
  function reportSyncFailure(err) {
    if (err && err.kind === "AUTH") { markAuthFailed(); return; }
    syncFailed = true;
    if (typeof console !== "undefined") console.error("calibration sync failure:", err);
    renderBanner();
  }

  // GET a file → {json, sha} or null (404). Throws a typed error otherwise.
  /** @param {string} path @returns {Promise<{json:any, sha:string}|null>} */
  function ghGet(path) {
    /** @type {any} */
    var opts = { headers: { Authorization: "Bearer " + TOKEN, Accept: "application/vnd.github+json" } };
    var sig = timeoutSignal(); if (sig) opts.signal = sig;
    return fetch(API + path, opts).catch(function (e) {
      throw makeErr("RETRYABLE", 0, "network: " + (e && e.message)); // fetch reject (network/DNS/abort)
    }).then(function (r) {
      if (r.status === 404) return null;
      if (!r.ok) throw makeErr(C.classifyError(r.status), r.status, "GET " + path + " → " + r.status);
      return r.json().then(function (j) { return { json: JSON.parse(b64decode(j.content)), sha: j.sha }; });
    });
  }
  // PUT a file (sha optional to create). Resolves {sha}; throws a typed error on failure.
  /** @param {string} path @param {any} obj @param {string} [sha] @returns {Promise<{sha:string}>} */
  function ghPut(path, obj, sha) {
    /** @type {any} */
    var body = { message: "calibration: update " + path, content: b64encode(JSON.stringify(obj, null, 2)) };
    if (sha) body.sha = sha;
    /** @type {any} */
    var opts = {
      method: "PUT",
      headers: { Authorization: "Bearer " + TOKEN, Accept: "application/vnd.github+json" },
      body: JSON.stringify(body),
    };
    var sig = timeoutSignal(); if (sig) opts.signal = sig;
    return fetch(API + path, opts).catch(function (e) {
      throw makeErr("RETRYABLE", 0, "network: " + (e && e.message));
    }).then(function (r) {
      if (!r.ok) throw makeErr(C.classifyError(r.status), r.status, "PUT " + path + " → " + r.status);
      return r.json().then(function (j) { return { sha: j.content.sha }; });
    });
  }

  // Read-modify-write state.json under CAS. mutate(state) → newState, or null to DECLINE (no write).
  // Resolves { ok, declined?, state }; retries CAS/RETRYABLE with backoff; throws typed error otherwise.
  /** @param {(state:any)=>any} mutate @param {number} [tries] @returns {Promise<{ok:boolean, declined?:boolean, state:any}>} */
  function withState(mutate, tries) {
    tries = tries == null ? MAX_TRIES : tries;
    return ghGet(STATE_PATH).then(function (cur) {
      var state = cur ? cur.json : C.emptyState();
      var sha = cur ? cur.sha : undefined;
      var next = mutate(state);
      if (next == null) return { ok: false, declined: true, state: state }; // mutator declined — no write
      return ghPut(STATE_PATH, next, sha).then(function () { return { ok: true, state: next }; });
    }).catch(function (e) {
      if (C.isRetryable(e && e.kind) && tries > 0) return delay(BACKOFF_MS).then(function () { return withState(mutate, tries - 1); });
      throw e;
    });
  }

  // A reviewer's verdict file, union-merged under CAS. Throws a typed error on final failure.
  /** @param {string} bucketId @param {string} reviewer @param {string} itemId @param {string} verdict @param {number} [tries] @returns {Promise<any>} */
  function saveVerdict(bucketId, reviewer, itemId, verdict, tries) {
    tries = tries == null ? MAX_TRIES : tries;
    var path = "verdicts/" + encodeURIComponent(bucketId) + "__" + encodeURIComponent(reviewer) + ".json";
    return ghGet(path).then(function (cur) {
      var decisions = cur ? (cur.json.decisions || {}) : {};
      decisions = C.unionVerdicts({}, decisions); // normalize (drop malformed cells)
      decisions[itemId] = { verdict: verdict, timestamp: Date.now() };
      var payload = { reviewer: reviewer, bucket_id: bucketId, decisions: decisions };
      return ghPut(path, payload, cur ? cur.sha : undefined);
    }).catch(function (e) {
      if (C.isRetryable(e && e.kind) && tries > 0) return delay(BACKOFF_MS).then(function () { return saveVerdict(bucketId, reviewer, itemId, verdict, tries - 1); });
      throw e;
    });
  }

  // ---- app state (in memory) --------------------------------------------------------------------
  /** @type {any[]} */ var SCAFFOLDS = [];
  /** @type {any[]} */ var BUCKETS = [];
  /** @type {any} */ var MANIFEST = {};
  /** @type {Record<string, any>} */ var ITEMS_BY_ID = {};
  var state = C ? C.emptyState() : { roster: [], buckets: {} };
  var reviewer = LS ? (LS.getItem("calib:reviewer") || "") : "";
  /** @type {{mode:string, bucket:any, idx:number, localVerdicts:Record<string,string>, unsaved:Record<string,boolean>}} */
  var view = { mode: "loading", bucket: null, idx: 0, localVerdicts: {}, unsaved: {} };

  /** @param {any} bucket @returns {any[]} */
  function scaffoldsFor(bucket) { return bucket.item_ids.map(function (/** @type {string} */ id) { return ITEMS_BY_ID[id]; }).filter(Boolean); }
  function unsavedCount() { return Object.keys(view.unsaved).length; }

  // ---- rendering --------------------------------------------------------------------------------
  // Cast to non-null: in the browser boot() runs only with #app/#banner present; in tests boot() and
  // the render fns are never called (the module.exports branch exports the I/O layer only).
  var root = /** @type {HTMLElement} */ (typeof document !== "undefined" ? document.getElementById("app") : null);
  var bannerEl = /** @type {HTMLElement} */ (typeof document !== "undefined" ? document.getElementById("banner") : null);
  function renderBanner() {
    if (!bannerEl) return;
    if (authFailed) {
      bannerEl.textContent = "Your link/token is missing or expired — the page is read-only. Keep labeling and use Export, then send me the file.";
      bannerEl.className = "banner error";
    } else if (syncFailed || unsavedCount() > 0) {
      var n = unsavedCount();
      bannerEl.textContent = n > 0
        ? (n + " item" + (n === 1 ? "" : "s") + " didn't save — check your connection; re-label them or Export as a backup.")
        : "A sync step failed — your last action may not be saved. Check your connection and try again.";
      bannerEl.className = "banner error";
    } else { bannerEl.textContent = ""; bannerEl.className = "banner"; }
  }

  function refreshState() { return withState(function (s) { state = s; return null; }).then(function () { return state; }); }

  function renderRoster() {
    view.mode = "roster";
    root.textContent = "";
    var card = el("div", "card");
    card.appendChild(el("h2", null, "Who's reviewing?"));
    card.appendChild(el("p", "muted", "Pick your name to resume, or add a new one."));
    /** @type {string[]} */
    var names = (state.roster || []);
    if (names.length) {
      var sel = document.createElement("select");
      names.forEach(function (n) { var o = document.createElement("option"); o.value = n; o.textContent = n; sel.appendChild(o); });
      var use = button("Use this name", function () { setReviewer(sel.value); });
      card.appendChild(sel); card.appendChild(use);
      card.appendChild(el("div", "muted", "— or —"));
    }
    var input = document.createElement("input"); input.placeholder = "New reviewer name"; input.className = "name-input";
    input.id = "reviewer-name"; input.setAttribute("aria-label", "New reviewer name"); input.maxLength = 40;
    var add = button("Register + start", function () {
      var name = input.value.trim();
      if (!name) return;
      withState(function (s) {
        var r = C.registerName(s, name);
        if (!r.ok) { alert("Can't use that name: " + r.reason); return null; } // decline — no write
        state = r.state; return r.state;
      }).then(function (res) {
        if (res.ok) setReviewer(name); // only advance when the write actually landed
      }).catch(function (e) { reportSyncFailure(e); });
    });
    card.appendChild(input); card.appendChild(add);
    root.appendChild(card);
  }

  /** @param {string} name */
  function setReviewer(name) {
    reviewer = name;
    localStorage.setItem("calib:reviewer", name);
    if (!localStorage.getItem("calib:practiced")) renderPractice(0);
    else renderBoard();
  }

  /** @param {number} i */
  function renderPractice(i) {
    view.mode = "practice";
    root.textContent = "";
    root.appendChild(el("div", "practice-note", "Practice — these are examples with the answer shown, to learn the task. They are not scored."));
    const item = PRACTICE[i]; // const so the not-undefined narrowing below persists into the closures
    if (i >= PRACTICE.length || !item) { localStorage.setItem("calib:practiced", "1"); renderBoard(); return; }
    var main = el("div", null); root.appendChild(main);
    var render = function (/** @type {string|null} */ decided) {
      W.renderReviewItem(document, main, item, decided, {
        reveal: true, position: i + 1, total: PRACTICE.length,
        onChoose: function () { render(item.machine_verdict); }, // show the reveal on any choice
        onNext: function () { renderPractice(i + 1); }, onPrev: function () { renderPractice(Math.max(0, i - 1)); },
      });
    };
    render(null);
  }

  function renderBoard() {
    view.mode = "board";
    root.textContent = "";
    var now = Date.now();
    root.appendChild(el("h2", null, "Buckets — " + reviewer));
    var refresh = button("Refresh", function () { refreshState().then(renderBoard).catch(function (e) { reportSyncFailure(e); }); });
    refresh.className = "secondary"; root.appendChild(refresh);
    var grid = el("div", "board");
    BUCKETS.forEach(function (b) {
      var st = C.bucketStatus(state.buckets[b.bucket_id], b.confirmations_required, reviewer, now);
      var cell = el("div", "bucket " + st.state);
      cell.appendChild(el("div", "bid", b.bucket_id));
      cell.appendChild(el("div", "meta", b.item_ids.length + " items · needs " + b.confirmations_required +
        (st.holders.length ? " · " + st.holders.join(", ") : "")));
      cell.appendChild(el("div", "state-tag", st.state));
      if (!authFailed && (st.state === "available" || st.state === "mine")) {
        cell.appendChild(button(st.state === "mine" ? "Continue" : "Claim + open", function () { openBucket(b); }));
      }
      grid.appendChild(cell);
    });
    root.appendChild(grid);
    var exp = button("Export my verdicts", exportLocal); exp.className = "secondary"; root.appendChild(exp);
  }

  /** @param {any} b */
  function openBucket(b) {
    if (authFailed) { view.bucket = b; view.idx = 0; renderLabel(); return; } // read-only: label locally + Export
    withState(function (s) {
      var r = C.claim(s, b.bucket_id, b.confirmations_required, reviewer, Date.now());
      if (!r.ok) return null; // declined (full) — don't write
      state = r.state; return r.state;
    }).then(function (res) {
      if (res.declined) { alert("This bucket is full — someone else took the last slot. Pick another."); return; } // BAIL — don't open
      view.bucket = b; view.idx = 0; renderLabel();
    }).catch(function (e) { reportSyncFailure(e); });
  }

  // One place both the click and the keydown paths commit a verdict + advance.
  /** @param {string} v */
  function chooseAndAdvance(v) {
    var items = scaffoldsFor(view.bucket);
    var it = items[view.idx];
    if (!it) return;
    view.localVerdicts[it.item_id] = v;
    delete view.unsaved[it.item_id];
    if (!authFailed) {
      saveVerdict(view.bucket.bucket_id, reviewer, it.item_id, v)
        .catch(function (e) { view.unsaved[it.item_id] = true; reportSyncFailure(e); });
    }
    view.idx += 1;
    renderLabel();
  }

  function renderLabel() {
    view.mode = "label";
    var items = scaffoldsFor(view.bucket);
    root.textContent = "";
    root.appendChild(button("← Back to buckets", function () { renderBoard(); }));
    if (view.idx >= items.length) {
      if (unsavedCount() > 0) {
        root.appendChild(el("div", "done", unsavedCount() + " item(s) didn't save. Re-open the bucket to retry, or Export as a backup — this bucket is NOT marked complete."));
        return; // don't claim completion while verdicts are known-unsaved
      }
      if (!authFailed) {
        withState(function (s) {
          var r = C.complete(s, view.bucket.bucket_id, reviewer, view.bucket.confirmations_required);
          if (!r.ok) return null; // already at capacity via others — don't write
          state = r.state; return r.state;
        }).then(function (res) {
          root.textContent = "";
          root.appendChild(button("← Back to buckets", function () { renderBoard(); }));
          root.appendChild(el("div", "done", res.declined
            ? "This bucket was already completed by enough other reviewers while you were away — your answers are saved but it needed no more."
            : "Bucket complete. Thank you! Pick another from the board."));
        }).catch(function (e) {
          reportSyncFailure(e);
          root.appendChild(el("div", "done", "Your answers are saved, but marking the bucket complete failed — click Refresh on the board and it will reconcile."));
        });
      } else {
        root.appendChild(el("div", "done", "All items labeled locally. Use Export and send me the file."));
      }
      return;
    }
    var it = items[view.idx];
    var main = el("div", null); root.appendChild(main);
    // scored items are BLIND — reveal:false, no machine answer shown, ever.
    W.renderReviewItem(document, main, it, (view.localVerdicts[it.item_id] || null), {
      reveal: false, position: view.idx + 1, total: items.length,
      onChoose: chooseAndAdvance,
      onNext: function () { view.idx += 1; renderLabel(); },
      onPrev: function () { view.idx = Math.max(0, view.idx - 1); renderLabel(); },
    });
  }

  function exportLocal() {
    /** @type {{tool:string, version:number, reviewer:string, exported:string, decisions:Record<string, any>}} */
    var out = { tool: "calibration-review", version: 1, reviewer: reviewer,
      exported: new Date().toISOString(), decisions: {} };
    Object.keys(view.localVerdicts).forEach(function (id) { out.decisions[id] = { verdict: view.localVerdicts[id], timestamp: Date.now() }; });
    var blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a"); a.href = url;
    a.download = "calibration_decisions_" + (reviewer || "anon") + ".json"; a.click();
    URL.revokeObjectURL(url); // release immediately — the download was handed off synchronously
  }

  // ---- helpers ----------------------------------------------------------------------------------
  /** @param {string} tag @param {string|null} [cls] @param {string} [text] @returns {HTMLElement} */
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  /** @param {string} label @param {(this:GlobalEventHandlers, ev:MouseEvent)=>any} onclick @returns {HTMLButtonElement} */
  function button(label, onclick) { var b = document.createElement("button"); b.textContent = label; b.onclick = onclick; return b; }

  if (typeof document !== "undefined") {
    document.addEventListener("keydown", function (e) {
      if (view.mode !== "label") return;
      var items = scaffoldsFor(view.bucket);
      W.reviewItemKeydown(e, {
        item: view.idx < items.length ? items[view.idx] : null,
        onChoose: chooseAndAdvance,
        onNext: function () { view.idx += 1; renderLabel(); },
        onPrev: function () { view.idx = Math.max(0, view.idx - 1); renderLabel(); },
      });
    });
  }

  // ---- boot -------------------------------------------------------------------------------------
  function boot() {
    renderBanner();
    if (!TOKEN) markAuthFailed();
    Promise.all([
      fetch("scaffolds.json").then(function (r) { if (!r.ok) throw new Error("scaffolds.json → " + r.status); return r.json(); }),
      fetch("buckets.json").then(function (r) { if (!r.ok) throw new Error("buckets.json → " + r.status); return r.json(); }),
      fetch("manifest.json").then(function (r) { if (!r.ok) throw new Error("manifest.json → " + r.status); return r.json(); }),
    ]).then(function (res) {
      SCAFFOLDS = res[0]; BUCKETS = res[1]; MANIFEST = res[2];
      SCAFFOLDS.forEach(function (s) { ITEMS_BY_ID[s.item_id] = s; });
      return authFailed ? null : refreshState().catch(function (e) {
        // Coordination state failed to load — surface it and stop. An empty board would show every
        // bucket as available and invite double-claims, so a load failure must halt boot.
        reportSyncFailure(e);
        throw e;
      });
    }).then(function () {
      if (authFailed && !reviewer) { root.appendChild(el("div", "muted", "Read-only: no token. You can still label locally and Export.")); }
      if (reviewer && localStorage.getItem("calib:practiced")) renderBoard();
      else if (reviewer) renderPractice(0);
      else renderRoster();
    }).catch(function (e) {
      root.textContent = "";
      root.appendChild(el("div", "error", "Could not load calibration data: " + e.message));
      root.appendChild(button("Reload", function () { location.reload(); }));
    });
  }

  var api = { ghGet: ghGet, ghPut: ghPut, withState: withState, saveVerdict: saveVerdict };
  if (typeof module !== "undefined" && module.exports) module.exports = api; // tests import the I/O layer
  else boot(); // browser
})();
