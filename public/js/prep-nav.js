// Prep nav icon + prep-page nav fixes. Injected client-side only when the
// server says FEATURE_PREP is on, so with the flag off the icon row is
// byte-for-byte what it was before (src/lib/nav-badge.test.ts keeps guarding
// the static markup).
//
// Jobs, all idempotent:
// 0. Stale prep-page self-heal (see below): re-fetch outdated prep HTML once.
// 1. Prep icon FIRST in the row, ahead of Home/Feed. The server ships a
//    prep_nav cookie WITH the HTML response, so on flag-on the icon paints
//    synchronously at script time — no 2s gap while /flag round-trips when
//    switching tabs. The fetch below still revalidates either way.
// 2. Feed right-rail promo: when a page has the .sidebar rail, a Prep feature
//    card is inserted FIRST so the rail leads with the new feature; "On the
//    grind" and the account card follow below it.
// 3. Wallet icon: feed-app.js adds it on feed-family pages, but prep pages
//    don't load feed-app.js — mirror that exact insertion here.
// 4. Avatar: prep pages don't load feed-app.js either, so #navAv would stay
//    on the dicebear default. Paint from the cached session instantly, then
//    refresh from /api/auth/me (the authoritative account read).
(function () {
  "use strict";
  // 0. Stale-HTML self-heal: prep documents stamp window.PREP_V inline. The
  //    server ships this script with max-age=0, so the nav script is always
  //    current even when the page HTML came from an old browser cache — which
  //    would otherwise leave users tapping dead buttons on outdated prep
  //    markup (a Buy click that "does nothing", a report link that 404s).
  //    Reload once through a cache-busting query: never a loop, because the
  //    re-fetched document carries the stamp, and _pv already present stops
  //    us from trying again.
  var WANT_V = 9;
  if (window.PREP_V !== WANT_V &&
      /\/prep(?:\/|$)/.test(location.pathname) &&
      !/[?&]_pv=/.test(location.search)) {
    location.replace(location.pathname + location.search +
      (location.search ? "&" : "?") + "_pv=" + WANT_V);
    return;
  }
  var ICONS = ".topnav .icons";
  var row = document.querySelector(ICONS);
  if (!row) return;

  function removePrepIcon() {
    var stale = row.querySelector('a[href="/prep"]');
    if (stale) stale.parentNode.removeChild(stale);
  }

  function promoMarkup() {
    return '<span class="prep-rail-kicker" style="display:inline-block;font-size:0.64rem;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;color:#5430C9;background:#F0ECFD;border:1px solid rgba(108,63,232,.2);border-radius:999px;padding:4px 10px;">New - Prep</span>' +
      '<b style="display:block;font-size:0.95rem;margin:5px 0 5px;color:#0A0A0F;">Company research you can trust</b>' +
      '<p style="font-size:0.8rem;color:#555;line-height:1.5;margin:0 0 10px;">Sourced company reports, aptitude drills, ' +
      "interview mocks and anonymised pay signals - every claim labelled with its source.</p>" +
      '<a href="/prep" style="display:inline-flex;align-items:center;gap:5px;font-size:0.82rem;font-weight:700;color:#6C3FE8;">Open Prep &rarr;</a>';
  }

  function injectPromo() {
    var side = document.querySelector(".sidebar");
    if (!side) return;
    if (side.querySelector("[data-prep-promo]")) return;
    var p = document.createElement("div");
    p.className = "side-card";
    p.setAttribute("data-prep-promo", "1");
    p.innerHTML = promoMarkup();
    side.insertBefore(p, side.firstElementChild);
  }

  function removePromo() {
    var p = document.querySelector("[data-prep-promo]");
    if (p && p.parentNode) p.parentNode.removeChild(p);
  }

  function inject(enabled) {
    if (!enabled) {
      removePrepIcon();
      removePromo();
      document.cookie = "prep_nav=; Max-Age=0; Path=/";
      return;
    }
    if (!row.querySelector('a[href="/prep"]')) {
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
    injectPromo();
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
      inject(!!(d && d.success && d.data && d.data.enabled));
    })
    .catch(function () { /* offline: keep the cached state as-is */ });

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

  // ── 4b. Pending Prep Pro payment self-heal ──
  // If the browser died (or the network blipped) AFTER Razorpay captured the
  // money but BEFORE /pro/verify answered, the order sits PENDING with no
  // entitlement — the classic "I paid but still see Buy Prep Pro". The
  // checkout stashes {order, payment} as se_pro_pend; retry the verify once
  // per page load. 5xx/network failures keep the stash for the next load;
  // any definitive response (success or "not capturable") clears it.
  try {
    var pendTok = localStorage.getItem("se_token");
    var pend = JSON.parse(localStorage.getItem("se_pro_pend") || "null");
    if (pend && pend.o && pend.p && pend.ts && Date.now() - pend.ts < 24 * 60 * 60 * 1000) {
      if (pendTok) {
        fetch("/api/prep/pro/verify", {
          method: "POST",
          credentials: "same-origin",
          headers: { Authorization: "Bearer " + pendTok, "content-type": "application/json" },
          body: JSON.stringify({ razorpayOrderId: pend.o, razorpayPaymentId: pend.p }),
        })
          .then(function (r) {
            if (r.status >= 500) return null; // transient: keep the stash, retry next load
            return r.json().then(function (d) { return { status: r.status, d: d }; });
          })
          .then(function (v) {
            if (v === null) return;
            try { localStorage.removeItem("se_pro_pend"); } catch (e) { /* private mode */ }
            // 409 = the entitlement already exists (verify ran twice).
            var ok = (v.status >= 200 && v.status < 300 && v.d && v.d.success) || v.status === 409;
            if (ok) {
              try { localStorage.setItem("se_pro", JSON.stringify({ v: 1, ts: Date.now(), pro: true })); } catch (e) { /* private mode */ }
              location.reload();
            }
          })
          .catch(function () { /* network: keep the stash for the next load */ });
      }
    } else if (pend && pend.ts && Date.now() - pend.ts >= 24 * 60 * 60 * 1000) {
      try { localStorage.removeItem("se_pro_pend"); } catch (e) { /* private mode */ }
    }
  } catch (e) { /* private mode: no recovery available */ }

  // ── 5. Prep Pro chip ──
  // A small PRO pill next to the prep icon while the account holds an active
  // Prep Pro entitlement. Painted from the cached verdict instantly; the
  // server read happens at most once per 5 minutes so normal browsing never
  // crowds the shared /pro/status rate limit.
  try {
    var proTok = localStorage.getItem("se_token");
    var verdict = JSON.parse(localStorage.getItem("se_pro") || "null");
    function paintPro(on) {
      // Upgrade CTAs (e.g. "See Prep Pro") must disappear the moment the
      // account is a member — a paid user should never see the buy button.
      var ups = document.querySelectorAll("[data-pro-upgrade]");
      for (var ui = 0; ui < ups.length; ui++) ups[ui].style.display = on ? "none" : "";
      var chip = row.querySelector("[data-prep-pro-chip]");
      if (!on) { if (chip && chip.parentNode) chip.parentNode.removeChild(chip); return; }
      if (chip) return;
      chip = document.createElement("span");
      chip.setAttribute("data-prep-pro-chip", "1");
      chip.textContent = "PRO";
      chip.title = "Prep Pro member";
      chip.style.cssText = "font-size:0.6rem;font-weight:800;letter-spacing:0.08em;padding:3px 8px;border-radius:999px;" +
        "background:linear-gradient(135deg,#6C3FE8,#B929E8);color:#fff;line-height:1.4;cursor:default;";
      var chipAnchor = row.querySelector('a[href="/prep"]') || row.querySelector("#navProfile") || row.lastElementChild;
      if (chipAnchor) row.insertBefore(chip, chipAnchor.nextSibling);
      else row.appendChild(chip);
    }
    if (!proTok) {
      localStorage.removeItem("se_pro");
      paintPro(false);
      } else {
        var stamp = verdict && verdict.ts ? verdict.ts : 0;
        var fresh = stamp && (Date.now() - stamp) < 5 * 60 * 1000;
        if (fresh) {
          paintPro(verdict.pro === true);
        } else {
          fetch("/api/prep/pro/status", { credentials: "same-origin", headers: { Authorization: "Bearer " + proTok } })
            .then(function (r) {
              if (r.status === 401) {
                // Session is truly gone — drop the cache and the chip.
                try { localStorage.removeItem("se_pro"); } catch (e) { /* private mode */ }
                paintPro(false);
                return null;
              }
              // Rate limit or a server hiccup: keep whatever is painted and
              // never cache it as "not pro" — a refresh must not hide badges.
              if (!r.ok) return null;
              return r.json();
            })
            .then(function (d) {
              if (!d || !d.success) return;
              var on = !!(d.data && d.data.isPro);
              try { localStorage.setItem("se_pro", JSON.stringify({ v: 1, ts: Date.now(), pro: on })); } catch (e) { /* private mode */ }
              paintPro(on);
            })
            .catch(function () { /* offline: keep whatever is painted */ });
        }
      }
  } catch (e) { /* private mode: no chip, no cache */ }
})();
