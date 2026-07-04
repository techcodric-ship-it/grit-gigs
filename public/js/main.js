

// ═══════════════════════════════════════════════════════
//  SwiftExchange — main.js  (fully wired to backend)
// ═══════════════════════════════════════════════════════
const API = '/api';

/* ── helpers ── */
const $  = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];
const gT = () => localStorage.getItem('se_token');
const gU = () => { try { return JSON.parse(localStorage.getItem('se_user') || 'null'); } catch(e) { return null; } };
const sU = u  => localStorage.setItem('se_user', JSON.stringify(u));
function kycBadge(v) { return v ? '<span style="display:inline-flex;align-items:center;gap:2px;background:#d1fae5;color:#065f46;font-size:.58rem;font-weight:700;padding:1px 6px;border-radius:99px;vertical-align:middle;margin-left:4px;white-space:nowrap;">\u2713 KYC</span>' : ''; }

async function api(endpoint, opts = {}) {
  try {
    const r = await fetch(API + endpoint, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        ...(gT() && { Authorization: 'Bearer ' + gT() }),
        ...opts.headers,
      },
    });
    return r.json();
  } catch (e) {
    return { success: false, message: 'Request failed — check your connection or try again.' };
  }
}

/* ── toast ── */
function showToast(msg, type = 'info') {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.style.cssText = `position:fixed;bottom:24px;right:24px;z-index:9999;padding:13px 18px;border-radius:12px;font-size:0.86rem;font-family:'DM Sans',sans-serif;max-width:300px;line-height:1.5;box-shadow:0 8px 32px rgba(0,0,0,0.18);transform:translateY(80px);opacity:0;transition:all 0.32s ease;`;
  t.style.background = type === 'error' ? '#C0392B' : type === 'success' ? '#1A7A5E' : '#1C1C2E';
  t.style.color = 'white';
  t.innerHTML = msg;
  requestAnimationFrame(() => { t.style.transform = 'translateY(0)'; t.style.opacity = '1'; });
  setTimeout(() => { t.style.transform = 'translateY(80px)'; t.style.opacity = '0'; }, 3500);
}

/* ── modal ── */
window.openModal = function(id) {
  const m = document.getElementById(id);
  if (m) { m.classList.add('open'); document.body.style.overflow = 'hidden'; }
};
window.closeModal = function(id) {
  const m = document.getElementById(id);
  if (m) { m.classList.remove('open'); document.body.style.overflow = ''; }
};
$$('.modal-overlay').forEach(o => o.addEventListener('click', e => { if (e.target === o) closeModal(o.id); }));
document.addEventListener('keydown', e => { if (e.key === 'Escape') $$('.modal-overlay.open').forEach(m => closeModal(m.id)); });

/* ── nav scroll ── */
const nav = $('.nav');
window.addEventListener('scroll', () => nav?.classList.toggle('scrolled', scrollY > 20));

/* ── mobile menu ── */
const hamburger = $('.nav-hamburger');
const mobileMenu = document.getElementById('mobileMenu');
hamburger?.addEventListener('click', () => mobileMenu?.classList.toggle('open'));
document.addEventListener('click', e => {
  if (!hamburger?.contains(e.target) && !mobileMenu?.contains(e.target)) mobileMenu?.classList.remove('open');
});

/* ── smooth scroll ── */
$$('a[href^="#"]').forEach(a => a.addEventListener('click', e => {
  const t = document.querySelector(a.getAttribute('href'));
  if (t) { e.preventDefault(); t.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
}));

/* ── category pills ── */
$$('.cat-pill').forEach(p => p.addEventListener('click', () => {
  $$('.cat-pill').forEach(x => x.classList.remove('active'));
  p.classList.add('active');
}));

/* ── counter animation ── */
const counterObs = new IntersectionObserver(entries => {
  entries.forEach(en => {
    if (en.isIntersecting && !en.target.dataset.animated) {
      en.target.dataset.animated = 'true';
      const target = parseInt(en.target.dataset.target);
      const suffix = en.target.dataset.suffix || '';
      const dur = 1800;
      const start = performance.now();
      const tick = now => {
        const p = Math.min((now - start) / dur, 1);
        const ease = 1 - Math.pow(1 - p, 3);
        en.target.textContent = Math.floor(ease * target).toLocaleString('en-IN') + suffix;
        if (p < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
  });
}, { threshold: 0.5 });
$$('[data-target]').forEach(el => counterObs.observe(el));

/* ── fade-up animation ── */
const fadeObs = new IntersectionObserver(entries => {
  entries.forEach(en => { if (en.isIntersecting) en.target.classList.add('visible'); });
}, { threshold: 0.08 });
$$('.anim-fade-up').forEach(el => fadeObs.observe(el));

/* ── systems tabs ── */
$$('.sys-tab').forEach(tab => tab.addEventListener('click', () => {
  $$('.sys-tab').forEach(t => t.classList.remove('active'));
  $$('.sys-panel').forEach(p => p.classList.remove('active'));
  tab.classList.add('active');
  document.getElementById(tab.dataset.tab)?.classList.add('active');
}));

/* ── expose globals ── */
window.showToast = showToast;

// ═══════════════════════════════════════════════════════
//  UPDATE NAV based on login state
// ═══════════════════════════════════════════════════════
function updateNav(u) {
  const user = u || gU();
  const actions = $('.nav-actions');
  if (!actions) return;
  if (user) {
    actions.innerHTML = `
      <span id="mainNavPlanBadge"></span>
      <a href="dashboard.html" class="btn btn-secondary btn-sm">Hi, ${user.firstName}</a>
      <button class="btn btn-primary btn-sm" onclick="doLogout()">Sign out</button>`;
    // Fetch plan badge asynchronously
    api('/subscriptions/my-plan').then(function(pr) {
      var badgeEl = document.getElementById('mainNavPlanBadge');
      if (badgeEl && pr.success && pr.data.plan) {
        var b = pr.data.plan.badge;
        badgeEl.innerHTML = b
          ? '<span style="background:linear-gradient(135deg,#6C3FE8,#2980b9);color:#fff;font-size:.6rem;font-weight:700;padding:2px 7px;border-radius:4px;text-transform:uppercase;letter-spacing:.04em;margin-right:6px;vertical-align:middle;">' + b + '</span>'
          : '<span style="font-size:.65rem;color:var(--violet);font-weight:600;margin-right:6px;vertical-align:middle;">Free</span>';
      }
    }).catch(function(){});
  }
}
window.gT = gT;
window.gU = gU;
window.doLogout = function() {
  api('/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken: localStorage.getItem('se_refresh') }) });
  localStorage.removeItem('se_token');
  localStorage.removeItem('se_user');
  localStorage.removeItem('se_refresh');
  localStorage.removeItem('se_plan_cache');
  window.location.href = 'index.html';
};

  // Show nav immediately from localStorage
  updateNav();

  // Then verify session with the server — keeps nav correct even after token refresh
  (async function() {
    const token = gT();
    if (!token) return;
    try {
      const r = await fetch(API + '/auth/me', {
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }
      });
      const d = await r.json();
      if (d.success && d.data) {
        const user = d.data.user || d.data;
        sU(user); updateNav(user);
        // Also update index.html inline-nav if present
        const el = document.getElementById('siteNavActions');
        if (el && user.firstName) {
          var planBadgeHtml = '';
          try {
            var pr2 = JSON.parse(localStorage.getItem('se_plan_cache') || 'null');
            if (pr2 && pr2.badge) {
              planBadgeHtml = '<span style="background:linear-gradient(135deg,#6C3FE8,#2980b9);color:#fff;font-size:.6rem;font-weight:700;padding:2px 7px;border-radius:4px;text-transform:uppercase;letter-spacing:.04em;margin-right:6px;vertical-align:middle;">' + pr2.badge + '</span>';
            } else if (pr2) {
              planBadgeHtml = '<span style="font-size:.65rem;color:var(--violet);font-weight:600;margin-right:6px;vertical-align:middle;">Free</span>';
            }
          } catch(e) {}
          el.innerHTML = planBadgeHtml +
            '<a href="dashboard.html" class="btn btn-secondary btn-sm">Hi, ' + user.firstName + '</a>' +
            '<button class="btn btn-primary btn-sm" onclick="doLogout()">Sign out</button>';
        }
      } else if (r.status === 401) {
        const rf = localStorage.getItem('se_refresh');
        if (!rf) return;
        const r2 = await fetch(API + '/auth/refresh', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: rf })
        });
        const d2 = await r2.json();
        if (d2.success && d2.data?.accessToken) {
          localStorage.setItem('se_token', d2.data.accessToken);
          if (d2.data.refreshToken) localStorage.setItem('se_refresh', d2.data.refreshToken);
          if (d2.data.user) { sU(d2.data.user); updateNav(d2.data.user); }
        } else {
          localStorage.removeItem('se_token'); localStorage.removeItem('se_refresh'); localStorage.removeItem('se_user');
        }
      }
    } catch(e) {}
  })();

  // Handle browser Back button (BFCache restore)
  window.addEventListener('pageshow', function(e) { if (e.persisted) updateNav(); });

  // ═══════════════════════════════════════════════════════════════════
//  SIGN UP
// ═══════════════════════════════════════════════════════
let _signupData = null;

document.getElementById('signupForm')?.addEventListener('submit', async e => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');
  const orig = btn.textContent;
  btn.textContent = 'Creating account...'; btn.disabled = true;

  const inputs = e.target.querySelectorAll('input');
  const payload = {
    firstName: inputs[0].value.trim(),
    lastName:  inputs[1].value.trim(),
    email:     inputs[2].value.trim(),
    password:  inputs[3].value,
  };

  const data = await api('/auth/register', { method: 'POST', body: JSON.stringify(payload) });
  btn.textContent = orig; btn.disabled = false;

  if (data.success) {
    _signupData = data.data;
    document.getElementById('signupForm').style.display = 'none';
    document.getElementById('signupOtpStep').style.display = 'block';
    document.getElementById('otpEmailDisplay').textContent = 'Code sent to ' + data.data.email;
    document.getElementById('otpInput').value = '';
    document.getElementById('otpInput').focus();
  } else {
    showToast(data.message || 'Signup failed. Please try again.', 'error');
  }
});

document.getElementById('verifyOtpBtn')?.addEventListener('click', async () => {
  if (!_signupData) return;
  const otp = document.getElementById('otpInput').value.trim();
  if (!otp || otp.length < 4) { showToast('Enter the verification code from your email.', 'error'); return; }
  const btn = document.getElementById('verifyOtpBtn');
  btn.textContent = 'Verifying...'; btn.disabled = true;
  const data = await api('/auth/verify-signup', { method: 'POST', body: JSON.stringify({ email: _signupData.email, otp, signupToken: _signupData.signupToken }) });
  btn.textContent = 'Verify & Sign In'; btn.disabled = false;
  if (data.success) {
    localStorage.setItem('se_token', data.data.accessToken);
    localStorage.setItem('se_refresh', data.data.refreshToken);
    sU(data.data.user);
    updateNav(data.data.user);
    closeModal('signupModal');
    document.getElementById('signupForm').style.display = '';
    document.getElementById('signupOtpStep').style.display = 'none';
    _signupData = null;
    showToast('Welcome to Grit&Gigs!', 'success');
    setTimeout(() => window.location.href = 'dashboard.html', 1000);
  } else {
    showToast(data.message || 'Invalid code. Try again.', 'error');
  }
});

document.getElementById('otpInput')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('verifyOtpBtn').click();
});

document.getElementById('resendOtpLink')?.addEventListener('click', async () => {
  if (!_signupData) return;
  const link = document.getElementById('resendOtpLink');
  link.textContent = 'Sending...'; link.style.pointerEvents = 'none';
  const d = await api('/auth/resend-otp', { method: 'POST', body: JSON.stringify({ email: _signupData.email }) });
  link.textContent = 'Resend'; link.style.pointerEvents = '';
  showToast(d.message || (d.success ? 'Code resent!' : 'Failed'), d.success ? 'success' : 'error');
});

// ═══════════════════════════════════════════════════════
//  LOGIN
// ═══════════════════════════════════════════════════════
document.getElementById('loginForm')?.addEventListener('submit', async e => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');
  const orig = btn.textContent;
  btn.textContent = 'Signing in...'; btn.disabled = true;

  const email    = e.target.querySelector('input[type=email]').value.trim();
  const password = e.target.querySelector('input[type=password]').value;

  const data = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
  btn.textContent = orig; btn.disabled = false;

  if (data.success) {
    localStorage.setItem('se_token',   data.data.accessToken);
    localStorage.setItem('se_refresh', data.data.refreshToken);
    sU(data.data.user);
    updateNav(data.data.user);
    closeModal('loginModal');
    showToast(`Welcome back, ${data.data.user.firstName}!`, 'success');
    setTimeout(() => window.location.href = 'dashboard.html', 1000);
  } else {
    showToast(data.message || 'Invalid email or password.', 'error');
  }
});

// ═══════════════════════════════════════════════════════
//  POST BARTER (real)
// ═══════════════════════════════════════════════════════
document.getElementById('barterForm')?.addEventListener('submit', async e => {
  e.preventDefault();
  if (!gT()) { closeModal('barterModal'); openModal('signupModal'); return; }
  const btn = e.target.querySelector('button[type=submit]');
  const orig = btn.textContent;
  btn.textContent = 'Posting...'; btn.disabled = true;

  const inputs = e.target.querySelectorAll('input, textarea, select');
  const data = await api('/barter/requests', {
    method: 'POST',
    body: JSON.stringify({
      skillOffered: inputs[0].value,
      skillNeeded:  inputs[1].value,
      description:  inputs[2].value,
      timeline:     inputs[3].value,
      city:         inputs[4]?.value || '',
    }),
  });
  btn.textContent = orig; btn.disabled = false;
  closeModal('barterModal');
  showToast(data.success ? 'Exchange posted! Finding matches now.' : (data.message || 'Failed'), data.success ? 'success' : 'error');
});

// ═══════════════════════════════════════════════════════
//  LOAD LIVE BARTER CARDS on index page
// ═══════════════════════════════════════════════════════
async function loadLiveBarterCards() {
  const grid = document.querySelector('.barter-grid');
  if (!grid) return;
  const data = await api('/barter/requests?limit=5&sort=newest');
  const ctaCard = `
    <div class="barter-card" style="background:var(--violet);border-color:transparent;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;min-height:200px;">
      <div style="font-family:var(--font-display);font-size:1.2rem;font-weight:700;color:white;margin-bottom:8px;">Have a skill to offer?</div>
      <div style="font-size:0.88rem;color:rgba(255,255,255,0.75);margin-bottom:20px;line-height:1.5;">Post your exchange and get matched in minutes.</div>
      <button class="btn btn-white" onclick="if(window.gT && window.gT()){openModal('barterModal')}else{openModal('signupModal')}">Post exchange</button>
    </div>`;
  if (!data.success || !data.data.requests?.length) {
    grid.innerHTML = ctaCard;
    return;
  }

  const cards = data.data.requests.map(r => {
    const initials = ((r.user?.firstName || '?')[0] + (r.user?.lastName || '?')[0]).toUpperCase();
    const pp = r.user?.profilePhoto || '';
    const timeAgo = getTimeAgo(r.createdAt);
    const bgColors = ['avatar-v', 'avatar-g', 'avatar-a'];
    const bg = bgColors[Math.floor(Math.random() * bgColors.length)];
    const avHtml = pp ? `<img src="${pp}" style="width:34px;height:34px;border-radius:50%;object-fit:cover;flex-shrink:0;"/>` : `<div class="avatar-placeholder ${bg}" style="width:34px;height:34px;font-size:12px;">${initials}</div>`;
    return `
      <div class="barter-card">
        <div class="barter-card-top">
          <div class="barter-user-info">
            ${avHtml}
            <div><div class="barter-name">${r.user?.firstName || '?'} ${r.user?.lastName || ''}</div><div class="barter-loc">${r.city || 'India'}</div></div>
          </div>
          <span class="badge badge-surface">Active</span>
        </div>
        <div class="barter-exchange">
          <div class="barter-side"><div class="barter-label">I need</div><div class="barter-skill">${r.skillNeeded}</div></div>
          <div class="barter-arrow">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M7 16V4m0 0L3 8m4-4 4 4M17 8v12m0 0 4-4m-4 4-4-4"/></svg>
          </div>
          <div class="barter-side"><div class="barter-label">I offer</div><div class="barter-skill">${r.skillOffered}</div></div>
        </div>
        <div class="barter-card-footer">
          <span style="font-size:0.78rem;color:var(--text-muted);">${timeAgo}</span>
          <button class="btn btn-primary btn-sm" onclick="matchOrLogin('${r.id}')">Match me</button>
        </div>
      </div>`;
  });

  cards.push(ctaCard);
  cards.push(`<div style="grid-column:1/-1;text-align:center;margin-top:8px;"><a href="barter.html" class="btn btn-secondary btn-sm">View all exchanges →</a></div>`);
  grid.innerHTML = cards.join('');
}

window.matchOrLogin = async function(requestId) {
  if (!gT()) { openModal('signupModal'); return; }
  const data = await api('/barter/matches', { method: 'POST', body: JSON.stringify({ targetRequestId: requestId }) });
  showToast(data.success ? 'Match request sent!' : (data.message || 'Post your own exchange request first.'), data.success ? 'success' : 'error');
};

// ═══════════════════════════════════════════════════════
//  LOAD LIVE SERVICES on index + freelance page
// ═══════════════════════════════════════════════════════
async function loadLiveServices() {
  const grid = document.querySelector('.services-grid');
  if (!grid) return;
  const data = await api('/services?limit=4');
  if (!data.success || !data.data.services?.length) {
    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--text-muted);">No services yet. <a href=\"dashboard.html\" style=\"color:var(--violet);font-weight:600;\">Be the first to post one!</a></div>';
    return;
  }

  grid.innerHTML = data.data.services.map(s => {
    const initials = ((s.seller?.firstName || '?')[0] + (s.seller?.lastName || '')[0]).toUpperCase();
    const pp = s.seller?.profilePhoto || '';
    const ppEnc = encodeURIComponent(pp);
    const img = s.images?.[0] || getDefaultImg(s.category);
    const price = s.packages?.[0]?.priceInr || 0;
    const levelBadge = s.orderCount > 200 ? 'Top Rated' : s.orderCount > 50 ? 'Level 2' : s.orderCount > 10 ? 'Level 1' : 'New';
    const levelClass = levelBadge === 'Top Rated' ? 'badge-violet' : levelBadge === 'Level 2' ? 'badge-gold' : 'badge-surface';
    const sellerAv = pp ? `<img src="${pp}" style="width:24px;height:24px;border-radius:50%;object-fit:cover;flex-shrink:0;"/>` : `<div class="avatar-placeholder avatar-v" style="width:24px;height:24px;font-size:10px;">${initials}</div>`;
    return `
      <div class="service-card" onclick="openServiceModal('${s.id}','${s.title.replace(/'/g,"\\'")}',${price},'${ppEnc}','${s.seller?.firstName||'?'} ${s.seller?.lastName||''}')">
        <div class="service-card-img">
          <img src="${img}" alt="${s.title}" loading="lazy"/>
        </div>
        <div class="service-card-body">
          <div class="service-card-seller">
            ${sellerAv}
            <span class="service-card-seller-name">${s.seller?.firstName || '?'} ${s.seller?.lastName || ''}</span>
            <span class="badge ${levelClass}" style="font-size:0.68rem;padding:2px 7px;">${levelBadge}</span>
          </div>
          <div class="service-card-title">${s.title}</div>
          <div class="service-card-footer">
            <div class="service-card-rating">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="#F59E0B"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
              ${s.ratingAvg?.toFixed(1) || 'New'} <span style="color:var(--text-muted);font-weight:400;">(${s.reviewCount || 0})</span>
            </div>
            <div class="service-card-price">From ₹${price.toLocaleString('en-IN')}</div>
          </div>
        </div>
      </div>`;
  }).join('');
}

// ═══════════════════════════════════════════════════════
//  SERVICE DETAIL MODAL (real — buy or login)
// ═══════════════════════════════════════════════════════
window.openServiceModal = async function(serviceId, title, price, profilePhoto, sellerName) {
  // Fetch full service details
  const data = await api('/services/' + serviceId);
  if (!data.success) { showToast('Failed to load service', 'error'); return; }
  const s = data.data.service;

  // Build modal HTML
  const modal = document.getElementById('serviceModal');
  if (!modal) return;

  const img = s.images?.[0] || getDefaultImg(s.category);
  const pkgHtml = s.packages.map(p => `
    <div style="background:var(--surface);border-radius:12px;padding:16px;border:1px solid var(--border);cursor:pointer;" onclick="selectPackage('${p.id}', ${p.priceInr}, this)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <span style="font-weight:600;font-size:0.9rem;text-transform:capitalize;">${p.packageType}</span>
        <span style="font-family:var(--font-display);font-size:1.1rem;font-weight:700;color:var(--violet);">₹${p.priceInr.toLocaleString('en-IN')}</span>
      </div>
      <div style="font-size:0.82rem;color:var(--text-secondary);margin-bottom:8px;">${p.description}</div>
      <div style="display:flex;gap:12px;font-size:0.75rem;color:var(--text-muted);">
        <span>⏱ ${p.deliveryDays} days</span><span>🔄 ${p.revisions === 999 ? 'Unlimited' : p.revisions} revisions</span>
      </div>
    </div>`).join('');

  const reviewsHtml = s.reviews?.length ? s.reviews.slice(0,3).map(r => {
    const ri = ((r.reviewer?.firstName||'?')[0]+(r.reviewer?.lastName||'')[0]).toUpperCase();
    const rpp = r.reviewer?.profilePhoto || '';
    const rProfUrl = 'profile.html?id=' + encodeURIComponent(r.reviewerId);
    const rAv = rpp ? `<img src="${rpp}" style="width:28px;height:28px;border-radius:50%;object-fit:cover;flex-shrink:0;cursor:pointer;" onclick="closeModal('serviceModal');location.href='${rProfUrl}'"/>` : `<div class="avatar-placeholder avatar-v" style="width:28px;height:28px;font-size:10px;cursor:pointer;" onclick="closeModal('serviceModal');location.href='${rProfUrl}'">${ri}</div>`;
    return `<div style="padding:12px 0;border-bottom:1px solid var(--border);">
      <div style="display:flex;gap:10px;align-items:center;margin-bottom:6px;">
        ${rAv}
        <span style="font-weight:600;font-size:0.84rem;cursor:pointer;" onclick="closeModal('serviceModal');location.href='${rProfUrl}'">${r.reviewer?.firstName||'?'} ${r.reviewer?.lastName||''}</span>
        <span style="color:#F59E0B;margin-left:auto;">${'★'.repeat(r.rating)}${'☆'.repeat(5-r.rating)}</span>
      </div>
      <p style="font-size:0.82rem;color:var(--text-secondary);">${r.reviewText||''}</p>
    </div>`;
  }).join('') : '<div style="padding:12px 0;color:var(--muted);font-size:0.84rem;">No reviews yet — be the first buyer!</div>';

  const profileUrl = 'profile.html?id=' + encodeURIComponent(s.sellerId);
  const sellerAv = profilePhoto ? `<img src="${decodeURIComponent(profilePhoto)}" style="width:34px;height:34px;border-radius:50%;object-fit:cover;flex-shrink:0;cursor:pointer;" onclick="closeModal('serviceModal');location.href='${profileUrl}'"/>` : `<div class="avatar-placeholder avatar-v" style="width:34px;height:34px;font-size:12px;cursor:pointer;" onclick="closeModal('serviceModal');location.href='${profileUrl}'">${((s.seller?.firstName||'?')[0]+(s.seller?.lastName||'')[0]).toUpperCase()}</div>`;

  modal.querySelector('.modal').innerHTML = `
    <button class="modal-close" onclick="closeModal('serviceModal')">×</button>
    <img src="${img}" alt="${s.title}" style="width:100%;height:200px;object-fit:cover;border-radius:14px;margin-bottom:18px;"/>
    <div style="display:flex;gap:10px;align-items:center;margin-bottom:12px;">
      ${sellerAv}
      <div><div style="font-weight:600;font-size:0.9rem;cursor:pointer;" onclick="closeModal('serviceModal');location.href='${profileUrl}'">${sellerName}${kycBadge(s.seller?.kycVerified)}</div><div style="font-size:0.75rem;color:var(--text-muted);">${s.seller?.city||'India'} · Rep ${s.seller?.reputationScore||0}</div></div>
      <div style="margin-left:auto;"><span style="color:#F59E0B;font-weight:700;">${s.ratingAvg?.toFixed(1)||'New'}</span> <span style="color:var(--text-muted);font-size:0.8rem;">(${s.reviewCount||0})</span></div>
    </div>
    <h3 style="font-size:1.05rem;margin-bottom:8px;line-height:1.4;">${s.title}</h3>
    <p style="font-size:0.86rem;color:var(--text-secondary);line-height:1.65;margin-bottom:18px;">${s.description?.slice(0,200)}...</p>
    <div style="margin-bottom:18px;"><div style="font-weight:600;margin-bottom:10px;font-size:0.9rem;">Choose a package</div><div style="display:flex;flex-direction:column;gap:10px;" id="pkgList">${pkgHtml}</div></div>
    <input type="hidden" id="selectedPkgId" value="${s.packages?.[0]?.id||''}"/>
    <input type="hidden" id="selectedPkgPrice" value="${s.packages?.[0]?.priceInr||0}"/>
    <input type="hidden" id="currentServiceId" value="${s.id}"/>
    <div style="margin-bottom:18px;"><div style="font-weight:600;margin-bottom:10px;font-size:0.9rem;">Your requirements</div><textarea id="orderRequirements" style="width:100%;padding:10px 12px;border-radius:8px;border:1.5px solid rgba(10,10,15,0.15);font-family:'DM Sans',sans-serif;font-size:0.86rem;outline:none;resize:vertical;" rows="3" placeholder="Describe what you need specifically..."></textarea></div>
    <button class="btn btn-primary btn-lg" style="width:100%;justify-content:center;" onclick="placeOrder()">
      Continue — ₹<span id="modalPrice">${(s.packages?.[0]?.priceInr||0).toLocaleString('en-IN')}</span>
    </button>
    <div style="margin-top:16px;border-top:1px solid var(--border);padding-top:16px;"><div style="font-weight:600;margin-bottom:8px;font-size:0.9rem;">Reviews</div>${reviewsHtml}</div>`;

  openModal('serviceModal');
};

window.selectPackage = function(pkgId, price, el) {
  $$('#pkgList > div').forEach(d => d.style.borderColor = 'var(--border)');
  el.style.borderColor = 'var(--violet)';
  document.getElementById('selectedPkgId').value = pkgId;
  document.getElementById('selectedPkgPrice').value = price;
  document.getElementById('modalPrice').textContent = price.toLocaleString('en-IN');
};

window.placeOrder = async function() {
  if (!gT()) { closeModal('serviceModal'); openModal('signupModal'); return; }
  const serviceId = document.getElementById('currentServiceId').value;
  const packageId = document.getElementById('selectedPkgId').value;
  const requirements = document.getElementById('orderRequirements').value;
  if (!packageId) { showToast('Please select a package', 'error'); return; }

  const btn = document.querySelector('#serviceModal button.btn-primary');
  const orig = btn.textContent; btn.textContent = 'Placing order...'; btn.disabled = true;

  const data = await api('/orders', { method: 'POST', body: JSON.stringify({ serviceId, packageId, requirements }) });
  btn.textContent = orig; btn.disabled = false;

  if (data.success) {
    closeModal('serviceModal');
    showToast('Order placed successfully! Check your dashboard.', 'success');
    setTimeout(() => window.location.href = 'dashboard.html', 1500);
  } else {
    showToast(data.message || 'Failed to place order', 'error');
  }
};

// ═══════════════════════════════════════════════════════
//  FREELANCE PAGE — load real services + filters
// ═══════════════════════════════════════════════════════


// ═══════════════════════════════════════════════════════
//  BARTER PAGE — load real exchanges
// ═══════════════════════════════════════════════════════
async function loadBarterPage(q = '', category = '', city = '', sort = 'newest') {
  const grid = document.querySelector('.barter-cards-grid');
  if (!grid) return;
  grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--text-muted);">Loading exchanges...</div>';

  let endpoint = '/barter/requests?limit=12';
  if (sort) endpoint += '&sort=' + encodeURIComponent(sort);
  if (q) endpoint += '&q=' + encodeURIComponent(q);
  if (category) endpoint += '&category=' + encodeURIComponent(category);
  if (city) endpoint += '&city=' + encodeURIComponent(city);

  const data = await api(endpoint);
  if (!data.success) { grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--text-muted);">Failed to load. Is the backend running?</div>'; return; }

  const reqs = data.data.requests;
  const total = data.data.total ?? reqs.length;

  // Update count display
  const countEl = document.querySelector('[data-barter-count]');
  if (countEl) countEl.innerHTML = `Showing <strong style="color:var(--ink);">${total} active exchange${total !== 1 ? 's' : ''}</strong>`;

  // Update sidebar "Active now" stat
  const activeNowEl = document.getElementById('barterActiveNow');
  if (activeNowEl) activeNowEl.textContent = total;

  if (!reqs.length) { grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--text-muted);">No exchanges found. Be the first to post!</div>'; return; }

  const colors = ['avatar-v','avatar-g','avatar-a'];
  grid.innerHTML = reqs.map((r, i) => {
    const initials = ((r.user?.firstName||'?')[0]+(r.user?.lastName||'?')[0]).toUpperCase();
    const pp = r.user?.profilePhoto || '';
    const timeAgo = getTimeAgo(r.createdAt);
    const color = colors[i % colors.length];
    const avHtml = pp ? `<img src="${pp}" style="width:34px;height:34px;border-radius:50%;object-fit:cover;flex-shrink:0;"/>` : `<div class="avatar-placeholder ${color}" style="width:34px;height:34px;font-size:12px;">${initials}</div>`;
    return `
      <div class="barter-full-card" onclick="openBarterDetail('${r.id}')">
        <div class="bfc-header">
          <div class="bfc-user">
            ${avHtml}
            <div><div class="bfc-name">${r.user?.firstName||'?'} ${r.user?.lastName||''}</div><div class="bfc-meta">${r.city||'India'} · Rep ${r.user?.reputationScore||0}</div></div>
          </div>
          <span class="badge badge-surface" style="font-size:0.7rem;">Active</span>
        </div>
        <div class="bfc-exchange">
          <div><div class="bfc-side-label">I need</div><div class="bfc-skill-name">${r.skillNeeded}</div><div class="bfc-skill-cat">${r.needCategory||''}</div></div>
          <div class="bfc-center">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M7 16V4m0 0L3 8m4-4 4 4M17 8v12m0 0 4-4m-4 4-4-4"/></svg>
          </div>
          <div><div class="bfc-side-label">I offer</div><div class="bfc-skill-name">${r.skillOffered}</div><div class="bfc-skill-cat">${r.offerCategory||''}</div></div>
        </div>
        ${r.description ? `<p class="bfc-desc">${r.description.slice(0,120)}</p>` : ''}
        <div class="bfc-footer">
          <div class="bfc-tags"><span class="bfc-tag">${r.timeline||'Flexible'}</span><span class="bfc-tag">${r.isRemote?'Remote':'Local'}</span></div>
          <span class="bfc-time">${timeAgo}</span>
        </div>
      </div>`;
  }).join('');
}

window.openBarterDetail = async function(requestId) {
  const data = await api('/barter/requests/' + requestId);
  if (!data.success) { showToast('Could not load exchange details', 'error'); return; }
  const r = data.data.request;
  const modal = document.getElementById('detailModal');
  if (!modal) return;
  const initials = ((r.user?.firstName||'?')[0]+(r.user?.lastName||'?')[0]).toUpperCase();
  const rpp = r.user?.profilePhoto || '';
  const rAv = rpp ? `<img src="${rpp}" style="width:40px;height:40px;border-radius:50%;object-fit:cover;flex-shrink:0;"/>` : `<div class="avatar-placeholder avatar-v">${initials}</div>`;
  modal.querySelector('.modal').innerHTML = `
    <button class="modal-close" onclick="closeModal('detailModal')">×</button>
    <div style="display:flex;gap:12px;align-items:center;margin-bottom:18px;">
      ${rAv}
      <div><div style="font-weight:600;font-size:1rem;">${r.user?.firstName||'?'} ${r.user?.lastName||''}</div><div style="font-size:0.8rem;color:var(--text-muted);">${r.city||'India'} · Rep ${r.user?.reputationScore||0}</div></div>
    </div>
    <div class="detail-exchange-visual">
      <div class="detail-skill-box"><div class="detail-skill-label">Needs</div><div class="detail-skill-name">${r.skillNeeded}</div></div>
      <div class="detail-arrow-circle">⇅</div>
      <div class="detail-skill-box"><div class="detail-skill-label">Offers</div><div class="detail-skill-name">${r.skillOffered}</div></div>
    </div>
    ${r.description ? `<p style="font-size:0.88rem;color:var(--text-secondary);margin-bottom:16px;line-height:1.65;">${r.description}</p>` : ''}
    <div style="display:flex;gap:20px;margin-bottom:20px;flex-wrap:wrap;">
      <div><div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:3px;">Timeline</div><div style="font-size:0.88rem;font-weight:600;">${r.timeline}</div></div>
      <div><div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:3px;">Location</div><div style="font-size:0.88rem;font-weight:600;">${r.isRemote?'Remote':'Local – '+r.city}</div></div>
    </div>
    <div style="display:flex;gap:10px;">
      <button class="btn btn-primary" style="flex:1;justify-content:center;" onclick="closeModal('detailModal');matchOrLogin('${r.id}')">Send match request</button>
      <button class="btn btn-secondary" onclick="closeModal('detailModal')">Cancel</button>
    </div>`;
  openModal('detailModal');
};

// ═══════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════
function getTimeAgo(dateStr) {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

function getDefaultImg(category) {
  const imgs = {
    'Design & Creative': 'https://images.unsplash.com/photo-1561070791-2526d30994b5?w=400&q=60',
    'Development': 'https://images.unsplash.com/photo-1498050108023-c5249f4df085?w=400&q=60',
    'Writing & Content': 'https://images.unsplash.com/photo-1455390582262-044cdead277a?w=400&q=60',
    'Digital Marketing': 'https://images.unsplash.com/photo-1432888498266-38ffec3eaf0a?w=400&q=60',
    'Video & Animation': 'https://images.unsplash.com/photo-1574717024653-61fd2cf4d44d?w=400&q=60',
    'Business': 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=400&q=60',
    'Music & Audio': 'https://images.unsplash.com/photo-1511379938547-c1f69419868d?w=400&q=60',
    'Data & Analytics': 'https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=400&q=60',
    'Education': 'https://images.unsplash.com/photo-1524178232363-1fb2b075b655?w=400&q=60',
  };
  return imgs[category] || 'https://images.unsplash.com/photo-1522202176988-66273c2fd55f?w=400&q=60';
}

// ═══════════════════════════════════════════════════════
//  PAGE-SPECIFIC INIT
// ═══════════════════════════════════════════════════════
const path = window.location.pathname;

if (path.includes('index') || path === '/' || path.endsWith('/')) {
  loadLiveBarterCards();
  loadLiveServices();
}



if (path.includes('barter')) {
  loadBarterPage();

  // Fetch real AI suggestions if logged in
  if (gT()) {
    api('/barter/ai-suggestions').then(d => {
      const notif = document.getElementById('matchNotif');
      const btn = document.getElementById('matchNotifBtn');
      if (!notif) return;
      if (d.success) {
        const suggestions = d.data.suggestions || [];
        const hasMyRequest = !!d.data.myRequest;
        if (suggestions.length > 0) {
          notif.querySelector('.match-notif-title').textContent = `AI found ${suggestions.length} complementary match${suggestions.length !== 1 ? 'es' : ''}`;
          notif.querySelector('.match-notif-sub').textContent = suggestions.length === 1
            ? `1 user who offers what you need and needs what you offer.`
            : `${suggestions.length} users who offer what you need and need what you offer.`;
          if (btn) { btn.textContent = 'See your matches'; btn.onclick = () => location.href = 'dashboard.html'; }
        } else if (hasMyRequest) {
          notif.querySelector('.match-notif-title').textContent = 'No matches found yet';
          notif.querySelector('.match-notif-sub').textContent = 'We haven\'t found a complementary skill swap yet. Check back after more people post.';
          if (btn) { btn.textContent = 'Browse all exchanges'; btn.onclick = () => window.scrollTo({top: document.querySelector('.barter-cards-grid')?.offsetTop || 0, behavior: 'smooth'}); }
        } else {
          notif.querySelector('.match-notif-title').textContent = 'Post an exchange to get AI-matched';
          notif.querySelector('.match-notif-sub').textContent = 'Our AI finds people who offer what you need and need what you offer.';
          if (btn) { btn.textContent = 'Post exchange'; btn.onclick = () => location.href = 'dashboard.html?tab=post-exchange'; }
        }
      }
    }).catch(() => {});
  } else {
    const notif = document.getElementById('matchNotif');
    if (notif) {
      notif.querySelector('.match-notif-title').textContent = 'Sign in to see your matches';
      notif.querySelector('.match-notif-sub').textContent = 'Our AI finds your perfect skill exchange partner for free.';
      const btn = document.getElementById('matchNotifBtn');
      if (btn) { btn.textContent = 'Sign in'; btn.onclick = () => openModal('loginModal'); }
    }
  }

  // Search input
  document.querySelector('.filter-search input')?.addEventListener('input', e => {
    const q = e.target.value;
    const cat = document.getElementById('barterCatFilter')?.value || '';
    const city = document.getElementById('barterLocFilter')?.value || '';
    const sort = document.getElementById('barterSortFilter')?.value || 'newest';
    loadBarterPage(q, cat, city, sort);
  });

  // Category / location / sort filters
  ['barterCatFilter', 'barterLocFilter', 'barterSortFilter'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', () => {
      const q = document.querySelector('.filter-search input')?.value || '';
      const cat = document.getElementById('barterCatFilter')?.value || '';
      const city = document.getElementById('barterLocFilter')?.value || '';
      const sort = document.getElementById('barterSortFilter')?.value || 'newest';
      loadBarterPage(q, cat, city, sort);
    });
  });
}

// Make sure serviceModal exists on all pages
if (!document.getElementById('serviceModal')) {
  const mo = document.createElement('div');
  mo.className = 'modal-overlay';
  mo.id = 'serviceModal';
  mo.innerHTML = '<div class="modal" style="max-width:580px;max-height:90vh;overflow-y:auto;"></div>';
  mo.addEventListener('click', e => { if (e.target === mo) closeModal('serviceModal'); });
  document.body.appendChild(mo);
}

// ── Google Sign-In (popup redirect flow) ──────────────────────────────────
function googleSignIn() {
  var w = 500, h = 600;
  var left = Math.max(0, (screen.width - w) / 2);
  var top = Math.max(0, (screen.height - h) / 2);
  var popup = window.open(
    '/api/auth/google/login',
    'google-login',
    'width=' + w + ',height=' + h + ',left=' + left + ',top=' + top + ',resizable=yes,scrollbars=yes'
  );
  if (!popup) {
    showToast('Popup was blocked. Please allow popups for this site.', 'error');
    return;
  }
}

// Listen for postMessage from the popup
window.addEventListener('message', function googleMessageHandler(e) {
  // Accept from any origin for now (our own server anyway)
  var data = e.data;
  if (!data || typeof data.success === 'undefined') return;

  if (data.success && data.data) {
    localStorage.setItem('se_token', data.data.accessToken);
    localStorage.setItem('se_refresh', data.data.refreshToken);
    localStorage.setItem('se_user', JSON.stringify(data.data.user));
    showToast('Welcome, ' + data.data.user.firstName + '!', 'success');
    setTimeout(function() { window.location.href = 'dashboard.html'; }, 600);
  } else {
    showToast(data.message || 'Google sign-in failed', 'error');
  }
});

// Wire up Google buttons
$$('.btn-google').forEach(function(btn) {
  btn.addEventListener('click', function(e) {
    e.preventDefault();
    googleSignIn();
  });
});

