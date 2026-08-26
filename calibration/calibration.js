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

   Single active session: because identity is a self-asserted name that any number of tabs/devices can
   resume, two tiers keep exactly one writer. Within a browser, navigator.locks elects one active tab
   (the others go read-only, promoted automatically when the holder closes). Across browsers/devices —
   where no in-browser channel exists — a lazy presence marker in state.json (calibration-core session
   reducers) plus a one-click take-over keep it legible; it is never a heartbeat and never auto-steals
   a live peer. `mode` (calibration-core.deriveMode) is a sum type — active / electing / passive-tab /
   passive-session / auth — that gates every state-mutating write EXCEPT register (no name exists yet).
   Concurrency is already data-safe via CAS + unionVerdicts, so this tier buys legibility, not safety.

   Security: the token lives only in the link fragment (never sent to a server) and localStorage; it
   is never written into any published file. The reviewer name is validated (calibration-core) so it
   can't become an unsafe path segment, and path segments are URL-encoded. Independence between
   reviewers is honor-system — the UI never shows a peer's verdicts.

   CSP: connect-src 'self' https://api.github.com — scaffolds/buckets same-origin, coordination via
   the API only.

   Testability: the fetch/CAS layer is exported via the module.exports guard (browser runs boot();
   tests import ghGet/ghPut/withState/saveVerdicts/makeVerdictWriter and stub global.fetch). */

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
  // Exponential backoff with full jitter, so retries that lost the same race don't re-collide in
  // lockstep on the next attempt. `attempt` is 0-based (0 = first retry).
  /** @param {number} attempt @returns {number} */
  function backoff(attempt) {
    var ceiling = BACKOFF_MS * Math.pow(2, attempt);
    return Math.round(Math.random() * ceiling);
  }

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
      if (C.isRetryable(e && e.kind) && tries > 0) return delay(backoff(MAX_TRIES - tries)).then(function () { return withState(mutate, tries - 1); });
      throw e;
    });
  }

  // Merge a batch of {itemId: verdict} into a reviewer's verdict file, union-preserving prior
  // decisions, under CAS. One commit per call regardless of batch size. Throws a typed error on
  // final failure. The verdict writer (makeVerdictWriter) serializes calls so no two overlap on the
  // same file — the CAS retry here only ever handles a genuine cross-device race.
  /** @param {string} bucketId @param {string} reviewer @param {Record<string,string>} newDecisions @param {number} [tries] @returns {Promise<any>} */
  function saveVerdicts(bucketId, reviewer, newDecisions, tries) {
    tries = tries == null ? MAX_TRIES : tries;
    var path = "verdicts/" + encodeURIComponent(bucketId) + "__" + encodeURIComponent(reviewer) + ".json";
    return ghGet(path).then(function (cur) {
      var decisions = cur ? (cur.json.decisions || {}) : {};
      decisions = C.unionVerdicts({}, decisions); // normalize (drop malformed cells)
      var now = Date.now();
      Object.keys(newDecisions).forEach(function (id) { decisions[id] = { verdict: newDecisions[id], timestamp: now }; });
      var payload = { reviewer: reviewer, bucket_id: bucketId, decisions: decisions };
      return ghPut(path, payload, cur ? cur.sha : undefined);
    }).catch(function (e) {
      if (C.isRetryable(e && e.kind) && tries > 0) return delay(backoff(MAX_TRIES - tries)).then(function () { return saveVerdicts(bucketId, reviewer, newDecisions, tries - 1); });
      throw e;
    });
  }

  // Coalescing serialized writer for verdict files. Rapid labels accumulate in `pending` and flush
  // together (one commit per file), and every flush runs behind a single `chain` promise so two
  // GET→PUT cycles can never overlap on the same file — the 409 sha-race is structurally impossible,
  // not merely retried, and N labels collapse to a handful of commits (dodging the secondary rate
  // limit). io.save persists one file's batch; io.onSaved / io.onFailed report which item ids landed
  // or need re-labeling. Injected so the writer is unit-testable without the DOM.
  /** @param {{save:(b:string,r:string,d:Record<string,string>)=>Promise<any>, onSaved?:(ids:string[])=>void, onFailed?:(ids:string[], err:any)=>void, isRetryable?:(err:any)=>boolean, debounceMs?:number, retryMs?:number}} io */
  function makeVerdictWriter(io) {
    var debounceMs = io.debounceMs == null ? 700 : io.debounceMs;
    var retryMs = io.retryMs == null ? 3000 : io.retryMs; // spacing before an automatic re-flush after a retryable failure
    /** @type {Record<string, {bucketId:string, reviewer:string, decisions:Record<string,string>}>} */
    var pending = {};
    /** @type {Promise<any>} */
    var chain = Promise.resolve();
    /** @type {any} */
    var timer = null;
    /** @param {string} bucketId @param {string} reviewer */
    function keyFor(bucketId, reviewer) { return bucketId + " " + reviewer; }
    /** @param {number} [ms] */
    function schedule(ms) { if (timer == null) timer = setTimeout(function () { timer = null; flush(); }, ms == null ? debounceMs : ms); }
    // Flush all pending files, one at a time, behind `chain`. Resolves when the drain completes. The
    // leading `.catch` keeps the chain resolve-only forever, so a throw in any callback can never
    // poison later flushes (which would otherwise silently kill the writer).
    function flush() {
      chain = chain.catch(function () {}).then(function () {
        return Object.keys(pending).reduce(function (p, k) {
          return p.then(function () {
            var slot = pending[k];
            if (!slot) return;
            var decisions = slot.decisions; // narrowed local — survives capture into the closures below
            /** @type {Record<string,string>} */
            var batch = {};
            Object.keys(decisions).forEach(function (id) { var v = decisions[id]; if (v != null) batch[id] = v; });
            var ids = Object.keys(batch);
            if (!ids.length) { delete pending[k]; return; }
            return io.save(slot.bucketId, slot.reviewer, batch).then(function () {
              // clear only the items we flushed whose verdict hasn't changed since the snapshot
              ids.forEach(function (id) { if (decisions[id] === batch[id]) delete decisions[id]; });
              if (!Object.keys(decisions).length) delete pending[k];
              try { if (io.onSaved) io.onSaved(ids); } catch (e) { /* a callback throw must not poison the chain */ }
            }, function (err) {
              try { if (io.onFailed) io.onFailed(ids, err); } catch (e) { /* as above */ } // items stay in `pending`
              // Only a retryable failure earns an automatic re-flush; a permanent one (AUTH/OTHER) would
              // otherwise spin a forever request loop — and a 403 secondary-rate-limit maps to AUTH, so
              // re-flushing it would sustain the very throttle we're avoiding. Items remain in `pending`
              // regardless, so Export and the completion recheck still cover them.
              if (!io.isRetryable || io.isRetryable(err)) schedule(retryMs + Math.round(Math.random() * retryMs));
            });
          });
        }, Promise.resolve());
      });
      return chain;
    }
    return {
      /** @param {string} bucketId @param {string} reviewer @param {string} itemId @param {string} verdict */
      queue: function (bucketId, reviewer, itemId, verdict) {
        var k = keyFor(bucketId, reviewer);
        var slot = pending[k] || (pending[k] = { bucketId: bucketId, reviewer: reviewer, decisions: {} });
        slot.decisions[itemId] = verdict;
        schedule();
      },
      // Cancel the debounce and flush now; await the returned promise before treating a bucket as done.
      flushNow: function () { if (timer != null) { clearTimeout(timer); timer = null; } return flush(); },
    };
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

  // The single verdict writer for this session: labels queue here and flush coalesced + serialized.
  // onSaved clears the "unsaved" mark once a batch lands; onFailed marks its items unsaved + banners.
  var verdictWriter = makeVerdictWriter({
    save: saveVerdicts,
    // A landed batch clears its items' unsaved marks and, once nothing is outstanding, the sticky
    // syncFailed flag — otherwise the banner would keep crying "sync failed" after a recovered blip.
    onSaved: function (ids) {
      ids.forEach(function (id) { delete view.unsaved[id]; });
      if (unsavedCount() === 0) { syncFailed = false; markSaved(); }
      renderBanner();
    },
    onFailed: function (ids, err) {
      ids.forEach(function (id) { view.unsaved[id] = true; });
      saveState = "idle"; renderSaveIndicator(); // clear the calm "Saving…" — the amber banner owns the failure now
      reportSyncFailure(err);
    },
    isRetryable: function (err) { return C.isRetryable(err && err.kind); },
  });

  // ---- single active session --------------------------------------------------------------------
  // Two tiers: navigator.locks elects ONE active tab per browser (instant, no network); a lazy
  // presence marker in state.json + a one-click take-over keep a single active writer legible across
  // browsers/devices. The pure core (planPresence/deriveMode) owns every decision; this shell only
  // executes it. `mode` gates every state-mutating write EXCEPT register (no name exists pre-register).
  var SS = typeof sessionStorage !== "undefined" ? sessionStorage : null; // per-tab: survives F5, clears on close
  function readSessionId() {
    var id = SS ? SS.getItem("calib:sid") : null;
    if (!id) {
      id = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : (String(Date.now()) + "-" + Math.random());
      if (SS) SS.setItem("calib:sid", id);
    }
    return id;
  }
  var SESSION_ID = readSessionId();
  /** @type {"electing"|"held"|"waiting"|"unsupported"} */
  var lockState = "electing";
  /** @type {"active"|"electing"|"passive-tab"|"passive-session"|"auth"|"unset"} */
  var mode = "unset"; // before a name is chosen
  function isActive() { return mode === "active"; }

  function hasLocks() { return typeof navigator !== "undefined" && !!navigator.locks; }
  function lockName() { return "calib:writer:" + encodeURIComponent(reviewer); }

  // Intra-browser leader election. The held tab keeps a never-resolving callback (releases only on tab
  // teardown or a steal); waiting tabs are promoted automatically when the holder goes. During a
  // take-over `takingOver` is set, so `afterLock` treats our self-abort as intentional, not a real loss.
  /** @type {AbortController|null} */
  var lockCtl = null;
  var takingOver = false;       // in-flight guard: a take-over is between click and settle (no double-fire)
  var pendingBoardFocus = false; // move focus to the board heading after a take-over, for keyboard/SR users
  function manageLock() {
    if (!hasLocks()) { lockState = "unsupported"; recomputeMode(); return; }
    lockState = "electing"; recomputeMode();
    var electing = setTimeout(function () { if (lockState === "electing") { lockState = "waiting"; recomputeMode(); } }, 300);
    lockCtl = new AbortController();
    var locks = navigator.locks;
    locks.request(lockName(), { signal: lockCtl.signal }, function () {
      clearTimeout(electing); lockState = "held"; recomputeMode();
      return new Promise(function () {}); // hold until tab teardown or steal
    }).then(afterLock, afterLock);
    function afterLock() {
      clearTimeout(electing);
      if (takingOver) return; // our own abort en route to a steal — the steal re-holds; not a real loss
      if (reviewer && !authFailed) manageLock(); // lost or stolen-from → re-elect (queue for promotion)
    }
  }
  // "Make this the active session" — become the SOLE active writer in ONE action by seizing BOTH tiers:
  // the cross-browser presence marker (always) and, when another tab in this browser holds it, the
  // intra-browser Web Lock. Seizing only one leaves the session stuck one tier short (lock without
  // presence → passive-session; presence without lock → passive-tab). `takingOver` blocks a double-click.
  function takeOver() {
    if (authFailed || takingOver) return;
    takingOver = true; pendingBoardFocus = true;
    var pending = 1; // count the async seizes; clear `takingOver` only when all have settled
    function done() { if (--pending <= 0) takingOver = false; }
    // Presence: claim the marker for this session; a remote/other holder steps down on its next read.
    withState(function (s) { state = C.takeoverSession(s, reviewer, SESSION_ID, Date.now()).state; return state; })
      .then(function () { recomputeMode(); rerenderCurrent(); done(); })
      .catch(function (e) { reportSyncFailure(e); done(); });
    // Lock: steal it only when we don't already hold it (a self-steal would needlessly churn our hold).
    if (hasLocks() && lockState !== "held") {
      pending++;
      if (lockCtl) lockCtl.abort(); // cancel our own pending wait first (afterLock sees `takingOver`)
      navigator.locks.request(lockName(), { steal: true }, function () {
        lockState = "held"; recomputeMode(); rerenderCurrent(); done();
        return new Promise(function () {});
      }).then(afterSteal, afterSteal);
      function afterSteal() { done(); if (reviewer && !authFailed) manageLock(); }
    }
  }

  // Decide the presence write over freshly-fetched state: claim a free/stale slot or refresh our own,
  // or return null to decline when a live FOREIGN session holds the name. Pure — the caller always
  // adopts the fetched state regardless, so a decline still updates our view of reality.
  /** @param {any} s @param {string} rev @param {string} sid @param {number} now @returns {any} */
  function presenceMutation(s, rev, sid, now) {
    if (C.sessionHeldByOther(s, rev, sid, now)) return null; // a live foreign holder — don't write over it
    return C.claimSession(s, rev, sid, now).state;
  }

  // Persist our presence marker. Adopts the freshly-fetched state UNCONDITIONALLY (even on decline) so
  // a session that has just been displaced converges to passive on the next recompute instead of
  // spinning against stale state. One write in flight at a time.
  var presenceWriting = false;
  function writePresence() {
    if (presenceWriting || authFailed || !reviewer) return;
    presenceWriting = true;
    withState(function (s) {
      state = s; // adopt the fresh fetch first — a decline must still update `state`
      return presenceMutation(s, reviewer, SESSION_ID, Date.now());
    }).then(
      function () { presenceWriting = false; recomputeMode(); },
      // On genuine failure, adopt read-only if the token died; otherwise leave it for the next natural
      // trigger (poll/visibility) — do NOT re-derive-and-rewrite here, which would spin on a persistent error.
      function (err) { presenceWriting = false; if (err && err.kind === "AUTH") { markAuthFailed(); recomputeMode(); } });
  }

  // Re-derive mode from (lockState, presence, auth), execute any due presence write, and re-render on
  // change. Called after every state read/write, poll, lock event, and visibility change.
  function recomputeMode() {
    if (!reviewer) { mode = authFailed ? "auth" : "unset"; return; }
    /** @type {{ mode: "active"|"electing"|"passive-tab"|"passive-session"|"auth", write: "claim"|"refresh"|"none" }} */
    var plan = C.planPresence(lockState, state, reviewer, SESSION_ID, authFailed, Date.now());
    var was = mode; mode = plan.mode;
    if (plan.write !== "none") writePresence();
    renderBanner();
    if (mode === was) return;
    if (mode !== "active" && (view.mode === "label" || view.mode === "claiming" || view.mode === "completing")) {
      // Demoted on a writing screen (a take-over landed): drain accepted verdicts (flushNow is never
      // gated), then drop to the now-read-only board rather than silently keep a writing UI up.
      verdictWriter.flushNow();
      renderBoard();
    } else {
      rerenderCurrent();
    }
  }
  function rerenderCurrent() {
    if (view.mode === "board") renderBoard();
    else if (view.mode === "label") renderLabel();
  }

  // ---- rendering --------------------------------------------------------------------------------
  // Cast to non-null: in the browser boot() runs only with #app/#banner present; in tests boot() and
  // the render fns are never called (the module.exports branch exports the I/O layer only).
  var root = /** @type {HTMLElement} */ (typeof document !== "undefined" ? document.getElementById("app") : null);
  var bannerEl = /** @type {HTMLElement} */ (typeof document !== "undefined" ? document.getElementById("banner") : null);

  // A calm, positive save indicator for NORMAL batching — distinct from the amber failure banner.
  // "Saving…" while a batch is in flight, a brief "✓ Saved" when it lands, then quiet. Genuine
  // failures still go to the banner; this never shows an error.
  var saveIndicatorEl = /** @type {HTMLElement} */ (typeof document !== "undefined" ? document.getElementById("save-indicator") : null);
  /** @type {"idle"|"saving"|"saved"} */
  var saveState = "idle";
  /** @type {any} */ var savedTimer = null;
  function renderSaveIndicator() {
    if (!saveIndicatorEl) return;
    saveIndicatorEl.className = "save-indicator " + saveState;
    saveIndicatorEl.textContent = saveState === "saving" ? "Saving…" : saveState === "saved" ? "✓ Saved" : "";
  }
  function markSaving() {
    if (savedTimer) { clearTimeout(savedTimer); savedTimer = null; }
    if (saveState !== "saving") { saveState = "saving"; renderSaveIndicator(); }
  }
  function markSaved() {
    saveState = "saved"; renderSaveIndicator();
    if (savedTimer) clearTimeout(savedTimer);
    savedTimer = setTimeout(function () { saveState = "idle"; renderSaveIndicator(); }, 1500);
  }

  /** @type {string|null} */ var lastBannerSig = null;
  function renderBanner() {
    if (!bannerEl) return;
    var text, cls, takeover = false;
    if (mode === "passive-tab") {
      text = "Another tab in this browser is the active session — this tab is read-only."; cls = "banner warn"; takeover = true;
    } else if (mode === "passive-session") {
      text = "You’re active in another browser or device — this session is read-only."; cls = "banner warn"; takeover = true;
    } else if (authFailed) {
      text = "Your link/token is missing or expired — this page is read-only. Open a fresh link to continue reviewing."; cls = "banner error";
    } else if (syncFailed || unsavedCount() > 0) {
      var n = unsavedCount();
      text = n > 0
        ? (n + " verdict" + (n === 1 ? "" : "s") + " haven't synced yet — they'll retry automatically. If it persists, Export as a backup.")
        : "A sync step failed — your last action may not be saved yet; it will retry automatically.";
      cls = "banner error";
    } else { text = ""; cls = "banner"; }
    // Only rebuild the live region when the message actually changes — otherwise a 25s poll re-sets an
    // identical banner and screen readers re-announce it (over-announcement), and a rebuild would reset
    // the take-over button's just-clicked disabled state.
    var sig = cls + "|" + (takeover ? "T|" : "") + text;
    if (sig === lastBannerSig) return;
    lastBannerSig = sig;
    bannerEl.textContent = ""; bannerEl.className = cls;
    if (text) bannerEl.appendChild(document.createTextNode(text));
    if (takeover) {
      var take = button("Make this the active session", function () { take.disabled = true; takeOver(); });
      take.className = "primary banner-action"; bannerEl.appendChild(take);
    }
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
      var sel = document.createElement("select"); sel.id = "reviewer-select"; sel.setAttribute("aria-label", "Pick your reviewer name");
      names.forEach(function (n) { var o = document.createElement("option"); o.value = n; o.textContent = n; sel.appendChild(o); });
      var use = button("Use this name", function () { setReviewer(sel.value, true); }); // resume: already registered, skip tutorial
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
        if (res.ok) setReviewer(name, false); // brand-new registration → show the one-time tutorial
      }).catch(function (e) { reportSyncFailure(e); });
    });
    card.appendChild(input); card.appendChild(add);
    root.appendChild(card);
  }

  // Start (or resume) intra-browser election + derive the initial mode for the current reviewer.
  function startSession() { if (!authFailed) manageLock(); recomputeMode(); }

  /** @param {string} name @param {boolean} isResume - true when picking an EXISTING roster name (returning
   *  reviewer → skip the tutorial); false for a brand-new registration (show it once). Onboarding-done is
   *  thus tied to roster membership (durable, cross-browser), not a per-browser localStorage flag. */
  function setReviewer(name, isResume) {
    reviewer = name;
    localStorage.setItem("calib:reviewer", name);
    startSession();
    if (isResume) renderBoard();
    else renderPractice(0);
  }

  /** @param {number} i */
  function renderPractice(i) {
    view.mode = "practice";
    root.textContent = "";
    root.appendChild(el("div", "practice-note", "Practice — these are examples with the answer shown, to learn the task. They are not scored."));
    const item = PRACTICE[i]; // const so the not-undefined narrowing below persists into the closures
    if (i >= PRACTICE.length || !item) { renderBoard(); return; } // finished onboarding → the board (roster membership records it)
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
    verdictWriter.flushNow(); // don't strand queued verdicts when leaving a bucket (never gated)
    root.textContent = "";
    var now = Date.now();
    var heading = el("h2", null, "Buckets — " + reviewer);
    heading.setAttribute("tabindex", "-1"); // focus target after a take-over so keyboard/SR users land here
    root.appendChild(heading);
    var bar = el("div", "board-actions");
    var refresh = button("Refresh", function () { refreshState().then(function () { recomputeMode(); renderBoard(); }).catch(function (e) { reportSyncFailure(e); }); });
    refresh.className = "secondary"; bar.appendChild(refresh);
    var sum = button("Progress summary", showSummary); sum.className = "secondary"; bar.appendChild(sum);
    // (A passive session's "Make this the active session" lives in the banner, next to the explanation
    // of why the page is read-only — see renderBanner — so it's available on every screen.)
    root.appendChild(bar);
    if (pendingBoardFocus) { pendingBoardFocus = false; heading.focus(); } // land focus on the board after a take-over
    var grid = el("div", "board");
    BUCKETS.forEach(function (b) {
      var st = C.bucketStatus(state.buckets[b.bucket_id], b.confirmations_required, reviewer, now);
      var cell = el("div", "bucket " + st.state);
      cell.appendChild(el("div", "bid", b.bucket_id));
      // headline: item count + confirmations still needed (counts down as reviewers finish), or complete.
      cell.appendChild(el("div", "meta", st.done
        ? b.item_ids.length + " items · ✓ complete"
        : b.item_ids.length + " items · needs " + st.remaining + " more of " + st.required));
      // roles, distinct: ✓ = finished, ◷ = mid-review; "you" called out so your work is unmistakable.
      var who = el("div", "who");
      st.completers.forEach(function (/** @type {string} */ n) {
        who.appendChild(el("span", "tag done" + (n === reviewer ? " me" : ""), "✓ " + (n === reviewer ? "you" : n)));
      });
      st.claimants.forEach(function (/** @type {string} */ n) {
        if (st.completers.indexOf(n) !== -1) return;
        who.appendChild(el("span", "tag wip" + (n === reviewer ? " me" : ""), "◷ " + (n === reviewer ? "you" : n) + " reviewing"));
      });
      if (who.childNodes.length) cell.appendChild(who);
      // status label: distinguish "fully confirmed" from "you finished, still awaiting others".
      var tag = st.done ? "confirmed"
        : st.state === "complete" ? "you're done · awaiting " + st.remaining + " more"
        : st.state === "mine" ? "in progress"
        : st.state === "claimed" ? "claimed by others"
        : "available";
      cell.appendChild(el("div", "state-tag", tag));
      if (isActive() && (st.state === "available" || st.state === "mine")) {
        cell.appendChild(button(st.state === "mine" ? "Continue" : "Claim + open", function () { openBucket(b); }));
      }
      grid.appendChild(cell);
    });
    root.appendChild(grid);
    var exp = button("Export my verdicts", exportLocal); exp.className = "secondary"; root.appendChild(exp);
  }

  // Progress dashboard — a modal over the campaign-wide summary (pure C.campaignSummary).
  function showSummary() {
    var s = C.campaignSummary(BUCKETS, state, Date.now());
    var t = s.totals;
    var overlay = el("div", "modal-overlay");
    overlay.onclick = function (e) { if (e.target === overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay); };
    var modal = el("div", "modal");
    modal.appendChild(el("h2", null, "Progress summary"));
    modal.appendChild(el("p", "muted",
      s.reviewers + " reviewer" + (s.reviewers === 1 ? "" : "s") + " registered · "
      + t.complete + " of " + t.buckets + " buckets confirmed · "
      + t.inProgress + " in progress · " + t.judgments + " item-judgments recorded"));
    var strata = el("div", "sum-strata");
    Object.keys(s.perStratum).sort().forEach(function (k) {
      var ps = s.perStratum[k];
      strata.appendChild(el("div", "sum-row", k + " — " + ps.complete + " / " + ps.total + " buckets confirmed"));
    });
    modal.appendChild(strata);
    var table = el("table", "sum-table");
    var head = el("tr");
    ["Reviewer", "Done", "In progress", "Items"].forEach(function (h) { head.appendChild(el("th", null, h)); });
    table.appendChild(head);
    s.perReviewer.forEach(function (/** @type {any} */ r) {
      var tr = el("tr", r.name === reviewer ? "me" : null);
      tr.appendChild(el("td", null, r.name === reviewer ? r.name + " (you)" : r.name));
      tr.appendChild(el("td", null, String(r.bucketsCompleted)));
      tr.appendChild(el("td", null, String(r.bucketsInProgress)));
      tr.appendChild(el("td", null, String(r.itemsReviewed)));
      table.appendChild(tr);
    });
    if (!s.perReviewer.length) modal.appendChild(el("p", "muted", "No reviewers have registered yet."));
    else modal.appendChild(table);
    var close = button("Close", function () { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); });
    close.className = "secondary"; modal.appendChild(close);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  }

  // Auto-refresh: poll the shared state on the board so concurrent reviewers see each other without a
  // manual Refresh. Board-mode only (never mid-label, so it can't disrupt a review); a failed poll is
  // swallowed — the manual Refresh + sync banner remain the fallback.
  var AUTO_REFRESH_MS = 25000;
  function pollBoard() {
    // Skip while hidden (Page Visibility best practice — a background tab shouldn't poll) or mid-label.
    if (typeof document !== "undefined" && document.hidden) return;
    if (view.mode !== "board" || authFailed) return;
    refreshState().then(function () { if (view.mode === "board") { recomputeMode(); renderBoard(); } }).catch(function () { /* manual Refresh is the fallback */ });
  }
  function startAutoRefresh() {
    if (typeof window === "undefined") return;
    setInterval(pollBoard, AUTO_REFRESH_MS);
    if (typeof document !== "undefined" && document.addEventListener) {
      document.addEventListener("visibilitychange", function () { if (!document.hidden) { recomputeMode(); pollBoard(); } });
      // A page restored from the bfcache is a fresh document but keeps its session; re-FETCH then
      // re-derive so a take-over that happened while it was frozen (visible only server-side) is
      // reflected — recomputeMode alone reads stale in-memory state.
      window.addEventListener("pageshow", function (e) { if (e && e.persisted) refreshState().then(recomputeMode).catch(function () {}); });
      // Best-effort: kick a flush as the tab is hidden/closed so buffered verdicts get one last chance
      // to land before the in-flight fetch is torn down (the debounce window is otherwise up to ~700ms).
      document.addEventListener("pagehide", function () { verdictWriter.flushNow(); });
    }
  }

  // Compose a coordination write with a presence-ts bump in ONE state.json mutation, over freshly-
  // fetched state. Declines (returns null → no write) when a live FOREIGN session holds the name — so
  // the gate is ATOMIC with the write (a demoted session's stale cached `mode` can't leak a write; the
  // CAS retry makes a loser refetch and decline here) — or when the primary claim/complete itself
  // declines (full bucket / at-capacity). Pure over args.
  /** @param {any} s @param {any} b @param {string} rev @param {string} sid @param {number} now @returns {import("./calibration-core.js").CoordState|null} */
  function claimWithPresence(s, b, rev, sid, now) {
    if (C.sessionHeldByOther(s, rev, sid, now)) return null; // a live foreign session owns this name — decline the whole write
    var r = C.claim(s, b.bucket_id, b.confirmations_required, rev, now);
    if (!r.ok) return null;
    return C.refreshSession(r.state, rev, sid, now);
  }
  /** @param {any} s @param {any} b @param {string} rev @param {string} sid @param {number} now @returns {import("./calibration-core.js").CoordState|null} */
  function completeWithPresence(s, b, rev, sid, now) {
    if (C.sessionHeldByOther(s, rev, sid, now)) return null; // as above — a foreign active session declines the completion
    var r = C.complete(s, b.bucket_id, rev, b.confirmations_required);
    if (!r.ok) return null;
    return C.refreshSession(r.state, rev, sid, now);
  }

  /** @param {any} b */
  function openBucket(b) {
    if (!isActive()) { renderBoard(); return; } // auth/passive/electing can't claim — the board is the path forward
    // Immediate feedback: the claim is a state.json CAS that can take a moment under contention, so the
    // click must never read as "nothing happened".
    view.mode = "claiming";
    root.textContent = "";
    root.appendChild(status("Claiming " + b.bucket_id + "…"));
    withState(function (s) {
      var next = claimWithPresence(s, b, reviewer, SESSION_ID, Date.now());
      if (next != null) state = next;
      return next; // null → declined (full bucket, or a foreign session took over); withState writes nothing
    }).then(function (res) {
      if (res.declined) {
        state = res.state; recomputeMode(); // adopt the fresh state — it may reveal we were taken over
        if (isActive()) alert("This bucket is full — someone else took the last slot. Pick another.");
        renderBoard(); // if demoted, the passive banner explains; either way the board reflects fresh state
        return;
      }
      recomputeMode();
      view.bucket = b; view.idx = 0; renderLabel();
    }).catch(function (e) { reportSyncFailure(e); renderBoard(); });
  }

  // One place both the click and the keydown paths commit a verdict + advance.
  /** @param {string} v */
  function chooseAndAdvance(v) {
    var items = scaffoldsFor(view.bucket);
    var it = items[view.idx];
    if (!it) return;
    view.localVerdicts[it.item_id] = v;
    delete view.unsaved[it.item_id];
    if (isActive()) { verdictWriter.queue(view.bucket.bucket_id, reviewer, it.item_id, v); markSaving(); } // gated: only the active session auto-saves
    view.idx += 1;
    renderLabel();
  }

  function renderLabel() {
    view.mode = "label";
    var items = scaffoldsFor(view.bucket);
    root.textContent = "";
    root.appendChild(button("← Back to buckets", function () { renderBoard(); }));
    if (view.idx >= items.length) {
      if (isActive()) {
        // Capture THIS bucket: the flush below can take seconds (its own retries), and the reviewer
        // can click "Back" and open another bucket meanwhile — completion must target the bucket they
        // actually finished, never wherever `view.bucket` has since roamed to.
        var bucket = view.bucket;
        view.mode = "completing"; // silences the keydown handler so no relabel slips into pending mid-flush
        var saving = status("Saving your verdicts…");
        var prog = el("div", "progress indeterminate");
        prog.setAttribute("role", "progressbar"); prog.setAttribute("aria-label", "Saving verdicts"); // indeterminate: no aria-valuenow
        prog.appendChild(el("div", "bar")); saving.appendChild(prog);
        root.appendChild(saving);
        // The flush is a network round-trip of unknown length, so the bar is indeterminate (honest) —
        // after a few seconds, reassure rather than fake a percentage.
        var slow = setTimeout(function () {
          if (view.mode === "completing" && view.bucket === bucket) saving.appendChild(el("div", "muted", "Taking longer than usual — your answers are safe, still saving."));
        }, 4000);
        verdictWriter.flushNow().then(function () {
          clearTimeout(slow);
          var stillHere = view.bucket === bucket && view.mode === "completing";
          var failed = scaffoldsFor(bucket).some(function (it) { return view.unsaved[it.item_id]; });
          if (failed) {
            if (stillHere) {
              root.textContent = "";
              root.appendChild(button("← Back to buckets", function () { renderBoard(); }));
              root.appendChild(status("Some verdicts didn't save. Re-open the bucket to retry, or Export as a backup — this bucket is NOT marked complete."));
            }
            return; // don't claim completion while this bucket's verdicts are known-unsaved
          }
          markBucketComplete(bucket);
        });
        return;
      }
      renderBoard(); // reached only if demoted right at the end of a bucket — go back to the read-only board
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

  // Mark a specific finished bucket complete (all its verdicts confirmed landed). Takes the bucket
  // explicitly — never reads view.bucket — because it runs after an async flush the reviewer may have
  // navigated away from. DOM writes are guarded on the reviewer still viewing this completion screen,
  // so a stale resolution can't paint over the bucket they moved on to.
  /** @param {any} bucket */
  function markBucketComplete(bucket) {
    function onThisScreen() { return view.bucket === bucket && view.mode === "completing"; }
    withState(function (s) {
      var next = completeWithPresence(s, bucket, reviewer, SESSION_ID, Date.now());
      if (next != null) state = next;
      return next; // null → already at capacity via others; withState writes nothing
    }).then(function (res) {
      recomputeMode();
      if (!onThisScreen()) return; // reviewer moved on — state is updated, but don't clobber their screen
      root.textContent = "";
      root.appendChild(button("← Back to buckets", function () { renderBoard(); }));
      root.appendChild(status(res.declined
        ? "This bucket was already completed by enough other reviewers while you were away — your answers are saved but it needed no more."
        : "Bucket complete. Thank you! Pick another from the board."));
    }).catch(function (e) {
      reportSyncFailure(e);
      if (onThisScreen()) root.appendChild(status("Your answers are saved, but marking the bucket complete failed — click Refresh on the board and it will reconcile."));
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
  // A transient status message that assistive tech announces (role=status ⇒ implicit aria-live=polite).
  // Used for Claiming…/Saving…/Bucket-complete, which are painted into #app (not a live region).
  /** @param {string} text @returns {HTMLElement} */
  function status(text) { var e = el("div", "done", text); e.setAttribute("role", "status"); return e; }

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
      if (authFailed && !reviewer) { root.appendChild(el("div", "muted", "Read-only: this link is missing its access token. Open a fresh link to review.")); }
      if (reviewer) startSession(); // resume-by-name: election + initial mode before first render
      // Registered (in the roster) ⇒ already onboarded ⇒ straight to the board; otherwise show the
      // tutorial. Roster membership is the durable, cross-browser onboarding signal.
      if (reviewer && (state.roster || []).indexOf(reviewer) !== -1) renderBoard();
      else if (reviewer) renderPractice(0);
      else renderRoster();
      if (!authFailed) startAutoRefresh();
    }).catch(function (e) {
      root.textContent = "";
      root.appendChild(el("div", "error", "Could not load calibration data: " + e.message));
      root.appendChild(button("Reload", function () { location.reload(); }));
    });
  }

  var api = { ghGet: ghGet, ghPut: ghPut, withState: withState, saveVerdicts: saveVerdicts, makeVerdictWriter: makeVerdictWriter,
    claimWithPresence: claimWithPresence, completeWithPresence: completeWithPresence, presenceMutation: presenceMutation };
  if (typeof module !== "undefined" && module.exports) module.exports = api; // tests import the I/O layer
  else boot(); // browser
})();
