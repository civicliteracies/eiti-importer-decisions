/* Pure coordination core for the distributed calibration page (TASK-329.06.01).

   The claim-lease algebra over state.json, plus roster registration and verdict union — all pure so
   the tests can drive the laws without a browser or the GitHub API. The impure shell
   (calibration.js) does token/fetch/DOM and calls these.

   state.json shape:
     { "roster": ["ana", ...],
       "buckets": { "<bucket_id>": { "claimants": [{"name","ts"}], "completed_by": ["ana", ...] } },
       "sessions": { "<reviewer>": { "sessionId": "…", "ts": 0 } } }   // the designated active session per name

   The `sessions` map is the cross-browser single-active-session marker: a capacity-1 claim-lease keyed
   by sessionId with a short staleness horizon (SESSION_TTL_MS). It is refreshed lazily and NEVER
   auto-claimed over a live holder — transfer happens only via takeoverSession (the one-click take-over)
   or after the holder goes stale. deriveMode/planPresence turn (lock state, presence, auth) into the
   shell's read-only `mode`. All reducers stay pure; the shell (calibration.js) does the I/O + Web Locks.

   Laws (asserted in tests/js/calibration-coord.test.js):
     - registerName rejects a duplicate name (identity is the structural key for verdicts + H).
     - claim is idempotent for the same reviewer (retry-after-409 safe) and capacity-bounded
       (never more contributors than confirmations_required).
     - completion is monotone (completed_by only grows); a claim is NOT monotone (release/expiry
       free a slot) — so an abandoned bucket cannot permanently starve coverage. */

/**
 * @typedef {{ name: string, ts: number }} Claimant
 * @typedef {{ claimants: Claimant[], completed_by: string[] }} BucketState
 * @typedef {{ sessionId: string, ts: number }} SessionRec
 * @typedef {{ roster: string[], buckets: Record<string, BucketState>, sessions?: Record<string, SessionRec> }} CoordState
 * @typedef {{ verdict: string, timestamp: number }} VerdictCell
 * @typedef {{ ok: boolean, reason?: string, state: CoordState }} CoordResult
 */

(function (/** @type {any} */ root) {
  "use strict";

  var DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // a claim older than this with no completion is reclaimable

  /** @returns {CoordState} */
  function emptyState() { return { roster: [], buckets: {} }; }

  /**
   * @param {CoordState} state
   * @param {string} bucketId
   * @returns {BucketState}
   */
  function _bucket(state, bucketId) {
    // hasOwnProperty, not a bare index read: a bucketId of "__proto__"/"constructor" would otherwise
    // resolve up the prototype chain (truthy) and skip the create branch, then mutate Object.prototype.
    var b = Object.prototype.hasOwnProperty.call(state.buckets, bucketId) ? state.buckets[bucketId] : undefined;
    if (!b) { b = { claimants: [], completed_by: [] }; state.buckets[bucketId] = b; }
    if (!b.claimants) b.claimants = [];
    if (!b.completed_by) b.completed_by = [];
    return b;
  }

  /**
   * @param {CoordState} [state]
   * @returns {CoordState}
   */
  function _clone(state) { return /** @type {CoordState} */ (JSON.parse(JSON.stringify(state || emptyState()))); }

  /**
   * Reviewers actively holding a slot: a non-expired claimant who has not already completed.
   * @param {BucketState} bucket
   * @param {number} now
   * @param {number} ttlMs
   * @returns {Claimant[]}
   */
  function activeClaimants(bucket, now, ttlMs) {
    var done = new Set(bucket.completed_by || []);
    return (bucket.claimants || []).filter(function (/** @type {Claimant} */ c) {
      return !done.has(c.name) && (now - c.ts) < ttlMs;
    });
  }

  /**
   * A slot is held by anyone who completed (permanent) or is a non-expired active claimant.
   * @param {BucketState} bucket
   * @param {number} now
   * @param {number} ttlMs
   * @returns {Set<string>}
   */
  function holders(bucket, now, ttlMs) {
    var s = new Set(bucket.completed_by || []);
    activeClaimants(bucket, now, ttlMs).forEach(function (/** @type {Claimant} */ c) { s.add(c.name); });
    return s;
  }

  /**
   * Board status for one bucket from the reviewer's point of view.
   * @param {BucketState|undefined} bucketState
   * @param {number} required - the bucket's confirmations_required (from buckets.json)
   * @param {string} reviewer
   * @param {number} now
   * @param {number} [ttlMs]
   * @returns {{ state: string, mine: boolean, holders: string[], completers: string[], claimants: string[], remaining: number, required: number, done: boolean }}
   */
  function bucketStatus(bucketState, required, reviewer, now, ttlMs) {
    ttlMs = ttlMs ?? DEFAULT_TTL_MS;
    var b = bucketState || { claimants: [], completed_by: [] };
    var completers = (b.completed_by || []).slice();
    var done = completers.length >= required;
    var iCompleted = completers.indexOf(reviewer) !== -1;
    var held = holders(b, now, ttlMs);
    var iHold = held.has(reviewer);
    // active claimants who have NOT completed — the people currently mid-review (role distinct from completers)
    var claimants = activeClaimants(b, now, ttlMs).map(function (/** @type {Claimant} */ c) { return c.name; });
    var state;
    if (iCompleted) state = "complete";           // I finished it (regardless of others)
    else if (done) state = "complete";            // enough others finished
    else if (iHold) state = "mine";               // I hold a live slot
    else if (held.size >= required) state = "claimed"; // others hold all slots
    else state = "available";
    return {
      state: state,
      mine: iHold || iCompleted,
      holders: Array.from(held),
      completers: completers,
      claimants: claimants,
      remaining: Math.max(0, required - completers.length), // confirmations still needed
      required: required,
      done: done,
    };
  }

  /**
   * Campaign-wide progress for the summary dashboard — reviewer-agnostic. Pure over (buckets, state).
   * Buckets: the buckets.json array ({ bucket_id, stratum, item_ids, confirmations_required }).
   * @param {Array<{ bucket_id: string, stratum: string, item_ids: string[], confirmations_required: number }>} buckets
   * @param {CoordState} state
   * @param {number} now
   * @param {number} [ttlMs]
   */
  function campaignSummary(buckets, state, now, ttlMs) {
    ttlMs = ttlMs ?? DEFAULT_TTL_MS;
    var st = state || emptyState();
    var roster = (st.roster || []).slice();
    /** @typedef {{ name: string, bucketsCompleted: number, bucketsInProgress: number, itemsReviewed: number }} Seat */
    /** @type {Record<string, Seat>} */
    var per = {};
    /** @param {string} n @returns {Seat} */
    function seat(n) {
      var r = per[n];
      if (!r) { r = { name: n, bucketsCompleted: 0, bucketsInProgress: 0, itemsReviewed: 0 }; per[n] = r; }
      return r;
    }
    roster.forEach(seat);
    /** @type {Record<string, { total: number, complete: number }>} */
    var strata = {};
    var totals = { buckets: 0, complete: 0, inProgress: 0, available: 0, items: 0, judgments: 0 };
    (buckets || []).forEach(function (bk) {
      var bs = st.buckets && Object.prototype.hasOwnProperty.call(st.buckets, bk.bucket_id) ? st.buckets[bk.bucket_id] : undefined;
      var completedBy = (bs && bs.completed_by) || [];
      var nItems = (bk.item_ids || []).length;
      var strat = bk.stratum || "?";
      var ps = strata[strat];
      if (!ps) { ps = { total: 0, complete: 0 }; strata[strat] = ps; }
      ps.total += 1;
      totals.buckets += 1;
      totals.items += nItems;
      var isComplete = completedBy.length >= bk.confirmations_required;
      var active = bs ? activeClaimants(bs, now, ttlMs) : [];
      if (isComplete) { totals.complete += 1; ps.complete += 1; }
      else if (active.length) totals.inProgress += 1;
      else totals.available += 1;
      completedBy.forEach(function (/** @type {string} */ n) {
        var r = seat(n); r.bucketsCompleted += 1; r.itemsReviewed += nItems; totals.judgments += nItems;
      });
      active.forEach(function (/** @type {Claimant} */ c) {
        if (completedBy.indexOf(c.name) === -1) seat(c.name).bucketsInProgress += 1;
      });
    });
    /** @type {Seat[]} */
    var perReviewer = [];
    Object.keys(per).sort().forEach(function (k) { var r = per[k]; if (r) perReviewer.push(r); });
    return { reviewers: roster.length, totals: totals, perStratum: strata, perReviewer: perReviewer };
  }

  /**
   * @param {CoordState} state
   * @param {string} name
   * @returns {CoordResult}
   */
  // A reviewer name is BOTH a display identity AND a GitHub path segment (verdicts/<bucket>__<name>.json)
  // AND the join key in the estimate. Restrict it to characters safe in all three: letters, digits,
  // spaces, and . _ - — so a name can never carry a "/" (extra path segment), ".." (traversal), or
  // "#"/"?"/"%" (URL-mangling) that would silently write to the wrong path and vanish from the estimate.
  var _NAME_RE = /^[A-Za-z0-9 ._-]{1,40}$/;

  /**
   * @param {string} name
   * @returns {{ ok: true, name: string } | { ok: false, reason: string }}
   */
  function validateReviewerName(name) {
    var clean = String(name || "").trim();
    if (!clean) return { ok: false, reason: "empty name" };
    if (clean.indexOf("..") !== -1) return { ok: false, reason: "name may not contain .." };
    if (!_NAME_RE.test(clean)) return { ok: false, reason: "name may use only letters, numbers, spaces, and . _ -" };
    return { ok: true, name: clean };
  }

  /**
   * @param {CoordState} state
   * @param {string} name
   * @returns {CoordResult}
   */
  function registerName(state, name) {
    var s = _clone(state);
    var v = validateReviewerName(name);
    if (!v.ok) return { ok: false, reason: v.reason, state: s };
    if (s.roster.indexOf(v.name) !== -1) return { ok: false, reason: "name taken", state: s };
    s.roster.push(v.name);
    s.roster.sort();
    return { ok: true, state: s };
  }

  /**
   * Classify a GitHub Contents API HTTP status for the shell's retry/error handling.
   * AUTH (401/403) → read-only; CAS (409/422) → refetch+retry; RETRYABLE (429/5xx) → backoff+retry;
   * OTHER (4xx) → surface, don't retry. A network-layer fetch rejection maps to RETRYABLE at the call site.
   * @param {number} status
   * @returns {"AUTH"|"CAS"|"RETRYABLE"|"OTHER"}
   */
  function classifyError(status) {
    if (status === 401 || status === 403) return "AUTH";
    if (status === 409 || status === 422) return "CAS";
    if (status === 429 || (status >= 500 && status < 600)) return "RETRYABLE";
    return "OTHER";
  }

  /** @param {string} kind @returns {boolean} */
  function isRetryable(kind) { return kind === "CAS" || kind === "RETRYABLE"; }

  /**
   * Claim a bucket for a reviewer. Idempotent for a reviewer who already holds it (refreshes the
   * lease ts). Capacity-bounded: refused when required slots are already held by others.
   * @param {CoordState} state
   * @param {string} bucketId
   * @param {number} required
   * @param {string} reviewer
   * @param {number} now
   * @param {number} [ttlMs]
   * @returns {CoordResult}
   */
  function claim(state, bucketId, required, reviewer, now, ttlMs) {
    ttlMs = ttlMs ?? DEFAULT_TTL_MS;
    var s = _clone(state);
    var b = _bucket(s, bucketId);
    if ((b.completed_by || []).indexOf(reviewer) !== -1) return { ok: true, reason: "already completed", state: s };
    var existing = b.claimants.find(function (/** @type {Claimant} */ c) { return c.name === reviewer; });
    if (existing) { existing.ts = now; return { ok: true, reason: "refreshed", state: s }; } // idempotent
    var held = holders(b, now, ttlMs);
    if (held.size >= required) return { ok: false, reason: "full", state: s };
    b.claimants.push({ name: reviewer, ts: now });
    return { ok: true, state: s };
  }

  /**
   * @param {CoordState} state
   * @param {string} bucketId
   * @param {string} reviewer
   * @returns {CoordResult}
   */
  function release(state, bucketId, reviewer) {
    var s = _clone(state);
    var b = _bucket(s, bucketId);
    b.claimants = b.claimants.filter(function (/** @type {Claimant} */ c) { return c.name !== reviewer; });
    return { ok: true, state: s };
  }

  /**
   * Mark a reviewer done with a bucket. Monotone in `completed_by` (only grows) and CAPACITY-BOUNDED:
   * a completion that would push `completed_by` past `required` is REFUSED (ok:false). This closes the
   * stale-tab-after-TTL-reclaim path where an abandoned reviewer resumes and completes a bucket two
   * others already finished — without the cap, `completed_by` could exceed the confirmations the bucket
   * was designed for, and the abandoned reviewer's surplus verdicts would leak into A/H. A reviewer
   * already in `completed_by` re-completing is an idempotent no-op (ok:true).
   * @param {CoordState} state
   * @param {string} bucketId
   * @param {string} reviewer
   * @param {number} [required] - the bucket's confirmations_required; omit to skip the cap (monotone add)
   * @returns {CoordResult}
   */
  function complete(state, bucketId, reviewer, required) {
    var s = _clone(state);
    var b = _bucket(s, bucketId);
    if (b.completed_by.indexOf(reviewer) !== -1) {
      b.claimants = b.claimants.filter(function (/** @type {Claimant} */ c) { return c.name !== reviewer; });
      return { ok: true, reason: "already completed", state: s };
    }
    if (required != null && b.completed_by.length >= required) {
      // bucket already met its confirmation count via other reviewers — refuse the surplus completion
      b.claimants = b.claimants.filter(function (/** @type {Claimant} */ c) { return c.name !== reviewer; });
      return { ok: false, reason: "already at capacity", state: s };
    }
    b.claimants = b.claimants.filter(function (/** @type {Claimant} */ c) { return c.name !== reviewer; });
    b.completed_by.push(reviewer);
    return { ok: true, state: s };
  }

  /**
   * Merge one reviewer's verdict cells into an accumulator, latest timestamp winning per item (a
   * same-reviewer multi-device union — a re-pull can't double-count).
   * @param {Record<string, VerdictCell>} acc
   * @param {Record<string, VerdictCell>} decisions
   * @returns {Record<string, VerdictCell>}
   */
  function unionVerdicts(acc, decisions) {
    acc = acc || {};
    Object.keys(decisions || {}).forEach(function (/** @type {string} */ itemId) {
      var cell = decisions[itemId];
      if (!cell || typeof cell.verdict !== "string") return;
      var ts = typeof cell.timestamp === "number" ? cell.timestamp : 0;
      var existing = acc[itemId];
      if (!existing || ts >= existing.timestamp) acc[itemId] = { verdict: cell.verdict, timestamp: ts };
    });
    return acc;
  }

  // ---- single-active-session presence (a capacity-1 claim-lease keyed by sessionId) ----------------
  // The cross-browser "who is the designated active writer for this name" record. Lazy: refreshed
  // only on activity, and NEVER auto-claimed by a non-holder — a live holder is displaced only by an
  // explicit takeoverSession (the one-click take-over) or after it goes stale (which only changes
  // messaging, never auto-transfers). Staleness is a shorter horizon than a bucket claim's TTL.
  var SESSION_TTL_MS = 5 * 60 * 1000;

  /**
   * Prototype-safe read of the name-keyed sessions map — a reviewer name of "__proto__"/"constructor"
   * would otherwise resolve up the prototype chain (the same hazard _bucket guards).
   * @param {CoordState} state
   * @param {string} name
   * @returns {SessionRec|undefined}
   */
  function _session(state, name) {
    var m = state.sessions;
    return (m && Object.prototype.hasOwnProperty.call(m, name)) ? m[name] : undefined;
  }

  /**
   * Store `rec` under a name-key as a plain own property. A bracket assignment `m[name] = rec` with
   * name "__proto__" invokes the prototype SETTER (stores nothing); defineProperty writes an ordinary
   * enumerable own property that JSON round-trips normally — so a reviewer named "__proto__" is data,
   * not a pollution vector.
   * @param {Record<string, SessionRec>} m
   * @param {string} name
   * @param {SessionRec} rec
   */
  function _setSession(m, name, rec) {
    Object.defineProperty(m, name, { value: rec, enumerable: true, writable: true, configurable: true });
  }

  /**
   * The sessionId currently designated active for `name`, or null when none is set or it has gone
   * stale. Reading is non-destructive — a stale record is simply not returned, never rewritten.
   * @param {CoordState} state
   * @param {string} name
   * @param {number} now
   * @param {number} [ttlMs]
   * @returns {string|null}
   */
  function activeSession(state, name, now, ttlMs) {
    ttlMs = ttlMs ?? SESSION_TTL_MS;
    var rec = _session(state, name);
    if (!rec || typeof rec.sessionId !== "string") return null;
    return (now - rec.ts) < ttlMs ? rec.sessionId : null;
  }

  /**
   * True when a DIFFERENT, non-stale session holds the active-session slot for `name` — i.e. writing
   * as `sessionId` would step on a live peer. The single source for the "decline this write" decision
   * shared by the presence refresh and the compound claim/complete writes.
   * @param {CoordState} state
   * @param {string} name
   * @param {string} sessionId
   * @param {number} now
   * @param {number} [ttlMs]
   * @returns {boolean}
   */
  function sessionHeldByOther(state, name, sessionId, now, ttlMs) {
    var active = activeSession(state, name, now, ttlMs);
    return active != null && active !== sessionId;
  }

  /**
   * Claim or refresh the single active-session slot for `name` as `sessionId`. Succeeds when the slot
   * is empty, already ours (idempotent ts refresh), or held by a stale session; REFUSED (ok:false,
   * state unchanged in content) when a DIFFERENT non-stale session holds it. Never steals a live
   * holder — that is takeoverSession's job.
   * @param {CoordState} state
   * @param {string} name
   * @param {string} sessionId
   * @param {number} now
   * @param {number} [ttlMs]
   * @returns {CoordResult}
   */
  function claimSession(state, name, sessionId, now, ttlMs) {
    ttlMs = ttlMs ?? SESSION_TTL_MS;
    var s = _clone(state);
    if (!s.sessions) s.sessions = {};
    var cur = _session(s, name);
    if (cur && cur.sessionId !== sessionId && (now - cur.ts) < ttlMs) {
      return { ok: false, reason: "held by another session", state: s };
    }
    _setSession(s.sessions, name, { sessionId: sessionId, ts: now });
    return { ok: true, state: s };
  }

  /**
   * Force the active-session slot to `sessionId` regardless of a live holder — the explicit
   * cross-browser take-over. The displaced session learns it lost on its next activeSession read.
   * @param {CoordState} state
   * @param {string} name
   * @param {string} sessionId
   * @param {number} now
   * @returns {CoordResult}
   */
  function takeoverSession(state, name, sessionId, now) {
    var s = _clone(state);
    if (!s.sessions) s.sessions = {};
    _setSession(s.sessions, name, { sessionId: sessionId, ts: now });
    return { ok: true, state: s };
  }

  /**
   * Compose a presence-ts bump into another reducer's output, to piggyback presence on the
   * claim/complete write. Bumps iff we may hold the slot (empty/ours/stale); a NO-OP over a live
   * foreign holder, so a piggybacked write can never resurrect us over a peer.
   * @param {CoordState} state
   * @param {string} name
   * @param {string} sessionId
   * @param {number} now
   * @param {number} [ttlMs]
   * @returns {CoordState}
   */
  function refreshSession(state, name, sessionId, now, ttlMs) {
    var r = claimSession(state, name, sessionId, now, ttlMs);
    return r.ok ? r.state : state;
  }

  /**
   * The reviewer's session mode, from three independent inputs. Precedence: a token/auth failure
   * dominates (read-only regardless); then the intra-browser Web Lock (another tab here holds it, or
   * we don't yet know our lock state); then cross-browser presence (another browser/device is the
   * designated active session). "active" is the only writable mode.
   * @param {"held"|"waiting"|"electing"|"unsupported"} lockState
   * @param {string|null} activeSessionId - the fresh presence holder (activeSession), or null
   * @param {string} mySessionId
   * @param {boolean} authFailed
   * @returns {"active"|"electing"|"passive-tab"|"passive-session"|"auth"}
   */
  function deriveMode(lockState, activeSessionId, mySessionId, authFailed) {
    if (authFailed) return "auth";
    if (lockState === "electing") return "electing";
    if (lockState === "waiting") return "passive-tab"; // another tab in THIS browser holds the lock
    // held | unsupported → we are this browser's writer candidate; cross-browser presence decides
    if (activeSessionId && activeSessionId !== mySessionId) return "passive-session";
    return "active";
  }

  /**
   * Whether an active session should refresh its presence ts now: true once older than half the TTL,
   * so a continuously-labeling holder re-marks itself well before a peer could observe it as stale,
   * while an idle session writes nothing.
   * @param {number} myTs
   * @param {number} now
   * @param {number} [ttlMs]
   * @returns {boolean}
   */
  function presenceRefreshDue(myTs, now, ttlMs) {
    ttlMs = ttlMs ?? SESSION_TTL_MS;
    return (now - myTs) > (ttlMs / 2);
  }

  /**
   * The whole presence-loop decision, pure: from the observed state decide the session `mode` and
   * whether a presence write is due (`claim` a free/stale slot, `refresh` our own aging slot, or
   * `none`). It NEVER asks to write over a live foreign holder — `write` is non-`none` only when the
   * derived mode is "active", i.e. no fresh foreign session exists. The shell executes the returned
   * action; a raced write is a safe no-op (claimSession/refreshSession decline a live foreign holder).
   * @param {"held"|"waiting"|"electing"|"unsupported"} lockState
   * @param {CoordState} state
   * @param {string} reviewer
   * @param {string} mySessionId
   * @param {boolean} authFailed
   * @param {number} now
   * @param {number} [ttlMs]
   * @returns {{ mode: "active"|"electing"|"passive-tab"|"passive-session"|"auth", write: "claim"|"refresh"|"none" }}
   */
  function planPresence(lockState, state, reviewer, mySessionId, authFailed, now, ttlMs) {
    var active = activeSession(state, reviewer, now, ttlMs);
    var mode = deriveMode(lockState, active, mySessionId, authFailed);
    if (mode !== "active") return { mode: mode, write: "none" };
    var rec = _session(state, reviewer);
    if (!rec || rec.sessionId !== mySessionId) return { mode: mode, write: "claim" };   // free or stale → take it
    if (presenceRefreshDue(rec.ts, now, ttlMs)) return { mode: mode, write: "refresh" }; // ours but aging
    return { mode: mode, write: "none" };
  }

  var api = {
    DEFAULT_TTL_MS: DEFAULT_TTL_MS,
    SESSION_TTL_MS: SESSION_TTL_MS,
    emptyState: emptyState,
    activeClaimants: activeClaimants,
    holders: holders,
    bucketStatus: bucketStatus,
    campaignSummary: campaignSummary,
    validateReviewerName: validateReviewerName,
    registerName: registerName,
    claim: claim,
    release: release,
    complete: complete,
    unionVerdicts: unionVerdicts,
    classifyError: classifyError,
    isRetryable: isRetryable,
    activeSession: activeSession,
    sessionHeldByOther: sessionHeldByOther,
    claimSession: claimSession,
    takeoverSession: takeoverSession,
    refreshSession: refreshSession,
    deriveMode: deriveMode,
    presenceRefreshDue: presenceRefreshDue,
    planPresence: planPresence,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CalibrationCoord = api;
})(typeof window !== "undefined" ? window : this);
