// Vanilla-JS i18n-Loader fuer statische Pages OHNE Alpine.
// Verwendung:
//   <script src="/static/locales-vanilla.js"></script>
//   <h1 data-i18n="lead.headline">Original-Text als Fallback</h1>
//   <input data-i18n-placeholder="form.name" placeholder="Original">
//   <a data-i18n-title="legal.note" title="Original">
//   <a href="#" data-i18n="btn.next">Original</a>
//
// Locale-Auswahl: ?lang= URL-Param > localStorage.lang > navigator.language > "de".
// Persistiert in localStorage. Stellt window.__setLocale(lang) bereit.

(function () {
  var SUPPORTED = ["de", "en", "fr"];
  var FALLBACK = "de";

  function detect() {
    try {
      var u = new URL(window.location.href);
      var q = (u.searchParams.get("lang") || "").toLowerCase();
      if (SUPPORTED.indexOf(q) >= 0) {
        try { localStorage.setItem("lang", q); } catch (e) {}
        return q;
      }
    } catch (e) {}
    try {
      var s = (localStorage.getItem("lang") || "").toLowerCase();
      if (SUPPORTED.indexOf(s) >= 0) return s;
    } catch (e) {}
    var n = (navigator.language || "de").slice(0, 2).toLowerCase();
    return SUPPORTED.indexOf(n) >= 0 ? n : FALLBACK;
  }

  var current = detect();
  var dict = {};

  function applyToDOM() {
    var nodes = document.querySelectorAll("[data-i18n]");
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var key = el.getAttribute("data-i18n");
      if (key && dict[key] != null) el.textContent = dict[key];
    }
    var attrs = ["placeholder", "title", "alt", "aria-label", "value"];
    for (var a = 0; a < attrs.length; a++) {
      var attr = attrs[a];
      var sel = "[data-i18n-" + attr + "]";
      var nodes2 = document.querySelectorAll(sel);
      for (var j = 0; j < nodes2.length; j++) {
        var el2 = nodes2[j];
        var key2 = el2.getAttribute("data-i18n-" + attr);
        if (key2 && dict[key2] != null) el2.setAttribute(attr, dict[key2]);
      }
    }
    document.documentElement.setAttribute("lang", current);
    // <title> via data-i18n-title-tag
    var t = document.querySelector("title[data-i18n]");
    if (t) {
      var k = t.getAttribute("data-i18n");
      if (k && dict[k] != null) document.title = dict[k];
    }
    // Locale-Switcher Buttons markieren
    var btns = document.querySelectorAll("[data-i18n-switch]");
    for (var b = 0; b < btns.length; b++) {
      var btn = btns[b];
      btn.classList.toggle("active", btn.getAttribute("data-i18n-switch") === current);
    }
  }

  function load(lang) {
    if (SUPPORTED.indexOf(lang) < 0) lang = FALLBACK;
    return fetch("/api/i18n/" + lang + ".json", { credentials: "omit" })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (d) { dict = d || {}; current = lang; applyToDOM(); })
      .catch(function (e) { console.warn("i18n load failed", e); });
  }

  window.__setLocale = function (lang) {
    try { localStorage.setItem("lang", lang); } catch (e) {}
    load(lang);
  };
  window.__currentLocale = function () { return current; };
  window.__t = function (key) { return dict[key] != null ? dict[key] : key; };

  // Initial laden
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { load(current); });
  } else {
    load(current);
  }
})();
