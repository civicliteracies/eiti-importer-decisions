/* Boots a review page from its JSON config.

   A review page is an HTML file that loads the four shared scripts — review-widget.js,
   calibration-core.js, calibration.js, then this one — and names its config in a meta tag:

     <meta name="calibration-config" content="importer-review-config.json">

   This script reads that URL (relative to the page, and on the page's own origin), fetches the config
   (no-store, so a republished config is picked up at once), resolves its dataUrls relative to the
   config's own URL, and calls CalibrationApp.create(options).boot(). The config is data, so a page
   needs no JS of its own. calibration.js's create() is the one validator of the options: whatever it
   refuses, like a missing meta tag, an unreachable or non-JSON config, is shown in #banner instead of
   failing silently.

   The module.exports guard is how the Node tests drive start() against a stubbed fetch; in the browser
   start() runs once on load. */

(function (/** @type {any} */ root) {
  "use strict";

  var META = 'meta[name="calibration-config"]';

  /**
   * The config's URL from the page's meta tag, resolved against the page and held to its origin.
   * Throws with a reader-facing message when the tag is missing or points elsewhere.
   * @param {Document} doc
   * @returns {URL}
   */
  function configUrl(doc) {
    var meta = /** @type {HTMLMetaElement|null} */ (doc.querySelector(META));
    var content = meta ? meta.content.trim() : "";
    if (!content) throw new Error("this page names no review config (" + META + " is missing or empty)");
    var page = new URL(doc.baseURI);
    var url = new URL(content, page);
    if (url.origin !== page.origin) throw new Error("the review config must be on this page's own origin, not " + url.origin);
    return url;
  }

  /**
   * The parsed config with its dataUrls made absolute against the config's own URL, so a config can
   * name its data files next to itself wherever the page that loads it lives. Every other field
   * passes through to CalibrationApp.create, which validates the whole shape.
   * @param {any} json
   * @param {URL} url - where the config was fetched from
   * @returns {any}
   */
  function resolveOptions(json, url) {
    if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("the review config is not a JSON object");
    var d = json.dataUrls;
    if (!d || typeof d !== "object") throw new Error("the review config has no dataUrls object");
    /** @type {Record<string, string>} */
    var resolved = {};
    ["scaffolds", "buckets", "manifest"].forEach(function (k) {
      if (typeof d[k] !== "string" || !d[k]) throw new Error("the review config's dataUrls." + k + " must be a non-empty string");
      resolved[k] = new URL(d[k], url).href;
    });
    var options = Object.assign({}, json);
    options.dataUrls = resolved;
    return options;
  }

  /** Show a boot failure where the page shows its other failures. @param {Document} doc @param {any} err */
  function report(doc, err) {
    var banner = doc.getElementById("banner");
    var text = "This review page could not start: " + (err && err.message ? err.message : String(err));
    if (banner) {
      banner.className = "banner error";
      banner.textContent = text;
    }
    if (typeof console !== "undefined") console.error("calibration-boot:", err);
  }

  /**
   * Read, resolve and boot the page's config. Resolves once the page has booted or the failure has
   * been reported; never rejects.
   * @param {Document} doc
   * @returns {Promise<void>}
   */
  function start(doc) {
    return Promise.resolve().then(function () {
      var url = configUrl(doc);
      return fetch(url.href, { cache: "no-store" }).then(function (r) {
        if (!r.ok) throw new Error("the review config " + url.pathname + " answered " + r.status);
        return r.json().catch(function () { throw new Error("the review config " + url.pathname + " is not valid JSON"); });
      }).then(function (json) {
        var app = root.CalibrationApp;
        if (!app || typeof app.create !== "function") throw new Error("calibration.js is not loaded before calibration-boot.js");
        app.create(resolveOptions(json, url)).boot();
      });
    }).catch(function (err) { report(doc, err); });
  }

  var api = { configUrl: configUrl, resolveOptions: resolveOptions, start: start };
  if (typeof module !== "undefined" && module.exports) module.exports = api; // tests drive start() here
  else start(document);
})(typeof window !== "undefined" ? window : this);
