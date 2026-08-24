/* Pure coordination core for the distributed calibration page (TASK-329.06.01).

   The claim-lease algebra over state.json, plus roster registration and verdict union — all pure so
   the tests can drive the laws without a browser or the GitHub API. The impure shell
   (calibration.js) does token/fetch/DOM and calls these.

   state.json shape:
     { "roster": ["ana", ...],
       "buckets": { "<bucket_id>": { "claimants": [{"name","ts"}], "completed_by": ["ana", ...] } } }

   Laws (asserted in tests/js/calibration-coord.test.js):
     - registerName rejects a duplicate name (identity is the structural key for verdicts + H).
     - claim is idempotent for the same reviewer (retry-after-409 safe) and capacity-bounded
       (never more contributors than confirmations_required).
     - completion is monotone (completed_by only grows); a claim is NOT monotone (release/expiry
       free a slot) — so an abandoned bucket cannot permanently starve coverage. */

/**
 * @typedef {{ name: string, ts: number }} Claimant
 * @typedef {{ claimants: Claimant[], completed_by: string[] }} BucketState
 * @typedef {{ roster: string[], buckets: Record<string, BucketState> }} CoordState
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
   * @returns {{ state: string, mine: boolean, holders: string[], required: number, done: boolean }}
   */
  function bucketStatus(bucketState, required, reviewer, now, ttlMs) {
    ttlMs = ttlMs ?? DEFAULT_TTL_MS;
    var b = bucketState || { claimants: [], completed_by: [] };
    var done = (b.completed_by || []).length >= required;
    var iCompleted = (b.completed_by || []).indexOf(reviewer) !== -1;
    var held = holders(b, now, ttlMs);
    var iHold = held.has(reviewer);
    var state;
    if (iCompleted) state = "complete";           // I finished it (regardless of others)
    else if (done) state = "complete";            // enough others finished
    else if (iHold) state = "mine";               // I hold a live slot
    else if (held.size >= required) state = "claimed"; // others hold all slots
    else state = "available";
    return { state: state, mine: iHold || iCompleted, holders: Array.from(held), required: required, done: done };
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

  var api = {
    DEFAULT_TTL_MS: DEFAULT_TTL_MS,
    emptyState: emptyState,
    activeClaimants: activeClaimants,
    holders: holders,
    bucketStatus: bucketStatus,
    validateReviewerName: validateReviewerName,
    registerName: registerName,
    claim: claim,
    release: release,
    complete: complete,
    unionVerdicts: unionVerdicts,
    classifyError: classifyError,
    isRetryable: isRetryable,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CalibrationCoord = api;
})(typeof window !== "undefined" ? window : this);
