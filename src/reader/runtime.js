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

  /* Native mode: the document is served by the app's own URI scheme, so the
     browser loads scripts, styles, fonts, modules and XHR/fetch itself from
     the archive. None of the replay machinery below applies — the page runs
     exactly as it did online. Legacy single-file snapshots (about:srcdoc)
     still take the replay path. */
  var NATIVE = false;
  try { NATIVE = location.protocol === "prophet:"; } catch (e) {}

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

  /* ---- opaque-origin survival shims ------------------------------------
     The snapshot runs in a sandboxed iframe with an opaque origin. Several
     APIs throw SecurityError there (cookie, indexedDB, caches...) and a
     single uncaught throw during a page script's boot kills that script's
     interactivity entirely. Give them all harmless fallbacks. */

  var OPAQUE = (function () {
    try { return window.origin === "null" || !window.origin; } catch (e) { return true; }
  })();

  if (OPAQUE) {
    // document.cookie: in-memory jar.
    (function () {
      var broken = false;
      try { void document.cookie; } catch (e) { broken = true; }
      if (!broken) return;
      var jar = new Map();
      try {
        Object.defineProperty(document, "cookie", {
          configurable: true,
          get: function () {
            var parts = [];
            jar.forEach(function (v, k) { parts.push(k + "=" + v); });
            return parts.join("; ");
          },
          set: function (v) {
            try {
              var pair = String(v).split(";")[0];
              var eq = pair.indexOf("=");
              if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
            } catch (e) {}
          },
        });
      } catch (e) {}
    })();

    // indexedDB: requests fail asynchronously instead of throwing.
    (function () {
      function failingRequest() {
        var req = {
          onerror: null, onsuccess: null, onupgradeneeded: null, onblocked: null,
          readyState: "done", result: undefined,
          error: { name: "SecurityError", message: "indexedDB is unavailable in offline snapshots" },
          addEventListener: function (t, cb) { if (t === "error") this.onerror = cb; },
          removeEventListener: function () {},
        };
        setTimeout(function () {
          if (req.onerror) { try { req.onerror({ target: req, type: "error" }); } catch (e) {} }
        }, 0);
        return req;
      }
      var stub = {
        open: failingRequest,
        deleteDatabase: failingRequest,
        databases: function () { return Promise.resolve([]); },
        cmp: function () { return 0; },
      };
      try { Object.defineProperty(window, "indexedDB", { value: stub, configurable: true }); } catch (e) {}
    })();

    // CacheStorage: resolve/reject softly.
    (function () {
      var stub = {
        open: function () { return Promise.reject(new Error("caches unavailable offline")); },
        match: function () { return Promise.resolve(undefined); },
        has: function () { return Promise.resolve(false); },
        keys: function () { return Promise.resolve([]); },
        delete: function () { return Promise.resolve(false); },
      };
      try { Object.defineProperty(window, "caches", { value: stub, configurable: true }); } catch (e) {}
    })();

    try { navigator.sendBeacon = function () { return true; }; } catch (e) {}

    // WebSocket/EventSource: constructors can throw synchronously under the
    // reader CSP; give scripts an inert socket instead of a crash.
    (function () {
      function inertSocket() {
        var listeners = {};
        var s = {
          readyState: 3, bufferedAmount: 0, url: "", protocol: "", extensions: "",
          binaryType: "blob",
          onopen: null, onmessage: null, onerror: null, onclose: null,
          send: function () {}, close: function () {},
          addEventListener: function (t, cb) { (listeners[t] = listeners[t] || []).push(cb); },
          removeEventListener: function () {},
          dispatchEvent: function () { return true; },
        };
        setTimeout(function () {
          var ev = { type: "error", target: s };
          if (s.onerror) { try { s.onerror(ev); } catch (e) {} }
          (listeners.error || []).forEach(function (cb) { try { cb(ev); } catch (e) {} });
          var ce = { type: "close", code: 1006, reason: "offline snapshot", wasClean: false, target: s };
          if (s.onclose) { try { s.onclose(ce); } catch (e) {} }
          (listeners.close || []).forEach(function (cb) { try { cb(ce); } catch (e) {} });
        }, 0);
        return s;
      }
      ["WebSocket", "EventSource"].forEach(function (name) {
        var Real = window[name];
        if (!Real) return;
        var Wrapped = function (url, arg) {
          try { return new Real(url, arg); } catch (e) { return inertSocket(); }
        };
        Wrapped.prototype = Real.prototype;
        if (name === "WebSocket") {
          Wrapped.CONNECTING = 0; Wrapped.OPEN = 1; Wrapped.CLOSING = 2; Wrapped.CLOSED = 3;
        }
        try { window[name] = Wrapped; } catch (e) {}
      });
    })();
  }

  /* ---- late lifecycle shims ---------------------------------------------
     Replayed bundler chunks execute asynchronously and often finish AFTER
     the document's DOMContentLoaded/load events have fired. Code inside
     them that does addEventListener("load", startAnimations) would wait
     forever — online it loaded before those events, so it never noticed.
     If the moment has already passed, run the listener now. */

  var lifecycleFired = { DOMContentLoaded: false, load: false };
  document.addEventListener("DOMContentLoaded", function () { lifecycleFired.DOMContentLoaded = true; }, true);
  window.addEventListener("load", function () { lifecycleFired.load = true; }, true);
  if (document.readyState === "interactive") lifecycleFired.DOMContentLoaded = true;
  if (document.readyState === "complete") { lifecycleFired.DOMContentLoaded = true; lifecycleFired.load = true; }

  function lateInvoke(listener, type, target) {
    setTimeout(function () {
      try {
        var cb = typeof listener === "function"
          ? listener
          : listener && typeof listener.handleEvent === "function"
            ? function (ev) { return listener.handleEvent(ev); }
            : null;
        if (!cb) return;
        var ev;
        try { ev = new Event(type); } catch (e) { ev = { type: type, target: target }; }
        cb.call(target, ev);
      } catch (e) {}
    }, 0);
  }

  function missedLifecycleEvent(type) {
    if (NATIVE) return false; // native loading fires these in the right order
    if (type === "DOMContentLoaded") return lifecycleFired.DOMContentLoaded;
    if (type === "load" || type === "pageshow") return lifecycleFired.load;
    return false;
  }

  [window, document].forEach(function (target) {
    try {
      var orig = target.addEventListener;
      target.addEventListener = function (type, listener, opts) {
        try {
          if (listener && missedLifecycleEvent(String(type))) {
            lateInvoke(listener, String(type), target);
            return;
          }
        } catch (e) {}
        return orig.call(target, type, listener, opts);
      };
    } catch (e) {}
  });

  try {
    var winProto = Object.getPrototypeOf(window);
    var onloadDesc =
      Object.getOwnPropertyDescriptor(window, "onload") ||
      (winProto && Object.getOwnPropertyDescriptor(winProto, "onload"));
    Object.defineProperty(window, "onload", {
      configurable: true,
      get: function () {
        try { return onloadDesc && onloadDesc.get ? onloadDesc.get.call(window) : null; } catch (e) { return null; }
      },
      set: function (f) {
        if (lifecycleFired.load && typeof f === "function") lateInvoke(f, "load", window);
        else if (onloadDesc && onloadDesc.set) { try { onloadDesc.set.call(window, f); } catch (e) {} }
      },
    });
  } catch (e) {}

  if (!NATIVE) {
    // Layout-dependent animation libraries commonly re-measure on resize and
    // arm on the first scroll; give them one nudge once everything settled.
    window.addEventListener("load", function () {
      setTimeout(function () {
        try { window.dispatchEvent(new Event("resize")); } catch (e) {}
        try { window.dispatchEvent(new Event("scroll")); } catch (e) {}
      }, 150);
    });
  }

  /* ---- clean-up removals ------------------------------------------------
     Archive documents keep the original server HTML so the page's own
     scripts can hydrate against it; the elements the user removed during
     capture are recorded as selectors and stripped here instead. */
  function applyCleanup() {
    var el = document.getElementById("prophet-cleanup");
    if (!el) return;
    var selectors;
    try { selectors = JSON.parse(el.textContent); } catch (e) { return; }
    if (!selectors || !selectors.length) return;
    function strip() {
      for (var i = 0; i < selectors.length; i++) {
        try {
          var node = document.querySelector(selectors[i]);
          if (node && node.parentNode) node.parentNode.removeChild(node);
        } catch (e) {}
      }
    }
    strip();
    // Re-apply after hydration, which can re-insert removed nodes.
    if (document.readyState !== "complete") {
      window.addEventListener("load", function () { setTimeout(strip, 60); });
    } else {
      setTimeout(strip, 60);
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", applyCleanup);
  } else {
    applyCleanup();
  }

  /* ---- offline replay vault ---------------------------------------------
     The capture toolkit recorded every network response the page consumed
     and embedded them in <script type="application/json" id="prophet-vault">.
     Replaying them through patched fetch/XHR/script-src makes interactive
     pieces behave offline exactly as they did online. */

  function hashStr(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }

  var VAULT = { loaded: false, map: null, byUrl: null, blobUrls: {}, sourceBase: null };

  function vaultLoad() {
    if (VAULT.loaded) return VAULT;
    VAULT.loaded = true;
    try {
      var srcMeta = document.querySelector('meta[name="prophet-source"]');
      if (srcMeta) VAULT.sourceBase = srcMeta.getAttribute("content");
    } catch (e) {}
    try {
      var elv = document.getElementById("prophet-vault");
      if (!elv) return VAULT;
      var arr = JSON.parse(elv.textContent);
      VAULT.map = new Map();
      VAULT.byUrl = new Map();
      for (var i = 0; i < arr.length; i++) {
        var e = arr[i];
        VAULT.map.set(e.k, e);
        if (e.k.indexOf("GET ") === 0) {
          var uq = e.u.split("#")[0];
          if (!VAULT.byUrl.has(uq)) VAULT.byUrl.set(uq, e);
          var noQ = uq.split("?")[0];
          if (!VAULT.byUrl.has(noQ)) VAULT.byUrl.set(noQ, e);
        }
      }
    } catch (e) {}
    return VAULT;
  }

  function vaultBytes(entry) {
    if (entry._buf) return entry._buf;
    var bin = atob(entry.b);
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    entry._buf = arr.buffer;
    return entry._buf;
  }

  function vaultText(entry) {
    if (entry._text == null) {
      try { entry._text = new TextDecoder("utf-8").decode(vaultBytes(entry)); } catch (e) { entry._text = ""; }
    }
    return entry._text;
  }

  /** Resolve a page-script URL: absolute as-is, relative against the
      original article URL (about:srcdoc can't resolve them). */
  function resolveUrl(raw) {
    if (raw == null) return null;
    var s = String(raw);
    try { return new URL(s).href; } catch (e) {}
    var v = vaultLoad();
    if (v.sourceBase) {
      try { return new URL(s, v.sourceBase).href; } catch (e) {}
    }
    return null;
  }

  function vaultLookup(method, absUrl, body) {
    var v = vaultLoad();
    if (!v.map || !absUrl) return null;
    var hit = v.map.get(method + " " + absUrl);
    if (!hit && method !== "GET" && typeof body === "string" && body.length > 0 && body.length < 4096) {
      hit = v.map.get(method + " " + absUrl + " " + hashStr(body));
    }
    if (!hit && method === "GET") {
      var uq = absUrl.split("#")[0];
      hit = v.byUrl.get(uq) || v.byUrl.get(uq.split("?")[0]);
    }
    return hit || null;
  }

  function vaultBlobUrl(absUrl, fallbackMime) {
    var hit = vaultLookup("GET", absUrl, null);
    if (!hit) return null;
    if (!VAULT.blobUrls[absUrl]) {
      try {
        VAULT.blobUrls[absUrl] = URL.createObjectURL(
          new Blob([vaultBytes(hit)], { type: hit.t || fallbackMime || "text/javascript" }),
        );
      } catch (e) {
        return null;
      }
    }
    return VAULT.blobUrls[absUrl];
  }

  // fetch replay
  (function () {
    var origFetch = window.fetch ? window.fetch.bind(window) : null;
    window.fetch = function (input, init) {
      try {
        var method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
        var raw = typeof input === "string" ? input : input && input.url ? input.url : String(input);
        var abs = resolveUrl(raw);
        var body = init && typeof init.body === "string" ? init.body : null;
        var hit = abs && vaultLookup(method, abs, body);
        if (hit) {
          var resp = new Response(vaultBytes(hit).slice(0), {
            status: hit.s || 200,
            statusText: "OK",
            headers: hit.t ? { "Content-Type": hit.t } : {},
          });
          try { Object.defineProperty(resp, "url", { value: hit.u }); } catch (e) {}
          return Promise.resolve(resp);
        }
        // Miss: relative URLs are meaningless against about:srcdoc — give
        // them their online meaning so the request at least fails like a
        // network error instead of a TypeError.
        if (!origFetch) return Promise.reject(new TypeError("network unavailable in snapshot"));
        if (abs && typeof input === "string") return origFetch(abs, init);
      } catch (e) {}
      return origFetch
        ? origFetch(input, init)
        : Promise.reject(new TypeError("network unavailable in snapshot"));
    };
  })();

  // XMLHttpRequest replay
  (function () {
    var RealXHR = window.XMLHttpRequest;
    if (!RealXHR) return;
    var Wrapped = function () {
      var xhr = new RealXHR();
      var meta = { m: "GET", u: "" };
      var origOpen = xhr.open;
      xhr.open = function (m, u) {
        meta.m = String(m || "GET").toUpperCase();
        meta.u = resolveUrl(String(u)) || "";
        var args = Array.prototype.slice.call(arguments);
        // Relative URLs don't resolve against about:srcdoc (open() throws);
        // hand the real XHR the absolute URL the page meant.
        if (meta.u) args[1] = meta.u;
        return origOpen.apply(xhr, args);
      };
      var origSend = xhr.send;
      xhr.send = function (body) {
        var hit = meta.u ? vaultLookup(meta.m, meta.u, typeof body === "string" ? body : null) : null;
        if (!hit) return origSend.apply(xhr, arguments);
        setTimeout(function () {
          try {
            var define = function (k, v) {
              try { Object.defineProperty(xhr, k, { value: v, configurable: true }); } catch (e) {}
            };
            define("readyState", 4);
            define("status", hit.s || 200);
            define("statusText", "OK");
            define("responseURL", hit.u);
            var rt = xhr.responseType;
            var resp;
            if (rt === "" || rt === "text") {
              resp = vaultText(hit);
              define("responseText", resp);
            } else if (rt === "json") {
              try { resp = JSON.parse(vaultText(hit)); } catch (e) { resp = null; }
            } else if (rt === "arraybuffer") {
              resp = vaultBytes(hit).slice(0);
            } else if (rt === "blob") {
              resp = new Blob([vaultBytes(hit)], { type: hit.t || "" });
            } else {
              resp = vaultText(hit);
            }
            define("response", resp);
            xhr.getResponseHeader = function (n) {
              return n && String(n).toLowerCase() === "content-type" ? hit.t || null : null;
            };
            xhr.getAllResponseHeaders = function () {
              return hit.t ? "content-type: " + hit.t + "\r\n" : "";
            };
            var size = 0;
            try { size = vaultBytes(hit).byteLength; } catch (e) {}
            xhr.dispatchEvent(new Event("readystatechange"));
            try {
              xhr.dispatchEvent(new ProgressEvent("load", { loaded: size, total: size }));
              xhr.dispatchEvent(new ProgressEvent("loadend", { loaded: size, total: size }));
            } catch (e2) {
              xhr.dispatchEvent(new Event("load"));
              xhr.dispatchEvent(new Event("loadend"));
            }
          } catch (e) {}
        }, 0);
      };
      return xhr;
    };
    Wrapped.prototype = RealXHR.prototype;
    ["UNSENT", "OPENED", "HEADERS_RECEIVED", "LOADING", "DONE"].forEach(function (name, i) {
      Wrapped[name] = i;
    });
    window.XMLHttpRequest = Wrapped;
  })();

  /* ---- script identity & replay layer -----------------------------------
     The serializer defused every executable script (type="prophet/*") so
     the parser executes none of them. We re-run the full list in document
     order ourselves — external classics synchronously from vault text —
     while identity patches make script.src / getAttribute("src") report
     each script's ORIGINAL URL. Bundler runtimes (webpack, Turbopack)
     derive chunk paths from that identity; their subsequent dynamic chunk
     loads go through the patched setters and come out of the vault as
     blob: URLs. */
  (function () {
    var origGetAttribute = Element.prototype.getAttribute;
    var origSetAttribute = Element.prototype.setAttribute;

    function isScriptEl(el) {
      return el.tagName && String(el.tagName).toUpperCase() === "SCRIPT";
    }

    /** Map an outgoing resource URL to a vault blob, remembering the
        original URL on the element for identity reads. */
    function mapUrl(el, v, fallbackMime) {
      var abs = resolveUrl(v);
      if (!abs || !/^https?:/i.test(abs)) return v;
      var blob = vaultBlobUrl(abs, fallbackMime);
      if (!blob) return abs; // not vaulted: at least give it its online URL
      if (el) {
        try { origSetAttribute.call(el, "data-prophet-src", abs); } catch (e) {}
      }
      return blob;
    }

    [
      { ctor: window.HTMLScriptElement, mime: "text/javascript", identity: true },
      { ctor: window.HTMLImageElement, mime: "image/png", identity: false },
    ].forEach(function (target) {
      if (!target.ctor) return;
      var proto = target.ctor.prototype;
      var desc = Object.getOwnPropertyDescriptor(proto, "src");
      if (!desc || !desc.set) return;
      try {
        Object.defineProperty(proto, "src", {
          configurable: true,
          enumerable: desc.enumerable,
          get: target.identity
            ? function () {
                var ps = origGetAttribute.call(this, "data-prophet-src");
                if (ps != null) return ps;
                return desc.get.call(this);
              }
            : desc.get,
          set: function (v) {
            desc.set.call(this, mapUrl(this, String(v), target.mime));
          },
        });
      } catch (e) {}
    });

    // Dynamically-inserted stylesheet chunks (webpack CSS splitting).
    (function () {
      if (!window.HTMLLinkElement) return;
      var proto = window.HTMLLinkElement.prototype;
      var desc = Object.getOwnPropertyDescriptor(proto, "href");
      if (!desc || !desc.set) return;
      try {
        Object.defineProperty(proto, "href", {
          configurable: true,
          enumerable: desc.enumerable,
          get: desc.get,
          set: function (v) { desc.set.call(this, mapUrl(this, String(v), "text/css")); },
        });
      } catch (e) {}
    })();

    try {
      Element.prototype.getAttribute = function (name) {
        if (name != null && String(name).toLowerCase() === "src" && isScriptEl(this)) {
          var ps = origGetAttribute.call(this, "data-prophet-src");
          if (ps != null) return ps;
        }
        return origGetAttribute.call(this, name);
      };
      Element.prototype.setAttribute = function (name, value) {
        if (name != null) {
          var n = String(name).toLowerCase();
          if (n === "src") {
            if (isScriptEl(this)) value = mapUrl(this, String(value), "text/javascript");
            else if (this.tagName && String(this.tagName).toUpperCase() === "IMG") {
              value = mapUrl(this, String(value), "image/png");
            }
          } else if (n === "href" && this.tagName && String(this.tagName).toUpperCase() === "LINK") {
            value = mapUrl(this, String(value), "text/css");
          }
        }
        return origSetAttribute.call(this, name, value);
      };
    } catch (e) {}

    // Post-parse document.write would blow the document away; insert inline.
    try {
      var docWrite = function () {
        var html = Array.prototype.join.call(arguments, "");
        try {
          var cs = document.currentScript;
          if (cs && cs.parentNode) cs.insertAdjacentHTML("beforebegin", html);
        } catch (e) {}
      };
      document.write = docWrite;
      document.writeln = docWrite;
    } catch (e) {}

    function executeOne(old) {
      var t = old.getAttribute("type") || "";
      var isModule = t === "prophet/module" || t === "prophet/module-inline";
      var srcUrl = origGetAttribute.call(old, "data-prophet-src");
      var s = document.createElement("script");
      if (isModule) s.type = "module";
      if (srcUrl) {
        origSetAttribute.call(s, "data-prophet-src", srcUrl);
        var hit = vaultLookup("GET", srcUrl, null);
        if (hit && !isModule) {
          // Synchronous execution; identity patches report the original URL
          // to document.currentScript.src / getAttribute("src").
          s.textContent = vaultText(hit);
        } else {
          // Modules (blob keeps them fetchable) or non-vaulted scripts.
          var url = hit ? vaultBlobUrl(srcUrl, "text/javascript") || srcUrl : srcUrl;
          origSetAttribute.call(s, "src", url);
        }
      } else {
        s.textContent = old.textContent;
      }
      old.parentNode.replaceChild(s, old); // classic inline runs synchronously here
      if (srcUrl && !origGetAttribute.call(s, "src")) {
        // Already-started scripts ignore src changes; expose the original
        // URL for attribute-based scans (querySelector('script[src...]')).
        try { origSetAttribute.call(s, "src", srcUrl); } catch (e) {}
      }
    }

    function replayAll() {
      var defused = document.querySelectorAll('script[type^="prophet/"]');
      var list = [];
      for (var i = 0; i < defused.length; i++) list.push(defused[i]);
      for (var j = 0; j < list.length; j++) {
        try { executeOne(list[j]); } catch (e) {}
      }
    }

    // Run with the DOM fully parsed but BEFORE DOMContentLoaded dispatches,
    // so the scripts' ready-listeners still fire (spec: readystatechange to
    // "interactive" precedes the DOMContentLoaded event).
    if (document.readyState === "loading") {
      document.addEventListener("readystatechange", function h() {
        if (document.readyState !== "loading") {
          document.removeEventListener("readystatechange", h);
          replayAll();
        }
      });
    } else {
      replayAll();
    }
  })();

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
