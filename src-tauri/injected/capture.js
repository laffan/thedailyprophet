/*
 * The Daily Prophet — capture toolkit.
 * Injected into every page of the embedded "capture" webview as a Tauri
 * initialization script (document-start). Two responsibilities:
 *
 *  1. RECORDER (always on): patches fetch/XMLHttpRequest from the very first
 *     moment so every network response the page consumes — article data,
 *     chart JSON, lazy script chunks — is captured with the user's session.
 *     At snapshot time this becomes the "vault" embedded in the snapshot;
 *     the reader runtime replays it so interactive pieces work offline
 *     exactly like they did online.
 *
 *  2. CAPTURE API (dormant until driven): clean-up overlay + single-file
 *     snapshot serializer, controlled from the main window through
 *     window.__PROPHET_CAPTURE__ (via Webview::eval).
 *
 * IPC back to Rust uses window.__TAURI_INTERNALS__.invoke, available here
 * because the capture webview has a remote-URL capability granting the six
 * capture_* reporting commands.
 */
(function () {
  "use strict";
  if (window !== window.top) return; // top frame only
  if (window.__PROPHET_CAPTURE__) return;

  /* ================= IPC ================= */

  function invoke(cmd, args) {
    try {
      var t = window.__TAURI_INTERNALS__ || (window.__TAURI__ && window.__TAURI__.core);
      if (t && t.invoke) return t.invoke(cmd, args || {});
    } catch (e) {}
    return Promise.reject(new Error("no tauri bridge"));
  }

  function progress(stage, detail) {
    invoke("capture_progress", { stage: stage, detail: detail || null }).catch(function () {});
  }

  // The resource-timing buffer defaults to ~250 entries; big pages load far
  // more, and every entry lost is a script/data file missing from the vault.
  try {
    performance.setResourceTimingBufferSize(50000);
    performance.addEventListener("resourcetimingbufferfull", function () {
      try { performance.setResourceTimingBufferSize(100000); } catch (e) {}
    });
  } catch (e) {}

  function reportPage() {
    invoke("capture_page_info", { title: document.title || "", url: location.href }).catch(function () {});
  }
  if (document.readyState !== "loading") reportPage();
  document.addEventListener("DOMContentLoaded", reportPage);
  window.addEventListener("load", reportPage);
  window.addEventListener("popstate", function () { setTimeout(reportPage, 150); });

  function absUrl(raw, base) {
    try {
      return new URL(raw, base || document.baseURI).href;
    } catch (e) {
      return null;
    }
  }

  function hashStr(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }

  function noop() {}

  /* ================= dynamic-node tracker =================
     Nodes inserted by scripts AFTER parsing (charts, widgets, lazy chunks)
     are tracked from document-start. For scripts-on snapshots they are
     stripped: the re-running scripts rebuild them from the vault — exactly
     what happens when the page is reloaded online. Keeping them would make
     append-style renderers (d3 et al) draw everything twice. */

  var DYNAMIC = (typeof WeakSet !== "undefined") ? new WeakSet() : null;
  if (DYNAMIC) {
    try {
      new MutationObserver(function (muts) {
        if (document.readyState === "loading") return; // parser inserts
        for (var i = 0; i < muts.length; i++) {
          var added = muts[i].addedNodes;
          for (var j = 0; j < added.length; j++) {
            if (added[j].nodeType === 1) DYNAMIC.add(added[j]);
          }
        }
      }).observe(document, { childList: true, subtree: true }); // documentElement doesn't exist yet at document-start
    } catch (e) {
      DYNAMIC = null;
    }
  }

  /** Decide whether stripping dynamic nodes is safe: on app-rendered pages
      (SPAs, hydration shells) nearly everything is "dynamic" and stripping
      would blank the article — keep the DOM there instead. */
  function planDynamicStrip() {
    if (!DYNAMIC || !document.body) return false;
    var all = document.body.querySelectorAll("*");
    if (!all.length) return false;
    var derived = new WeakSet();
    var dynCount = 0;
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (DYNAMIC.has(el) || (el.parentElement && derived.has(el.parentElement))) {
        derived.add(el);
        dynCount++;
      }
    }
    var ratio = dynCount / all.length;
    progress(
      "Script-generated content",
      dynCount + " of " + all.length + " elements" + (ratio <= 0.4 ? " — will be rebuilt by scripts" : " — app-rendered page, keeping DOM"),
    );
    return ratio <= 0.4;
  }

  /* ================= network recorder =================
     Records successful responses so the snapshot can replay them offline.
     Key format (must match the reader runtime's lookup):
       GET  -> "GET <absolute-url>"
       POST -> "POST <absolute-url> <djb2-of-body>" (small string bodies)   */

  var RECORDER = {
    active: true,
    entries: new Map(), // key -> { u, s, t, buf }
    budget: 64 * 1024 * 1024,
    perResource: 8 * 1024 * 1024,
  };

  function recorderKey(method, url, body) {
    var k = method + " " + url;
    if (method !== "GET" && typeof body === "string" && body.length > 0 && body.length < 4096) {
      k += " " + hashStr(body);
    }
    return k;
  }

  function recorderPut(key, url, status, mime, buf) {
    if (!RECORDER.active || !buf) return;
    if (RECORDER.entries.has(key)) return;
    var size = buf.byteLength;
    if (size === 0 || size > RECORDER.perResource || size > RECORDER.budget) return;
    RECORDER.budget -= size;
    RECORDER.entries.set(key, { u: url, s: status, t: mime || "", buf: buf });
  }

  // ---- fetch ----
  var origFetch = window.fetch ? window.fetch.bind(window) : null;
  if (origFetch) {
    window.fetch = function (input, init) {
      var p = origFetch(input, init);
      try {
        var method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
        var raw = typeof input === "string" ? input : input && input.url ? input.url : String(input);
        var abs = absUrl(raw);
        var body = init && typeof init.body === "string" ? init.body : null;
        if (RECORDER.active && abs && /^https?:/i.test(abs) && (method === "GET" || method === "POST")) {
          p.then(function (resp) {
            try {
              if (!resp || !resp.ok || resp.type === "opaque") return;
              var mime = (resp.headers.get("content-type") || "").split(";")[0].trim();
              var clone = resp.clone();
              clone
                .arrayBuffer()
                .then(function (buf) {
                  recorderPut(recorderKey(method, abs, body), abs, resp.status, mime, buf);
                })
                .catch(noop);
            } catch (e) {}
          }).catch(noop);
        }
      } catch (e) {}
      return p;
    };
  }

  // ---- XMLHttpRequest ----
  var RealXHR = window.XMLHttpRequest;
  if (RealXHR) {
    var WrappedXHR = function () {
      var xhr = new RealXHR();
      var meta = { m: "GET", u: "" };
      var origOpen = xhr.open;
      xhr.open = function (m, u) {
        meta.m = String(m || "GET").toUpperCase();
        meta.u = absUrl(String(u)) || "";
        return origOpen.apply(xhr, arguments);
      };
      var origSend = xhr.send;
      xhr.send = function (body) {
        if (RECORDER.active && meta.u && /^https?:/i.test(meta.u)) {
          var bodyStr = typeof body === "string" ? body : null;
          xhr.addEventListener("load", function () {
            try {
              if (xhr.status < 200 || xhr.status >= 300) return;
              var mime = "";
              try {
                mime = (xhr.getResponseHeader("content-type") || "").split(";")[0].trim();
              } catch (e) {}
              var url = xhr.responseURL || meta.u;
              var key = recorderKey(meta.m, url, bodyStr);
              var rt = xhr.responseType;
              if (rt === "" || rt === "text") {
                recorderPut(key, url, xhr.status, mime, new TextEncoder().encode(xhr.responseText).buffer);
              } else if (rt === "arraybuffer" && xhr.response) {
                recorderPut(key, url, xhr.status, mime, xhr.response.slice(0));
              } else if (rt === "json" && xhr.response != null) {
                recorderPut(key, url, xhr.status, mime, new TextEncoder().encode(JSON.stringify(xhr.response)).buffer);
              } else if (rt === "blob" && xhr.response) {
                xhr.response
                  .arrayBuffer()
                  .then(function (buf) {
                    recorderPut(key, url, xhr.status, mime, buf);
                  })
                  .catch(noop);
              }
            } catch (e) {}
          });
        }
        return origSend.apply(xhr, arguments);
      };
      return xhr;
    };
    WrappedXHR.prototype = RealXHR.prototype;
    ["UNSENT", "OPENED", "HEADERS_RECEIVED", "LOADING", "DONE"].forEach(function (name, i) {
      WrappedXHR[name] = i;
    });
    window.XMLHttpRequest = WrappedXHR;
  }

  /* ================= include mode =================
     Lets the reader pick links whose pages become part of the same
     document, so a multi-part article travels as one thing. Included pages
     are stored under their own URLs, so following the link in the reader is
     ordinary navigation inside the archive. */

  var INCLUDED = Object.create(null); // absolute url -> label
  var includedOrder = [];

  function includableUrl(a) {
    var raw = a.getAttribute("href");
    if (!raw || raw.charAt(0) === "#" || /^(javascript|mailto|tel):/i.test(raw)) return null;
    var abs = absUrl(raw);
    if (!abs || !/^https?:/i.test(abs)) return null;
    abs = abs.split("#")[0];
    if (abs === location.href.split("#")[0]) return null;
    // Same site only: following a link off-site would pull in the whole web.
    try {
      if (new URL(abs).origin !== location.origin) return null;
    } catch (e) {
      return null;
    }
    return abs;
  }

  function reportIncluded() {
    invoke("capture_included", {
      urls: includedOrder.map(function (u) {
        return { url: u, label: INCLUDED[u] || u };
      }),
    }).catch(function () {});
  }

  function paintIncluded() {
    var links = document.querySelectorAll("a[href]");
    for (var i = 0; i < links.length; i++) {
      var u = includableUrl(links[i]);
      if (u && INCLUDED[u]) links[i].setAttribute(INCLUDED_ATTR, "1");
      else links[i].removeAttribute(INCLUDED_ATTR);
    }
  }

  function toggleInclude(a) {
    var u = includableUrl(a);
    if (!u) return false;
    if (INCLUDED[u]) {
      delete INCLUDED[u];
      includedOrder = includedOrder.filter(function (x) { return x !== u; });
    } else {
      INCLUDED[u] = (a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 90) || u;
      includedOrder.push(u);
    }
    paintIncluded();
    reportIncluded();
    return true;
  }

  /* ================= clean-up mode ================= */

  var UI_ATTR = "data-prophet-ui";
  var REMOVED_ATTR = "data-prophet-removed";
  var INCLUDED_ATTR = "data-prophet-included";

  var cleanup = {
    active: false,
    mode: "cleanup", // "cleanup" removes elements; "include" picks links
    removed: [],
    baseEl: null,
    level: 0,
    host: null,
    shadow: null,
    box: null,
    label: null,
    countEl: null,
    styleEl: null,
  };

  function currentTarget() {
    var el = cleanup.baseEl;
    if (!el) return null;
    for (var i = 0; i < cleanup.level; i++) {
      var p = el.parentElement;
      if (!p || p === document.body || p === document.documentElement) break;
      el = p;
    }
    return el;
  }

  function describe(el) {
    var s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    else if (el.classList && el.classList.length) s += "." + Array.prototype.slice.call(el.classList, 0, 2).join(".");
    return s;
  }

  function positionBox() {
    var el = currentTarget();
    if (!el || !cleanup.box) return;
    var r = el.getBoundingClientRect();
    if (cleanup.mode === "include") {
      var u = includableUrl(el);
      cleanup.box.className = INCLUDED[u] ? "box box-included" : "box box-include";
      cleanup.label.className = INCLUDED[u] ? "label label-included" : "label label-include";
      cleanup.label.textContent = (INCLUDED[u] ? "Included — click to remove: " : "Add page: ") +
        (u || "").replace(/^https?:\/\/[^/]+/, "");
      cleanup.box.style.display = "block";
      cleanup.label.style.display = "block";
      cleanup.box.style.left = r.left - 2 + "px";
      cleanup.box.style.top = r.top - 2 + "px";
      cleanup.box.style.width = r.width + 4 + "px";
      cleanup.box.style.height = r.height + 4 + "px";
      var ily = r.top - 26;
      if (ily < 4) ily = r.bottom + 4;
      cleanup.label.style.left = Math.max(4, r.left) + "px";
      cleanup.label.style.top = ily + "px";
      return;
    }
    cleanup.box.className = "box";
    cleanup.label.className = "label";
    cleanup.box.style.display = "block";
    cleanup.box.style.left = r.left - 2 + "px";
    cleanup.box.style.top = r.top - 2 + "px";
    cleanup.box.style.width = r.width + 4 + "px";
    cleanup.box.style.height = r.height + 4 + "px";
    cleanup.label.textContent = describe(el);
    cleanup.label.style.display = "block";
    var ly = r.top - 26;
    if (ly < 4) ly = r.top + 4;
    cleanup.label.style.left = Math.max(4, r.left) + "px";
    cleanup.label.style.top = ly + "px";
  }

  function hideBox() {
    if (cleanup.box) cleanup.box.style.display = "none";
    if (cleanup.label) cleanup.label.style.display = "none";
  }

  function reportCount() {
    if (cleanup.countEl) {
      cleanup.countEl.textContent = cleanup.removed.length + " removed";
    }
    invoke("capture_count", { count: cleanup.removed.length }).catch(function () {});
  }

  function onMove(e) {
    if (!cleanup.active) return;
    if (cleanup.host && (e.target === cleanup.host || cleanup.host.contains(e.target))) {
      hideBox();
      return;
    }
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === cleanup.host || (cleanup.host && cleanup.host.contains(el))) {
      hideBox();
      return;
    }
    if (cleanup.mode === "include") {
      // Only links are targets here, and always the whole link.
      var link = el.closest ? el.closest("a[href]") : null;
      if (!link || !includableUrl(link)) {
        hideBox();
        cleanup.baseEl = null;
        return;
      }
      cleanup.baseEl = link;
      cleanup.level = 0;
      positionBox();
      return;
    }
    if (el !== cleanup.baseEl) {
      cleanup.baseEl = el;
      cleanup.level = 0;
    }
    positionBox();
  }

  function onClick(e) {
    if (!cleanup.active) return;
    if (cleanup.host && (e.target === cleanup.host || cleanup.host.contains(e.target))) return;

    if (cleanup.mode === "include") {
      var link = e.target && e.target.closest ? e.target.closest("a[href]") : null;
      if (!link) return; // let ordinary page interaction through while picking
      e.preventDefault();
      e.stopImmediatePropagation();
      toggleInclude(link);
      positionBox();
      return;
    }

    e.preventDefault();
    e.stopImmediatePropagation();
    var el = currentTarget();
    if (!el) return;
    if (el === document.body || el === document.documentElement) return;
    el.setAttribute(REMOVED_ATTR, "1");
    cleanup.removed.push(el);
    cleanup.baseEl = null;
    cleanup.level = 0;
    hideBox();
    reportCount();
  }

  function onKey(e) {
    if (!cleanup.active) return;
    if (cleanup.mode === "include") return; // no parent/child walking for links
    if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopImmediatePropagation();
      cleanup.level++;
      var el = currentTarget();
      if (el === document.body) cleanup.level--;
      positionBox();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (cleanup.level > 0) cleanup.level--;
      positionBox();
    } else if (e.key === "z" || e.key === "Z") {
      e.preventDefault();
      e.stopImmediatePropagation();
      api.undo();
    }
  }

  function buildOverlay() {
    var host = document.createElement("div");
    host.setAttribute(UI_ATTR, "1");
    host.style.cssText = "all:initial; position:fixed; z-index:2147483647; top:0; left:0;";
    var shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML =
      "<style>" +
      ".box{position:fixed;display:none;pointer-events:none;border:2px solid #c0392b;background:rgba(192,57,43,0.12);border-radius:3px;z-index:2}" +
      ".box-include{border-color:#1d7a4c;background:rgba(29,122,76,0.12)}" +
      ".box-included{border-color:#1d7a4c;background:rgba(29,122,76,0.28);border-style:double;border-width:4px}" +
      ".label{position:fixed;display:none;pointer-events:none;background:#c0392b;color:#fff;font:11px/1.6 -apple-system,Helvetica,sans-serif;padding:1px 7px;border-radius:3px;z-index:3;max-width:60vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".label-include,.label-included{background:#1d7a4c}" +
      ".bar{position:fixed;top:12px;right:12px;z-index:4;display:flex;gap:8px;align-items:center;background:#231d13;color:#f2e8d5;font:12.5px -apple-system,Helvetica,sans-serif;padding:9px 12px;border-radius:9px;box-shadow:0 6px 18px rgba(0,0,0,.35)}" +
      ".bar button{all:initial;font:600 12px -apple-system,Helvetica,sans-serif;color:#f2e8d5;background:#4a3f2c;padding:5px 11px;border-radius:6px;cursor:pointer}" +
      ".bar button:hover{background:#5d4f37}" +
      ".count{font-weight:700;margin-right:2px}" +
      ".hint{opacity:.65;margin-left:2px}" +
      "</style>" +
      '<div class="box"></div><div class="label"></div>' +
      '<div class="bar"><span class="count">0 removed</span>' +
      '<button data-act="undo">Undo (Z)</button><button data-act="restore">Restore all</button>' +
      '<span class="hint">click removes · ↑ grows</span></div>';
    cleanup.box = shadow.querySelector(".box");
    cleanup.label = shadow.querySelector(".label");
    cleanup.countEl = shadow.querySelector(".count");
    shadow.querySelector('[data-act="undo"]').addEventListener("click", function (e) {
      e.stopPropagation();
      api.undo();
    });
    shadow.querySelector('[data-act="restore"]').addEventListener("click", function (e) {
      e.stopPropagation();
      api.restoreAll();
    });
    cleanup.host = host;
    cleanup.shadow = shadow;
    document.documentElement.appendChild(host);
  }

  /* ================= snapshot ================= */

  var BUDGET_TOTAL = 120 * 1024 * 1024; // stop inlining after this many bytes
  var PER_RESOURCE_CAP = 30 * 1024 * 1024;
  var resourceCache = new Map(); // absolute url -> { dataUri, mime, buf, bytes } | null | Promise
  var budgetLeft = BUDGET_TOTAL;
  var fetchedCount = 0;

  function bytesToB64(buf) {
    var bytes = new Uint8Array(buf);
    var chunks = [];
    var CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) {
      chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CH)));
    }
    return btoa(chunks.join(""));
  }

  function guessMime(url) {
    var m = (url.split("?")[0].match(/\.([a-z0-9]+)$/i) || [])[1];
    var map = {
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
      webp: "image/webp", avif: "image/avif", svg: "image/svg+xml", ico: "image/x-icon",
      css: "text/css", js: "text/javascript", mjs: "text/javascript",
      woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
      mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", ogg: "audio/ogg",
      json: "application/json",
    };
    return map[(m || "").toLowerCase()] || "application/octet-stream";
  }

  /** Fetch a resource as { dataUri, mime, buf, bytes } or null. Page fetch first, Rust fallback. */
  function fetchResource(url) {
    if (resourceCache.has(url)) return Promise.resolve(resourceCache.get(url));
    if (!/^https?:/i.test(url)) {
      if (/^data:/i.test(url)) {
        var r0 = { dataUri: url, text: null, bytes: url.length };
        resourceCache.set(url, r0);
        return Promise.resolve(r0);
      }
      resourceCache.set(url, null);
      return Promise.resolve(null);
    }
    var p = (origFetch || window.fetch)(url, { credentials: "include", redirect: "follow" })
      .then(function (resp) {
        if (!resp.ok || resp.type === "opaque") throw new Error("http " + resp.status);
        return resp.arrayBuffer().then(function (buf) {
          var mime = (resp.headers.get("content-type") || "").split(";")[0].trim() || guessMime(url);
          return { buf: buf, mime: mime };
        });
      })
      .catch(function () {
        // Cross-origin without CORS headers: fall back to the Rust fetcher
        // (no cookies, but fine for CDNs).
        return invoke("capture_fetch", { url: url }).then(function (res) {
          if (!res || !res.ok) return null;
          var bin = atob(res.b64);
          var arr = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          return { buf: arr.buffer, mime: res.mime || guessMime(url) };
        });
      })
      .then(function (got) {
        if (!got || !got.buf) {
          resourceCache.set(url, null);
          return null;
        }
        var size = got.buf.byteLength;
        if (size > PER_RESOURCE_CAP || size > budgetLeft) {
          resourceCache.set(url, null);
          return null;
        }
        budgetLeft -= size;
        fetchedCount++;
        if (fetchedCount % 25 === 0) progress("Inlining resources", fetchedCount + " fetched");
        var out = {
          dataUri: "data:" + got.mime + ";base64," + bytesToB64(got.buf),
          mime: got.mime,
          buf: got.buf,
          bytes: size,
        };
        resourceCache.set(url, out);
        return out;
      })
      .catch(function () {
        resourceCache.set(url, null);
        return null;
      });
    resourceCache.set(url, p);
    return p;
  }

  function fetchText(url) {
    return fetchResource(url).then(function (r) {
      if (!r || !r.buf) return null;
      try {
        return new TextDecoder("utf-8").decode(r.buf);
      } catch (e) {
        return null;
      }
    });
  }

  var CSS_URL_RE = /url\(\s*(['"]?)([^'")]+?)\1\s*\)/g;
  var CSS_IMPORT_RE = /@import\s+(?:url\(\s*['"]?([^'")]+?)['"]?\s*\)|['"]([^'"]+?)['"])\s*([^;]*);/g;

  /** Inline @imports and url(...) references inside a css string. */
  function processCss(cssText, baseUrl, depth) {
    if (!cssText) return Promise.resolve("");
    if (depth > 4) return Promise.resolve(cssText);

    var importJobs = [];
    cssText.replace(CSS_IMPORT_RE, function (whole, u1, u2, media) {
      var raw = u1 || u2;
      var abs = absUrl(raw, baseUrl);
      if (abs) importJobs.push({ whole: whole, url: abs, media: (media || "").trim() });
      return whole;
    });

    var importPromise = Promise.all(
      importJobs.map(function (job) {
        return fetchText(job.url).then(function (txt) {
          if (txt == null) return { whole: job.whole, replacement: "/* prophet: import unavailable */" };
          return processCss(txt, job.url, depth + 1).then(function (inner) {
            var rep = job.media ? "@media " + job.media + " {\n" + inner + "\n}" : inner;
            return { whole: job.whole, replacement: rep };
          });
        });
      }),
    ).then(function (reps) {
      var out = cssText;
      reps.forEach(function (r) {
        out = out.split(r.whole).join(r.replacement);
      });
      return out;
    });

    return importPromise.then(function (css) {
      var urls = [];
      css.replace(CSS_URL_RE, function (whole, q, raw) {
        if (/^data:|^#/i.test(raw.trim())) return whole;
        var abs = absUrl(raw.trim(), baseUrl);
        if (abs && urls.indexOf(abs) === -1 && /^https?:/i.test(abs)) urls.push(abs);
        return whole;
      });
      if (!urls.length) return css;
      return Promise.all(
        urls.map(function (u) {
          return fetchResource(u).then(function (r) {
            return { url: u, dataUri: r && r.dataUri };
          });
        }),
      ).then(function (results) {
        var byUrl = {};
        results.forEach(function (r) {
          if (r.dataUri) byUrl[r.url] = r.dataUri;
        });
        return css.replace(CSS_URL_RE, function (whole, q, raw) {
          var t = raw.trim();
          if (/^data:|^#/i.test(t)) return whole;
          var abs = absUrl(t, baseUrl);
          if (abs && byUrl[abs]) return 'url("' + byUrl[abs] + '")';
          if (abs) return 'url("' + abs + '")'; // absolutize what we couldn't inline
          return whole;
        });
      });
    });
  }

  function serializeSheet(sheet) {
    try {
      var rules = sheet.cssRules;
      var out = [];
      for (var i = 0; i < rules.length; i++) out.push(rules[i].cssText);
      return Promise.resolve({ css: out.join("\n"), base: sheet.href || document.baseURI });
    } catch (e) {
      if (sheet.href) {
        return fetchText(sheet.href).then(function (txt) {
          return { css: txt || "", base: sheet.href };
        });
      }
      return Promise.resolve({ css: "", base: document.baseURI });
    }
  }

  /**
   * Walk the live tree and its clone in lockstep (structures are identical
   * right after cloneNode(true)), collecting async inlining jobs.
   */
  function walkPair(live, clone, jobs, opts) {
    if (live.nodeType !== 1) return;
    var tag = live.tagName;

    // Skip subtrees the user removed or our own UI.
    if (live.getAttribute && (live.getAttribute(UI_ATTR) || live.getAttribute(REMOVED_ATTR))) {
      if (clone.parentNode) clone.parentNode.removeChild(clone);
      return;
    }

    // Script-created nodes: the re-running scripts rebuild them (vault-fed).
    // Dynamically-inserted <script> tags are ALWAYS dropped in scripts-on
    // mode — the code that inserted them once will insert them again.
    if (opts.includeScripts && DYNAMIC && DYNAMIC.has(live) && (opts.stripDynamic || tag === "SCRIPT")) {
      if (clone.parentNode) clone.parentNode.removeChild(clone);
      return;
    }

    // Open shadow roots -> declarative shadow DOM.
    if (live.shadowRoot && live.shadowRoot.mode === "open") {
      var tpl = document.createElement("template");
      tpl.setAttribute("shadowrootmode", "open");
      var frag = tpl.content;
      var kids = live.shadowRoot.childNodes;
      for (var s = 0; s < kids.length; s++) {
        var kidClone = kids[s].cloneNode(true);
        frag.appendChild(kidClone);
        walkPair(kids[s], kidClone, jobs, opts);
      }
      // Adopted stylesheets of the shadow root.
      try {
        var adopted = live.shadowRoot.adoptedStyleSheets || [];
        for (var a = 0; a < adopted.length; a++) {
          (function (sheet) {
            var styleEl = document.createElement("style");
            frag.insertBefore(styleEl, frag.firstChild);
            jobs.push(function () {
              return serializeSheet(sheet).then(function (got) {
                return processCss(got.css, got.base, 0).then(function (css) {
                  styleEl.textContent = css;
                });
              });
            });
          })(adopted[a]);
        }
      } catch (e) {}
      clone.insertBefore(tpl, clone.firstChild);
    }

    if (tag === "LINK") {
      handleLink(live, clone, jobs, opts);
    } else if (tag === "STYLE") {
      (function () {
        var sheet = live.sheet;
        jobs.push(function () {
          if (!sheet) return Promise.resolve();
          return serializeSheet(sheet).then(function (got) {
            return processCss(got.css, got.base, 0).then(function (css) {
              clone.textContent = css;
            });
          });
        });
      })();
    } else if (tag === "IMG") {
      handleImg(live, clone, jobs);
    } else if (tag === "SOURCE") {
      // <picture>/<video> sources: the chosen candidate is captured on the
      // parent element; sources themselves would re-trigger network loads.
      if (clone.parentNode) clone.parentNode.removeChild(clone);
      return;
    } else if (tag === "VIDEO" || tag === "AUDIO") {
      handleMedia(live, clone, jobs);
    } else if (tag === "CANVAS") {
      handleCanvas(live, clone, opts);
    } else if (tag === "IFRAME" || tag === "FRAME") {
      handleIframe(live, clone);
    } else if (tag === "INPUT") {
      try {
        var type = (live.getAttribute("type") || "text").toLowerCase();
        if (type === "checkbox" || type === "radio") {
          if (live.checked) clone.setAttribute("checked", "");
          else clone.removeAttribute("checked");
        } else if (type !== "password" && type !== "file") {
          clone.setAttribute("value", live.value);
        }
      } catch (e) {}
    } else if (tag === "TEXTAREA") {
      clone.textContent = live.value;
    } else if (tag === "OPTION") {
      if (live.selected) clone.setAttribute("selected", "");
      else clone.removeAttribute("selected");
    } else if (tag === "SCRIPT") {
      handleScript(live, clone, jobs, opts);
    }

    // style="... url(...)" attributes
    var styleAttr = live.getAttribute && live.getAttribute("style");
    if (styleAttr && styleAttr.indexOf("url(") !== -1) {
      (function (attr) {
        jobs.push(function () {
          return processCss(attr, document.baseURI, 4).then(function (css) {
            clone.setAttribute("style", css);
          });
        });
      })(styleAttr);
    }

    // Absolutize plain anchors.
    if (tag === "A" && live.getAttribute("href")) {
      var href = live.getAttribute("href");
      if (href.charAt(0) !== "#" && !/^javascript:/i.test(href)) {
        var abs = absUrl(href);
        if (abs) clone.setAttribute("href", abs);
      }
    }

    // Recurse children in lockstep.
    var L = live.childNodes, C = clone.childNodes;
    var lArr = [], cArr = [];
    for (var i = 0; i < L.length; i++) lArr.push(L[i]);
    for (var j = 0; j < C.length; j++) cArr.push(C[j]);
    // The clone may have gained a leading <template> (shadow DOM); align from the end.
    var offset = cArr.length - lArr.length;
    for (var k = 0; k < lArr.length; k++) {
      var cNode = cArr[k + offset];
      if (cNode) walkPair(lArr[k], cNode, jobs, opts);
    }
  }

  function handleLink(live, clone, jobs, opts) {
    var rel = (live.getAttribute("rel") || "").toLowerCase();
    if (/stylesheet/.test(rel)) {
      var sheet = live.sheet;
      var styleEl = document.createElement("style");
      var media = live.getAttribute("media");
      if (media) styleEl.setAttribute("media", media);
      styleEl.setAttribute("data-prophet-href", live.href || "");
      if (clone.parentNode) clone.parentNode.replaceChild(styleEl, clone);
      jobs.push(function () {
        if (!sheet) {
          return fetchText(live.href).then(function (txt) {
            if (txt == null) return;
            return processCss(txt, live.href, 0).then(function (css) {
              styleEl.textContent = css;
            });
          });
        }
        return serializeSheet(sheet).then(function (got) {
          return processCss(got.css, got.base, 0).then(function (css) {
            styleEl.textContent = css;
          });
        });
      });
    } else if (/icon|apple-touch-icon/.test(rel)) {
      var href = live.href;
      jobs.push(function () {
        return fetchResource(href).then(function (r) {
          if (r && r.dataUri) clone.setAttribute("href", r.dataUri);
        });
      });
    } else if (/preload|prefetch|preconnect|dns-prefetch|modulepreload|manifest/.test(rel)) {
      if (clone.parentNode) clone.parentNode.removeChild(clone);
    } else if (live.getAttribute("href")) {
      var abs = absUrl(live.getAttribute("href"));
      if (abs) clone.setAttribute("href", abs);
    }
    void opts;
  }

  function handleImg(live, clone, jobs) {
    var src = live.currentSrc || live.src;
    clone.removeAttribute("srcset");
    clone.removeAttribute("sizes");
    clone.removeAttribute("crossorigin");
    clone.removeAttribute("integrity");
    if (clone.getAttribute("loading") === "lazy") clone.setAttribute("loading", "eager");
    // Neutralize common lazy-load stashes so stale values don't fight the inline src.
    ["data-src", "data-srcset", "data-lazy-src", "data-original"].forEach(function (a) {
      clone.removeAttribute(a);
    });
    if (!src) return;
    var abs = absUrl(src);
    if (!abs) return;
    clone.setAttribute("src", abs);
    jobs.push(function () {
      return fetchResource(abs).then(function (r) {
        if (r && r.dataUri) clone.setAttribute("src", r.dataUri);
      });
    });
  }

  function handleMedia(live, clone, jobs) {
    var poster = live.getAttribute && live.getAttribute("poster");
    if (poster) {
      var absPoster = absUrl(poster);
      if (absPoster) {
        jobs.push(function () {
          return fetchResource(absPoster).then(function (r) {
            if (r && r.dataUri) clone.setAttribute("poster", r.dataUri);
          });
        });
      }
    }
    var src = live.currentSrc || live.getAttribute("src") || "";
    if (src) {
      var abs = absUrl(src);
      if (abs) {
        clone.setAttribute("src", abs);
        clone.setAttribute("preload", "metadata");
        jobs.push(function () {
          return fetchResource(abs).then(function (r) {
            if (r && r.dataUri) clone.setAttribute("src", r.dataUri);
          });
        });
      }
    }
  }

  function handleCanvas(live, clone, opts) {
    var dataUrl = null;
    try {
      dataUrl = live.toDataURL("image/png");
    } catch (e) {
      /* tainted canvas */
    }
    if (!dataUrl) return;
    if (opts.includeScripts) {
      // Scripts may repaint it; keep the canvas but give it a painted backdrop
      // for the moment before (or in case) they do.
      clone.setAttribute("style", ((clone.getAttribute("style") || "") + ";background-image:url(" + dataUrl + ");background-size:100% 100%;").replace(/^;/, ""));
    } else {
      var img = document.createElement("img");
      img.setAttribute("src", dataUrl);
      if (live.className) img.setAttribute("class", live.className);
      if (live.getAttribute("style")) img.setAttribute("style", live.getAttribute("style"));
      img.setAttribute("width", live.width);
      img.setAttribute("height", live.height);
      if (clone.parentNode) clone.parentNode.replaceChild(img, clone);
    }
  }

  function handleIframe(live, clone) {
    var replacement;
    try {
      var innerDoc = live.contentDocument; // throws / null when cross-origin
      if (innerDoc && innerDoc.documentElement) {
        clone.setAttribute("srcdoc", "<!DOCTYPE html>" + innerDoc.documentElement.outerHTML);
        clone.removeAttribute("src");
        return;
      }
    } catch (e) {}
    replacement = document.createElement("div");
    replacement.setAttribute("style", "border:1px dashed #999;padding:14px;font:13px sans-serif;color:#666;background:#f6f6f6;");
    var src = live.getAttribute("src") || "";
    replacement.textContent = "Embedded frame not captured" + (src ? ": " + src : "");
    if (clone.parentNode) clone.parentNode.replaceChild(replacement, clone);
  }

  /**
   * Scripts are never inlined-in-place: bundler runtimes (webpack,
   * Turbopack...) self-identify through their script tag's src URL, and
   * chunk registration breaks if that identity is lost. Instead every
   * executable script is DEFUSED (type="prophet/*", content in the vault,
   * original URL in data-prophet-src) and the reader runtime re-executes
   * the whole list in document order with identity patches in place.
   */
  function handleScript(live, clone, jobs, opts) {
    var type = (live.getAttribute("type") || "").toLowerCase().trim();
    if (!opts.includeScripts) {
      var keep = type === "application/json" || type === "application/ld+json" || type === "importmap";
      if (!keep && clone.parentNode) clone.parentNode.removeChild(clone);
      return;
    }
    var isModule = type === "module";
    var executable = !type || isModule || /javascript|ecmascript/.test(type);
    if (!executable) return; // data blocks (json, ld+json, importmap...) stay verbatim
    clone.removeAttribute("integrity");
    clone.removeAttribute("crossorigin");
    clone.removeAttribute("nonce");
    var src = live.getAttribute("src");
    if (!src) {
      clone.setAttribute("type", isModule ? "prophet/module-inline" : "prophet/inline");
      return;
    }
    var abs = absUrl(src);
    if (!abs) return;
    clone.setAttribute("type", isModule ? "prophet/module" : "prophet/classic");
    clone.setAttribute("data-prophet-src", abs);
    clone.removeAttribute("src");
    clone.removeAttribute("defer");
    clone.removeAttribute("async");
    jobs.push(function () {
      return fetchResource(abs).then(function (r) {
        if (r && r.buf) recorderPutForce("GET " + abs, abs, 200, r.mime, r.buf);
      });
    });
  }

  // Vault writes during snapshot bypass the "recorder paused" flag.
  function recorderPutForce(key, url, status, mime, buf) {
    var was = RECORDER.active;
    RECORDER.active = true;
    recorderPut(key, url, status, mime, buf);
    RECORDER.active = was;
  }

  function stripDangerous(rootClone, opts) {
    // CSP / refresh metas would fight the reader; remove them.
    var metas = rootClone.querySelectorAll("meta[http-equiv]");
    for (var i = 0; i < metas.length; i++) {
      var he = (metas[i].getAttribute("http-equiv") || "").toLowerCase();
      if (he === "content-security-policy" || he === "refresh") metas[i].parentNode.removeChild(metas[i]);
    }
    var bases = rootClone.querySelectorAll("base");
    for (var b = 0; b < bases.length; b++) bases[b].parentNode.removeChild(bases[b]);

    if (!opts.includeScripts) {
      var all = rootClone.querySelectorAll("*");
      for (var j = 0; j < all.length; j++) {
        var el = all[j];
        var names = el.getAttributeNames ? el.getAttributeNames() : [];
        for (var k = 0; k < names.length; k++) {
          if (names[k].toLowerCase().indexOf("on") === 0) el.removeAttribute(names[k]);
        }
        if (el.tagName === "A") {
          var href = el.getAttribute("href");
          if (href && /^javascript:/i.test(href)) el.setAttribute("href", "#");
        }
      }
    }
  }

  function runJobs(jobs, concurrency) {
    var i = 0;
    var total = jobs.length;
    var reported = 0;
    function next() {
      if (i >= jobs.length) return Promise.resolve();
      var job = jobs[i++];
      return Promise.resolve()
        .then(job)
        .catch(function () {})
        .then(function () {
          reported++;
          if (reported % 40 === 0) progress("Inlining resources", reported + " / " + total);
          return next();
        });
    }
    var lanes = [];
    for (var l = 0; l < concurrency; l++) lanes.push(next());
    return Promise.all(lanes);
  }

  /* ---- offline replay vault ------------------------------------------- */

  /** URLs the page loaded that the recorder couldn't see (script tags,
      pre-recorder requests). Sourced from the performance timeline. */
  function sweepResourceUrls() {
    var urls = [];
    var seen = {};
    try {
      var entries = performance.getEntriesByType("resource");
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        if (!/^https?:/i.test(e.name)) continue;
        if (seen[e.name]) continue;
        if (RECORDER.entries.has("GET " + e.name)) continue;
        var it = e.initiatorType;
        // "link" covers rel=preload'd chunks (Next.js preloads then reuses).
        if (it === "script" || it === "link" || it === "fetch" || it === "xmlhttprequest" || it === "other" || it === "img") {
          seen[e.name] = true;
          urls.push(e.name);
        }
      }
    } catch (e) {}
    return urls.slice(0, 800);
  }

  function buildVault(opts) {
    if (!opts.includeScripts) return Promise.resolve(null);
    var urls = sweepResourceUrls();
    progress("Recording offline replay data", urls.length + " extra resources");
    return Promise.all(
      urls.map(function (u) {
        return fetchResource(u).then(function (r) {
          if (r && r.buf) recorderPutForce("GET " + u, u, 200, r.mime, r.buf);
        });
      }),
    ).then(function () {
      var arr = [];
      RECORDER.entries.forEach(function (v, k) {
        arr.push({ k: k, u: v.u, s: v.s, t: v.t, b: bytesToB64(v.buf), _size: v.buf.byteLength });
      });
      // Keep the vault under ~48MB of raw payload; drop the biggest first.
      var MAX_VAULT = 48 * 1024 * 1024;
      var total = arr.reduce(function (acc, e) { return acc + e._size; }, 0);
      if (total > MAX_VAULT) {
        arr.sort(function (a, b) { return a._size - b._size; });
        var kept = [];
        var acc = 0;
        for (var i = 0; i < arr.length; i++) {
          if (acc + arr[i]._size > MAX_VAULT) continue;
          acc += arr[i]._size;
          kept.push(arr[i]);
        }
        progress("Offline data trimmed", (arr.length - kept.length) + " large responses dropped");
        arr = kept;
      }
      var totalMb = Math.round(arr.reduce(function (acc, e) { return acc + e._size; }, 0) / 1048576);
      progress("Offline replay data ready", arr.length + " responses (" + totalMb + " MB)");
      arr.forEach(function (e) { delete e._size; });
      return arr.length ? arr : null;
    });
  }

  function pickCover() {
    var url = null;
    var og = document.querySelector('meta[property="og:image"], meta[name="og:image"], meta[name="twitter:image"]');
    if (og && og.getAttribute("content")) url = absUrl(og.getAttribute("content"));
    if (!url) {
      var best = null;
      var bestArea = 0;
      var imgs = document.querySelectorAll("img");
      for (var i = 0; i < imgs.length && i < 400; i++) {
        var im = imgs[i];
        var area = (im.naturalWidth || 0) * (im.naturalHeight || 0);
        if (area > bestArea && im.naturalWidth >= 300 && im.naturalHeight >= 200) {
          bestArea = area;
          best = im;
        }
      }
      if (best) url = absUrl(best.currentSrc || best.src);
    }
    if (!url) return Promise.resolve(null);
    return fetchResource(url)
      .then(function (r) {
        if (!r || !r.buf) return null;
        return createImageBitmap(new Blob([r.buf], { type: r.mime }))
          .then(function (bmp) {
            var maxW = 640;
            var scale = Math.min(1, maxW / bmp.width);
            var w = Math.max(1, Math.round(bmp.width * scale));
            var h = Math.max(1, Math.round(bmp.height * scale));
            var canvas = document.createElement("canvas");
            canvas.width = w;
            canvas.height = h;
            canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
            var dataUrl = canvas.toDataURL("image/jpeg", 0.82);
            var b64 = dataUrl.split(",")[1];
            return { b64: b64, mime: "image/jpeg" };
          })
          .catch(function () {
            // Not decodable (e.g. svg in some engines) — use raw bytes if small.
            if (r.bytes < 1.5 * 1024 * 1024) {
              return { b64: r.dataUri.split(",")[1], mime: r.mime };
            }
            return null;
          });
      })
      .catch(function () {
        return null;
      });
  }

  function collectMeta(opts) {
    function metaContent(sel) {
      var m = document.querySelector(sel);
      return m ? m.getAttribute("content") : null;
    }
    var title =
      (opts && opts.title) ||
      metaContent('meta[property="og:title"]') ||
      document.title ||
      location.hostname;
    var excerpt =
      metaContent('meta[name="description"]') ||
      metaContent('meta[property="og:description"]') ||
      null;
    if (!excerpt) {
      var ps = document.querySelectorAll("p");
      for (var i = 0; i < ps.length; i++) {
        var t = (ps[i].textContent || "").trim();
        if (t.length > 80) {
          excerpt = t.slice(0, 240);
          break;
        }
      }
    }
    var author = metaContent('meta[name="author"]') || metaContent('meta[property="article:author"]') || null;
    return { title: title.trim().slice(0, 300), excerpt: excerpt, author: author };
  }

  /* ================= archive capture (format 2) =================
     The Safari .webarchive model: keep the main document as the server sent
     it and store every subresource under its ORIGINAL URL. At read time a
     custom scheme serves them back, so the browser's own loader handles
     script identity, async ordering, module graphs and lifecycle events —
     no rewriting, no monkey-patching, no replay. */

  function cssPath(el) {
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement && parts.length < 12) {
      var parent = node.parentElement;
      if (!parent) break;
      var idx = 1;
      var sib = node;
      while ((sib = sib.previousElementSibling)) {
        if (sib.tagName === node.tagName) idx++;
      }
      parts.unshift(node.tagName.toLowerCase() + ":nth-of-type(" + idx + ")");
      node = parent;
    }
    return parts.length ? "html > " + parts.join(" > ") : null;
  }

  /** Every URL this page is known to have loaded. */
  function collectResourceUrls() {
    var urls = [];
    var seen = Object.create(null);
    function add(u) {
      if (!u) return;
      var abs = absUrl(u);
      if (!abs || !/^https?:/i.test(abs)) return;
      if (abs.split("#")[0] === location.href.split("#")[0]) return; // the doc itself
      if (seen[abs]) return;
      seen[abs] = true;
      urls.push(abs);
    }
    try {
      var entries = performance.getEntriesByType("resource");
      for (var i = 0; i < entries.length; i++) add(entries[i].name);
    } catch (e) {}
    // DOM references (covers anything that loaded before the timeline existed).
    var q = document.querySelectorAll("script[src], link[href], img[src], source[src], video[src], audio[src], video[poster]");
    for (var j = 0; j < q.length; j++) {
      var el = q[j];
      add(el.getAttribute("src") || el.getAttribute("href"));
      if (el.getAttribute("poster")) add(el.getAttribute("poster"));
      var ss = el.getAttribute("srcset");
      if (ss) {
        ss.split(",").forEach(function (part) { add(part.trim().split(/\s+/)[0]); });
      }
      // <img> may have resolved a different candidate than the attribute.
      if (el.currentSrc) add(el.currentSrc);
    }
    // Stylesheet-referenced assets (fonts, background images).
    try {
      for (var s = 0; s < document.styleSheets.length; s++) {
        var sheet = document.styleSheets[s];
        if (sheet.href) add(sheet.href);
      }
    } catch (e) {}
    // Anything the recorder saw (API payloads live here).
    RECORDER.entries.forEach(function (v) { add(v.u); });
    return urls;
  }

  /** Pull url(...) targets out of captured CSS so fonts/images come along. */
  function cssAssetUrls(cssText, baseUrl) {
    var out = [];
    try {
      cssText.replace(CSS_URL_RE, function (whole, q, raw) {
        var t = (raw || "").trim();
        if (!t || /^data:|^#/i.test(t)) return whole;
        var abs = absUrl(t, baseUrl);
        if (abs && /^https?:/i.test(abs)) out.push(abs);
        return whole;
      });
      cssText.replace(CSS_IMPORT_RE, function (whole, u1, u2) {
        var abs = absUrl((u1 || u2 || "").trim(), baseUrl);
        if (abs && /^https?:/i.test(abs)) out.push(abs);
        return whole;
      });
    } catch (e) {}
    return out;
  }

  function storeResource(url) {
    return fetchResource(url).then(function (r) {
      if (!r || !r.buf) return null;
      var b64 = r.dataUri.indexOf(",") >= 0 ? r.dataUri.slice(r.dataUri.indexOf(",") + 1) : null;
      if (!b64) return null;
      return invoke("capture_archive_resource", { url: url, mime: r.mime || "", b64: b64 })
        .then(function (ok) { return ok ? r : null; })
        .catch(function () { return null; });
    });
  }

  /**
   * Add each page the user marked with the include tool.
   *
   * The page is *loaded*, not just fetched: a hidden same-origin iframe runs
   * its scripts so route chunks, audio, lazily-imported modules and data
   * requests actually happen and can be observed through that frame's
   * resource timeline. A static HTML scan cannot see any of those — they
   * exist only once the page's own code runs.
   */
  function harvestPage(pageUrl) {
    return new Promise(function (resolve) {
      var frame = document.createElement("iframe");
      frame.setAttribute(UI_ATTR, "1");
      frame.setAttribute("src", pageUrl);
      frame.style.cssText =
        "position:fixed;left:-20000px;top:0;width:1280px;height:900px;" +
        "opacity:0;pointer-events:none;border:0;visibility:hidden";
      var settled = false;

      function collect() {
        if (settled) return;
        settled = true;
        var found = [];
        try {
          var w = frame.contentWindow;
          var d = w.document;
          var entries = w.performance.getEntriesByType("resource");
          for (var i = 0; i < entries.length; i++) {
            if (entries[i].initiatorType === "navigation") continue;
            found.push(entries[i].name);
          }
          var q = d.querySelectorAll(
            "script[src], link[href], img[src], source[src], video[src], audio[src], video[poster]",
          );
          for (var j = 0; j < q.length; j++) {
            var el = q[j];
            var raw = el.getAttribute("src") || el.getAttribute("href");
            if (raw) found.push(absUrl(raw, pageUrl));
            if (el.currentSrc) found.push(el.currentSrc);
          }
        } catch (e) {
          // Cross-origin or blocked framing — fall back to the static scan.
        }
        try { frame.remove(); } catch (e) {}
        resolve(found.filter(Boolean));
      }

      // Nudge the page so viewport-triggered work (lazy images, scroll-linked
      // loaders, audio preloads) actually fires before we look.
      function exercise() {
        var step = 0;
        var timer = setInterval(function () {
          try {
            var w = frame.contentWindow;
            step++;
            w.scrollTo(0, w.document.body.scrollHeight * (step / 6));
            w.dispatchEvent(new w.Event("resize"));
          } catch (e) {}
          if (step >= 6) {
            clearInterval(timer);
            setTimeout(collect, 1800);
          }
        }, 450);
      }

      frame.addEventListener("load", function () { setTimeout(exercise, 600); });
      setTimeout(collect, 25000); // hard cap so one bad page can't stall a capture
      document.body.appendChild(frame);
    });
  }

  /** Static fallback when a page refuses to be framed. */
  function staticScan(html, pageUrl) {
    var out = [];
    try {
      var doc = new DOMParser().parseFromString(html, "text/html");
      var nodes = doc.querySelectorAll(
        "script[src], link[rel~=stylesheet], link[rel~=icon], link[as], img[src]",
      );
      for (var n = 0; n < nodes.length; n++) {
        var raw = nodes[n].getAttribute("src") || nodes[n].getAttribute("href");
        var abs = absUrl(raw, pageUrl);
        if (abs) out.push(abs);
      }
    } catch (e) {}
    return out;
  }

  function fetchIncludedPages() {
    var pages = includedOrder.slice(0, 60);
    if (!pages.length) return Promise.resolve(0);
    progress("Adding linked pages", pages.length + " selected");
    var stored = 0;

    // Sequential: each page is loaded for real, and running several at once
    // would distort what the page does on its own.
    var chain = Promise.resolve();
    pages.forEach(function (pageUrl, i) {
      chain = chain.then(function () {
        progress("Loading page " + (i + 1) + " of " + pages.length, INCLUDED[pageUrl] || pageUrl);
        return (origFetch || window.fetch)(pageUrl, { credentials: "include" })
          .then(function (r) {
            if (!r || !r.ok) return null;
            var ct = (r.headers.get("content-type") || "").split(";")[0].trim();
            if (ct && ct.indexOf("html") === -1) return null;
            return r.text();
          })
          .catch(function () { return null; })
          .then(function (html) {
            if (!html) {
              progress("Linked page unavailable", pageUrl);
              return;
            }
            var bytes = new TextEncoder().encode(html);
            return invoke("capture_archive_resource", {
              url: pageUrl,
              mime: "text/html",
              b64: bytesToB64(bytes.buffer),
            })
              .then(function () {
                stored++;
                return harvestPage(pageUrl);
              })
              .then(function (found) {
                var list = (found && found.length ? found : staticScan(html, pageUrl)).filter(
                  function (u, idx, arr) {
                    return (
                      /^https?:/i.test(u) &&
                      arr.indexOf(u) === idx &&
                      !resourceCache.has(u) &&
                      u.split("#")[0] !== pageUrl.split("#")[0]
                    );
                  },
                );
                if (!list.length) return;
                progress("Saving page " + (i + 1) + " assets", list.length + " resources");
                return runJobs(
                  list.slice(0, 400).map(function (u) {
                    return function () { return storeResource(u); };
                  }),
                  6,
                );
              })
              .catch(function () {});
          });
      });
    });

    return chain.then(function () {
      if (stored) progress("Linked pages added", stored + " of " + pages.length);
      return stored;
    });
  }

  function archiveSnapshot(opts) {
    var removedSelectors = [];
    for (var i = 0; i < cleanup.removed.length; i++) {
      var sel = cssPath(cleanup.removed[i]);
      if (sel) removedSelectors.push(sel);
    }

    progress("Starting", location.hostname);
    return invoke("capture_archive_begin", { mainUrl: location.href })
      .then(function () {
        // The ORIGINAL server document — what the page's own scripts expect
        // to hydrate against. Re-fetched with credentials so paywalled and
        // logged-in pages come back the way the user sees them.
        progress("Fetching the page source");
        return (origFetch || window.fetch)(location.href, {
          credentials: "include",
          cache: "force-cache",
        })
          .then(function (r) { return r.ok ? r.text() : null; })
          .catch(function () { return null; });
      })
      .then(function (serverHtml) {
        var urls = collectResourceUrls();
        progress("Collecting resources", urls.length + " found");
        var done = 0;
        var cssFollowUps = [];
        return runJobs(
          urls.map(function (u) {
            return function () {
              return storeResource(u).then(function (r) {
                done++;
                if (done % 10 === 0) progress("Saving resources", done + " / " + urls.length);
                if (r && r.buf && /css/i.test(r.mime || "")) {
                  try {
                    var txt = new TextDecoder("utf-8").decode(r.buf);
                    cssAssetUrls(txt, u).forEach(function (a) { cssFollowUps.push(a); });
                  } catch (e) {}
                }
              });
            };
          }),
          6,
        ).then(function () {
          // Second pass: assets referenced from inside stylesheets.
          var extra = cssFollowUps.filter(function (u, i) {
            return cssFollowUps.indexOf(u) === i && !resourceCache.has(u);
          });
          if (!extra.length) return serverHtml;
          progress("Saving stylesheet assets", extra.length + " found");
          return runJobs(
            extra.map(function (u) { return function () { return storeResource(u); }; }),
            6,
          ).then(function () { return serverHtml; });
        });
      })
      .then(function (serverHtml) {
        return fetchIncludedPages().then(function () { return serverHtml; });
      })
      .then(function (serverHtml) {
        progress("Choosing a cover");
        return pickCover().then(function (cover) {
          return { html: serverHtml, cover: cover };
        });
      })
      .then(function (got) {
        var html = got.html;
        if (!html) {
          // Could not re-fetch (rare): fall back to the live DOM, which at
          // least preserves what the user prepared.
          progress("Using the live DOM", "page source unavailable");
          var clone = document.documentElement.cloneNode(true);
          var strays = clone.querySelectorAll("[" + UI_ATTR + "], [" + REMOVED_ATTR + "]");
          for (var i = 0; i < strays.length; i++) {
            if (strays[i].parentNode) strays[i].parentNode.removeChild(strays[i]);
          }
          html = "<!DOCTYPE html>\n" + clone.outerHTML;
          removedSelectors = []; // already applied
        }
        if (removedSelectors.length) {
          var payload = JSON.stringify(removedSelectors).replace(/</g, "\\u003c");
          var tag =
            '<script type="application/json" id="prophet-cleanup">' + payload + "</" + "script>";
          var at = html.toLowerCase().lastIndexOf("</body>");
          html = at > -1 ? html.slice(0, at) + tag + html.slice(at) : html + tag;
        }
        var meta = collectMeta(opts);
        progress("Saving", Math.round(html.length / 1024) + " KB page + resources");
        return invoke("capture_archive_finish", {
          doc: {
            title: meta.title,
            sourceUrl: location.href,
            author: meta.author,
            excerpt: meta.excerpt,
            mainHtml: html,
            coverB64: got.cover ? got.cover.b64 : null,
            coverMime: got.cover ? got.cover.mime : null,
            scripts: true,
          },
        });
      });
  }

  var snapshotRunning = false;

  function snapshot(opts) {
    opts = opts || {};
    if (snapshotRunning) return;
    snapshotRunning = true;
    api.endCleanup();
    RECORDER.active = false; // our own serializer traffic must not enter the vault

    // Interactive captures use the resource-map archive: the page keeps its
    // real URLs and the browser loads it natively at read time. Only the
    // "no scripts" mode still flattens into a single file.
    if (opts.includeScripts !== false) {
      archiveSnapshot(opts)
        .catch(function (e) {
          invoke("capture_failed", { message: String((e && e.message) || e) }).catch(function () {});
        })
        .then(function () {
          snapshotRunning = false;
          RECORDER.active = true;
        });
      return;
    }

    progress("Starting", location.hostname);
    if (opts.includeScripts) opts.stripDynamic = planDynamicStrip();
    var clone = document.documentElement.cloneNode(true);
    var jobs = [];

    try {
      walkPair(document.documentElement, clone, jobs, opts);
    } catch (e) {
      snapshotRunning = false;
      invoke("capture_failed", { message: "walk failed: " + (e && e.message) }).catch(function () {});
      return;
    }

    // Document-level constructed stylesheets.
    try {
      var adopted = document.adoptedStyleSheets || [];
      var head = clone.querySelector("head");
      for (var a = 0; a < adopted.length; a++) {
        (function (sheet) {
          var styleEl = document.createElement("style");
          if (head) head.appendChild(styleEl);
          jobs.push(function () {
            return serializeSheet(sheet).then(function (got) {
              return processCss(got.css, got.base, 0).then(function (css) {
                styleEl.textContent = css;
              });
            });
          });
        })(adopted[a]);
      }
    } catch (e) {}

    progress("Processing " + jobs.length + " resources");

    runJobs(jobs, 8)
      .then(function () {
        return buildVault(opts);
      })
      .then(function (vault) {
        progress("Choosing a cover");
        return pickCover().then(function (cover) {
          return { vault: vault, cover: cover };
        });
      })
      .then(function (got) {
        progress("Serializing document");
        stripDangerous(clone, opts);

        // Provenance + charset hygiene + the offline replay vault.
        var head = clone.querySelector("head");
        if (head) {
          if (got.vault) {
            var vaultScript = document.createElement("script");
            vaultScript.setAttribute("type", "application/json");
            vaultScript.setAttribute("id", "prophet-vault");
            vaultScript.textContent = JSON.stringify(got.vault).replace(/</g, "\\u003c");
            head.insertBefore(vaultScript, head.firstChild);
          }
          var srcMeta = document.createElement("meta");
          srcMeta.setAttribute("name", "prophet-source");
          srcMeta.setAttribute("content", location.href);
          head.insertBefore(srcMeta, head.firstChild);
          if (!head.querySelector("meta[charset]")) {
            var cs = document.createElement("meta");
            cs.setAttribute("charset", "utf-8");
            head.insertBefore(cs, head.firstChild);
          }
        }

        var html = "<!DOCTYPE html>\n" + clone.outerHTML;
        var meta = collectMeta(opts);
        progress("Saving", Math.round(html.length / 1024) + " KB");
        return invoke("capture_deliver", {
          doc: {
            title: meta.title,
            sourceUrl: location.href,
            author: meta.author,
            excerpt: meta.excerpt,
            scripts: !!opts.includeScripts,
            html: html,
            coverB64: got.cover ? got.cover.b64 : null,
            coverMime: got.cover ? got.cover.mime : null,
          },
        });
      })
      .catch(function (e) {
        invoke("capture_failed", { message: String((e && e.message) || e) }).catch(function () {});
      })
      .then(function () {
        snapshotRunning = false;
        RECORDER.active = true;
      });
  }

  /* ================= public api ================= */

  function ensureStyle() {
    if (cleanup.styleEl) return;
    cleanup.styleEl = document.createElement("style");
    cleanup.styleEl.setAttribute(UI_ATTR, "1");
    cleanup.styleEl.textContent =
      "[" + REMOVED_ATTR + "]{display:none !important;}" +
      "[" + INCLUDED_ATTR + "]{outline:2px solid #1d7a4c !important;outline-offset:1px;" +
      "background-color:rgba(29,122,76,0.14) !important;border-radius:2px;}";
    document.documentElement.appendChild(cleanup.styleEl);
  }

  function startOverlay(mode) {
    cleanup.mode = mode;
    if (cleanup.active) {
      // Switching modes: reset hover state, keep listeners.
      cleanup.baseEl = null;
      cleanup.level = 0;
      hideBox();
      updateBar();
      return;
    }
    cleanup.active = true;
    ensureStyle();
    if (!cleanup.host) buildOverlay();
    cleanup.host.style.display = "block";
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
    updateBar();
    reportCount();
  }

  function updateBar() {
    if (!cleanup.shadow) return;
    var bar = cleanup.shadow.querySelector(".bar");
    var hint = cleanup.shadow.querySelector(".hint");
    var include = cleanup.mode === "include";
    if (bar) bar.style.display = include ? "none" : "flex";
    if (hint) hint.textContent = include ? "click a link to add its page" : "click removes · ↑ grows";
  }

  var api = {
    beginCleanup: function () {
      startOverlay("cleanup");
    },
    beginInclude: function () {
      ensureStyle();
      paintIncluded();
      startOverlay("include");
      reportIncluded();
    },
    endCleanup: function () {
      if (!cleanup.active) return;
      cleanup.active = false;
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey, true);
      hideBox();
      if (cleanup.host) cleanup.host.style.display = "none";
    },
    clearIncluded: function () {
      INCLUDED = Object.create(null);
      includedOrder = [];
      paintIncluded();
      reportIncluded();
    },
    /** Adds the page currently being browsed (the manual fallback). */
    includeCurrent: function () {
      var u = location.href.split("#")[0];
      if (!INCLUDED[u]) {
        INCLUDED[u] = (document.title || u).slice(0, 90);
        includedOrder.push(u);
      }
      reportIncluded();
    },
    undo: function () {
      var el = cleanup.removed.pop();
      if (el) el.removeAttribute(REMOVED_ATTR);
      reportCount();
    },
    restoreAll: function () {
      while (cleanup.removed.length) {
        cleanup.removed.pop().removeAttribute(REMOVED_ATTR);
      }
      // Also clear strays from a previous visit to this page.
      var strays = document.querySelectorAll("[" + REMOVED_ATTR + "]");
      for (var i = 0; i < strays.length; i++) strays[i].removeAttribute(REMOVED_ATTR);
      reportCount();
    },
    snapshot: snapshot,

    /** Adds pages to a document that already exists in the library. */
    appendPages: function (docId, urls) {
      if (snapshotRunning) return;
      snapshotRunning = true;
      RECORDER.active = false;
      INCLUDED = Object.create(null);
      includedOrder = [];
      (urls || []).forEach(function (u) {
        if (!INCLUDED[u]) {
          INCLUDED[u] = u;
          includedOrder.push(u);
        }
      });
      progress("Adding pages", includedOrder.length + " selected");
      invoke("capture_archive_open_existing", { id: docId })
        .then(function () { return fetchIncludedPages(); })
        .then(function () { return invoke("capture_archive_commit"); })
        .catch(function (e) {
          invoke("capture_failed", { message: String((e && e.message) || e) }).catch(function () {});
        })
        .then(function () {
          snapshotRunning = false;
          RECORDER.active = true;
        });
    },
  };

  window.__PROPHET_CAPTURE__ = api;
})();
