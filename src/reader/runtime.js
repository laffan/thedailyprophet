/*
 * The Daily Prophet — reader runtime.
 * Injected into the snapshot iframe (sandbox="allow-scripts", opaque origin).
 * Talks to the reader UI in the parent window exclusively via postMessage.
 * Must never contain a closing script tag literal.
 */
(function () {
  "use strict";
  if (window.__PROPHET_RUNTIME__) return;
  window.__PROPHET_RUNTIME__ = true;

  /* ---- shims: opaque origins throw on storage / history access -------- */
  function memoryStorage() {
    var m = new Map();
    return {
      get length() { return m.size; },
      key: function (i) { return Array.from(m.keys())[i] || null; },
      getItem: function (k) { return m.has(String(k)) ? m.get(String(k)) : null; },
      setItem: function (k, v) { m.set(String(k), String(v)); },
      removeItem: function (k) { m.delete(String(k)); },
      clear: function () { m.clear(); },
    };
  }
  ["localStorage", "sessionStorage"].forEach(function (name) {
    var broken = false;
    try { void window[name]; } catch (e) { broken = true; }
    if (broken) {
      try {
        Object.defineProperty(window, name, { value: memoryStorage(), configurable: true });
      } catch (e) { /* leave as-is */ }
    }
  });
  try {
    var origPush = history.pushState.bind(history);
    var origReplace = history.replaceState.bind(history);
    history.pushState = function () { try { return origPush.apply(null, arguments); } catch (e) {} };
    history.replaceState = function () { try { return origReplace.apply(null, arguments); } catch (e) {} };
  } catch (e) { /* ignore */ }

  /* ---- messaging ------------------------------------------------------ */
  function send(type, payload) {
    var msg = Object.assign({ __prophet: true, type: type }, payload || {});
    try { window.parent.postMessage(msg, "*"); } catch (e) {}
  }

  var COLORS = {
    sun: "rgba(245, 214, 99, 0.55)",
    rose: "rgba(244, 169, 184, 0.55)",
    mint: "rgba(168, 220, 196, 0.55)",
    sky: "rgba(169, 203, 238, 0.55)",
  };
  var BORDERS = {
    sun: "#d4af2f",
    rose: "#d4728c",
    mint: "#5fae8b",
    sky: "#6c98cf",
  };

  /* ---- scroll root ----------------------------------------------------- */
  var scrollRoot = null;
  var rootIsDocument = true;

  function findScrollRoot() {
    var de = document.scrollingElement || document.documentElement;
    if (de.scrollHeight > de.clientHeight + 100) {
      rootIsDocument = true;
      return de;
    }
    // Some pages scroll inside a fixed container; find the biggest one.
    var best = null;
    var bestH = 0;
    var all = document.querySelectorAll("div, main, section, article");
    var limit = Math.min(all.length, 4000);
    var minVh = window.innerHeight * 0.5;
    for (var i = 0; i < limit; i++) {
      var n = all[i];
      if (n.clientHeight < minVh) continue;
      if (n.scrollHeight <= n.clientHeight + 100) continue;
      var oy;
      try { oy = getComputedStyle(n).overflowY; } catch (e) { continue; }
      if (oy !== "auto" && oy !== "scroll") continue;
      if (n.scrollHeight > bestH) { bestH = n.scrollHeight; best = n; }
    }
    if (best) {
      rootIsDocument = false;
      return best;
    }
    rootIsDocument = true;
    return de;
  }

  function metrics() {
    var r = scrollRoot;
    var max = Math.max(1, r.scrollHeight - r.clientHeight);
    return {
      y: r.scrollTop,
      ratio: Math.min(1, Math.max(0, r.scrollTop / max)),
      docHeight: r.scrollHeight,
      viewport: r.clientHeight,
    };
  }

  function scrollTo(y, smooth) {
    try {
      scrollRoot.scrollTo({ top: y, behavior: smooth ? "smooth" : "auto" });
    } catch (e) {
      scrollRoot.scrollTop = y;
    }
  }

  /* ---- text index (normalized, whitespace-collapsed) ------------------- */
  var indexDirty = true;
  var textIndex = null; // { raw, norm, normToRaw:[...], records:[{node,start,end}] }

  function skippableParent(node) {
    var p = node.parentNode;
    while (p && p.nodeType === 1) {
      var t = p.nodeName;
      if (t === "SCRIPT" || t === "STYLE" || t === "NOSCRIPT" || t === "TEMPLATE") return true;
      p = p.parentNode;
    }
    return false;
  }

  function buildIndex() {
    var records = [];
    var raw = "";
    var walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, null);
    var node;
    while ((node = walker.nextNode())) {
      var v = node.nodeValue;
      if (!v) continue;
      if (skippableParent(node)) continue;
      records.push({ node: node, start: raw.length, end: raw.length + v.length });
      raw += v;
    }
    var norm = "";
    var normToRaw = [];
    var ws = false;
    for (var i = 0; i < raw.length; i++) {
      var c = raw[i];
      if (/\s/.test(c)) {
        if (!ws && norm.length) { norm += " "; normToRaw.push(i); }
        ws = true;
      } else {
        norm += c;
        normToRaw.push(i);
        ws = false;
      }
    }
    textIndex = { raw: raw, norm: norm, normToRaw: normToRaw, records: records };
    indexDirty = false;
  }

  function ensureIndex() {
    if (indexDirty || !textIndex) buildIndex();
  }

  function normalizeQuote(s) {
    return (s || "").replace(/\s+/g, " ").trim();
  }

  function posToNodeOffset(rawPos, preferEnd) {
    var rs = textIndex.records;
    var lo = 0, hi = rs.length - 1, best = null;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      var r = rs[mid];
      if (rawPos < r.start) hi = mid - 1;
      else if (rawPos > r.end) lo = mid + 1;
      else {
        best = r;
        if (rawPos === r.end && !preferEnd && mid + 1 < rs.length && rs[mid + 1].start === r.end) {
          best = rs[mid + 1];
        }
        break;
      }
    }
    if (!best) best = rawPos <= 0 ? rs[0] : rs[rs.length - 1];
    if (!best) return null;
    var off = Math.min(best.node.nodeValue.length, Math.max(0, rawPos - best.start));
    return { node: best.node, offset: off };
  }

  function scoreContext(hay, pos, prefix, suffix) {
    var score = 0;
    if (prefix) {
      var start = Math.max(0, pos - prefix.length);
      var before = hay.slice(start, pos);
      var i = prefix.length - 1, j = before.length - 1;
      while (i >= 0 && j >= 0 && prefix[i] === before[j]) { score++; i--; j--; }
    }
    if (suffix) {
      var after = hay.slice(pos, pos + suffix.length);
      var k = 0;
      while (k < suffix.length && k < after.length && suffix[k] === after[k]) { score++; k++; }
    }
    return score;
  }

  /** Find a quote in the document; returns a Range or null. */
  function findQuote(exact, prefix, suffix) {
    ensureIndex();
    var nExact = normalizeQuote(exact);
    if (!nExact) return null;
    var nPrefix = normalizeQuote(prefix);
    var nSuffix = normalizeQuote(suffix);
    var hay = textIndex.norm;
    var candidates = [];
    var from = 0;
    while (candidates.length < 64) {
      var idx = hay.indexOf(nExact, from);
      if (idx === -1) break;
      candidates.push(idx);
      from = idx + 1;
    }
    if (!candidates.length) return null;
    var best = candidates[0];
    if (candidates.length > 1) {
      var bestScore = -1;
      for (var i = 0; i < candidates.length; i++) {
        var s = scoreContext(hay, candidates[i], nPrefix, "") +
          scoreContext(hay, candidates[i] + nExact.length, "", nSuffix);
        if (s > bestScore) { bestScore = s; best = candidates[i]; }
      }
    }
    var rawStart = textIndex.normToRaw[best];
    var lastNormIdx = best + nExact.length - 1;
    var rawEnd = textIndex.normToRaw[lastNormIdx] + 1;
    var a = posToNodeOffset(rawStart, false);
    var b = posToNodeOffset(rawEnd, true);
    if (!a || !b) return null;
    var range = document.createRange();
    try {
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
    } catch (e) {
      return null;
    }
    if (range.collapsed) return null;
    return range;
  }

  /* ---- highlight rendering --------------------------------------------- */
  function wrapRange(range, id, color) {
    var rootNode = range.commonAncestorContainer;
    if (rootNode.nodeType !== 1) rootNode = rootNode.parentNode;
    var walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT, null);
    var targets = [];
    var n;
    while ((n = walker.nextNode())) {
      if (!range.intersectsNode(n)) continue;
      if (skippableParent(n)) continue;
      targets.push(n);
    }
    var made = 0;
    for (var i = 0; i < targets.length; i++) {
      var t = targets[i];
      var start = t === range.startContainer ? range.startOffset : 0;
      var end = t === range.endContainer ? range.endOffset : t.nodeValue.length;
      if (end <= start) continue;
      var piece = t;
      if (start > 0) piece = t.splitText(start);
      if (end - start < piece.nodeValue.length) piece.splitText(end - start);
      var mark = document.createElement("mark");
      mark.setAttribute("data-prophet-hl", id);
      mark.setAttribute("data-prophet-color", color);
      mark.style.backgroundColor = COLORS[color] || COLORS.sun;
      mark.style.borderBottom = "2px solid " + (BORDERS[color] || BORDERS.sun);
      mark.style.color = "inherit";
      mark.style.padding = "0";
      mark.style.cursor = "pointer";
      piece.parentNode.insertBefore(mark, piece);
      mark.appendChild(piece);
      made++;
    }
    indexDirty = true;
    return made > 0;
  }

  function unwrapHighlight(id) {
    var marks = document.querySelectorAll('mark[data-prophet-hl="' + cssEscape(id) + '"]');
    for (var i = 0; i < marks.length; i++) {
      var m = marks[i];
      var parent = m.parentNode;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
      try { parent.normalize(); } catch (e) {}
    }
    indexDirty = true;
    return marks.length > 0;
  }

  function recolorHighlight(id, color) {
    var marks = document.querySelectorAll('mark[data-prophet-hl="' + cssEscape(id) + '"]');
    for (var i = 0; i < marks.length; i++) {
      marks[i].style.backgroundColor = COLORS[color] || COLORS.sun;
      marks[i].style.borderBottom = "2px solid " + (BORDERS[color] || BORDERS.sun);
      marks[i].setAttribute("data-prophet-color", color);
    }
  }

  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, "");
  }

  function applyHighlight(hl) {
    if (document.querySelector('mark[data-prophet-hl="' + cssEscape(hl.id) + '"]')) return true;
    var range = findQuote(hl.exact, hl.prefix, hl.suffix);
    if (!range) return false;
    return wrapRange(range, hl.id, hl.color);
  }

  var knownHighlights = [];

  function applyAll(highlights) {
    knownHighlights = highlights || [];
    var applied = [];
    var orphaned = [];
    for (var i = 0; i < knownHighlights.length; i++) {
      var hl = knownHighlights[i];
      if (applyHighlight(hl)) applied.push(hl.id);
      else orphaned.push(hl.id);
    }
    send("highlights-applied", { applied: applied, orphaned: orphaned });
  }

  function flashHighlight(id) {
    var mark = document.querySelector('mark[data-prophet-hl="' + cssEscape(id) + '"]');
    if (!mark) return false;
    try { mark.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) { mark.scrollIntoView(); }
    var marks = document.querySelectorAll('mark[data-prophet-hl="' + cssEscape(id) + '"]');
    for (var i = 0; i < marks.length; i++) {
      (function (m) {
        var old = m.style.outline;
        m.style.outline = "2px solid rgba(180, 120, 30, 0.9)";
        setTimeout(function () { m.style.outline = old; }, 1400);
      })(marks[i]);
    }
    return true;
  }

  /* ---- selection -> quote ---------------------------------------------- */
  var CONTEXT_LEN = 40;

  function rawPosOfBoundary(container, offset) {
    ensureIndex();
    var rs = textIndex.records;
    if (container.nodeType === 3) {
      for (var i = 0; i < rs.length; i++) {
        if (rs[i].node === container) return rs[i].start + Math.min(offset, container.nodeValue.length);
      }
      return -1;
    }
    // Element boundary: use the first text node at/after the given child index.
    var probe = document.createRange();
    try {
      probe.setStart(container, offset);
      probe.setEnd(container, offset);
    } catch (e) {
      return -1;
    }
    for (var j = 0; j < rs.length; j++) {
      var r = document.createRange();
      r.selectNodeContents(rs[j].node);
      if (probe.compareBoundaryPoints(Range.START_TO_START, r) <= 0) return rs[j].start;
    }
    return textIndex.raw.length;
  }

  function quoteFromSelection(sel) {
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    var range = sel.getRangeAt(0);
    var exact = normalizeQuote(sel.toString());
    if (exact.length < 1 || exact.length > 6000) return null;
    var a = rawPosOfBoundary(range.startContainer, range.startOffset);
    var b = rawPosOfBoundary(range.endContainer, range.endOffset);
    if (a < 0 || b < 0 || b <= a) return { exact: exact, prefix: "", suffix: "" };
    var prefix = normalizeQuote(textIndex.raw.slice(Math.max(0, a - CONTEXT_LEN * 2), a)).slice(-CONTEXT_LEN);
    var suffix = normalizeQuote(textIndex.raw.slice(b, b + CONTEXT_LEN * 2)).slice(0, CONTEXT_LEN);
    return { exact: exact, prefix: prefix, suffix: suffix };
  }

  /* ---- bookmark context ------------------------------------------------ */
  function contextSnippet() {
    var headings = document.querySelectorAll("h1, h2, h3, h4");
    var lastAbove = null;
    for (var i = 0; i < headings.length; i++) {
      var rect = headings[i].getBoundingClientRect();
      if (rect.top <= 90) lastAbove = headings[i];
      else if (rect.top < window.innerHeight * 0.6 && !lastAbove) { lastAbove = headings[i]; break; }
      else if (rect.top > window.innerHeight) break;
    }
    var text = lastAbove ? lastAbove.textContent : "";
    if (!text || !text.trim()) {
      var ps = document.querySelectorAll("p");
      for (var j = 0; j < ps.length; j++) {
        var r = ps[j].getBoundingClientRect();
        if (r.top >= 0 && r.top < window.innerHeight * 0.7 && ps[j].textContent.trim().length > 20) {
          text = ps[j].textContent;
          break;
        }
      }
    }
    return normalizeQuote(text || "").slice(0, 80);
  }

  /* ---- event wiring ----------------------------------------------------- */
  var started = false;

  function start() {
    if (started) return;
    started = true;
    scrollRoot = findScrollRoot();

    var scrollTarget = rootIsDocument ? window : scrollRoot;
    var pending = false;
    scrollTarget.addEventListener("scroll", function () {
      if (pending) return;
      pending = true;
      requestAnimationFrame(function () {
        pending = false;
        send("scroll", metrics());
      });
    }, { passive: true });

    document.addEventListener("selectionchange", function () {
      var sel;
      try { sel = window.getSelection(); } catch (e) { return; }
      if (!sel || sel.isCollapsed) {
        send("selection-cleared", {});
      }
    });

    document.addEventListener("mouseup", function () {
      setTimeout(reportSelection, 10);
    });
    document.addEventListener("touchend", function () {
      setTimeout(reportSelection, 120);
    });

    document.addEventListener("click", function (e) {
      var mark = e.target && e.target.closest ? e.target.closest("mark[data-prophet-hl]") : null;
      if (mark) {
        var sel = window.getSelection();
        if (sel && !sel.isCollapsed) return; // selecting, not clicking
        e.preventDefault();
        e.stopPropagation();
        var rect = mark.getBoundingClientRect();
        send("highlight-clicked", {
          id: mark.getAttribute("data-prophet-hl"),
          color: mark.getAttribute("data-prophet-color"),
          rect: { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
        });
        return;
      }
      var link = e.target && e.target.closest ? e.target.closest("a[href]") : null;
      if (!link) return;
      var href = link.getAttribute("href") || "";
      if (href.charAt(0) === "#") {
        // In-page anchor: handle manually (srcdoc base URL quirks).
        e.preventDefault();
        var id = href.slice(1);
        var target = document.getElementById(id) || document.getElementsByName(id)[0];
        if (target) {
          try { target.scrollIntoView({ behavior: "smooth", block: "start" }); } catch (err) { target.scrollIntoView(); }
        }
        return;
      }
      if (/^https?:/i.test(href)) {
        e.preventDefault();
        send("external-link", { href: href });
        return;
      }
      // Anything else (javascript:, relative leftovers) — block navigation.
      e.preventDefault();
    }, true);

    var mo = new MutationObserver(function () { indexDirty = true; });
    try {
      mo.observe(document.body || document.documentElement, { childList: true, subtree: true, characterData: true });
    } catch (e) {}

    send("ready", metrics());

    // Interactive snapshots may keep laying out after load; report fresh heights.
    setTimeout(function () { send("doc-height", metrics()); }, 800);
    setTimeout(function () { send("doc-height", metrics()); }, 2500);
    // Late re-renders can wipe marks; re-apply anything missing.
    setTimeout(function () { if (knownHighlights.length) applyAll(knownHighlights); }, 2600);
  }

  function reportSelection() {
    var sel;
    try { sel = window.getSelection(); } catch (e) { return; }
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    if (sel.anchorNode && sel.anchorNode.parentElement &&
        sel.anchorNode.parentElement.closest("mark[data-prophet-hl]") &&
        sel.toString().length < 2) return;
    var quote = quoteFromSelection(sel);
    if (!quote || !quote.exact) return;
    var rect;
    try { rect = sel.getRangeAt(0).getBoundingClientRect(); } catch (e) { return; }
    send("selection", {
      exact: quote.exact,
      prefix: quote.prefix,
      suffix: quote.suffix,
      rect: { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
    });
  }

  var restoreState = null;
  var userScrolled = false;
  window.addEventListener("wheel", function () { userScrolled = true; }, { passive: true, capture: true });
  window.addEventListener("touchmove", function () { userScrolled = true; }, { passive: true, capture: true });

  function restoreScroll(state) {
    if (!state) return;
    var m = metrics();
    var y = state.scrollY || 0;
    if (state.docHeight && Math.abs(m.docHeight - state.docHeight) > state.docHeight * 0.02) {
      y = (state.scrollRatio || 0) * Math.max(0, m.docHeight - m.viewport);
    }
    scrollTo(y, false);
    // Late layout shifts (fonts, scripts) can move content under us; retry
    // unless the reader has taken over scrolling.
    [400, 1200].forEach(function (delay) {
      setTimeout(function () {
        if (userScrolled) return;
        var mm = metrics();
        var target = state.scrollY || 0;
        if (state.docHeight && Math.abs(mm.docHeight - state.docHeight) > state.docHeight * 0.02) {
          target = (state.scrollRatio || 0) * Math.max(0, mm.docHeight - mm.viewport);
        }
        if (Math.abs(mm.y - target) > 40) scrollTo(target, false);
      }, delay);
    });
  }

  window.addEventListener("message", function (e) {
    var d = e.data;
    if (!d || d.__prophet !== true) return;
    switch (d.type) {
      case "init":
        restoreState = d.state || null;
        applyAll(d.highlights || []);
        restoreScroll(restoreState);
        send("scroll", metrics());
        break;
      case "apply-highlight": {
        var hl = d.hl;
        var ok = applyHighlight(hl);
        if (ok) knownHighlights.push(hl);
        try { window.getSelection().removeAllRanges(); } catch (err) {}
        send("highlight-result", { id: hl.id, ok: ok });
        break;
      }
      case "remove-highlight":
        unwrapHighlight(d.id);
        knownHighlights = knownHighlights.filter(function (h) { return h.id !== d.id; });
        break;
      case "recolor-highlight":
        recolorHighlight(d.id, d.color);
        knownHighlights.forEach(function (h) { if (h.id === d.id) h.color = d.color; });
        break;
      case "scroll-to":
        userScrolled = true;
        if (typeof d.y === "number") scrollTo(d.y, d.smooth !== false);
        else if (typeof d.ratio === "number") {
          var m = metrics();
          scrollTo(d.ratio * Math.max(0, m.docHeight - m.viewport), d.smooth !== false);
        }
        break;
      case "scroll-to-highlight":
        userScrolled = true;
        if (!flashHighlight(d.id)) send("highlight-missing", { id: d.id });
        break;
      case "get-context":
        send("context", {
          reqId: d.reqId,
          snippet: contextSnippet(),
          y: metrics().y,
          ratio: metrics().ratio,
          docHeight: metrics().docHeight,
        });
        break;
      case "clear-selection":
        try { window.getSelection().removeAllRanges(); } catch (err) {}
        break;
    }
  });

  if (document.readyState === "complete" || document.readyState === "interactive") {
    setTimeout(start, 0);
  } else {
    document.addEventListener("DOMContentLoaded", function () { setTimeout(start, 0); });
  }
})();
