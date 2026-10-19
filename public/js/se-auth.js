// Prep-page session helper (window.SeAuth).
//
// Prep pages read localStorage se_token into a Bearer header with no refresh
// path, so once the 7-day access token aged out a signed-in member hit
// "Sign in to continue" in the interview gate and the nav PRO chip dropped to
// paying members — site pages already recover via the 30-day rotating
// se_refresh token (feed-app.js / main.js), prep pages never did.
//
//   token() / haveRefresh() / haveSession()
//   refresh()        -> Promise<bool>; only one refresh in flight at a time
//   fetch(url, opts) -> Response; refreshes when the token is missing or the
//                       server answers 401, then retries exactly once
(function () {
  "use strict";

  function lsGet(k) {
    try { return localStorage.getItem(k); } catch (e) { return null; }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(k, v); } catch (e) { /* private mode */ }
  }

  function token() { return lsGet("se_token") || ""; }
  function haveRefresh() { return !!lsGet("se_refresh"); }
  function haveSession() { return !!token() || haveRefresh(); }

  function store(access, refresh) {
    if (access) lsSet("se_token", access);
    if (refresh) lsSet("se_refresh", refresh);
  }

  // POST /api/auth/refresh {refreshToken} -> {data:{accessToken, refreshToken}}.
  // On failure leave storage alone: a sibling tab may have just rotated this
  // refresh token and already written the fresh pair.
  function refresh() {
    if (window.__seAuthRefreshP) return window.__seAuthRefreshP;
    var rt = lsGet("se_refresh");
    if (!rt) return Promise.resolve(false);
    var p = fetch("/api/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: rt }),
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (d && d.success && d.data && d.data.accessToken) {
          store(d.data.accessToken, d.data.refreshToken);
          return true;
        }
        return false;
      })
      .catch(function () { return false; })
      .then(function (ok) { window.__seAuthRefreshP = null; return ok; });
    window.__seAuthRefreshP = p;
    return p;
  }

  function authedFetch(url, opts) {
    var o = opts || {};
    // No token: exchange the refresh token first so the retry carries a fresh
    // Bearer. No session at all: plain fetch — the caller's 401 handling runs.
    var start = token()
      ? Promise.resolve(true)
      : haveRefresh()
        ? refresh()
        : Promise.resolve(false);
    return start.then(function () {
      var t = token();
      if (!t) return fetch(url, o);
      var headers = {};
      if (o.headers) {
        for (var k in o.headers) {
          if (Object.prototype.hasOwnProperty.call(o.headers, k)) headers[k] = o.headers[k];
        }
      }
      var merged = {};
      for (var kk in o) {
        if (Object.prototype.hasOwnProperty.call(o, kk)) merged[kk] = o[kk];
      }
      merged.headers = headers;
      // Authorization only — never content-type: FormData bodies must keep
      // their multipart boundary (JSON callers pass their own content-type).
      headers["Authorization"] = "Bearer " + t;
      return fetch(url, merged).then(function (r) {
        if (r.status !== 401) return r;
        return refresh().then(function (ok) {
          if (!ok) return r;
          var t2 = token();
          if (!t2) return r;
          headers["Authorization"] = "Bearer " + t2;
          return fetch(url, merged);
        });
      });
    });
  }

  window.SeAuth = {
    token: token,
    haveRefresh: haveRefresh,
    haveSession: haveSession,
    refresh: refresh,
    fetch: authedFetch,
  };
})();
