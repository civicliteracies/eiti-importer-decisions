/* Pan/zoom for the inline dedup-pipeline DAG. First-party, zero-dependency — the same shape as the
   other published pages' scripts. It transforms the SVG's #stage-root via a transform *attribute*
   (not CSS), so it is safe under the mirror's strict CSP. Cursor↔diagram coordinate conversion uses
   the SVG's own screen CTM, so zoom-to-cursor and drag-pan stay exact at any fit. */
(function () {
  function ready(fn) {
    if (document.readyState !== "loading") fn();
    else document.addEventListener("DOMContentLoaded", fn);
  }

  ready(function () {
    var svg = document.getElementById("dag");
    var stage = document.getElementById("stage-root");
    var vp = document.getElementById("viewport");
    if (!svg || !stage || !vp) return;

    var s = 1, tx = 0, ty = 0;
    var MIN = 0.8, MAX = 8, VBW = 1360; // VBW = diagram viewBox width (see the generator)

    function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
    function apply() { stage.setAttribute("transform", "translate(" + tx + " " + ty + ") scale(" + s + ")"); }

    // client pixels → the SVG's own user (viewBox) coordinates. The root CTM is
    // unaffected by #stage-root's transform, so this mapping is stable mid-gesture.
    function toUser(clientX, clientY) {
      var m = svg.getScreenCTM();
      if (!m) return { x: clientX, y: clientY };
      var pt = svg.createSVGPoint();
      pt.x = clientX; pt.y = clientY;
      var p = pt.matrixTransform(m.inverse());
      return { x: p.x, y: p.y };
    }

    function zoomAt(clientX, clientY, factor) {
      var ns = clamp(s * factor, MIN, MAX);
      if (ns === s) return;
      var p = toUser(clientX, clientY);
      tx = p.x - (p.x - tx) * (ns / s);
      ty = p.y - (p.y - ty) * (ns / s);
      s = ns;
      apply();
    }

    function centerZoom(factor) {
      var r = vp.getBoundingClientRect();
      zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
    }

    // Reset view: fill the board width and top-align, so the richly-iconed nodes are legible at once
    // and the reader pans down through the pipeline. On very wide screens the fill scale is capped so
    // the nodes don't balloon; the diagram is then centred.
    function fit() {
      var m = svg.getScreenCTM();
      if (!m) { s = 1; tx = 0; ty = 0; apply(); return; }
      var r = vp.getBoundingClientRect();
      var pad = 26;
      var want = (r.width - 2 * pad) / (m.a * VBW);
      s = clamp(want, 1, 4.4);
      var contentW = m.a * VBW * s;
      tx = (r.left + (r.width - contentW) / 2 - m.e) / m.a;
      ty = (r.top + pad - m.f) / m.a;
      apply();
    }

    // wheel zooms toward the cursor and never scrolls the page over the graph
    vp.addEventListener("wheel", function (e) {
      if (e.deltaY === 0) return; // pure-horizontal scroll (trackpad swipe / shift+wheel): let it pass, don't zoom
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.12 : 1 / 1.12);
    }, { passive: false });

    // drag to pan; two fingers to pinch-zoom
    var pts = new Map(), pinch = 0;
    vp.addEventListener("pointerdown", function (e) {
      vp.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 1) vp.classList.add("grabbing");
    });
    vp.addEventListener("pointermove", function (e) {
      if (!pts.has(e.pointerId)) return;
      var prev = pts.get(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 1) {
        var a = toUser(prev.x, prev.y), b = toUser(e.clientX, e.clientY);
        tx += b.x - a.x; ty += b.y - a.y; apply();
      } else if (pts.size === 2) {
        var it = pts.values(), p1 = it.next().value, p2 = it.next().value;
        var d = Math.hypot(p1.x - p2.x, p1.y - p2.y);
        if (pinch) zoomAt((p1.x + p2.x) / 2, (p1.y + p2.y) / 2, d / pinch);
        pinch = d;
      }
    });
    function end(e) {
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = 0;
      if (!pts.size) vp.classList.remove("grabbing");
    }
    ["pointerup", "pointercancel", "lostpointercapture"].forEach(function (ev) {
      vp.addEventListener(ev, end);
    });
    vp.addEventListener("dblclick", function (e) { zoomAt(e.clientX, e.clientY, 1.5); });

    document.getElementById("zin").addEventListener("click", function () { centerZoom(1.25); });
    document.getElementById("zout").addEventListener("click", function () { centerZoom(0.8); });
    document.getElementById("zfit").addEventListener("click", fit);

    // staggered reveal — enhancement only; setting .style is CSSOM (allowed under the strict CSP),
    // and without this the nodes simply render (the CSS hides them only while #dag has .anim).
    var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduced) {
      svg.classList.add("anim");
      Array.prototype.forEach.call(svg.querySelectorAll(".node"), function (n, i) {
        n.style.animationDelay = (0.15 + i * 0.04) + "s";
        n.classList.add("in");
      });
    }

    fit();
  });
})();
