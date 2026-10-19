// Prep nav icon + prep-page nav fixes. Injected client-side only when the
// server says FEATURE_PREP is on, so with the flag off the icon row is
// byte-for-byte what it was before (src/lib/nav-badge.test.ts keeps guarding
// the static markup).
//
// Three jobs, all idempotent:
// 1. Prep icon FIRST in the row, ahead of Home/Feed. The server ships a
//    prep_nav cookie WITH the HTML response, so on flag-on the icon paints
//    synchronously at script time — no 2s gap while /flag round-trips when
//    switching tabs. The fetch below still revalidates either way.
// 2. Wallet icon: feed-app.js adds it on feed-family pages, but prep pages
//    don't load feed-app.js — mirror that exact insertion here.
// 3. Avatar: prep pages don't load feed-app.js either, so #navAv would stay
//    on the dicebear default. Paint from the cached session instantly, then
//    refresh from /api/auth/me (the authoritative account read).
(function () {
  "use strict";
  var ICONS = ".topnav .icons";
  var row = document.querySelector(ICONS);
  if (!row) return;

  function inject(enabled) {
    if (!enabled) return;
    if (row.querySelector('a[href="/prep"]')) return;
    var a = document.createElement("a");
    a.href = "/prep";
    a.title = "Prep";
    a.setAttribute("data-prep-nav", "1");
    a.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>' +
      '<path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/>' +
      '<path d="M9 7.5h6"/>' +
      "</svg>";
    var first = row.firstElementChild;
    if (first) row.insertBefore(a, first);
    else row.appendChild(a);
  }

  function cookieEnabled() {
    return /(?:^|;\s*)prep_nav=1(?:;|$)/.test(document.cookie);
  }

  // Instant path: the cookie rides along with this page's own response, so it
  // is readable by the time this deferred script runs — even on first load.
  if (cookieEnabled()) inject(true);

  fetch("/api/prep/flag", { credentials: "same-origin" })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      var on = !!(d && d.success && d.data && d.data.enabled);
      if (on) inject(true);
      else {
        var stale = row.querySelector('a[href="/prep"]');
        if (stale) stale.parentNode.removeChild(stale);
        document.cookie = "prep_nav=; Max-Age=0; Path=/";
      }
    })
    .catch(function () { /* offline: keep the cached icon as-is */ });

  // ── wallet icon (mirrors feed-app.js buildTopnavDropdown) ──
  if (!row.querySelector('a[href="/wallet.html"]')) {
    var w = document.createElement("a");
    w.href = "/wallet.html";
    w.title = "Wallet";
    w.innerHTML = '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="15" rx="2.5"/><path d="M3 10h18"/><circle cx="16" cy="15" r="1.6"/></svg>';
    var anchor = row.querySelector("#navProfile") || row.lastElementChild;
    row.insertBefore(w, anchor);
  }

  // ── nav avatar ──
  var av = document.getElementById("navAv");
  if (av) {
    function applyAvatar(u) {
      if (!u) return;
      var src = u.profilePhoto ||
        "https://api.dicebear.com/9.x/initials/svg?seed=" +
          encodeURIComponent(u.email || u.firstName || "grit") +
          "&backgroundColor=f0f0f0&textColor=262626&bold=true";
      if (av.getAttribute("src") !== src) av.src = src;
    }
    try {
      var cached = JSON.parse(localStorage.getItem("se_user") || "null");
      if (cached && (cached.id || cached.email)) applyAvatar(cached);
    } catch (e) { /* corrupted cache: fall through to the server read */ }
    var token = localStorage.getItem("se_token");
    if (token) {
      fetch("/api/auth/me", { headers: { Authorization: "Bearer " + token } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          var fresh = d && d.success && d.data && d.data.user;
          if (!fresh || !fresh.id) return;
          applyAvatar(fresh);
          try { localStorage.setItem("se_user", JSON.stringify(Object.assign({}, cached, fresh))); } catch (e) { /* private mode */ }
        })
        .catch(function () { /* keep the cached avatar */ });
    }
  }
})();
