(function () {
  var API = '/api';
  var TOTAL = 5;
  var STEP_LABELS = ['Your role', 'About you', 'Your skills', 'Portfolio links', 'Sample works'];
  var step = 1;
  var role = '';
  var submitting = false;
  var onDone = null;
  var state = {
    tagline: '',
    bio: '',
    city: '',
    offered: [],
    needed: [],
    links: [{ label: '', url: '' }],
    samples: [{ title: '', description: '', url: '', image: '' }],
  };

  function el(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function ensureCss() {
    if (el('gritObCss')) return;
    var s = document.createElement('style');
    s.id = 'gritObCss';
    s.textContent =
      '#gritOb{position:fixed;inset:0;z-index:9999;display:none;align-items:center;justify-content:center;padding:16px;font-family:Inter,"Segoe UI",system-ui,-apple-system,sans-serif}' +
      '#gritOb.open{display:flex}' +
      '#gritOb .bd{position:absolute;inset:0;background:rgba(10,10,16,.62)}' +
      '#gritOb .card{position:relative;background:#fff;color:#1a1a1f;border-radius:18px;width:560px;max-width:100%;max-height:94vh;overflow:auto;box-shadow:0 30px 70px rgba(0,0,0,.35);padding:24px 26px 18px}' +
      '#gritOb .brand{font-size:11px;letter-spacing:.2em;font-weight:800;color:#a17400;text-align:center}' +
      '#gritOb .prog{height:5px;background:#eee;border-radius:99px;margin:12px 0 8px;overflow:hidden}' +
      '#gritOb .prog i{display:block;height:100%;background:linear-gradient(90deg,#eab308,#f59e0b);border-radius:99px;transition:width .25s}' +
      '#gritOb .steplbl{font-size:12px;color:#6b7280;text-align:center;margin-bottom:14px}' +
      '#gritOb h3{margin:0 0 4px;font-size:20px;line-height:1.25}' +
      '#gritOb .sub{margin:0 0 16px;font-size:13.5px;color:#6b7280;line-height:1.5}' +
      '#gritOb .fld{margin-bottom:14px}' +
      '#gritOb label{display:block;font-size:12px;font-weight:700;color:#374151;margin-bottom:6px}' +
      '#gritOb .in{width:100%;box-sizing:border-box;border:1px solid #d8d8de;border-radius:10px;padding:10px 12px;font-size:14px;font-family:inherit;background:#fff;color:#1a1a1f;outline:none}' +
      '#gritOb .in:focus{border-color:#eab308;box-shadow:0 0 0 3px rgba(234,179,8,.18)}' +
      '#gritOb textarea.in{min-height:74px;resize:vertical}' +
      '#gritOb .roles{display:flex;gap:10px;flex-wrap:wrap}' +
      '#gritOb .role{flex:1;min-width:150px;border:1.5px solid #e3e3e8;background:#fafafa;border-radius:14px;padding:16px 12px;cursor:pointer;text-align:center;font-family:inherit;transition:.15s}' +
      '#gritOb .role:hover{border-color:#d0d0d8;background:#f4f4f6}' +
      '#gritOb .role.sel{border-color:#eab308;background:#fffbeb;box-shadow:0 0 0 3px rgba(234,179,8,.2)}' +
      '#gritOb .role .ic{width:40px;height:40px;border-radius:50%;background:#111;color:#eab308;font-weight:800;font-size:15px;display:flex;align-items:center;justify-content:center;margin:0 auto 10px}' +
      '#gritOb .role b{display:block;font-size:14.5px;margin-bottom:4px}' +
      '#gritOb .role small{display:block;font-size:12px;color:#6b7280;line-height:1.4}' +
      '#gritOb .chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;min-height:6px}' +
      '#gritOb .chip{display:inline-flex;align-items:center;gap:6px;background:#f3f4f6;border:1px solid #e3e3e8;border-radius:99px;padding:5px 10px;font-size:13px;color:#1f2937}' +
      '#gritOb .chip button{border:0;background:none;cursor:pointer;color:#9ca3af;font-size:14px;line-height:1;padding:0}' +
      '#gritOb .chip button:hover{color:#dc2626}' +
      '#gritOb .hint{font-size:12px;color:#9ca3af;margin-top:5px}' +
      '#gritOb .empty{font-size:12.5px;color:#9ca3af;font-style:italic}' +
      '#gritOb .row{display:flex;gap:8px;margin-bottom:8px;align-items:flex-start}' +
      '#gritOb .row .in{flex:1}' +
      '#gritOb .row .in.grow{flex:2}' +
      '#gritOb .del{border:1px solid #e3e3e8;background:#fff;color:#9ca3af;border-radius:10px;width:38px;min-width:38px;height:38px;cursor:pointer;font-size:16px;line-height:1}' +
      '#gritOb .del:hover{border-color:#fca5a5;color:#dc2626;background:#fef2f2}' +
      '#gritOb .add{border:1.5px dashed #d0d0d8;background:#fafafa;color:#4b5563;border-radius:10px;padding:9px 14px;cursor:pointer;font-size:13px;font-family:inherit;font-weight:600}' +
      '#gritOb .add:hover{border-color:#eab308;color:#a17400;background:#fffbeb}' +
      '#gritOb .sample{border:1px solid #ececf0;background:#fafafa;border-radius:14px;padding:14px;margin-bottom:10px;position:relative}' +
      '#gritOb .sample .del{position:absolute;top:10px;right:10px;height:32px;width:32px;min-width:32px}' +
      '#gritOb .sample h4{margin:0 0 10px;font-size:13px;color:#374151}' +
      '#gritOb .err{min-height:18px;font-size:12.5px;color:#dc2626;text-align:center;margin-top:4px}' +
      '#gritOb .ok{color:#16a34a}' +
      '#gritOb .foot{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:8px;border-top:1px solid #f0f0f3;padding-top:14px}' +
      '#gritOb .navs{display:flex;gap:8px;margin-left:auto}' +
      '#gritOb .sk{border:0;background:none;color:#6b7280;font-size:13px;cursor:pointer;font-family:inherit;padding:8px 4px}' +
      '#gritOb .sk:hover{color:#111;text-decoration:underline}' +
      '#gritOb .ghost{border:1px solid #d8d8de;background:#fff;color:#374151;border-radius:10px;padding:10px 18px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit}' +
      '#gritOb .ghost:hover{background:#f3f4f6}' +
      '#gritOb .pri{border:0;background:#111;color:#fff;border-radius:10px;padding:10px 22px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;min-width:96px}' +
      '#gritOb .pri:hover{background:#333}' +
      '#gritOb .pri:disabled{opacity:.55;cursor:default}' +
      '@media (max-width:520px){#gritOb .card{padding:18px 16px 14px}#gritOb .role{min-width:120px}}';
    document.head.appendChild(s);
  }

  function markup() {
    return (
      '<div id="gritOb">' +
      '<div class="bd"></div>' +
      '<div class="card" role="dialog" aria-modal="true">' +
      '<div class="brand">GRIT AND GIGS</div>' +
      '<div class="prog"><i id="gritObProg"></i></div>' +
      '<div class="steplbl" id="gritObStepLabel"></div>' +
      '<div id="gritObBody"></div>' +
      '<div class="err" id="gritObErr"></div>' +
      '<div class="foot">' +
      '<button type="button" class="sk" id="gritObSkip">Skip for now</button>' +
      '<div class="navs">' +
      '<button type="button" class="ghost" id="gritObBack">Back</button>' +
      '<button type="button" class="pri" id="gritObNext">Next</button>' +
      '</div></div></div></div>'
    );
  }

  function showErr(msg, ok) {
    var e = el('gritObErr');
    if (!e) return;
    e.textContent = msg || '';
    e.className = 'err' + (ok ? ' ok' : '');
  }

  function roleHtml() {
    var cards = [
      { v: 'freelancer', ic: 'W', t: 'I want work', d: 'Offer your skills and take on gigs' },
      { v: 'client', ic: 'H', t: 'I want to hire', d: 'Post work and find talent' },
      { v: 'both', ic: 'B', t: 'Both', d: 'Hire people and work yourself' },
    ];
    return (
      '<h3>What brings you here?</h3>' +
      '<p class="sub">Pick how you will use Grit&Gigs. You can change this later in Settings.</p>' +
      '<div class="roles">' +
      cards
        .map(function (c) {
          return (
            '<button type="button" class="role' + (role === c.v ? ' sel' : '') + '" data-role="' + c.v + '">' +
            '<span class="ic">' + c.ic + '</span><b>' + c.t + '</b><small>' + c.d + '</small></button>'
          );
        })
        .join('') +
      '</div>'
    );
  }

  function step2Html() {
    return (
      '<h3>Tell us about you</h3>' +
      '<p class="sub">A short intro helps clients and collaborators trust you faster.</p>' +
      '<div class="fld"><label>Tagline</label><input class="in" data-st="tagline" maxlength="150" placeholder="e.g. Full-stack developer from Chennai" value="' + esc(state.tagline) + '"/></div>' +
      '<div class="fld"><label>Bio</label><textarea class="in" data-st="bio" maxlength="600" placeholder="What you do, what you are good at, what you are proud of...">' + esc(state.bio) + '</textarea></div>' +
      '<div class="fld"><label>City</label><input class="in" data-st="city" maxlength="100" placeholder="e.g. Bengaluru" value="' + esc(state.city) + '"/></div>'
    );
  }

  function chipsHtml(key, label, ph) {
    var list = state[key];
    var chips = list.length
      ? list
          .map(function (s, i) {
            return '<span class="chip">' + esc(s) + '<button type="button" data-chipdel="' + key + '" data-ci="' + i + '" aria-label="Remove">&times;</button></span>';
          })
          .join('')
      : '<span class="empty">None yet</span>';
    return (
      '<div class="fld"><label>' + label + '</label>' +
      '<div class="chips" id="chips-' + key + '">' + chips + '</div>' +
      '<input class="in" data-chip="' + key + '" placeholder="' + ph + '"/>' +
      '<div class="hint">Press Enter to add. Max 15.</div></div>'
    );
  }

  function step3Html() {
    return (
      '<h3>Your skills</h3>' +
      '<p class="sub">Skills power your profile, search ranking and recommendations.</p>' +
      chipsHtml('offered', 'Skills you offer', 'React, Video editing, Content writing...') +
      chipsHtml('needed', 'Skills you want', 'Copywriting, Figma, Accounting...')
    );
  }

  function step4Html() {
    var rows = state.links
      .map(function (l, i) {
        return (
          '<div class="row">' +
          '<input class="in" data-lk="label" data-i="' + i + '" maxlength="60" placeholder="Label (e.g. Dribbble)" value="' + esc(l.label) + '"/>' +
          '<input class="in grow" data-lk="url" data-i="' + i + '" maxlength="400" placeholder="https://..." value="' + esc(l.url) + '"/>' +
          (state.links.length > 1
            ? '<button type="button" class="del" data-dellink="' + i + '" aria-label="Remove link">&times;</button>'
            : '') +
          '</div>'
        );
      })
      .join('');
    return (
      '<h3>Portfolio links</h3>' +
      '<p class="sub">Websites, Behance, GitHub, Instagram business pages, anything that shows your work.</p>' +
      rows +
      (state.links.length < 5
        ? '<button type="button" class="add" id="gritObAddLink">+ Add another link</button>'
        : '<div class="hint">Maximum 5 links on this step.</div>')
    );
  }

  function step5Html() {
    var cards = state.samples
      .map(function (s, i) {
        return (
          '<div class="sample">' +
          (state.samples.length > 1
            ? '<button type="button" class="del" data-delsample="' + i + '" aria-label="Remove sample">&times;</button>'
            : '') +
          '<h4>Sample ' + (i + 1) + '</h4>' +
          '<div class="fld"><input class="in" data-sm="title" data-i="' + i + '" maxlength="200" placeholder="Title (e.g. Logo for a coffee brand)" value="' + esc(s.title) + '"/></div>' +
          '<div class="fld"><textarea class="in" data-sm="description" data-i="' + i + '" maxlength="1000" placeholder="What it is, what you did, the result...">' + esc(s.description) + '</textarea></div>' +
          '<div class="row"><input class="in" data-sm="image" data-i="' + i + '" maxlength="500" placeholder="Image URL (optional)" value="' + esc(s.image) + '"/>' +
          '<input class="in" data-sm="url" data-i="' + i + '" maxlength="500" placeholder="Link to view it (optional)" value="' + esc(s.url) + '"/></div>' +
          '</div>'
        );
      })
      .join('');
    return (
      '<h3>Show your best work</h3>' +
      '<p class="sub">Add up to 4 samples. Real work builds trust faster than any bio.</p>' +
      cards +
      (state.samples.length < 4
        ? '<button type="button" class="add" id="gritObAddSample">+ Add another sample</button>'
        : '<div class="hint">Maximum 4 samples on this step.</div>')
    );
  }

  var RENDERERS = { 1: roleHtml, 2: step2Html, 3: step3Html, 4: step4Html, 5: step5Html };

  function render() {
    var body = el('gritObBody');
    if (!body) return;
    body.innerHTML = RENDERERS[step]();
    el('gritObStepLabel').textContent = 'Step ' + step + ' of ' + TOTAL + ' — ' + STEP_LABELS[step - 1];
    el('gritObProg').style.width = Math.round((step / TOTAL) * 100) + '%';
    el('gritObBack').style.visibility = step === 1 ? 'hidden' : 'visible';
    el('gritObNext').textContent = step === TOTAL ? 'Finish' : 'Next';
    showErr('');
    var first = body.querySelector('input:not([data-chip]), textarea');
    if (step === 1) first = body.querySelector('.role');
    if (first && first.focus) { try { first.focus({ preventScroll: true }); } catch (e) { first.focus(); } }
  }

  function paintChips(key) {
    var box = el('chips-' + key);
    if (!box) return;
    box.innerHTML = state[key].length
      ? state[key]
          .map(function (s, i) {
            return '<span class="chip">' + esc(s) + '<button type="button" data-chipdel="' + key + '" data-ci="' + i + '" aria-label="Remove">&times;</button></span>';
          })
          .join('')
      : '<span class="empty">None yet</span>';
  }

  function addChip(key) {
    var inp = document.querySelector('#gritObBody [data-chip="' + key + '"]');
    if (!inp) return;
    var v = inp.value.trim().replace(/,+$/, '');
    if (!v) return;
    if (state[key].length >= 15) { showErr('You can add up to 15 skills here.'); return; }
    if (state[key].indexOf(v) === -1) state[key].push(v);
    inp.value = '';
    paintChips(key);
    showErr('');
  }

  function currentToken() {
    try { return localStorage.getItem('se_token') || ''; } catch (e) { return ''; }
  }

  function finish(skip) {
    if (submitting) return;
    if (!skip && !role) {
      step = 1;
      render();
      showErr('Pick one option to continue.');
      return;
    }
    var tok = currentToken();
    if (!tok) { showErr('Session expired. Please sign in again.'); return; }
    var body = {};
    if (!skip) {
      var links = state.links
        .filter(function (l) { return (l.url || '').trim(); })
        .map(function (l) { return { label: (l.label || '').trim() || 'Portfolio', url: l.url.trim() }; });
      var samples = state.samples
        .filter(function (s) { return (s.title || '').trim() || (s.url || '').trim() || (s.image || '').trim(); })
        .map(function (s) {
          return {
            title: (s.title || '').trim(),
            description: (s.description || '').trim(),
            url: (s.url || '').trim(),
            image: (s.image || '').trim(),
          };
        });
      body = {
        seekingTo: role,
        tagline: (state.tagline || '').trim(),
        bio: (state.bio || '').trim(),
        city: (state.city || '').trim(),
        skillsOffered: state.offered,
        skillsNeeded: state.needed,
        portfolioLinks: links,
        sampleWorks: samples,
      };
    }
    submitting = true;
    var btn = el('gritObNext');
    btn.disabled = true;
    btn.textContent = skip ? 'Skipping…' : 'Saving…';
    fetch(API + (skip ? '/auth/skip-onboarding' : '/auth/onboarding'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
      body: JSON.stringify(body),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        submitting = false;
        btn.disabled = false;
        btn.textContent = step === TOTAL ? 'Finish' : 'Next';
        if (!d.success) { showErr(d.message || 'Something went wrong. Please try again.'); return; }
        try {
          if (d.data && d.data.user) {
            var cur = JSON.parse(localStorage.getItem('se_user') || '{}');
            localStorage.setItem('se_user', JSON.stringify(Object.assign(cur, d.data.user)));
          }
        } catch (e) {}
        var done = onDone;
        close();
        if (typeof done === 'function') done({ skipped: !!skip, user: d.data && d.data.user });
      })
      .catch(function () {
        submitting = false;
        btn.disabled = false;
        btn.textContent = step === TOTAL ? 'Finish' : 'Next';
        showErr('Network error. Please try again.');
      });
  }

  function wire() {
    var body = el('gritObBody');
    el('gritObSkip').addEventListener('click', function () { finish(true); });
    el('gritObBack').addEventListener('click', function () {
      if (step > 1) { step -= 1; render(); }
    });
    el('gritObNext').addEventListener('click', function () {
      if (step === 1 && !role) { showErr('Pick one option to continue.'); return; }
      if (step < TOTAL) { step += 1; render(); } else { finish(false); }
    });
    body.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('[data-role],[data-chipdel],[data-dellink],[data-delsample],#gritObAddLink,#gritObAddSample') : null;
      if (!t) return;
      if (t.dataset.role) {
        role = t.dataset.role;
        var all = body.querySelectorAll('.role');
        for (var i = 0; i < all.length; i++) all[i].classList.toggle('sel', all[i].dataset.role === role);
        showErr('');
        return;
      }
      if (t.dataset.chipdel) {
        state[t.dataset.chipdel].splice(parseInt(t.dataset.ci, 10), 1);
        paintChips(t.dataset.chipdel);
        return;
      }
      if (t.dataset.dellink !== undefined && t.dataset.dellink !== '') {
        state.links.splice(parseInt(t.dataset.dellink, 10), 1);
        render();
        return;
      }
      if (t.dataset.delsample !== undefined && t.dataset.delsample !== '') {
        state.samples.splice(parseInt(t.dataset.delsample, 10), 1);
        render();
        return;
      }
      if (t.id === 'gritObAddLink') {
        if (state.links.length >= 5) return;
        state.links.push({ label: '', url: '' });
        render();
        return;
      }
      if (t.id === 'gritObAddSample') {
        if (state.samples.length >= 4) return;
        state.samples.push({ title: '', description: '', url: '', image: '' });
        render();
      }
    });
    body.addEventListener('input', function (e) {
      var t = e.target;
      if (t.dataset.st) { state[t.dataset.st] = t.value; return; }
      if (t.dataset.lk && state.links[+t.dataset.i]) { state.links[+t.dataset.i][t.dataset.lk] = t.value; return; }
      if (t.dataset.sm && state.samples[+t.dataset.i]) { state.samples[+t.dataset.i][t.dataset.sm] = t.value; }
    });
    body.addEventListener('keydown', function (e) {
      var t = e.target;
      if (!t.dataset || !t.dataset.chip) return;
      if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addChip(t.dataset.chip); }
    });
    body.addEventListener(
      'blur',
      function (e) {
        var t = e.target;
        if (t.dataset && t.dataset.chip && t.value.trim()) addChip(t.dataset.chip);
      },
      true
    );
  }

  function open(opts) {
    opts = opts || {};
    onDone = typeof opts.onDone === 'function' ? opts.onDone : null;
    ensureCss();
    if (!el('gritOb')) {
      document.body.insertAdjacentHTML('beforeend', markup());
      wire();
    }
    var u = opts.user || {};
    if (u.tagline) state.tagline = u.tagline;
    if (u.bio) state.bio = u.bio;
    if (u.city) state.city = u.city;
    if (Array.isArray(u.skillsOffered) && u.skillsOffered.length) state.offered = u.skillsOffered.slice(0, 15);
    if (Array.isArray(u.skillsNeeded) && u.skillsNeeded.length) state.needed = u.skillsNeeded.slice(0, 15);
    if (Array.isArray(u.portfolioLinks) && u.portfolioLinks.length) {
      state.links = u.portfolioLinks.slice(0, 5).map(function (l) {
        return { label: (l && l.label) || '', url: (l && l.url) || '' };
      });
    }
    if (Array.isArray(u.sampleWorks) && u.sampleWorks.length) {
      state.samples = u.sampleWorks.slice(0, 4).map(function (s) {
        return {
          title: (s && s.title) || '',
          description: (s && s.description) || '',
          url: (s && s.url) || '',
          image: (s && s.image) || '',
        };
      });
    }
    step = 1;
    role = u.seekingTo || '';
    submitting = false;
    document.body.style.overflow = 'hidden';
    el('gritOb').classList.add('open');
    render();
  }

  function close() {
    var root = el('gritOb');
    if (root) root.classList.remove('open');
    document.body.style.overflow = '';
    onDone = null;
  }

  window.GritOnboarding = { open: open, close: close };
})();
