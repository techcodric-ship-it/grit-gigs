/* Grit&Gigs Hustle Feed — shared app */
(function () {
  var API = '/api';
  var getToken = function () { return localStorage.getItem('se_token') || localStorage.getItem('token') || ''; };
  var getUser = function () {
    try { return JSON.parse(localStorage.getItem('se_user') || localStorage.getItem('user') || 'null'); }
    catch (e) { return null; }
  };
  var token = getToken();
  var me = getUser();

  var toastEl = document.getElementById('toast');
  function toast(msg, isErr) {
    if (!toastEl) { alert(msg); return; }
    toastEl.textContent = msg;
    toastEl.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { toastEl.className = 'toast'; }, 2600);
  }

  function api(path, opts) {
    opts = opts || {};
    var headers = opts.headers || {};
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (opts.body) headers['Content-Type'] = 'application/json';
    return fetch(API + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (r) {
      return r.json().then(function (d) { return { ok: r.ok, status: r.status, d: d }; });
    });
  }

  function avatarFor(u) {
    if (u && u.profilePhoto) return u.profilePhoto;
    var seed = (u && (u.email || u.firstName)) || 'grit';
    return 'https://api.dicebear.com/9.x/initials/svg?seed=' + encodeURIComponent(seed) + '&backgroundColor=ff5c1a,c8f522&bold=true';
  }
  function handleFor(u) {
    if (!u) return '@hustler';
    return '@' + String(u.firstName || 'hustler').toLowerCase().replace(/[^a-z0-9]/g, '') + (u.lastName ? '_' + String(u.lastName).toLowerCase().replace(/[^a-z0-9]/g, '') : '');
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function timeAgo(iso) {
    var d = new Date(iso); if (isNaN(d)) return '';
    var s = Math.max(1, Math.floor((Date.now() - d.getTime()) / 1000));
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    return Math.floor(s / 86400) + 'd';
  }
  function kindLabel(k) {
    return { GIG: 'GIG', BARTER: 'BARTER', WIN: 'WIN', TIPS: 'TIPS', POST: 'POST' }[k] || 'POST';
  }
  function scoreFor(post, liked) {
    var base = Math.min(96, 34 + (post.likeCount || 0) * 3 + (post.commentCount || 0) * 4);
    if (liked) base += 4;
    var author = post.author || {};
    if (author.reputationScore) base = base + Math.min(10, (author.reputationScore || 0));
    return Math.max(6, Math.min(100, base));
  }

  function openLogin() {
    var m = document.getElementById('loginModal');
    if (m) m.classList.add('open');
    setTimeout(function () { var e = document.getElementById('loginEmail'); if (e) e.focus(); }, 60);
  }
  function openRegister() {
    closeModals();
    var m = document.getElementById('registerModal');
    if (m) m.classList.add('open');
  }
  function closeModals() {
    document.querySelectorAll('.modal-backdrop').forEach(function (x) { x.classList.remove('open'); });
  }

  // ── login flow ────────────────────────────────────────────
  var loginSubmit = document.getElementById('loginSubmit');
  if (loginSubmit) {
    loginSubmit.addEventListener('click', function () {
      var email = document.getElementById('loginEmail').value.trim();
      var pass = document.getElementById('loginPass').value;
      var errEl = document.getElementById('loginErr');
      if (!email || !pass) { errEl.textContent = 'Email and password required.'; return; }
      errEl.textContent = 'Signing in…';
      loginSubmit.disabled = true;
      fetch(API + '/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, password: pass }),
      }).then(function (r) { return r.json(); }).then(function (d) {
        loginSubmit.disabled = false;
        if (!d.success) { errEl.textContent = d.message || 'Login failed.'; return; }
        var u = d.data.user;
        localStorage.setItem('se_token', d.data.accessToken);
        localStorage.setItem('se_user', JSON.stringify(u));
        token = d.data.accessToken;
        me = u;
        toast('Welcome back, ' + (u.firstName || 'hustler') + '!');
        closeModals();
        refreshAuthedUI();
      }).catch(function () {
        loginSubmit.disabled = false;
        errEl.textContent = 'Network error. Try again.';
      });
    });
  }

  // ── register + OTP verify flow ────────────────────────────
  var regSubmit = document.getElementById('regSubmit');
  if (regSubmit) {
    regSubmit.addEventListener('click', function () {
      var fName = document.getElementById('regFirst').value.trim();
      var lName = document.getElementById('regLast').value.trim();
      var email = document.getElementById('regEmail').value.trim();
      var phone = document.getElementById('regPhone').value.trim();
      var pass = document.getElementById('regPass').value;
      var errEl = document.getElementById('regErr');
      if (!fName || !lName || !email || !phone || pass.length < 8) {
        errEl.textContent = 'All fields required — password 8+ characters.';
        return;
      }
      errEl.textContent = 'Creating your account…';
      regSubmit.disabled = true;
      fetch(API + '/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ firstName: fName, lastName: lName, email: email, phone: phone, password: pass }),
      }).then(function (r) { return r.json(); }).then(function (d) {
        regSubmit.disabled = false;
        if (!d.success) { errEl.textContent = d.message || 'Registration failed.'; return; }
        localStorage.setItem('signup_email', email);
        localStorage.setItem('signup_token', d.data.signupToken);
        document.getElementById('verifyEmail').textContent = email;
        showVerify();
      }).catch(function () {
        regSubmit.disabled = false;
        errEl.textContent = 'Network error. Try again.';
      });
    });
  }
  function showVerify() {
    document.getElementById('registerModal').classList.remove('open');
    document.getElementById('verifyModal').classList.add('open');
  }
  var verifySubmit = document.getElementById('verifySubmit');
  if (verifySubmit) {
    verifySubmit.addEventListener('click', function () {
      var otp = document.getElementById('verifyOtp').value.trim();
      var email = localStorage.getItem('signup_email') || '';
      var signupToken = localStorage.getItem('signup_token') || '';
      var errEl = document.getElementById('verifyErr');
      if (!otp) { errEl.textContent = 'Enter the 6-digit code.'; return; }
      errEl.textContent = 'Verifying…';
      verifySubmit.disabled = true;
      fetch(API + '/auth/verify-signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, otp: otp, signupToken: signupToken }),
      }).then(function (r) { return r.json(); }).then(function (d) {
        verifySubmit.disabled = false;
        if (!d.success) { errEl.textContent = d.message || 'Verification failed.'; return; }
        localStorage.removeItem('signup_email');
        localStorage.removeItem('signup_token');
        document.getElementById('verifyModal').classList.remove('open');
        var emailFld = document.getElementById('loginEmail');
        var passFld = document.getElementById('loginPass');
        if (emailFld) emailFld.value = email;
        if (passFld) passFld.focus();
        toast('Account verified. Sign in with your password.');
      }).catch(function () {
        verifySubmit.disabled = false;
        errEl.textContent = 'Network error. Try again.';
      });
    });
  }

  // ── render a post card (shared) ───────────────────────────
  function renderPost(row) {
    var p = row.post || row;
    var author = row.author || {};
    var isMine = me && me.id === (p.userId || author.id);
    var media = p.media && p.media.length ? p.media : [];
    var tags = p.tags && p.tags.length ? p.tags : [];
    var score = scoreFor(p, row.likedByMe);
    var kind = kindLabel(p.kind);

    var el = document.createElement('div');
    el.className = 'post';
    el.dataset.id = p.id;
    var followBtn = '';
    if (token && !isMine) {
      followBtn = '<button class="follow-btn' + (row.followingAuthor ? ' on' : '') + '" data-follow="' + p.userId + '">' + (row.followingAuthor ? 'Following' : 'Follow') + '</button>';
    } else if (isMine) {
      followBtn = '<button class="follow-btn" data-del="' + p.id + '">Delete</button>';
    }

    var authorLink = '<a href="/profile.html?id=' + esc(author.id) + '">' +
      '<div class="who">' +
        '<div class="nm">' + esc(author.firstName || 'Hustler') + (author.kycVerified ? ' <span class="vh">VERIFIED</span>' : '') + '</div>' +
        '<div class="meta"><span>' + esc(handleFor(author)) + '</span> · <span class="loc">' + esc(author.city || '') + '</span> · ' + timeAgo(p.createdAt) + '</div>' +
      '</div></a>';

    var mediaHtml = '';
    var first = media[0];
    if (first && first.url) {
      var val = /\.(mp4|webm|ogg)$/i.test(first.url);
      mediaHtml = val
        ? '<div class="post-media"><video src="' + esc(first.url) + '" controls style="width:100%;max-height:380px;border-radius:12px;border:1px solid var(--line);"></video></div>'
        : '<div class="post-media"><img src="' + esc(first.url) + '" loading="lazy" onerror="this.style.display=\'none\'"/></div>';
    }

    var tagsHtml = tags.map(function (t) { return '<span class="tag">#' + esc(t) + '</span>'; }).join('');

    var gigChip = '';
    if (p.kind === 'GIG' && p.priceInr) {
      gigChip = '<div><span class="gig-chip">₹<b>' + Number(p.priceInr).toLocaleString('en-IN') + '</b> · ' + (p.deliveryDays ? p.deliveryDays + ' days' : 'negotiable') + '</span></div>';
    } else if (p.kind === 'BARTER') {
      gigChip = '<div><span class="gig-chip">⟷ Barter · skill swap</span></div>';
    } else if (p.kind === 'WIN') {
      gigChip = '<div><span class="gig-chip">✓ Win</span></div>';
    }

    var commentsHtml = (row.comments || []).slice(0, 2).map(function (c) {
      return '<div class="cmt"><b>' + esc(c.author.firstName || 'hustler') + '</b>' + esc(c.content) + '</div>';
    }).join('');

    el.innerHTML =
      '<div class="post-head">' +
        '<a href="/profile.html?id=' + esc(author.id) + '"><img src="' + esc(avatarFor(author)) + '" alt=""/></a>' +
        authorLink + followBtn +
      '</div>' +
      '<div class="post-body">' +
        '<div class="post-text"><span class="hh">' + kind + '</span> ' + esc(p.content) + '</div>' +
        (tagsHtml ? '<div class="tags">' + tagsHtml + '</div>' : '') +
        gigChip + mediaHtml +
      '</div>' +
      '<div class="post-actions">' +
        '<button class="act' + (row.likedByMe ? ' liked' : '') + '" data-like="' + p.id + '">♥ <span data-likes>' + Number(p.likeCount || 0).toLocaleString('en-IN') + '</span></button>' +
        '<button class="act" data-cmt="' + p.id + '">💬 <span data-cmts>' + Number(p.commentCount || 0).toLocaleString('en-IN') + '</span></button>' +
      '</div>' +
      '<div class="score-bar"><i style="width:' + score + '%;"></i></div>' +
      '<div class="post-comments" data-comments>' +
        commentsHtml +
        (token ? '<div class="cmt-form"><input placeholder="Drop a comment…" data-cmf="' + p.id + '"/><button data-cms="' + p.id + '">Send</button></div>' : '') +
      '</div>';

    // like
    var likeBtn = el.querySelector('[data-like]');
    likeBtn.addEventListener('click', function () {
      if (!token) { openLogin(); return; }
      var b = likeBtn, liked = b.classList.contains('liked');
      b.disabled = true;
      api('/community/posts/' + p.id + '/like', { method: 'POST' }).then(function (r) {
        b.disabled = false;
        if (!r.ok) { toast(r.d.message || 'Failed', true); return; }
        var dd = r.d.data;
        b.classList.toggle('liked', dd.liked);
        b.querySelector('[data-likes]').textContent = Number(dd.likeCount).toLocaleString('en-IN');
        var bar = b.closest('.post').querySelector('.score-bar i');
        if (bar) bar.style.width = scoreFor(p, dd.liked) + '%';
      });
    });

    // comment
    var cmtIn = el.querySelector('[data-cmf]');
    var cmtBtn = el.querySelector('[data-cms]');
    function sendComment() {
      if (!token) { openLogin(); return; }
      var text = cmtIn.value.trim();
      if (!text) return;
      cmtBtn.disabled = true;
      api('/community/posts/' + p.id + '/comment', { method: 'POST', body: { content: text } }).then(function (r) {
        cmtBtn.disabled = false;
        if (!r.ok) { toast(r.d.message || 'Failed', true); return; }
        cmtIn.value = '';
        var box = el.querySelector('[data-comments]');
        var c = r.d.data;
        box.insertBefore(domComment(c, c.author), cmtIn.parentNode);
        el.querySelector('[data-cmts]').textContent = Number(c.commentCount).toLocaleString('en-IN');
      });
    }
    if (cmtIn) cmtIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') sendComment(); });
    if (cmtBtn) cmtBtn.addEventListener('click', sendComment);

    // follow
    var fb = el.querySelector('[data-follow]');
    if (fb) fb.addEventListener('click', function () {
      if (!token) { openLogin(); return; }
      api('/community/users/' + p.userId + '/follow', { method: 'POST' }).then(function (r) {
        if (!r.ok) { toast(r.d.message || 'Failed', true); return; }
        fb.classList.toggle('on', r.d.data.following);
        fb.textContent = r.d.data.following ? 'Following' : 'Follow';
        toast(r.d.data.following ? 'Following ' + (author.firstName || '') : 'Unfollowed');
      });
    });

    // delete
    var del = el.querySelector('[data-del]');
    if (del) del.addEventListener('click', function () {
      if (!confirm('Delete this post?')) return;
      api('/community/posts/' + p.id + '/delete', { method: 'POST' }).then(function (r) {
        if (!r.ok) { toast(r.d.message || 'Failed', true); return; }
        el.remove();
        toast('Post deleted');
      });
    });

    return el;
  }

  function domComment(c, author) {
    var div = document.createElement('div');
    div.className = 'cmt';
    div.innerHTML = '<b>' + esc((author && author.firstName) || 'hustler') + '</b>' + esc(c.content);
    return div;
  }

  // ── rail user / guest ─────────────────────────────────────
  function refreshAuthedUI() {
    token = getToken();
    me = getUser();
    var rail = document.getElementById('railUser');
    if (rail) {
      if (token && me) {
        rail.innerHTML =
          '<a class="rail-user" href="/profile.html?id=' + esc(me.id) + '"><img src="' + esc(avatarFor(me)) + '" alt=""/><div style="min-width:0;"><div class="nm">' + esc(me.firstName || 'Hustler') + '</div><div class="hh">' + esc(handleFor(me)) + ' · <span id="logoutLink" style="color:var(--signal);cursor:pointer;">leave</span></div></div></a>';
        var lo = document.getElementById('logoutLink');
        if (lo) lo.addEventListener('click', function (e) {
          e.preventDefault(); e.stopPropagation();
          localStorage.removeItem('se_token'); localStorage.removeItem('se_user');
          token = ''; me = null;
          refreshAuthedUI();
          location.reload();
        });
      } else {
        rail.innerHTML = '<div class="guest"><p>Follow hustlers, like the grind, post your wins.</p><button id="railSignIn">Sign in</button></div>';
        var si = document.getElementById('railSignIn');
        if (si) si.addEventListener('click', function () { openLogin(); });
      }
    }
    if (typeof window.onAuthed === 'function') window.onAuthed(token, me);
  }

  // ── expose the shared API ─────────────────────────────────
  window.community = {
    api: api,
    token: function () { return getToken(); },
    me: function () { return getUser(); },
    setSession: function (t, u) { token = t; me = u; },
    toast: toast,
    esc: esc,
    timeAgo: timeAgo,
    avatarFor: avatarFor,
    handleFor: handleFor,
    kindLabel: kindLabel,
    scoreFor: scoreFor,
    renderPost: renderPost,
    domComment: domComment,
    openLogin: openLogin,
    openRegister: openRegister,
    refresh: refreshAuthedUI,
  };

  document.addEventListener('keydown', function (e) {
    if (e.key === 'n' && !e.ctrlKey && !e.metaKey && token &&
        !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) {
      e.preventDefault();
      var cb = document.getElementById('composeModal');
      if (cb) cb.classList.add('open');
    }
  });

  // init
  var rail = document.getElementById('railUser');
  if (rail) refreshAuthedUI();
  else if (typeof window.onInit === 'function') window.onInit();
})();