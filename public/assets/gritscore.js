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

  window.GS = {
    API: API,
    token: token,
    user: user,
    request: request,
    authedFetch: authedFetch,
    toast: toast,
    esc: esc,
    plural: plural,
    timeAgo: timeAgo,
    tierClass: tierClass,
    starsHtml: starsHtml,
    EVIDENCE_LABEL: EVIDENCE_LABEL,
    STATUS_LABEL: STATUS_LABEL
  };
})();
