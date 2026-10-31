/* Distributed review page shell.

   Wires the shared blind-review widget (review-widget.js) and the pure claim-lease core
   (calibration-core.js) to the GitHub Contents API. Reviewers open a link carrying a fine-grained
   token in the URL fragment, take a reviewer identity, claim buckets (unavailable to others once
   their confirmations are held), label BLIND (scored items never reveal the machine answer — only
   the warm-up practice set does), and their verdicts auto-save to the private coordination repo.
   Resume from any device.

   A factory, not a page: `CalibrationApp.create(options)` builds one page instance and nothing runs
   until its `boot()` is called. Each page loads the shared scripts and names its JSON config in a
   meta tag; calibration-boot.js fetches that config and calls `create(...).boot()` with the page's
   options (see AppOptions below): the coordination
   repo and paths, the data URLs, the review config, the practice set, the storage and lock prefixes,
   and the identity mode. Two pages on one origin pass distinct prefixes, so they never share a
   stored token, a reviewer or a Web Lock.

   Identity: "typed" — the reviewer picks or registers a name on a roster screen; one shared token
   serves every reviewer. "github" — the reviewer is the GitHub login of the token in their own link
   (GET https://api.github.com/user), validated like a typed name and registered into the roster on
   first visit; there is no name screen.

   Error handling: every GitHub call is classified (calibration-core.classifyError) into AUTH
   (401/403 → read-only), CAS (409/422 → refetch+retry), RETRYABLE (429/5xx/network → backoff+retry),
   or OTHER. A retry uses bounded backoff and a per-call timeout. Only a genuine AUTH failure switches
   the page to read-only; any other failure raises a distinct "not saved" banner WITHOUT disabling
   writes, and a save/complete is never reported as successful unless its write actually landed.

   Eventual consistency: the Contents API is NOT read-after-write consistent — a GET right after a
   PUT can return the previous sha for seconds. So (a) every GET is `cache: "no-store"` (a cached
   max-age=60 GET, un-invalidated by a 409'd PUT, is what let a stale sha 409-storm forever); (b) each
   coordination file is a single in-tab writer, serialized — verdict files thread their sha+decisions
   forward from each PUT response and never re-GET on the hot path (so their self-409 is eliminated,
   not merely retried), and state writes queue on one chain so the client never races its own
   CONCURRENT writes. A residual state 409 from replica lag is still possible and is healed by
   the CAS retry — as is any genuine cross-device race.

   Single active session: because an identity can be resumed from any number of tabs/devices, two
   tiers keep exactly one writer. Within a browser, navigator.locks elects one active tab
   (the others go read-only, promoted automatically when the holder closes). Across browsers/devices —
   where no in-browser channel exists — a lazy presence marker in the state file (calibration-core
   session reducers) plus a one-click take-over keep it legible; it is never a heartbeat and never
   auto-steals a live peer. `mode` (calibration-core.deriveMode) is a sum type — active / electing /
   passive-tab / passive-session / auth — that gates every state-mutating write EXCEPT register (no
   name exists yet). Concurrency is already data-safe via CAS + unionVerdicts, so this tier buys
   legibility, not safety.

   Security: the token lives only in the link fragment (never sent to a server) and localStorage; it
   is never written into any published file. The reviewer name is validated (calibration-core) so it
   can't become an unsafe path segment, and path segments are URL-encoded. Independence between
   reviewers is honor-system — the UI never shows a peer's verdicts.

   CSP: connect-src 'self' https://api.github.com — data files same-origin, coordination and the
   token's login via the API only.

   Testability: the module.exports guard exports { create, makeVerdictWriter }; an instance exposes its
   fetch/CAS layer (ghGet/ghPut/withState/saveVerdicts) and the presence compositions next to boot(),
   so tests stub global.fetch and drive them without a browser. */

/**
 * @typedef {import("./review-widget.js").ReviewConfig} ReviewConfig
 * @typedef {import("./review-widget.js").ReviewItem} ReviewItem
 * @typedef {import("./review-widget.js").Decided} Decided
 * @typedef {import("./review-widget.js").Partition} Partition
 * @typedef {import("./calibration-core.js").VerdictCell} VerdictCell
 * @typedef {import("./calibration-core.js").CoordState} CoordState
 * @typedef {import("./calibration-core.js").BucketState} BucketState
 * @typedef {import("./calibration-core.js").SessionRec} SessionRec
 * @typedef {import("./calibration-core.js").Bucket} Bucket
 * @typedef {{ scaffolds: string, buckets: string, manifest: string }} DataUrls
 * @typedef {{ owner: string, repo: string, statePath: string, verdictDir: string, dataUrls: DataUrls,
 *   storagePrefix: string, lockPrefix: string, config: ReviewConfig, practice: ReviewItem[],
 *   identity: "typed"|"github" }} AppOptions
 *   owner/repo: the private coordination repo. statePath: the coordination state file in it.
 *   verdictDir: the folder of verdict files, one per (bucket, reviewer): <verdictDir>/<bucket>__<reviewer>.json.
 *   dataUrls: the page's scaffolds/buckets/manifest, fetched relative to the page.
 *   storagePrefix: prefixes the localStorage/sessionStorage keys (token, reviewer, sid).
 *   lockPrefix: prefixes the Web Lock name (the reviewer name follows, URL-encoded).
 *   config: the review semantics per item kind. practice: the warm-up items, shown with the reveal (may be []).
 *   identity: "typed" (roster screen, shared token) or "github" (the token's GitHub login).
 * @typedef {{ sha: (string|undefined), decisions: Record<string, VerdictCell> }} VerdictSnapshot
 * @typedef {{ reviewer: string, bucket_id: string, decisions: Record<string, VerdictCell>, campaign_id: string }} VerdictFile
 *   - one (bucket, reviewer)'s verdict file, stamped with the campaign_id of the manifest its items were
 *   published under, so the campaign's ingest can refuse a file reviewed against another publish
 * @typedef {{ campaign_id: string }} Manifest - the page's published manifest.json, as far as the shell
 *   reads it: the publish the page's items come from (a non-empty id)
 * @typedef {{ content: string, sha: string }} GhFile - a Contents API GET of a file: its base64 content and blob sha
 * @typedef {{ content: { sha: string } }} GhPutResult - a Contents API PUT: the file's new blob sha
 * @typedef {{ login: string }} GhUser - GET /user, as far as the shell reads it
 * @typedef {"AUTH"|"CAS"|"RETRYABLE"|"OTHER"} ErrKind - calibration-core.classifyError's classes
 * @typedef {Error & { kind: ErrKind, status: number }} GhError - a classified GitHub call failure
 * @typedef {{ ok: boolean, declined?: boolean, state: CoordState }} StateResult - a withState outcome
 * @typedef {{ kind: "label", bucket: Bucket, idx: number, notice: (string|null), noticeAnnounced: boolean,
 *   pending: (string|null), draftMember: (string|null) }} LabelScreen - one labeling session of a bucket,
 *   opened by openBucket: the item shown (idx); a calm notice for the session (a full-bucket claim race),
 *   announced once; the first-step answer awaiting its follow-up on the current item (the widget's
 *   two-step choice), cleared whenever the item changes or an answer commits; and the member whose
 *   selector changed the current item's draft last, so its selector keeps focus
 * @typedef {{ kind: "loading" } | { kind: "roster" } | { kind: "practice" } | { kind: "board" } | LabelScreen
 *   | { kind: "completing", bucket: Bucket }} Screen - what the page shows; "completing" is a finished
 *   bucket whose verdicts are flushing before it is marked complete
 * @typedef {typeof globalThis & { CalibrationReviewWidget?: typeof import("./review-widget.js"),
 *   CalibrationCoord?: typeof import("./calibration-core.js"), CalibrationApp?: typeof import("./calibration.js") }} Globals
 *   - the window the classic scripts publish themselves onto
 */

(function (/** @type {Globals} */ root) {
  "use strict";

  var TIMEOUT_MS = 15000;
  var MAX_TRIES = 5;
  var BACKOFF_MS = 400;
  var USER_API = "https://api.github.com/user";


  // ---- typed errors + GitHub Contents client ----------------------------------------------------
  /** @param {string} str */
  function b64encode(str) { return btoa(unescape(encodeURIComponent(str))); }
  /** @param {string} b64 */
  function b64decode(b64) { return decodeURIComponent(escape(atob(b64))); }

  /** @param {ErrKind} kind @param {number} status @param {string} message @returns {GhError} */
  function makeErr(kind, status, message) {
    return Object.assign(new Error(message), { kind: kind, status: status });
  }
  // The class of a failure makeErr raised, or "" for any other rejection.
  /** @param {unknown} e @returns {string} */
  function errKind(e) { return e && typeof e === "object" && "kind" in e && typeof e.kind === "string" ? e.kind : ""; }
  /** @param {unknown} e @returns {string} */
  function messageOf(e) { return e instanceof Error ? e.message : String(e); }
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

  // Coalescing serialized writer for verdict files. Rapid labels accumulate in `pending` and flush
  // together (one commit per file), and every flush runs behind a single `chain` promise so two
  // GET→PUT cycles can never overlap on the same file, and N labels collapse to a handful of commits
  // (dodging the secondary rate limit). The writer also holds each file's authoritative {sha,
  // decisions} snapshot (seeded from the file on the first flush, then advanced from every PUT
  // response) and threads it into `io.save`, so successive flushes never re-GET a just-written file —
  // that post-write GET is what sampled GitHub's read-after-write staleness and 409-stormed. A failed
  // flush drops the snapshot so the next attempt re-seeds from GitHub. io.save persists one file's
  // batch given the prior snapshot and resolves the NEW snapshot; io.onSaved / io.onFailed report
  // which item ids landed or need re-labeling. Injected so the writer is unit-testable without the DOM.
  /** @param {{save:(b:string,r:string,d:Record<string,Decided>,snapshot:(VerdictSnapshot|null))=>Promise<VerdictSnapshot>, onSaved?:(ids:string[])=>void, onFailed?:(ids:string[], err:unknown)=>void, isRetryable?:(err:unknown)=>boolean, debounceMs?:number, retryMs?:number}} io */
  function makeVerdictWriter(io) {
    var debounceMs = io.debounceMs == null ? 700 : io.debounceMs;
    var retryMs = io.retryMs == null ? 3000 : io.retryMs; // spacing before an automatic re-flush after a retryable failure
    /** @type {Record<string, {bucketId:string, reviewer:string, decisions:Record<string,Decided>}>} */
    var pending = {};
    /** @type {Record<string, VerdictSnapshot|null>} */
    var snap = {}; // per-file authoritative {sha, decisions} threaded across flushes (null/absent ⇒ re-seed via GET)
    /** @type {Promise<unknown>} */
    var chain = Promise.resolve();
    /** @type {ReturnType<typeof setTimeout>|null} */
    var timer = null;
    /** @param {string} bucketId @param {string} reviewer */
    function keyFor(bucketId, reviewer) { return bucketId + "__" + reviewer; }
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
            /** @type {Record<string,Decided>} */
            var batch = {};
            Object.keys(decisions).forEach(function (id) { var v = decisions[id]; if (v != null) batch[id] = v; });
            var ids = Object.keys(batch);
            if (!ids.length) { delete pending[k]; return; }
            return io.save(slot.bucketId, slot.reviewer, batch, snap[k] || null).then(function (nextSnap) {
              snap[k] = nextSnap; // advance the threaded snapshot from the PUT response (io.save resolves the new snapshot)
              // clear only the items we flushed whose answer hasn't been re-queued since the snapshot
              // (queue stores a fresh object per answer, so identity tells a re-label apart)
              ids.forEach(function (id) { if (decisions[id] === batch[id]) delete decisions[id]; });
              if (!Object.keys(decisions).length) delete pending[k];
              try { if (io.onSaved) io.onSaved(ids); } catch (e) { /* a callback throw must not poison the chain */ }
            }, function (/** @type {unknown} */ err) {
              snap[k] = null; // the file's sha is now uncertain — re-seed from GitHub on the next attempt
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
      /** @param {string} bucketId @param {string} reviewer @param {string} itemId @param {Decided} decided */
      queue: function (bucketId, reviewer, itemId, decided) {
        var k = keyFor(bucketId, reviewer);
        var slot = pending[k] || (pending[k] = { bucketId: bucketId, reviewer: reviewer, decisions: {} });
        slot.decisions[itemId] = decided;
        schedule();
      },
      // Cancel the debounce and flush now; await the returned promise before treating a bucket as done.
      flushNow: function () { if (timer != null) { clearTimeout(timer); timer = null; } return flush(); },
    };
  }

  // The answer a widget commit stands for: a partition answer carries its partition and no detail.
  /** @param {string} verdict @param {string|null} detail @param {Partition|undefined} partition @returns {Decided} */
  function decidedOf(verdict, detail, partition) {
    return partition ? { verdict: verdict, detail: null, partition: partition } : { verdict: verdict, detail: detail };
  }

  // The verdict cell a reviewer's answer is stored as: `detail` and `partition` only when the answer
  // has one, so a one-step answer's cell is exactly { verdict, timestamp }.
  /** @param {Decided} decided @param {number} timestamp @returns {VerdictCell} */
  function verdictCell(decided, timestamp) {
    /** @type {VerdictCell} */
    var cell = { verdict: decided.verdict, timestamp: timestamp };
    if (decided.detail != null) cell.detail = decided.detail;
    if (decided.partition != null) cell.partition = decided.partition;
    return cell;
  }

  // ---- options ----------------------------------------------------------------------------------
  var _GH_NAME_RE = /^[A-Za-z0-9_.-]+$/;

  /** @param {unknown} v @returns {v is Record<string, unknown>} */
  function isObject(v) { return v != null && typeof v === "object"; }

  /** @param {unknown} v @returns {v is unknown[]} */
  function isList(v) { return Array.isArray(v); }

  /** @param {unknown} v @returns {v is string[]} */
  function isStringList(v) { return isList(v) && v.every(function (x) { return typeof x === "string"; }); }

  /** @param {unknown} v @returns {v is string} */
  function nonEmptyString(v) { return typeof v === "string" && v.length > 0; }

  // A repo-relative path: non-empty "/"-separated segments, none of them "." or "..", so a page's
  // statePath/verdictDir can only ever address a file inside the coordination repo.
  /** @param {unknown} p @returns {boolean} */
  function isRepoPath(p) {
    return nonEmptyString(p) && String(p).split("/").every(function (seg) { return seg !== "" && seg !== "." && seg !== ".."; });
  }

  /** @param {string} p @returns {string} */
  function encodePath(p) { return p.split("/").map(encodeURIComponent).join("/"); }

  // ---- data read from GitHub and the page's data files ------------------------------------------
  // Each read is checked against its declared shape here, once; a mismatch throws.

  /** @param {unknown} v @returns {v is BucketState} */
  function isBucketState(v) {
    return isObject(v) && isStringList(v.completed_by) && isList(v.claimants) && v.claimants.every(function (c) {
      return isObject(c) && typeof c.name === "string" && typeof c.ts === "number";
    });
  }

  /** @param {unknown} v @returns {v is SessionRec} */
  function isSessionRec(v) { return isObject(v) && typeof v.sessionId === "string" && typeof v.ts === "number"; }

  /** @template T @param {unknown} v @param {(x: unknown) => x is T} isT @returns {v is Record<string, T>} */
  function isRecordOf(v, isT) { return isObject(v) && Object.keys(v).every(function (k) { return isT(v[k]); }); }

  // state.json: a state written before the single-session marker has no `sessions`.
  /** @param {unknown} v @returns {v is CoordState} */
  function isCoordState(v) {
    return isObject(v) && isStringList(v.roster) && isRecordOf(v.buckets, isBucketState)
      && (v.sessions === undefined || isRecordOf(v.sessions, isSessionRec));
  }

  /** @param {unknown} j @param {string} path @returns {CoordState} */
  function parseCoordState(j, path) {
    if (isCoordState(j)) return j;
    throw makeErr("OTHER", 0, path + " is not a coordination state");
  }

  // A verdict file's cells, each still unknown: unionVerdicts keeps the well-formed ones. A file with
  // no decisions object holds none.
  /** @param {unknown} j @param {string} path @returns {Record<string, unknown>} */
  function verdictDecisions(j, path) {
    if (!isObject(j)) throw makeErr("OTHER", 0, path + " is not a verdict file");
    return isObject(j.decisions) ? j.decisions : {};
  }

  /** @param {unknown} v @returns {v is Bucket} */
  function isBucket(v) {
    return isObject(v) && typeof v.bucket_id === "string" && typeof v.stratum === "string" && isStringList(v.item_ids)
      && typeof v.confirmations_required === "number" && (v.excluded_reviewers === undefined || isStringList(v.excluded_reviewers));
  }

  /** @param {unknown} raw @param {string} url @returns {Bucket[]} */
  function parseBuckets(raw, url) {
    if (isList(raw) && raw.every(isBucket)) return raw;
    throw new Error(url + " is not a list of buckets");
  }

  // The published items by id. Refuses a bucket that names an item `url` does not publish, so every
  // bucket's items are in the map.
  /** @param {ReviewItem[]} items @param {Bucket[]} buckets @param {string} url @returns {Map<string, ReviewItem>} */
  function indexItems(items, buckets, url) {
    /** @type {Map<string, ReviewItem>} */
    var byId = new Map();
    items.forEach(function (it) { byId.set(it.item_id, it); });
    buckets.forEach(function (b) {
      b.item_ids.forEach(function (id) {
        if (!byId.has(id)) throw new Error("bucket " + b.bucket_id + " names item " + JSON.stringify(id) + ", which " + url + " does not publish");
      });
    });
    return byId;
  }

  /** @param {unknown} raw @param {string} url @returns {Manifest} */
  function parseManifest(raw, url) {
    if (isObject(raw) && nonEmptyString(raw.campaign_id)) return { campaign_id: raw.campaign_id };
    throw new Error(url + " is not a campaign manifest: it needs a non-empty campaign_id");
  }

  /** @param {unknown} j @param {number} status @param {string} path @returns {GhFile} */
  function parseGhFile(j, status, path) {
    if (isObject(j) && typeof j.content === "string" && typeof j.sha === "string") return { content: j.content, sha: j.sha };
    throw makeErr("OTHER", status, "GET " + path + ": response had no content and sha");
  }

  // The returned sha is threaded forward as the next write's CAS token; if a malformed response ever
  // lacked it, `sha` would be undefined → ghPut's `if (sha)` treats it as a create and silently drops
  // CAS. Refuse it (OTHER = surface, don't retry-loop) rather than write blind.
  /** @param {unknown} j @param {number} status @param {string} path @returns {GhPutResult} */
  function parseGhPutResult(j, status, path) {
    var sha = isObject(j) && isObject(j.content) ? j.content.sha : undefined;
    if (typeof sha === "string" && sha) return { content: { sha: sha } };
    throw makeErr("OTHER", status, "PUT " + path + ": response had no content.sha");
  }

  /** @param {unknown} j @param {number} status @returns {GhUser} */
  function parseGhUser(j, status) {
    if (isObject(j) && typeof j.login === "string") return { login: j.login };
    throw makeErr("OTHER", status, "GET /user: response had no login");
  }

  /**
   * Refuse options a page could not run with — before anything renders — with a message naming the
   * first problem. The review config is checked by the widget's own validateReviewConfig, and each
   * practice item by its validateReviewItem.
   * @param {unknown} o
   * @param {typeof import("./review-widget.js")} W - the review widget module
   * @returns {AppOptions}
   */
  function checkOptions(o, W) {
    /** @param {string} why @returns {never} */
    function fail(why) { throw new Error("CalibrationApp.create: " + why); }
    if (!isObject(o)) fail("options must be an object");
    ["owner", "repo"].forEach(function (k) { var v = o[k]; if (!nonEmptyString(v) || !_GH_NAME_RE.test(v)) fail(k + " must be a GitHub owner/repo name"); });
    ["statePath", "verdictDir"].forEach(function (k) { if (!isRepoPath(o[k])) fail(k + " must be a repo-relative path with no empty, . or .. segment"); });
    ["storagePrefix", "lockPrefix"].forEach(function (k) { if (!nonEmptyString(o[k])) fail(k + " must be a non-empty string"); });
    const dataUrls = o.dataUrls; // const: its narrowing reaches the closure below
    if (!isObject(dataUrls)) fail("dataUrls must be an object");
    ["scaffolds", "buckets", "manifest"].forEach(function (k) { if (!nonEmptyString(dataUrls[k])) fail("dataUrls." + k + " must be a non-empty string"); });
    if (o.identity !== "typed" && o.identity !== "github") fail('identity must be "typed" or "github"');
    var vc = W.validateReviewConfig(o.config);
    if (!vc.ok) fail("config: " + vc.reason);
    var config = /** @type {ReviewConfig} */ (o.config); // validateReviewConfig has held it to a ReviewConfig
    var practice = o.practice;
    if (!isList(practice)) fail("practice must be an array (empty for no practice set)");
    practice.forEach(function (it, /** @type {number} */ i) {
      var vi = W.validateReviewItem(it, config);
      if (!vi.ok) fail("practice item " + (i + 1) + ": " + vi.reason);
    });
    return /** @type {AppOptions} */ (o);
  }

  /** @template T @param {T|undefined} mod @param {string} file @returns {T} */
  function sibling(mod, file) {
    if (!mod) throw new Error("CalibrationApp.create: " + file + " is not loaded");
    return mod;
  }

  /**
   * Build one review page instance from its options. Reads the stored token (and the link fragment's
   * token) and the stored reviewer; renders and fetches nothing until boot(). `options` is parsed
   * here (checkOptions), so a page's config reaches it as data.
   * @param {unknown} options
   */
  function create(options) {
    // The two sibling classic scripts publish themselves onto window before this one loads.
    var W = sibling(root.CalibrationReviewWidget, "review-widget.js");
    var C = sibling(root.CalibrationCoord, "calibration-core.js");
    var OPTS = checkOptions(options, W);
    var API = "https://api.github.com/repos/" + encodeURIComponent(OPTS.owner) + "/" + encodeURIComponent(OPTS.repo) + "/contents/";
    var STATE_PATH = encodePath(OPTS.statePath);
    var VERDICT_DIR = encodePath(OPTS.verdictDir);
    var DATA = OPTS.dataUrls;
    var CONFIG = OPTS.config;
    var IDENTITY = OPTS.identity;
    // Practice set — separate from the scored items, shown WITH the reveal so a reviewer learns the
    // task; never scored (not real scaffolds), so onboarding can't contaminate the measurement.
    var PRACTICE = OPTS.practice;
    var TOKEN_KEY = OPTS.storagePrefix + "token";
    var REVIEWER_KEY = OPTS.storagePrefix + "reviewer";
    var SID_KEY = OPTS.storagePrefix + "sid";

    // ---- token ----------------------------------------------------------------------------------
    var LS = typeof localStorage !== "undefined" ? localStorage : null; // null under a non-DOM test env
    function readToken() {
      var m = /(?:^|[#&])token=([^&]+)/.exec(location.hash || "");
      if (m && m[1]) {
        var tok = decodeURIComponent(m[1]);
        if (LS) LS.setItem(TOKEN_KEY, tok);
        history.replaceState(null, "", location.pathname + location.search); // strip token from the address bar
        return tok;
      }
      return (LS && LS.getItem(TOKEN_KEY)) || "";
    }
    var TOKEN = typeof window !== "undefined" && window.location ? readToken() : "";

    // ---- typed errors + GitHub Contents client --------------------------------------------------
    var authFailed = false;
    var syncFailed = false;
    // A token death (401/403) — the one failure class that flips the page read-only. markAuthFailed alone
    // only repaints the banner; callers that could be mid-write must follow it with recomputeMode() to
    // actually re-derive `mode` and bounce off any writing screen.
    /** @param {unknown} e @returns {boolean} */
    function isAuthError(e) { return errKind(e) === "AUTH"; }
    function markAuthFailed() { authFailed = true; renderBanner(); }

    // Classify + surface a sync failure WITHOUT disabling writes (unless it's a genuine AUTH failure).
    /** @param {unknown} err */
    function reportSyncFailure(err) {
      if (isAuthError(err)) { markAuthFailed(); return; }
      syncFailed = true;
      if (typeof console !== "undefined") console.error("calibration sync failure:", err);
      renderBanner();
    }

    // GET a file → {json, sha} or null (404). Throws a typed error otherwise.
    // `cache: "no-store"`: GitHub's API responses carry `Cache-Control: private, max-age=60`, and a
    // 409'd PUT does NOT invalidate a cached GET (HTTP invalidation applies to non-error responses).
    // Without no-store the browser would re-serve a stale sha from its own cache for up to a minute —
    // so a CAS retry re-reads the SAME stale sha and 409s forever. Every read must reach GitHub.
    /** @param {string} path @returns {Promise<{json:unknown, sha:string}|null>} */
    function ghGet(path) {
      /** @type {RequestInit} */
      var opts = { cache: "no-store", headers: { Authorization: "Bearer " + TOKEN, Accept: "application/vnd.github+json" } };
      var sig = timeoutSignal(); if (sig) opts.signal = sig;
      return fetch(API + path, opts).catch(function (/** @type {unknown} */ e) {
        throw makeErr("RETRYABLE", 0, "network: " + messageOf(e)); // fetch reject (network/DNS/abort)
      }).then(function (r) {
        if (r.status === 404) return null;
        if (!r.ok) throw makeErr(C.classifyError(r.status), r.status, "GET " + path + " → " + r.status);
        return r.json().then(function (/** @type {unknown} */ j) {
          var file = parseGhFile(j, r.status, path);
          /** @type {unknown} */
          var json = JSON.parse(b64decode(file.content));
          return { json: json, sha: file.sha };
        });
      });
    }
    // PUT a file (sha optional to create). Resolves {sha}; throws a typed error on failure.
    /** @param {string} path @param {unknown} obj @param {string} [sha] @returns {Promise<{sha:string}>} */
    function ghPut(path, obj, sha) {
      /** @type {{ message: string, content: string, sha?: string }} */
      var body = { message: "calibration: update " + path, content: b64encode(JSON.stringify(obj, null, 2)) };
      if (sha) body.sha = sha;
      /** @type {RequestInit} */
      var opts = {
        method: "PUT",
        headers: { Authorization: "Bearer " + TOKEN, Accept: "application/vnd.github+json" },
        body: JSON.stringify(body),
      };
      var sig = timeoutSignal(); if (sig) opts.signal = sig;
      return fetch(API + path, opts).catch(function (/** @type {unknown} */ e) {
        throw makeErr("RETRYABLE", 0, "network: " + messageOf(e));
      }).then(function (r) {
        if (!r.ok) throw makeErr(C.classifyError(r.status), r.status, "PUT " + path + " → " + r.status);
        return r.json().then(function (/** @type {unknown} */ j) { return { sha: parseGhPutResult(j, r.status, path).content.sha }; });
      });
    }

    // Read-modify-write state.json under CAS. mutate(state) → newState, or null to DECLINE (no write).
    // Resolves { ok, declined?, state }; retries CAS/RETRYABLE with backoff; throws typed error otherwise.
    //
    // All state.json access is serialized through `stateChain`: the client is a SINGLE in-tab writer, so
    // its own concurrent operations (open-claim, presence refresh, completion, take-over) never race
    // each other into a self-inflicted CAS collision. Unlike the verdict file, state.json is NOT
    // sha-threaded — each op re-GETs fresh state per attempt (so the atomic take-over gate, a loser
    // refetching and declining, still holds). Serialization removes the concurrent-collision storm; a
    // RESIDUAL 409 from server-side replica lag (read-after-write) is still possible and is healed by
    // the CAS retry below, not by serialization. Freshness reads (refreshState/poll) queue here too and
    // simply observe — a benign head-of-line wait behind an in-flight write's retries.
    /** @type {Promise<unknown>} */
    var stateChain = Promise.resolve();
    // Run `attempt`, retrying a CAS/RETRYABLE failure with jittered backoff up to `tries` times; a
    // permanent failure (AUTH/OTHER) throws immediately. `onRetry(err)` runs before each re-attempt so a
    // caller can invalidate stale state (e.g. drop a threaded sha on a genuine 409). Single-sources the
    // isRetryable + MAX_TRIES + backoff policy shared by withState and saveVerdicts. Each retry re-invokes
    // `attempt` from scratch (re-GET → re-mutate/re-union → re-PUT) — never a replayed precomputed
    // payload, which is what lets a CAS loser observe an interleaved write and decline.
    /** @template T @param {() => Promise<T>} attempt @param {number} tries @param {(err:unknown)=>void} [onRetry] @returns {Promise<T>} */
    function retryWithBackoff(attempt, tries, onRetry) {
      return attempt().catch(function (/** @type {unknown} */ e) {
        if (!C.isRetryable(errKind(e)) || tries <= 0) throw e;
        if (onRetry) onRetry(e);
        return delay(backoff(MAX_TRIES - tries)).then(function () { return retryWithBackoff(attempt, tries - 1, onRetry); });
      });
    }
    /** @param {(state:CoordState)=>(CoordState|null)} mutate @param {number} [tries] @returns {Promise<StateResult>} */
    function withState(mutate, tries) {
      // The single funnel for state.json OWNS state coherence: whatever an attempt resolves — the newly
      // written state on success, or the freshly-fetched state on a decline — becomes the module `state`
      // here, once, on resolution. Mutators are pure over their `s` argument and must NOT assign `state`
      // themselves; making adoption a per-call-site chore is what let one decline path silently skip it.
      // (On a final failure the assignment .then is skipped, so a failed write never adopts a partial read.)
      var run = stateChain.catch(function () {}).then(function () { return withStateAttempt(mutate, tries); })
        .then(function (res) { state = res.state; return res; });
      stateChain = run.catch(function () {}); // keep the chain resolve-only so one failure can't wedge the queue
      return run;
    }
    /** @param {(s:CoordState)=>(CoordState|null)} mutate @param {number} [tries] @returns {Promise<StateResult>} */
    function withStateAttempt(mutate, tries) {
      return retryWithBackoff(function () {
        return ghGet(STATE_PATH).then(function (cur) {
          var fetched = cur ? parseCoordState(cur.json, STATE_PATH) : C.emptyState(); // local — do not shadow the module `state`
          var sha = cur ? cur.sha : undefined;
          const next = mutate(fetched); // const: its not-null narrowing reaches the closure below
          if (next == null) return { ok: false, declined: true, state: fetched }; // mutator declined — no write; adopt the fetch
          return ghPut(STATE_PATH, next, sha).then(function () { return { ok: true, state: next }; });
        });
      }, tries == null ? MAX_TRIES : tries);
    }

    // The verdict file of one (bucket, reviewer): <verdictDir>/<bucket>__<reviewer>.json, each segment
    // URL-encoded.
    /** @param {string} bucketId @param {string} reviewer @returns {string} */
    function verdictPath(bucketId, reviewer) {
      return VERDICT_DIR + "/" + encodeURIComponent(bucketId) + "__" + encodeURIComponent(reviewer) + ".json";
    }

    // Merge a batch of {itemId: Decided} into a reviewer's verdict file, union-preserving prior
    // decisions, under CAS. One commit per call regardless of batch size. Throws a typed error on
    // final failure.
    //
    // A verdict file has exactly ONE writer (this reviewer, serialized by makeVerdictWriter), so the
    // caller can THREAD the authoritative snapshot forward: when `snapshot` ({sha, decisions}) is
    // supplied, we already know the file's sha and contents from our own last PUT and skip the GET
    // entirely — the post-write GET is exactly what sampled GitHub's read-after-write staleness window
    // and 409-stormed across a fast reviewer's successive flushes. A GET happens only on cold start (no
    // snapshot) or a genuine cross-device 409, where we invalidate, refetch, and re-union so no device's
    // verdicts are lost (unionVerdicts keeps both, latest-timestamp-per-item winning). Resolves the NEW
    // snapshot {sha, decisions} for the writer to thread into the next flush.
    /** @param {string} bucketId @param {string} reviewer @param {Record<string,Decided>} newDecisions
     *  @param {VerdictSnapshot|null} [snapshot]
     *  @param {number} [tries] @returns {Promise<VerdictSnapshot>} */
    function saveVerdicts(bucketId, reviewer, newDecisions, snapshot, tries) {
      var path = verdictPath(bucketId, reviewer);
      // Every verdict file carries its campaign's id; with no manifest loaded there is none to stamp.
      var manifest = MANIFEST;
      if (!manifest) return Promise.reject(new Error("cannot write " + path + ": the page's manifest is not loaded"));
      var campaignId = manifest.campaign_id;
      // `snapshot` is re-read on each attempt; a genuine 409 drops it (onRetry below) so the retry
      // re-GETs fresh and re-unions — no verdict lost. A network blip keeps it (our sha is still valid).
      return retryWithBackoff(function () {
        /** @type {Promise<{ sha: (string|undefined), decisions: Record<string, unknown> }>} */
        var seed = snapshot
          ? Promise.resolve({ sha: snapshot.sha, decisions: snapshot.decisions })
          : ghGet(path).then(function (cur) {
              return { sha: cur ? cur.sha : undefined, decisions: cur ? verdictDecisions(cur.json, path) : {} };
            });
        return seed.then(function (base) {
          var decisions = C.unionVerdicts({}, base.decisions); // clone + normalize; never mutate the threaded snapshot in place
          var now = Date.now();
          Object.keys(newDecisions).forEach(function (id) {
            var d = newDecisions[id];
            if (d) decisions[id] = verdictCell(d, now);
          });
          /** @type {VerdictFile} */
          var payload = { reviewer: reviewer, bucket_id: bucketId, decisions: decisions, campaign_id: campaignId };
          return ghPut(path, payload, base.sha).then(function (r) { return { sha: r.sha, decisions: decisions }; });
        });
      }, tries == null ? MAX_TRIES : tries, function (e) { if (errKind(e) === "CAS") snapshot = null; });
    }

    // ---- app state (in memory) --------------------------------------------------------------------
    /** @type {ReviewItem[]} */ var SCAFFOLDS = [];
    /** @type {Bucket[]} */ var BUCKETS = [];
    // The published manifest, read at boot; its campaign_id is stamped on every verdict file.
    /** @type {Manifest|null} */ var MANIFEST = null;
    /** @type {Map<string, ReviewItem>} */ var ITEMS = new Map();
    var state = C.emptyState();
    // A typed identity resumes from storage; a GitHub identity is the token's login, resolved at boot.
    var reviewer = IDENTITY === "typed" && LS ? (LS.getItem(REVIEWER_KEY) || "") : "";
    // `drafts` holds, per item, the partition a partition item's reviewer is building and has not
    // saved, kept across navigation for the page session and dropped when the item's answer commits.
    /** @type {{screen:Screen, localVerdicts:Record<string,Decided>, unsaved:Record<string,boolean>, drafts:Record<string,Partition>}} */
    var view = { screen: { kind: "loading" }, localVerdicts: {}, unsaved: {}, drafts: {} };

    // The published item `id`. Total once boot has indexed the items (indexItems), since a bucket names
    // only published items and nothing reads a bucket before boot.
    /** @param {string} id @returns {ReviewItem} */
    function itemOf(id) {
      var it = ITEMS.get(id);
      if (!it) throw new Error("calibration: item " + JSON.stringify(id) + " is not published");
      return it;
    }
    /** @param {Bucket} bucket @returns {ReviewItem[]} */
    function scaffoldsFor(bucket) { return bucket.item_ids.map(function (id) { return itemOf(id); }); }
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
        verdictSaving = false; showSaved = false; renderSaveIndicator(); // clear the calm "Saving…" — the amber banner owns the failure now
        reportSyncFailure(err);
      },
      isRetryable: function (err) { return C.isRetryable(errKind(err)); },
    });

    // ---- single active session --------------------------------------------------------------------
    // Two tiers: navigator.locks elects ONE active tab per browser (instant, no network); a lazy
    // presence marker in state.json + a one-click take-over keep a single active writer legible across
    // browsers/devices. The pure core (planPresence/deriveMode) owns every decision; this shell only
    // executes it. `mode` gates every state-mutating write EXCEPT register (no name exists pre-register).
    var SS = typeof sessionStorage !== "undefined" ? sessionStorage : null; // per-tab: survives F5, clears on close
    function readSessionId() {
      var id = SS ? SS.getItem(SID_KEY) : null;
      if (!id) {
        id = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : (String(Date.now()) + "-" + Math.random());
        if (SS) SS.setItem(SID_KEY, id);
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
    function lockName() { return OPTS.lockPrefix + encodeURIComponent(reviewer); }

    // Intra-browser leader election. The held tab keeps a never-resolving callback (releases only on tab
    // teardown or a steal); waiting tabs are promoted automatically when the holder goes. During a
    // take-over `takingOver` is set, so `afterLock` treats our self-abort as intentional, not a real loss.
    /** @type {AbortController|null} */
    var lockCtl = null;
    /** @type {((v?: unknown) => void)|null} */ // a Promise resolver (its value is unused)
    var heldRelease = null;       // resolves the held-lock callback promise → releases our hold (see releaseLock)
    var releasing = false;        // a self-initiated release (pagehide) is in flight — its lock-callback settle is NOT a loss to re-elect on
    var takingOver = false;       // in-flight guard: a take-over is between click and settle (no double-fire)
    var pendingBoardFocus = false; // move focus to the board heading after a take-over, for keyboard/SR users
    function manageLock() {
      if (!hasLocks()) { lockState = "unsupported"; recomputeMode(); return; }
      lockState = "electing"; recomputeMode();
      // A slow grant is NOT proof another tab holds the lock. Instead of flipping to a read-only
      // "another tab is active" banner on a bare 300ms timeout — which also fires on a reload's teardown
      // race or a momentarily busy main thread with no real competitor — confirm a genuine foreign
      // holder via navigator.locks.query() first. If nobody actually holds our lock, keep electing: a
      // free lock is granted to its sole requester, so the grant is imminent and the held-callback below
      // will stop this recheck. Only a real foreign holder makes this tab passive.
      var electing = setTimeout(function reelect() {
        if (lockState !== "electing") return;
        if (!navigator.locks.query) { lockState = "waiting"; recomputeMode(); return; } // no query() → fall back to the timeout heuristic
        navigator.locks.query().then(function (q) {
          if (lockState !== "electing") return; // granted (or torn down) meanwhile
          var name = lockName();
          var foreign = (q.held || []).some(function (l) { return l.name === name; }); // we don't hold it yet, so any holder is another tab
          if (foreign) { lockState = "waiting"; recomputeMode(); }
          else electing = setTimeout(reelect, 300); // nobody holds it — the grant is just slow; re-check, don't cry wolf
        }, function () { if (lockState === "electing") { lockState = "waiting"; recomputeMode(); } }); // query() failed → heuristic
      }, 300);
      lockCtl = new AbortController();
      var locks = navigator.locks;
      locks.request(lockName(), { signal: lockCtl.signal }, function () {
        clearTimeout(electing); lockState = "held"; recomputeMode();
        return new Promise(function (resolve) { heldRelease = resolve; }); // hold until tab teardown, steal, or explicit release (pagehide)
      }).then(afterLock, afterLock);
      function afterLock() {
        clearTimeout(electing); heldRelease = null;
        if (takingOver) return; // our own abort en route to a steal — the steal re-holds; not a real loss
        if (releasing) { releasing = false; return; } // our own pagehide release — pageshow re-elects, not us (else two elections race)
        if (reviewer && !authFailed) manageLock(); // lost or stolen-from → re-elect (queue for promotion)
      }
    }
    // Release our held Web Lock immediately (used on pagehide): a reloading/closing tab must free the
    // lock BEFORE the next document elects, or that document's query() would see this dying tab as a
    // foreign holder and show a false "another tab is active" banner. `releasing` tells the lock
    // callback's settle handler (afterLock / afterSteal) that this settle is our own doing, so it must
    // NOT auto-re-elect — a bfcache restore re-elects exactly once, via the pageshow handler.
    function releaseLock() { if (heldRelease) { releasing = true; heldRelease(); heldRelease = null; } }
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
      withState(function (s) { return C.takeoverSession(s, reviewer, SESSION_ID, Date.now()).state; })
        .then(function () { recomputeMode(); rerenderCurrent(); done(); })
        .catch(function (/** @type {unknown} */ e) { reportSyncFailure(e); done(); });
      // Lock: steal it only when we don't already hold it (a self-steal would needlessly churn our hold).
      if (hasLocks() && lockState !== "held") {
        pending++;
        if (lockCtl) lockCtl.abort(); // cancel our own pending wait first (afterLock sees `takingOver`)
        navigator.locks.request(lockName(), { steal: true }, function () {
          lockState = "held"; recomputeMode(); rerenderCurrent(); done();
          return new Promise(function (resolve) { heldRelease = resolve; }); // releasable on pagehide, like the elected hold
        }).then(afterSteal, afterSteal);
        function afterSteal() { done(); if (releasing) { releasing = false; return; } if (reviewer && !authFailed) manageLock(); } // same self-release guard as afterLock
      }
    }

    // Decide the presence write over freshly-fetched state: claim a free/stale slot or refresh our own,
    // or return null to decline when a live FOREIGN session holds the name. Pure over `s`; withState
    // adopts the fetched state on a decline, so a displaced session still updates its view of reality.
    /** @param {CoordState} s @param {string} rev @param {string} sid @param {number} now @returns {CoordState|null} */
    function presenceMutation(s, rev, sid, now) {
      if (C.sessionHeldByOther(s, rev, sid, now)) return null; // a live foreign holder — don't write over it
      return C.claimSession(s, rev, sid, now).state;
    }

    // Persist our presence marker. On a decline (a live foreign holder) withState still adopts the fresh
    // fetch, so a just-displaced session converges to passive on the next recompute rather than spinning
    // against stale state. One write in flight at a time.
    var presenceWriting = false;
    function writePresence() {
      if (presenceWriting || authFailed || !reviewer) return;
      presenceWriting = true;
      withState(function (s) {
        return presenceMutation(s, reviewer, SESSION_ID, Date.now());
      }).then(
        function () { presenceWriting = false; recomputeMode(); },
        // On genuine failure, adopt read-only if the token died; otherwise leave it for the next natural
        // trigger (poll/visibility) — do NOT re-derive-and-rewrite here, which would spin on a persistent error.
        function (/** @type {unknown} */ err) { presenceWriting = false; if (isAuthError(err)) { markAuthFailed(); recomputeMode(); } });
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
      if (mode !== "active" && (view.screen.kind === "label" || view.screen.kind === "completing")) {
        // Demoted on a writing screen (a take-over landed): drain accepted verdicts (flushNow is never
        // gated), then drop to the now-read-only board rather than silently keep a writing UI up.
        verdictWriter.flushNow();
        renderBoard();
      } else {
        rerenderCurrent();
      }
    }
    function rerenderCurrent() {
      var screen = view.screen;
      if (screen.kind === "board") renderBoard();
      else if (screen.kind === "label") renderLabel(screen);
    }

    // ---- rendering --------------------------------------------------------------------------------
    // Cast to non-null: calibration-boot.js calls create() from the end of <body>, so
    // #app/#banner exist; tests that only drive the I/O layer never render.
    var appEl = /** @type {HTMLElement} */ (typeof document !== "undefined" ? document.getElementById("app") : null);
    var bannerEl = /** @type {HTMLElement} */ (typeof document !== "undefined" ? document.getElementById("banner") : null);

    // A calm, positive activity indicator for NORMAL background writes — distinct from the amber failure
    // banner. Two independent sources feed it so a background slot-claim (optimistic open) and a verdict
    // batch can be in flight at once without clobbering each other's text: `verdictSaving` tracks a
    // verdict flush, `claimingCount` the open-claims. Display priority Saving… > Claiming… > ✓ Saved —
    // the reviewer's own data save wins the label; a claim that lands just goes quiet (no tick). Both
    // busy states use the `saving` class so the animated glyph applies to each. Never shows an error.
    var saveIndicatorEl = /** @type {HTMLElement} */ (typeof document !== "undefined" ? document.getElementById("save-indicator") : null);
    var verdictSaving = false; // a verdict batch is in flight
    var claimingCount = 0;     // background slot-claims in flight (optimistic open)
    var showSaved = false;     // transient "✓ Saved" tick after a verdict batch lands
    /** @type {ReturnType<typeof setTimeout>|null} */ var savedTimer = null;
    // Collapse the three independent sources into ONE display state (exactly one is shown), so the
    // precedence lives in a single place instead of being hand-encoded in both the class and the text.
    /** @returns {"saving"|"claiming"|"saved"|"idle"} */
    function saveIndicatorState() {
      if (verdictSaving) return "saving";     // the reviewer's own data save wins the label
      if (claimingCount > 0) return "claiming";
      if (showSaved) return "saved";
      return "idle";
    }
    function renderSaveIndicator() {
      if (!saveIndicatorEl) return;
      var s = saveIndicatorState();
      // "claiming" reuses the animated `saving` class (same glyph); the label distinguishes the two.
      saveIndicatorEl.className = "save-indicator " + (s === "claiming" ? "saving" : s);
      saveIndicatorEl.textContent = s === "saving" ? "Saving…" : s === "claiming" ? "Claiming…" : s === "saved" ? "✓ Saved" : "";
    }
    function markSaving() {
      if (savedTimer) { clearTimeout(savedTimer); savedTimer = null; }
      showSaved = false;
      if (!verdictSaving) { verdictSaving = true; renderSaveIndicator(); }
    }
    function markSaved() {
      verdictSaving = false; showSaved = true; renderSaveIndicator();
      if (savedTimer) clearTimeout(savedTimer);
      savedTimer = setTimeout(function () { showSaved = false; renderSaveIndicator(); }, 1500);
    }
    function beginClaiming() { claimingCount += 1; renderSaveIndicator(); }
    function endClaiming() { claimingCount = Math.max(0, claimingCount - 1); renderSaveIndicator(); }

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

    function refreshState() { return withState(function () { return null; }).then(function () { return state; }); } // null → no write; withState adopts the fetch into `state`

    function renderRoster() {
      view.screen = { kind: "roster" };
      appEl.textContent = "";
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
          return r.state;
        }).then(function (res) {
          if (res.ok) setReviewer(name, false); // brand-new registration → show the one-time tutorial
        }).catch(function (/** @type {unknown} */ e) { reportSyncFailure(e); });
      });
      card.appendChild(input); card.appendChild(add);
      appEl.appendChild(card);
    }

    // Start (or resume) intra-browser election + derive the initial mode for the current reviewer.
    function startSession() { if (!authFailed) manageLock(); recomputeMode(); }

    /** @param {string} name @param {boolean} isResume - true when picking an EXISTING roster name (returning
     *  reviewer → skip the tutorial); false for a brand-new registration (show it once). Onboarding-done is
     *  thus tied to roster membership (durable, cross-browser), not a per-browser localStorage flag. */
    function setReviewer(name, isResume) {
      reviewer = name;
      if (LS) LS.setItem(REVIEWER_KEY, name);
      startSession();
      if (isResume) renderBoard();
      else renderPractice(0);
    }

    /** @param {number} i */
    function renderPractice(i) {
      view.screen = { kind: "practice" };
      appEl.textContent = "";
      appEl.appendChild(el("div", "practice-note", "Practice — these are examples with the answer shown, to learn the task. They are not scored."));
      const item = PRACTICE[i]; // const so the not-undefined narrowing below persists into the closures
      if (i >= PRACTICE.length || !item) { renderBoard(); return; } // finished onboarding → the board (roster membership records it)
      var main = el("div", null); appEl.appendChild(main);
      /** @type {string|null} */
      var pending = null; // a first-step answer awaiting its follow-up (the two-step choice)
      /** @type {Partition|null} */
      var draft = null; // a partition item's answer in the making
      /** @type {string|null} */
      var draftMember = null;
      var render = function (/** @type {Decided|null} */ decided) {
        W.renderReviewItem(document, main, item, decided, CONFIG, {
          reveal: true, pending: pending, draft: draft, focusMember: draftMember, position: i + 1, total: PRACTICE.length,
          // the reveal shows the reviewer's own answer against the practice item's machine answer
          onChoose: function (/** @type {string} */ verdict, /** @type {string|null} */ detail, /** @type {Partition|undefined} */ partition) {
            pending = null; draft = null; draftMember = null;
            render(decidedOf(verdict, detail, partition));
          },
          onPending: function (/** @type {string|null} */ verdict) { pending = verdict; render(decided); },
          onDraft: function (/** @type {Partition} */ next, /** @type {string} */ memberId) { draft = next; draftMember = memberId; render(decided); },
          onNext: function () { renderPractice(i + 1); }, onPrev: function () { renderPractice(Math.max(0, i - 1)); },
        });
      };
      render(null);
    }

    function renderBoard() {
      view.screen = { kind: "board" };
      verdictWriter.flushNow(); // don't strand queued verdicts when leaving a bucket (never gated)
      appEl.textContent = "";
      var now = Date.now();
      var heading = el("h2", null, "Buckets — " + reviewer);
      heading.setAttribute("tabindex", "-1"); // focus target after a take-over so keyboard/SR users land here
      appEl.appendChild(heading);
      var bar = el("div", "board-actions");
      var refresh = button("Refresh", function () { refreshState().then(function () { recomputeMode(); renderBoard(); }).catch(function (/** @type {unknown} */ e) { reportSyncFailure(e); }); });
      refresh.className = "secondary"; bar.appendChild(refresh);
      var sum = button("Progress summary", showSummary); sum.className = "secondary"; bar.appendChild(sum);
      // (A passive session's "Make this the active session" lives in the banner, next to the explanation
      // of why the page is read-only — see renderBanner — so it's available on every screen.)
      appEl.appendChild(bar);
      if (pendingBoardFocus) { pendingBoardFocus = false; heading.focus(); } // land focus on the board after a take-over
      var grid = el("div", "board");
      BUCKETS.forEach(function (b) {
        var st = C.bucketStatus(state.buckets[b.bucket_id], b.confirmations_required, reviewer, now, undefined, b.excluded_reviewers);
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
        var tag = st.state === "excluded" ? "not open to you"
          : st.done ? "confirmed"
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
      appEl.appendChild(grid);
      var exp = button("Export my verdicts", exportLocal); exp.className = "secondary"; appEl.appendChild(exp);
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
      Object.entries(s.perStratum).sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; }).forEach(function (entry) {
        var k = entry[0], ps = entry[1];
        strata.appendChild(el("div", "sum-row", k + " — " + ps.complete + " / " + ps.total + " buckets confirmed"));
      });
      modal.appendChild(strata);
      var table = el("table", "sum-table");
      var head = el("tr");
      ["Reviewer", "Done", "In progress", "Items"].forEach(function (h) { head.appendChild(el("th", null, h)); });
      table.appendChild(head);
      s.perReviewer.forEach(function (r) {
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
      if (view.screen.kind !== "board" || authFailed) return;
      refreshState().then(function () { if (view.screen.kind === "board") { recomputeMode(); renderBoard(); } }).catch(function () { /* manual Refresh is the fallback */ });
    }
    function startAutoRefresh() {
      if (typeof window === "undefined") return;
      setInterval(pollBoard, AUTO_REFRESH_MS);
      if (typeof document !== "undefined" && document.addEventListener) {
        document.addEventListener("visibilitychange", function () { if (!document.hidden) { recomputeMode(); pollBoard(); } });
        // A page restored from the bfcache is a fresh document but keeps its session; re-FETCH then
        // re-derive so a take-over that happened while it was frozen (visible only server-side) is
        // reflected — recomputeMode alone reads stale in-memory state. It also re-elects the Web Lock,
        // which pagehide released when the page was frozen (below).
        window.addEventListener("pageshow", function (e) {
          if (!e || !e.persisted) return;
          if (reviewer && !authFailed) manageLock(); // re-acquire the lock we released on pagehide-into-bfcache
          refreshState().then(recomputeMode).catch(function () {});
        });
        // On hide/close/reload: flush buffered verdicts (the debounce window is otherwise up to ~700ms),
        // and RELEASE the Web Lock so the next document (a reload) elects without seeing this dying tab
        // as a foreign holder — the false "another tab is active" banner. A bfcache restore re-elects
        // via pageshow above.
        document.addEventListener("pagehide", function () { verdictWriter.flushNow(); releaseLock(); });
      }
    }

    // Compose a coordination write with a presence-ts bump in ONE state.json mutation, over freshly-
    // fetched state. Declines (returns null → no write) when a live FOREIGN session holds the name — so
    // the gate is ATOMIC with the write (a demoted session's stale cached `mode` can't leak a write; the
    // CAS retry makes a loser refetch and decline here) — or when the primary claim/complete itself
    // declines (full bucket / at-capacity). Pure over args.
    /** @param {CoordState} s @param {Bucket} b @param {string} rev @param {string} sid @param {number} now @returns {CoordState|null} */
    function claimWithPresence(s, b, rev, sid, now) {
      if (C.sessionHeldByOther(s, rev, sid, now)) return null; // a live foreign session owns this name — decline the whole write
      var r = C.claim(s, b.bucket_id, b.confirmations_required, rev, now, undefined, b.excluded_reviewers);
      if (!r.ok) return null;
      return C.refreshSession(r.state, rev, sid, now);
    }
    /** @param {CoordState} s @param {Bucket} b @param {string} rev @param {string} sid @param {number} now @returns {CoordState|null} */
    function completeWithPresence(s, b, rev, sid, now) {
      if (C.sessionHeldByOther(s, rev, sid, now)) return null; // as above — a foreign active session declines the completion
      var r = C.complete(s, b.bucket_id, rev, b.confirmations_required);
      if (!r.ok) return null;
      return C.refreshSession(r.state, rev, sid, now);
    }

    var openGeneration = 0; // a later openBucket supersedes an earlier in-flight one (the reviewer went Back + re-opened)
    /** @param {Bucket} b */
    function openBucket(b) {
      if (!isActive()) { renderBoard(); return; } // auth/passive/electing can't claim — the board is the path forward
      // Optimistic: opening a bucket is navigation, not a sync step. Show the review screen immediately;
      // the slot claim is a soft reservation that runs in the background (surfaced by the calm "Claiming…"
      // indicator). Verdicts save through their own writer regardless of the claim, and the completion cap
      // (C.complete) — not the claim — is what keeps surplus confirmations out of the analysis, so a slow
      // or failed claim never costs the reviewer their place.
      var gen = ++openGeneration; // the "← Back to buckets" button is live during the claim, so a second open can race this one
      /** @type {LabelScreen} */
      var screen = { kind: "label", bucket: b, idx: 0, notice: null, noticeAnnounced: false, pending: null, draftMember: null };
      renderLabel(screen);
      beginClaiming();
      withState(function (s) {
        return claimWithPresence(s, b, reviewer, SESSION_ID, Date.now()); // null → declined (full bucket, or a live foreign session holds the name)
      }).then(function (res) {
        if (gen !== openGeneration) return; // a newer open supersedes this: its stale state/notice must not land
        recomputeMode();                    // withState already adopted the fresh state (new on claim, fetched on decline); demotes to the read-only board if a take-over landed
        // Still active after a decline ⇒ the cause was a FULL bucket, not a take-over. Split/disposition
        // buckets need only one reviewer, so two reviewers opening the same one is an ordinary race. Keep
        // the reviewer on the screen (no bounce), but tell them their answers here may not be needed.
        if (res.declined && isActive() && view.screen === screen) {
          screen.notice = "Someone else is already reviewing this bucket — your answers here may not be needed. Pick another from the board when you're ready.";
          renderLabel(screen);
        }
      }, function (/** @type {unknown} */ e) {
        if (gen !== openGeneration) return; // stale failure of a superseded open
        // A failed claim is NOT a verdict-sync failure: nothing is unsaved and nothing retries a claim, so
        // the amber verdict banner would be a lie. A genuine AUTH failure, though, must flip the page
        // read-only — markAuthFailed alone only repaints the banner; recomputeMode re-derives `mode`
        // (→ read-only) and bounces off the writing screen (mirrors writePresence).
        if (isAuthError(e)) { markAuthFailed(); recomputeMode(); }
        else if (typeof console !== "undefined") console.warn("calibration: bucket claim did not land (labeling continues):", e);
      }).catch(function (/** @type {unknown} */ err) {
        // A resolution handler itself threw (a render bug) — surface it; two-arg then above means this
        // catch never sees the claim's own rejection, so it can't masquerade as a claim failure.
        if (typeof console !== "undefined") console.error("calibration: openBucket handler error:", err);
      }).finally(function () {
        endClaiming(); // exactly once per beginClaiming, whichever branch ran or threw
      });
    }

    // A choice confirms ON the chosen button (where the reviewer's eyes are), then advances after a short
    // beat, rather than swapping the card instantly. `choiceLocked` covers that beat so a second keypress
    // can't act on the current item twice or race the pending advance — extra presses during the ~150ms
    // window are ignored (a human reviewing can't out-pace it; a key-masher's spare presses are dropped,
    // never mis-assigned). Research puts ~150ms at the boundary where a state change reads as responsive.
    var CHOICE_ADVANCE_MS = 160;
    var choiceLocked = false;

    // Paint the chosen button into its selected state in place + a one-shot press animation, so the
    // confirmation lands on the button the reviewer just hit (click or keyboard) — the SAME navy selected
    // state they see when navigating back, so there's no separate visual vocabulary to learn. A
    // follow-up answer's button carries data-detail; a one-step answer's carries data-verdict.
    /** @param {string} verdict @param {string|null} detail */
    function flashChosen(verdict, detail) {
      if (typeof document === "undefined") return;
      var card = appEl.querySelector(".card");
      if (!card) return;
      var attr = detail != null ? "data-detail" : "data-verdict";
      var v = detail != null ? detail : verdict;
      var sel = "[" + attr + '="' + (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(v) : v) + '"]';
      var btn = card.querySelector(sel);
      if (btn) btn.classList.add("primary", "just-picked");
    }

    // Advance/retreat, gated by the confirm beat so a nav action can't race a pending choice-advance.
    /** @param {LabelScreen} screen */
    function resetItemState(screen) { screen.pending = null; screen.draftMember = null; }
    /** @param {LabelScreen} screen */
    function goNext(screen) { if (choiceLocked) return; screen.idx += 1; resetItemState(screen); renderLabel(screen); }
    /** @param {LabelScreen} screen */
    function goPrev(screen) { if (choiceLocked) return; screen.idx = Math.max(0, screen.idx - 1); resetItemState(screen); renderLabel(screen); }

    // A partition item's reviewer changed a member's selector: keep the new draft for that item and
    // focus that selector. During the confirm beat the draft is kept and the card is left as it is.
    /** @param {LabelScreen} screen @param {ReviewItem} it the item shown @param {Partition} draft @param {string} memberId */
    function changeDraft(screen, it, draft, memberId) {
      view.drafts[it.item_id] = draft;
      screen.draftMember = memberId;
      if (!choiceLocked) renderLabel(screen);
    }

    // The first step of a two-step choice: show the follow-up question for `verdict` (or, for null,
    // return to the first step). Nothing is recorded until the follow-up answer commits.
    /** @param {LabelScreen} screen @param {string|null} verdict */
    function choosePending(screen, verdict) {
      if (choiceLocked) return;
      screen.pending = verdict;
      renderLabel(screen);
    }

    // One place both the click and the keydown paths commit an answer + advance.
    /** @param {LabelScreen} screen @param {ReviewItem} it the item shown @param {string} verdict @param {string|null} detail @param {Partition} [partition] */
    function chooseAndAdvance(screen, it, verdict, detail, partition) {
      if (choiceLocked) return; // mid-confirm beat — ignore extra presses (see CHOICE_ADVANCE_MS)
      var decided = decidedOf(verdict, detail, partition);
      view.localVerdicts[it.item_id] = decided;
      delete view.drafts[it.item_id]; // the committed answer is the item's state now
      resetItemState(screen);
      delete view.unsaved[it.item_id];
      if (isActive()) { verdictWriter.queue(screen.bucket.bucket_id, reviewer, it.item_id, decided); markSaving(); } // gated: only the active session auto-saves
      flashChosen(verdict, detail); // confirm on the button…
      choiceLocked = true;
      setTimeout(function () { // …then advance — unless the reviewer left this labeling session during the beat
        choiceLocked = false;
        // Bail unless this session's screen is still the one shown: Back or completion replaces it, and a
        // Back → re-open of the SAME bucket opens a new one at idx 0, so a stale timer never advances it.
        if (view.screen !== screen) return;
        screen.idx += 1;
        renderLabel(screen);
      }, CHOICE_ADVANCE_MS);
    }

    // Whether the page still shows the completion of `bucket`.
    /** @param {Bucket} bucket @returns {boolean} */
    function completingOn(bucket) { return view.screen.kind === "completing" && view.screen.bucket === bucket; }

    /** @param {LabelScreen} screen */
    function renderLabel(screen) {
      view.screen = screen;
      var bucket = screen.bucket;
      var items = scaffoldsFor(bucket);
      const it = items[screen.idx]; // const so the not-undefined narrowing below persists into the widget's closures
      appEl.textContent = "";
      appEl.appendChild(button("← Back to buckets", function () { renderBoard(); }));
      if (screen.idx >= items.length || !it) {
        if (isActive()) {
          // Completion targets `bucket`: the flush below can take seconds (its own retries), and the
          // reviewer can click "Back" and open another bucket meanwhile — completion must target the
          // bucket they actually finished, never whichever bucket the page shows by then.
          view.screen = { kind: "completing", bucket: bucket }; // silences the keydown handler so no relabel slips into pending mid-flush
          var saving = status("Saving your verdicts…");
          var prog = el("div", "progress indeterminate");
          prog.setAttribute("role", "progressbar"); prog.setAttribute("aria-label", "Saving verdicts"); // indeterminate: no aria-valuenow
          prog.appendChild(el("div", "bar")); saving.appendChild(prog);
          appEl.appendChild(saving);
          // The flush is a network round-trip of unknown length, so the bar is indeterminate (honest) —
          // after a few seconds, reassure rather than fake a percentage.
          var slow = setTimeout(function () {
            if (completingOn(bucket)) saving.appendChild(el("div", "muted", "Taking longer than usual — your answers are safe, still saving."));
          }, 4000);
          verdictWriter.flushNow().then(function () {
            clearTimeout(slow);
            var stillHere = completingOn(bucket);
            var failed = scaffoldsFor(bucket).some(function (it) { return view.unsaved[it.item_id]; });
            if (failed) {
              if (stillHere) {
                appEl.textContent = "";
                appEl.appendChild(button("← Back to buckets", function () { renderBoard(); }));
                appEl.appendChild(status("Some verdicts didn't save. Re-open the bucket to retry, or Export as a backup — this bucket is NOT marked complete."));
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
      if (screen.notice) {
        // renderLabel rebuilds #app on every item advance, so announce the notice ONCE (role=status ⇒
        // aria-live=polite on the render right after the decline) — re-adding role each rebuild would
        // re-read it aloud on every item. Same one-shot discipline as renderBanner's lastBannerSig.
        var noticeEl = el("div", "notice", screen.notice); // calm, non-blocking (e.g. a full-bucket claim race)
        if (!screen.noticeAnnounced) { noticeEl.setAttribute("role", "status"); screen.noticeAnnounced = true; }
        appEl.appendChild(noticeEl);
      }
      var main = el("div", null); appEl.appendChild(main);
      // scored items are BLIND — reveal:false, no machine answer shown, ever.
      W.renderReviewItem(document, main, it, (view.localVerdicts[it.item_id] || null), CONFIG, {
        reveal: false, pending: screen.pending, draft: view.drafts[it.item_id] || null, focusMember: screen.draftMember,
        position: screen.idx + 1, total: items.length,
        onChoose: function (verdict, detail, partition) { chooseAndAdvance(screen, it, verdict, detail, partition); },
        onPending: function (verdict) { choosePending(screen, verdict); },
        onDraft: function (draft, memberId) { changeDraft(screen, it, draft, memberId); },
        onNext: function () { goNext(screen); },
        onPrev: function () { goPrev(screen); },
      });
    }

    // Mark a specific finished bucket complete (all its verdicts confirmed landed). Takes the bucket
    // explicitly — never the shown screen's — because it runs after an async flush the reviewer may have
    // navigated away from. DOM writes are guarded on the reviewer still viewing this completion screen,
    // so a stale resolution can't paint over the bucket they moved on to.
    /** @param {Bucket} bucket */
    function markBucketComplete(bucket) {
      function onThisScreen() { return completingOn(bucket); }
      withState(function (s) {
        return completeWithPresence(s, bucket, reviewer, SESSION_ID, Date.now()); // null → already at capacity via others; withState writes nothing
      }).then(function (res) {
        recomputeMode(); // withState already adopted the fresh state (new on completion, fetched on decline) — so this and the "Review next" suggestion below read current state, and a take-over demotes to read-only
        if (!onThisScreen()) return; // reviewer moved on — state is updated, but don't clobber their screen
        appEl.textContent = "";
        // The next reviewable bucket, if any — offered so a reviewer working through several doesn't detour
        // via the board each time. Shown only when one remains (gate + selector mirror the board's openable
        // rule); on the last bucket, only "Back to buckets" appears. Computed first so the message can adapt.
        const nxt = isActive() ? C.nextOpenBucket(BUCKETS, state, reviewer, Date.now(), bucket.bucket_id) : null; // const: its narrowing reaches the button's closure
        appEl.appendChild(status(res.declined
          ? "This bucket was already completed by enough other reviewers while you were away — your answers are saved but it needed no more."
          : nxt ? "Bucket complete. Thank you!" : "Bucket complete. Thank you! Pick another from the board."));
        // Actions sit centred BELOW the confirmation, reading as "done → what next", not floated in a corner.
        var actions = el("div", "done-actions");
        actions.appendChild(button("← Back to buckets", function () { renderBoard(); }));
        if (nxt) {
          var nextBtn = button("Review next →", function () { openBucket(nxt); });
          nextBtn.className = "primary";
          actions.appendChild(nextBtn);
        }
        appEl.appendChild(actions);
      }).catch(function (/** @type {unknown} */ e) {
        reportSyncFailure(e);
        if (onThisScreen()) appEl.appendChild(status("Your answers are saved, but marking the bucket complete failed — click Refresh on the board and it will reconcile."));
      });
    }

    function exportLocal() {
      /** @type {{tool:string, version:number, reviewer:string, exported:string, decisions:Record<string, VerdictCell>}} */
      var out = { tool: "calibration-review", version: 1, reviewer: reviewer,
        exported: new Date().toISOString(), decisions: {} };
      Object.keys(view.localVerdicts).forEach(function (id) {
        var d = view.localVerdicts[id];
        if (d) out.decisions[id] = verdictCell(d, Date.now());
      });
      var blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a"); a.href = url;
      a.download = "calibration_decisions_" + (reviewer || "anon") + ".json"; a.click();
      URL.revokeObjectURL(url); // release immediately — the download was handed off synchronously
    }

    // ---- helpers ----------------------------------------------------------------------------------
    /** @param {string} tag @param {string|null} [cls] @param {string} [text] @returns {HTMLElement} */
    function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
    /** @param {string} label @param {(this:GlobalEventHandlers, ev:MouseEvent)=>void} onclick @returns {HTMLButtonElement} */
    function button(label, onclick) { var b = document.createElement("button"); b.textContent = label; b.onclick = onclick; return b; }
    // A transient status message that assistive tech announces (role=status ⇒ implicit aria-live=polite).
    // Used for the completion flush ("Saving your verdicts…") and bucket-complete messages, painted into
    // #app (not a live region).
    /** @param {string} text @returns {HTMLElement} */
    function status(text) { var e = el("div", "done", text); e.setAttribute("role", "status"); return e; }

    var listeningKeys = false;
    function listenKeys() {
      if (listeningKeys || typeof document === "undefined") return; // once per instance, however often boot() runs
      listeningKeys = true;
      document.addEventListener("keydown", function (e) {
        if (view.screen.kind === "label") labelKeydown(e, view.screen);
      });
    }
    /** @param {KeyboardEvent} e @param {LabelScreen} screen */
    function labelKeydown(e, screen) {
      // Past the bucket's last item there is no live item (the completion screen is on its way):
      // navigation keys still move, and no choice key reaches an item.
      const it = scaffoldsFor(screen.bucket)[screen.idx]; // const: its narrowing reaches the choice closures
      var nav = { config: CONFIG, pending: screen.pending, onNext: function () { goNext(screen); }, onPrev: function () { goPrev(screen); } };
      W.reviewItemKeydown(e, it
        ? Object.assign(nav, {
          item: it,
          onChoose: function (/** @type {string} */ verdict, /** @type {string|null} */ detail) { chooseAndAdvance(screen, it, verdict, detail); },
          onPending: function (/** @type {string|null} */ verdict) { choosePending(screen, verdict); },
        })
        : Object.assign(nav, { item: null }));
    }

    // ---- GitHub identity ------------------------------------------------------------------------
    // The token's own login, as a validated reviewer name. Throws a typed error (AUTH on 401/403).
    /** @returns {Promise<string>} */
    function ghLogin() {
      /** @type {RequestInit} */
      var opts = { cache: "no-store", headers: { Authorization: "Bearer " + TOKEN, Accept: "application/vnd.github+json" } };
      var sig = timeoutSignal(); if (sig) opts.signal = sig;
      return fetch(USER_API, opts).catch(function (/** @type {unknown} */ e) {
        throw makeErr("RETRYABLE", 0, "network: " + messageOf(e));
      }).then(function (r) {
        if (!r.ok) throw makeErr(C.classifyError(r.status), r.status, "GET /user → " + r.status);
        return r.json().then(function (/** @type {unknown} */ j) { return parseGhUser(j, r.status); });
      }).then(function (user) {
        var v = C.validateReviewerName(user.login);
        if (!v.ok) throw makeErr("OTHER", 0, "the token's GitHub login is not a usable reviewer name: " + v.reason);
        return v.name;
      });
    }

    // Take the token's login as the reviewer, registering it into the roster on first visit. Resolves
    // true when the login was not yet registered (a first visit, which shows the practice set), false
    // otherwise — including a token GitHub refuses, which leaves the page read-only.
    /** @returns {Promise<boolean>} */
    function resolveGitHubReviewer() {
      return retryWithBackoff(ghLogin, MAX_TRIES).then(function (login) {
        var known = (state.roster || []).indexOf(login) !== -1;
        var registered = known ? Promise.resolve(null) : withState(function (s) {
          if ((s.roster || []).indexOf(login) !== -1) return null; // registered meanwhile, from another device
          var r = C.registerName(s, login);
          return r.ok ? r.state : null;
        });
        return registered.then(function () { reviewer = login; return !known; });
      }).catch(function (/** @type {unknown} */ e) {
        if (!isAuthError(e)) throw e;
        markAuthFailed();
        return false;
      });
    }

    // ---- boot -------------------------------------------------------------------------------------
    /** @param {string} url @returns {Promise<unknown>} */
    function fetchData(url) {
      return fetch(url).then(function (r) { if (!r.ok) throw new Error(url + " → " + r.status); return r.json(); });
    }

    // The page's items. An item no answer fits (a kind the config does not define, or an item its kind
    // cannot render) could not be answered: refuse the data set.
    /** @param {unknown} raw @returns {ReviewItem[]} */
    function parseScaffolds(raw) {
      if (!isList(raw)) throw new Error(DATA.scaffolds + " is not a list of items");
      var bad = raw.map(function (s) { return W.validateReviewItem(s, CONFIG); }).filter(function (r) { return !r.ok; });
      if (bad.length) throw new Error(bad.length + " item(s) cannot be answered, e.g. " + /** @type {{reason: string}} */ (bad[0]).reason);
      return /** @type {ReviewItem[]} */ (raw); // validateReviewItem has held each one to a ReviewItem
    }

    function boot() {
      listenKeys();
      renderBanner();
      if (!TOKEN) markAuthFailed();
      var firstVisit = false; // GitHub identity: the login was registered by this boot
      Promise.all([fetchData(DATA.scaffolds), fetchData(DATA.buckets), fetchData(DATA.manifest)]).then(function (res) {
        SCAFFOLDS = parseScaffolds(res[0]); BUCKETS = parseBuckets(res[1], DATA.buckets); MANIFEST = parseManifest(res[2], DATA.manifest);
        ITEMS = indexItems(SCAFFOLDS, BUCKETS, DATA.scaffolds);
        return authFailed ? null : refreshState().catch(function (/** @type {unknown} */ e) {
          // Coordination state failed to load — surface it and stop. An empty board would show every
          // bucket as available and invite double-claims, so a load failure must halt boot.
          reportSyncFailure(e);
          throw e;
        });
      }).then(function () {
        if (IDENTITY !== "github" || authFailed) return;
        return resolveGitHubReviewer().then(function (isNew) { firstVisit = isNew; });
      }).then(function () {
        if (authFailed && !reviewer) {
          appEl.appendChild(el("div", "muted", IDENTITY === "github"
            ? "Read-only: this page needs a link carrying your own GitHub access token. Open a fresh link to review."
            : "Read-only: this link is missing its access token. Open a fresh link to review."));
        }
        if (reviewer) startSession(); // resume: election + initial mode before first render
        // Onboarded ⇒ straight to the board; otherwise show the tutorial. A typed name is onboarded once
        // it is in the roster (the durable, cross-browser signal); a GitHub login on every visit after
        // the one that registered it.
        var onboarded = IDENTITY === "github" ? !firstVisit : (state.roster || []).indexOf(reviewer) !== -1;
        if (reviewer && onboarded) renderBoard();
        else if (reviewer) renderPractice(0);
        else if (IDENTITY === "typed") renderRoster();
        if (!authFailed) startAutoRefresh();
      }).catch(function (/** @type {unknown} */ e) {
        appEl.textContent = "";
        appEl.appendChild(el("div", "error", "Could not load calibration data: " + messageOf(e)));
        appEl.appendChild(button("Reload", function () { location.reload(); }));
      });
    }

    return {
      boot: boot,
      ghGet: ghGet,
      ghPut: ghPut,
      withState: withState,
      saveVerdicts: saveVerdicts,
      verdictPath: verdictPath,
      claimWithPresence: claimWithPresence,
      completeWithPresence: completeWithPresence,
      presenceMutation: presenceMutation,
    };
  }

  var api = { create: create, makeVerdictWriter: makeVerdictWriter };
  if (typeof module !== "undefined" && module.exports) module.exports = api; // tests build instances here
  else root.CalibrationApp = api; // browser global: calibration-boot.js calls create(...).boot()
})(typeof window !== "undefined" ? window : this);
