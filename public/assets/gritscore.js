/* GritScore shared client helpers: auth headers, API calls, formatting. */
(function () {
  var API = '/api/gritscore';

  function token() {
    try { return localStorage.getItem('se_token') || ''; } catch (e) { return ''; }
  }

  function user() {
    try { return JSON.parse(localStorage.getItem('se_user') || 'null'); } catch (e) { return null; }
  }

  function authHeaders(extra) {
    var headers = extra || {};
    var t = token();
    if (t) headers.Authorization = 'Bearer ' + t;
    return headers;
  }

  // Route auth-carrying calls through the shared SeAuth helper when it is on
  // the page. A 7-day access token ages out long before the 30-day refresh
  // token, and without this a signed-in member saw "Token expired" and an
  // empty card list. SeAuth exchanges se_refresh for a new se_token and
  // retries once; fall back to a plain bearer request when it is absent.
  function authedFetch(url, init) {
    if (window.SeAuth && typeof window.SeAuth.fetch === 'function') {
      return window.SeAuth.fetch(url, init);
    }
    var opts = init || {};
    var headers = {};
    for (var k in (opts.headers || {})) {
      if (Object.prototype.hasOwnProperty.call(opts.headers, k)) headers[k] = opts.headers[k];
    }
    var t = token();
    if (t) headers.Authorization = 'Bearer ' + t;
    opts.headers = headers;
    return fetch(url, opts);
  }

  // Proxy restarts and oversized uploads come back as HTML, not JSON. Turn
  // those into a sentence a person can act on instead of "Unexpected server
  // response", and retry an idempotent GET once when the proxy was restarting.
  function friendlyStatus(status) {
    if (status === 401) return 'Your session expired. Sign in again.';
    if (status === 403) return 'You do not have access to that.';
    if (status === 404) return 'That item could not be found.';
    if (status === 413) return 'That upload is too large. Keep each file under 5 MB.';
    if (status === 429) return 'Too many requests. Try again in a minute.';
    if (status === 502 || status === 503 || status === 504) {
      return 'The server took too long to answer. Try again in a moment.';
    }
    return 'Something went wrong (HTTP ' + status + '). Please try again.';
  }

  function readResponse(res) {
    var type = (res.headers.get('content-type') || '').toLowerCase();
    if (type.indexOf('json') === -1) {
      return res.text().catch(function () { return ''; }).then(function () {
        return { status: res.status, ok: false, data: { success: false, message: friendlyStatus(res.status) } };
      });
    }
    return res.json().catch(function () {
      return { success: false, message: friendlyStatus(res.status) };
    }).then(function (data) {
      return { status: res.status, ok: res.ok, data: data };
    });
  }

  function request(path, options) {
    var opts = options || {};
    var method = opts.method || 'GET';
    var init = {
      method: method,
      headers: authHeaders(opts.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      credentials: 'same-origin'
    };
    if (opts.body instanceof FormData) init.body = opts.body;
    else if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    var timeout = opts.timeout || 45000;
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, timeout) : null;
    if (ctl) init.signal = ctl.signal;
    var url = API + path;
    return authedFetch(url, init).then(function (res) {
      if (method !== 'GET' || res.status < 502 || res.status > 504) return res;
      return new Promise(function (resolve) {
        setTimeout(function () { resolve(authedFetch(url, init)); }, 700);
      });
    }).then(readResponse).finally(function () { if (timer) clearTimeout(timer); });
  }

  function toast(message, ms) {
    var el = document.getElementById('gsToast');
    if (!el) return;
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.classList.remove('show'); }, ms || 3200);
  }

  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function plural(n, one, many) {
    return n === 1 ? one : (many || one + 's');
  }

  function timeAgo(value) {
    if (!value) return '';
    var then = new Date(value).getTime();
    if (!isFinite(then)) return '';
    var diff = Math.max(0, Date.now() - then);
    var mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    var hours = Math.floor(mins / 60);
    if (hours < 24) return hours + 'h ago';
    var days = Math.floor(hours / 24);
    if (days < 30) return days + 'd ago';
    var months = Math.floor(days / 30);
    if (months < 12) return months + 'mo ago';
    return Math.floor(months / 12) + 'y ago';
  }

  var EVIDENCE_LABEL = {
    liveLink: 'Live link',
    github: 'Repository',
    published: 'Published',
    certificate: 'Certificate',
    file: 'Document',
    screenshot: 'Screenshot',
    none: 'No proof'
  };

  var STATUS_LABEL = {
    ok: { text: 'Link responds', cls: 'ok' },
    blocked: { text: 'Blocks bots', cls: 'warn' },
    dead: { text: 'Link is dead', cls: 'bad' },
    duplicate: { text: 'Reused URL', cls: 'bad' },
    invalid: { text: 'Not a usable link', cls: 'bad' },
    unchecked: { text: 'Not checked', cls: '' }
  };

  function tierClass(tier) {
    return 'gs-tier gs-tier-' + (tier || 'Starter');
  }

  function starsHtml(value, max) {
    var out = '';
    var limit = max || 5;
    for (var i = 1; i <= limit; i++) {
      out += '<span class="gs-star' + (i <= Math.round(value) ? ' on' : '') + '">&#9733;</span>';
    }
    return '<span class="gs-stars readonly">' + out + '</span>';
  }

  // The shared topnav on feed/prep pages paints #navAv from se_user and
  // /api/auth/me. GritScore pages don't load that script, so their sidebar and
  // topbar avatar stayed on the dicebear "seed=grit" fallback ("GR"). Paint
  // both here, with the same profilePhoto + name seed the rest of the app uses.
  function avatarSrc(u) {
    if (!u) return '';
    if (u.profilePhoto) return u.profilePhoto;
    var name = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
    return 'https://api.dicebear.com/9.x/initials/svg?seed=' +
      encodeURIComponent(name || u.email || 'grit') +
      '&backgroundColor=f0f0f0&textColor=262626&bold=true';
  }

  function paintAvatar(u) {
    if (!u || (!u.id && !u.email)) return;
    var src = avatarSrc(u);
    ['navAv', 'appSideAvatar'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el && src && el.getAttribute('src') !== src) el.src = src;
    });
    var link = document.getElementById('navProfile');
    if (link && u.id) link.href = '/profile.html?id=' + encodeURIComponent(u.id);
  }

  function initAvatar() {
    if (!document.getElementById('navAv') && !document.getElementById('appSideAvatar')) return;
    var cached = user();
    if (cached && (cached.id || cached.email)) paintAvatar(cached);
    authedFetch('/api/auth/me')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        var fresh = d && d.success && d.data && d.data.user;
        if (!fresh || !fresh.id) return;
        paintAvatar(fresh);
        try { localStorage.setItem('se_user', JSON.stringify(Object.assign({}, cached, fresh))); } catch (e) { /* private mode */ }
      })
      .catch(function () { /* keep the cached avatar */ });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initAvatar);
  else initAvatar();

  // ---- Theme art -----------------------------------------------------------
  // Shared by the public card and the owner's design preview so both draw the
  // same decoration. Decorative only: every layer is aria-hidden and hidden by
  // CSS on designs that don't use it.
  function web(cx, cy, radius, from, to, spokes, rings) {
    var angles = [];
    var out = '';
    var i;
    var k;
    for (i = 0; i <= spokes; i++) {
      var a = (from + (to - from) * i / spokes) * Math.PI / 180;
      angles.push([Math.cos(a), Math.sin(a)]);
    }
    angles.forEach(function (v) {
      out += '<path pathLength="1" d="M' + cx + ' ' + cy + 'L' +
        (cx + v[0] * radius).toFixed(1) + ' ' + (cy + v[1] * radius).toFixed(1) + '"/>';
    });
    for (k = 1; k <= rings; k++) {
      var r = radius * Math.pow(k / rings, 1.2);
      for (i = 0; i < spokes; i++) {
        var p = angles[i];
        var q = angles[i + 1];
        var mx = (p[0] + q[0]) / 2;
        var my = (p[1] + q[1]) / 2;
        out += '<path class="r" pathLength="1" d="M' + (cx + p[0] * r).toFixed(1) + ' ' + (cy + p[1] * r).toFixed(1) +
          'Q' + (cx + mx * r * 0.9).toFixed(1) + ' ' + (cy + my * r * 0.9).toFixed(1) +
          ' ' + (cx + q[0] * r).toFixed(1) + ' ' + (cy + q[1] * r).toFixed(1) + '"/>';
      }
    }
    return out;
  }

  function webSvg(inner) {
    return '<svg class="gs-flip-web" viewBox="0 0 100 176" preserveAspectRatio="none" aria-hidden="true">' + inner + '</svg>';
  }

  function frontFx(template) {
    if (template === 'spider') {
      return '<div class="gs-flip-fx web">' + webSvg(
        web(100, 0, 96, 91, 180, 8, 7) +
        web(0, 176, 72, 271, 359, 6, 5) +
        web(100, 118, 30, 128, 232, 4, 4)
      ) + '</div>';
    }
    if (template === 'space') {
      return '<div class="gs-flip-fx space"><b class="planet"></b><div class="orbit"><i></i><i></i></div></div>';
    }
    if (template === 'arctic') {
      return '<div class="gs-flip-fx arctic"><b></b><b></b><b></b></div>';
    }
    return '';
  }

  function backFx(template) {
    if (template === 'spider') {
      return '<div class="gs-flip-fx web">' + webSvg(
        web(100, 0, 70, 91, 180, 7, 6) +
        web(0, 176, 50, 271, 359, 5, 4)
      ) + '</div>';
    }
    return '';
  }

  window.GS = {
    API: API,
    token: token,
    user: user,
    request: request,
    authedFetch: authedFetch,
    toast: toast,
    esc: esc,
    plural: plural,
    frontFx: frontFx,
    backFx: backFx,
    timeAgo: timeAgo,
    tierClass: tierClass,
    starsHtml: starsHtml,
    EVIDENCE_LABEL: EVIDENCE_LABEL,
    STATUS_LABEL: STATUS_LABEL
  };
})();
