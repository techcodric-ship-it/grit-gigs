/* Grit&Gigs — shared Instagram-style app */
(function () {
  var API = '/api';
  function read() { return localStorage.getItem('se_token') || ''; }
  function getToken() { return read(); }
  function getUser() {
    try { return JSON.parse(localStorage.getItem('se_user') || 'null'); }
    catch (e) { return null; }
  }
  function getRefresh() { return localStorage.getItem('se_refresh') || ''; }
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

  var _refreshing = null;
  function refreshTokens() {
    if (_refreshing) return _refreshing;
    var rf = getRefresh();
    if (!rf) return Promise.reject({ nf: true });
    _refreshing = fetch(API + '/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: rf }),
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.success || !d.data || !d.data.accessToken) throw { nf: true };
      localStorage.setItem('se_token', d.data.accessToken);
      if (d.data.refreshToken) localStorage.setItem('se_refresh', d.data.refreshToken);
      token = d.data.accessToken;
      return d.data.accessToken;
    }).finally(function () { _refreshing = null; });
    return _refreshing;
  }

  function api(path, opts) {
    opts = opts || {};
    var attempts = arguments.length > 2 ? arguments[2] : 0;
    var headers = opts.headers || {};
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (opts.body) headers['Content-Type'] = 'application/json';
    return fetch(API + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (r) {
      return r.json().then(function (d) { return { ok: r.ok, status: r.status, d: d }; });
    }).then(function (res) {
      if (res.status === 401 && token && attempts === 0) {
        return refreshTokens().then(function () {
          return api(path, opts, 1);
        }).catch(function () {
          clearSession();
          return res;
        });
      }
      return res;
    });
  }

  function setSession(t, rf, u) {
    token = t; me = u;
    if (t) localStorage.setItem('se_token', t);
    if (rf) localStorage.setItem('se_refresh', rf);
    if (u) localStorage.setItem('se_user', JSON.stringify(u));
  }
  function clearSession() {
    token = ''; me = null;
    localStorage.removeItem('se_token');
    localStorage.removeItem('se_refresh');
  }

  // ── modals ──
  function openModal(id) { var m = document.getElementById(id); if (m) m.classList.add('open'); }
  function closeModals() { document.querySelectorAll('.modal-backdrop').forEach(function (x) { x.classList.remove('open'); }); }
  function openLogin() {
    closeModals();
    var m = document.getElementById('loginModal');
    if (m) m.classList.add('open');
    setTimeout(function () { var e = document.getElementById('loginEmail'); if (e) e.focus(); }, 60);
  }
  function openRegister() { closeModals(); var m = document.getElementById('registerModal'); if (m) m.classList.add('open'); }

  // ── avatar / handles ──
  function avatarFor(u) {
    if (u && u.profilePhoto) return u.profilePhoto;
    var seed = (u && (u.email || u.firstName)) || 'grit';
    return 'https://api.dicebear.com/9.x/initials/svg?seed=' + encodeURIComponent(seed) + '&backgroundColor=f0f0f0&textColor=262626&bold=true';
  }
  function handleFor(u) {
    if (!u) return '@hustler';
    return '@' + String(u.firstName || 'hustler').toLowerCase().replace(/[^a-z0-9]/g, '') + (u.lastName ? '_' + String(u.lastName).toLowerCase().replace(/[^a-z0-9]/g, '') : '');
  }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function timeAgo(iso) {
    var d = new Date(iso); if (isNaN(d)) return '';
    var s = Math.max(1, Math.floor((Date.now() - d.getTime()) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    if (s < 86400 * 7) return Math.floor(s / 86400) + 'd';
    var days = Math.floor(s / 86400);
    return days + 'd';
  }
  function kindCode(k) { return { GIG: 'GIG', BARTER: 'BARTER', WIN: 'WIN', TIPS: 'TIPS', POST: 'POST', REEL: 'REEL', PROJECT: 'PROJECT' }[k] || 'POST'; }
  function mediaOf(p) { return (p && p.media && p.media.length) ? p.media : []; }
  function primeMedia(row) {
    var p = row.post || row;
    var cover = p.coverUrl ? { url: p.coverUrl, type: 'image' } : null;
    var m = mediaOf(p);
    if (p.kind === 'REEL') {
      var v = m.filter(function (x) { return x.type === 'video'; })[0];
      if (v) return v;
    }
    if (cover) return cover;
    return m[0] || null;
  }
  function isVideoUrl(u) { return /\.(mp4|webm|m4v|mov)(\?|$)/i.test(u); }

  // ── render a post card ──
  function renderPost(row) {
    var p = row.post || row;
    var author = row.author || {};
    var isMine = me && me.id === (p.userId || author.id);
    var kind = kindCode(p.kind);
    var med = primeMedia(row);
    var mArr = mediaOf(p);

    var el = document.createElement('div');
    el.className = 'card' + (kind === 'REEL' ? ' reel-card' : '');
    el.dataset.id = p.id;

    var followBtn = '';
    if (token && !isMine) {
      followBtn = '<button class="follow' + (row.followingAuthor ? ' on' : '') + '" data-follow="' + esc(p.userId) + '">' + (row.followingAuthor ? 'Following' : 'Follow') + '</button>';
    } else if (isMine) {
      followBtn = '<button class="del" data-del="' + esc(p.id) + '">Delete</button>';
    }

    var mediaHtml = '';
    if (med && med.url) {
      if (kind === 'REEL') {
        var firstFrame = '';
        mediaHtml = '<div class="card-media reel" data-open="' + esc(p.id) + '">' +
          '<img src="' + esc(med.url) + '" loading="lazy" data-vsrc="' + esc(med.url) + '" onerror="this.style.display=\'none\'"/><div class="play">▶</div>' +
          '<span class="kind-stamp">REEL</span></div>';
      } else if (med.type === 'video') {
        mediaHtml = '<div class="card-media"><video src="' + esc(med.url) + '" controls preload="metadata" style="max-height:680px;"></video></div>';
      } else {
        mediaHtml = '<div class="card-media"' + (mArr.length > 1 ? '' : '') + '>' +
          '<img src="' + esc(med.url) + '" loading="lazy" onerror="this.style.display=\'none\'" style="' + (kind === 'BARTER' || kind === 'GIG' ? 'aspect-ratio:1/1;object-fit:cover;' : '') + '"/>' +
          '<span class="kind-stamp">' + kind + '</span>' +
          (kind === 'GIG' && p.priceInr ? '<span class="price-stamp">₹<b>' + Number(p.priceInr).toLocaleString('en-IN') + '</b>' + (p.deliveryDays ? ' · ' + p.deliveryDays + 'd' : '') + '</span>' : '') +
          (kind === 'PROJECT' && p.priceInr ? '<span class="price-stamp">Budget ₹' + Number(p.priceInr).toLocaleString('en-IN') + (p.priceMaxInr ? '–₹' + Number(p.priceMaxInr).toLocaleString('en-IN') : '') + '</span>' : '') +
          (kind === 'BARTER' ? '<span class="price-stamp">⟷ ' + (p.wantText ? esc(p.wantText) : 'Barter') + '</span>' : '') +
          '<div class="pv-overlay" style="position:absolute;inset:0;cursor:pointer;" data-open="' + esc(p.id) + '"></div></div>';
      }
    }

    // optional action buttons below media (for GIG/PROJECT/BARTER)
    var cta = '';
    if (kind === 'GIG' && token && !isMine) cta = '<button class="big-cta" data-order="' + esc(p.id) + '">Send order</button>';
    if (kind === 'PROJECT' && token && !isMine) cta = '<button class="big-cta" data-bid="' + esc(p.id) + '">Bid on project</button>';
    if (kind === 'BARTER' && token && !isMine) cta = '<button class="big-cta" data-offer="' + esc(p.id) + '">Make an offer</button>';

    var tagsHtml = (p.tags && p.tags.length) ? p.tags.map(function (t) { return '<a href="/explore.html?q=' + encodeURIComponent(t) + '">#' + esc(t) + '</a> '; }).join('') : '';

    var caption = '<div class="card-caption"><div><b>' + esc(author.firstName || 'Hustler') + '</b>' + esc((p.content || '').slice(0, 120)) + (p.content && p.content.length > 120 ? '<span class="more" data-more="' + esc(p.id) + '"> · more</span>' : '') + '</div>' +
      (tagsHtml ? '<div class="tags">' + tagsHtml + '</div>' : '') + '</div>';

    var commentsHtml = (row.comments || []).slice(0, 2).map(function (c) {
      return '<div class="cmt"><b>' + esc(c.author.firstName || 'hustler') + '</b> ' + esc(c.content) + '</div>';
    }).join('');
    var moreCmts = (row.comments && row.comments.length >= 2) ? '<a data-open="' + esc(p.id) + '" style="cursor:pointer;">View all ' + Number(p.commentCount || 0) + ' comments</a><br/>' : '';

    el.innerHTML =
      '<div class="card-head">' +
        '<img class="av" src="' + esc(avatarFor(author)) + '" alt=""/>' +
        '<div class="who"><a href="/profile.html?id=' + esc(author.id) + '"><div class="nm">' + esc(author.firstName || 'Hustler') + (author.kycVerified ? ' <span class="vh">VERIFIED</span>' : '') + '</div>' +
        '<div class="meta">' + esc(handleFor(author)) + (author.city ? ' · ' + esc(author.city) : '') + '</div></a></div>' +
        followBtn +
      '</div>' +
      mediaHtml +
      (cta ? '<div style="padding:0 16px 8px;">' + cta + '</div>' : '') +
      '<div class="card-actions">' +
        '<button class="like' + (row.likedByMe ? ' liked' : '') + '" data-like="' + esc(p.id) + '">♥<span class="c">' + Number(p.likeCount || 0).toLocaleString('en-IN') + '</span></button>' +
        '<button data-open="' + esc(p.id) + '">💬<span class="c">' + Number(p.commentCount || 0).toLocaleString('en-IN') + '</span></button>' +
        '<button class="sp" data-share="' + esc(p.id) + '">➤</button>' +
      '</div>' +
      '<div class="card-likes">' + Number(p.likeCount || 0).toLocaleString('en-IN') + ' likes</div>' +
      caption +
      '<div class="card-comments">' + moreCmts + commentsHtml + '</div>' +
      '<div class="card-date">' + timeAgo(p.createdAt) + '</div>' +
      '<div class="card-comment-form"><input placeholder="Add a comment..." data-cmf="' + esc(p.id) + '"/><button data-cms="' + esc(p.id) + '">Post</button></div>';

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
        b.querySelector('.c').textContent = Number(dd.likeCount).toLocaleString('en-IN');
        var likes = el.querySelector('.card-likes');
        if (likes) likes.textContent = Number(dd.likeCount).toLocaleString('en-IN') + ' likes';
      });
    });

    // open detail view
    el.querySelectorAll('[data-open="' + p.id + '"]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        if (e.target.closest('[data-del]') || e.target.closest('[data-order]') || e.target.closest('[data-bid]') || e.target.closest('[data-offer]')) return;
        if (e.target.closest('[data-cmf]') || e.target.closest('[data-cms]')) return;
        openPost(p.id);
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
        var box = el.querySelector('.card-comments');
        box.appendChild(domComment(r.d.data, r.d.data.author));
        el.querySelector('[data-cms] .c').textContent = Number(r.d.data.commentCount).toLocaleString('en-IN');
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

    // order / bid / offer → open dedicated composer child
    var order = el.querySelector('[data-order]');
    if (order) order.addEventListener('click', function () { if (!token) { openLogin(); return; } openOrderModal('GIG', p); });
    var bid = el.querySelector('[data-bid]');
    if (bid) bid.addEventListener('click', function () { if (!token) { openLogin(); return; } openOrderModal('PROJECT', p); });
    var offer = el.querySelector('[data-offer]');
    if (offer) offer.addEventListener('click', function () { if (!token) { openLogin(); return; } openOrderModal('BARTER', p); });

    return el;
  }

  function domComment(c, author) {
    var div = document.createElement('div');
    div.className = 'cmt';
    div.innerHTML = '<b>' + esc((author && author.firstName) || 'hustler') + '</b> ' + esc(c.content);
    return div;
  }

  // ── detail view (IG post/reel view) ──
  function openPost(postId) {
    var m = document.getElementById('postModal');
    if (!m) return;
    var body = m.querySelector('.modal');
    if (body) body.innerHTML = '<div class="loading">Loading…</div>';
    m.classList.add('open');
    api('/community/posts/' + postId).then(function (r) {
      if (!r.ok) { if (body) body.innerHTML = '<div class="empty"><h3>Could not load</h3><p>' + esc(r.d.message || '') + '</p></div>'; return; }
      var containerEl = document.createElement('div');
      containerEl.appendChild(renderPost(r.d.data));
      if (body) {
        body.innerHTML = '';
        body.appendChild(containerEl);
      }
    });
  }

  // ── order / bid / offer modal ──
  function openOrderModal(kind, post) {
    var m = document.getElementById('orderModal');
    if (!m) return;
    var t = document.getElementById('orderTitle');
    var f1 = document.getElementById('orderReq');
    if (t) t.textContent = kind === 'GIG' ? 'Order · ' + Number(post.priceInr).toLocaleString('en-IN') + ' /' + (post.deliveryDays ? ' ' + post.deliveryDays + 'd' : '') : kind === 'PROJECT' ? 'Apply for project' : 'Propose barter';
    if (f1) f1.placeholder = kind === 'GIG' ? 'Describe what you need, scope, deadline…' : kind === 'PROJECT' ? "Your bid + why you / what you'll deliver…" : 'What you can offer in exchange…';
    m.dataset.kind = kind;
    m.dataset.post = post.id;
    m.dataset.amt = kind === 'GIG' ? String(post.priceInr || '') : '';
    var amtRow = document.getElementById('orderAmtRow');
    if (amtRow) amtRow.style.display = kind === 'PROJECT' || kind === 'BARTER' ? '' : 'none';
    var amt = document.getElementById('orderAmt');
    if (amt) amt.placeholder = kind === 'PROJECT' ? 'Your bid (₹)' : kind === 'BARTER' ? 'Value you offer (₹, optional)' : '';
    m.classList.add('open');
  }

  // ── login / register / verify flows ──
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
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, password: pass }),
      }).then(function (r) { return r.json(); }).then(function (d) {
        loginSubmit.disabled = false;
        if (!d.success) { errEl.textContent = d.message || 'Login failed.'; return; }
        var u = d.data.user;
        setSession(d.data.accessToken, d.data.refreshToken, u);
        toast('Welcome back, ' + (u.firstName || 'hustler') + '!');
        closeModals();
        refreshAuthedUI();
      }).catch(function () { loginSubmit.disabled = false; errEl.textContent = 'Network error. Try again.'; });
    });
  }

  var regSubmit = document.getElementById('regSubmit');
  if (regSubmit) {
    regSubmit.addEventListener('click', function () {
      var fName = document.getElementById('regFirst').value.trim();
      var lName = document.getElementById('regLast').value.trim();
      var email = document.getElementById('regEmail').value.trim();
      var phone = document.getElementById('regPhone').value.trim();
      var pass = document.getElementById('regPass').value;
      var errEl = document.getElementById('regErr');
      if (!fName || !lName || !email || !phone || pass.length < 8) { errEl.textContent = 'All fields required — password 8+ characters.'; return; }
      errEl.textContent = 'Creating your account…';
      regSubmit.disabled = true;
      fetch(API + '/auth/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ firstName: fName, lastName: lName, email: email, phone: phone, password: pass }),
      }).then(function (r) { return r.json(); }).then(function (d) {
        regSubmit.disabled = false;
        if (!d.success) { errEl.textContent = d.message || 'Registration failed.'; return; }
        localStorage.setItem('signup_email', email);
        localStorage.setItem('signup_token', d.data.signupToken);
        document.getElementById('verifyEmail').textContent = email;
        document.getElementById('registerModal').classList.remove('open');
        document.getElementById('verifyModal').classList.add('open');
      }).catch(function () { regSubmit.disabled = false; errEl.textContent = 'Network error. Try again.'; });
    });
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
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, otp: otp, signupToken: signupToken }),
      }).then(function (r) { return r.json(); }).then(function (d) {
        verifySubmit.disabled = false;
        if (!d.success) { errEl.textContent = d.message || 'Verification failed.'; return; }
        localStorage.removeItem('signup_email');
        localStorage.removeItem('signup_token');
        document.getElementById('verifyModal').classList.remove('open');
        if (d.data && d.data.refreshToken) {
          setSession(d.data.accessToken, d.data.refreshToken, d.data.user);
          toast('Verified — you are in!');
          refreshAuthedUI();
        } else {
          var fld = document.getElementById('loginEmail');
          if (fld) fld.value = email;
          toast('Account verified. Sign in with your password.');
        }
      }).catch(function () { verifySubmit.disabled = false; errEl.textContent = 'Network error. Try again.'; });
    });
  }

  // ── rail / user chip ──
  function refreshAuthedUI() {
    token = getToken();
    me = getUser();
    var rail = document.getElementById('railUser');
    if (rail) {
      if (token && me) {
        rail.innerHTML =
          '<a class="top-item" href="/profile.html?id=' + esc(me.id) + '"><img class="av" src="' + esc(avatarFor(me)) + '" alt=""/><div><div class="nm">' + esc(me.firstName || 'Hustler') + '</div><div class="ct">' + esc(handleFor(me)) + '</div></div></a>' +
          '<button style="width:100%;margin-top:10px;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px;font-weight:600;" id="logoutBtn">Log out</button>';
        var lo = document.getElementById('logoutBtn');
        if (lo) lo.addEventListener('click', function () { clearSession(); toast('Logged out'); refreshAuthedUI(); if (location.pathname === '/feed' || location.pathname === '/feed.html') location.reload(); });
      } else {
        rail.innerHTML = '<p style="font-size:14px;color:var(--ink-2);margin:0 0 12px;">Join the hustle — like, comment, hire, and grow.</p><button style="width:100%;background:var(--ink);color:#fff;border:none;border-radius:8px;padding:9px;font-weight:600;" id="railSignIn">Sign in</button>';
        var si = document.getElementById('railSignIn');
        if (si) si.addEventListener('click', function () { openLogin(); });
      }
    }
    if (typeof window.onAuthed === 'function') window.onAuthed(token, me);
  }

  // ── post count refresh ──
  function loadUnreadBadge() {
    if (!getToken()) return;
    fetch(API + '/community/notifications?limit=1', { headers: { 'Authorization': 'Bearer ' + getToken() } })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.success) return;
        var bx = document.getElementById('notifBadge');
        if (bx) {
          var n = Number((d.data && d.data.unread) || 0);
          bx.style.display = n > 0 ? 'grid' : 'none';
          bx.textContent = n > 9 ? '9+' : n;
        }
      }).catch(function () {});
  }

  // ── expose shared API ──
  window.community = {
    api: api,
    token: getToken,
    me: getUser,
    setSession: setSession,
    clearSession: clearSession,
    toast: toast,
    esc: esc,
    timeAgo: timeAgo,
    avatarFor: avatarFor,
    handleFor: handleFor,
    kindCode: kindCode,
    mediaOf: mediaOf,
    primeMedia: primeMedia,
    renderPost: renderPost,
    domComment: domComment,
    openModal: openModal,
    closeModals: closeModals,
    openLogin: openLogin,
    openRegister: openRegister,
    openPost: openPost,
    openOrderModal: openOrderModal,
    refresh: refreshAuthedUI,
  };

  document.addEventListener('click', function (e) {
    var sh = e.target.closest('[data-share]');
    if (sh) {
      e.preventDefault();
      var pid = sh.getAttribute('data-share');
      if (navigator.share) {
        navigator.share({ title: 'Grit&Gigs', text: 'Check this on Grit&Gigs', url: location.origin + '/explore.html?post=' + encodeURIComponent(pid) }).catch(function () {});
      } else {
        location.href = '/messages.html?share=' + encodeURIComponent(pid);
      }
      return;
    }
    var msgBtn = e.target.closest('[data-msg]');
    if (msgBtn) {
      e.preventDefault();
      location.href = '/messages.html?to=' + encodeURIComponent(msgBtn.getAttribute('data-msg'));
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeModals();
  });

  var rail = document.getElementById('railUser');
  if (rail) refreshAuthedUI();
  else if (typeof window.onInit === 'function') window.onInit();
  loadUnreadBadge();
})();