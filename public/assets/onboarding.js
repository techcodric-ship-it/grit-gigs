(function () {
  var API = '/api';
  var TOTAL = 6;
  var STEP_LABELS = ['Your role', 'About you', 'Your skills', 'Portfolio links', 'Resume', 'Sample works'];
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
    resumeUrl: '',
    resumeName: '',
    resumeDraft: '',
    resumeUploading: false,
    resumeProgress: 0,
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
      '#gritOb .drop{border:1.5px dashed #d0d0d8;background:#fafafa;border-radius:14px;padding:20px 16px;text-align:center;cursor:pointer;font-family:inherit}' +
      '#gritOb .drop:hover{border-color:#eab308;background:#fffbeb}' +
      '#gritOb .drop .ic{width:42px;height:42px;border-radius:50%;background:#111;color:#eab308;font-weight:800;font-size:18px;display:flex;align-items:center;justify-content:center;margin:0 auto 10px}' +
      '#gritOb .drop b{display:block;font-size:14px;margin-bottom:4px}' +
      '#gritOb .drop small{color:#6b7280;font-size:12.5px}' +
      '#gritOb .drop input{display:none}' +
      '#gritOb .bar{height:6px;background:#eee;border-radius:99px;overflow:hidden;margin-top:12px}' +
      '#gritOb .bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,#eab308,#f59e0b);transition:width .2s}' +
      '#gritOb .filed{display:flex;align-items:center;gap:10px;border:1px solid #d8f0d8;background:#f4fdf4;border-radius:12px;padding:12px 14px;margin-bottom:12px}' +
      '#gritOb .filed .fn{flex:1;min-width:0}' +
      '#gritOb .filed .fn b{display:block;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '#gritOb .filed .fn small{color:#6b7280;font-size:12px;word-break:break-all}' +
      '#gritOb .filed button{border:1px solid #e3e3e8;background:#fff;border-radius:9px;padding:7px 12px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit;color:#374151}' +
      '#gritOb .filed button:hover{background:#fef2f2;border-color:#fca5a5;color:#dc2626}' +
      '#gritOb .sep{display:flex;align-items:center;gap:10px;color:#9ca3af;font-size:12px;margin:16px 0 12px}' +
      '#gritOb .sep::before,#gritOb .sep::after{content:"";flex:1;height:1px;background:#eee}' +
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
    var saved = state.resumeUrl
      ? '<div class="filed"><div class="fn"><b>' + esc(state.resumeName || 'Resume') + '</b><small>' + esc(state.resumeUrl) + '</small></div>' +
        '<button type="button" id="gritObResumeRemove">Remove</button></div>'
      : '';
    var drop =
      '<label class="drop" for="gritObResumeFile">' +
      '<span class="ic">R</span><b>Upload your resume / CV</b>' +
      '<small>PDF, Word or image · up to 8 MB</small>' +
      '<input type="file" id="gritObResumeFile" accept=".pdf,.doc,.docx,.odt,.rtf,.txt,.jpg,.jpeg,.png"/>' +
      '</label>' +
      (state.resumeUploading
        ? '<div class="bar"><i style="width:' + Math.max(3, state.resumeProgress) + '%"></i></div>' +
          '<div class="hint" style="text-align:center">Uploading… ' + Math.round(state.resumeProgress) + '%</div>'
        : '');
    return (
      '<h3>Add your resume</h3>' +
      '<p class="sub">Clients and collaborators can download it straight from your profile. Optional, but it doubles your chances.</p>' +
      saved +
      drop +
      '<div class="sep">or paste a link</div>' +
      '<div class="fld"><input class="in" data-st="resumeDraft" maxlength="1000" placeholder="https://drive.google.com/... or your portfolio host" value="' + esc(state.resumeDraft) + '"/>' +
      '<div class="hint">Google Drive, Dropbox, Notion, your own site — anything shareable.</div></div>'
    );
  }

  function step6Html() {
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

  var RENDERERS = { 1: roleHtml, 2: step2Html, 3: step3Html, 4: step4Html, 5: step5Html, 6: step6Html };

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
    if (step === 5) first = null;
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

  function cacheResume(url, name) {
    try {
      var cur = JSON.parse(localStorage.getItem('se_user') || '{}');
      cur.resumeUrl = url || null;
      cur.resumeName = name || null;
      localStorage.setItem('se_user', JSON.stringify(cur));
    } catch (e) {}
  }

  function putResume(payload) {
    return fetch(API + '/users/me/resume', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + currentToken() },
      body: JSON.stringify(payload),
    }).then(function (r) { return r.json(); });
  }

  function uploadResume(file) {
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { showErr('That file is larger than 8 MB. Please upload a smaller file.'); return; }
    var fd = new FormData();
    fd.append('resume', file);
    state.resumeUploading = true;
    state.resumeProgress = 0;
    render();
    var xhr = new XMLHttpRequest();
    xhr.open('POST', API + '/users/me/resume');
    xhr.setRequestHeader('Authorization', 'Bearer ' + currentToken());
    xhr.upload.onprogress = function (e) {
      if (e.lengthComputable) { state.resumeProgress = (e.loaded / e.total) * 100; paintResumeBar(); }
    };
    xhr.onload = function () {
      state.resumeUploading = false;
      state.resumeProgress = 0;
      var d = {};
      try { d = JSON.parse(xhr.responseText); } catch (e) {}
      if (xhr.status >= 200 && xhr.status < 300 && d.success) {
        state.resumeUrl = d.data.resumeUrl;
        state.resumeName = d.data.resumeName || file.name;
        state.resumeDraft = '';
        cacheResume(state.resumeUrl, state.resumeName);
        showErr('Resume uploaded.', true);
      } else {
        showErr((d && d.message) || 'Upload failed. Please try again.');
      }
      render();
    };
    xhr.onerror = function () {
      state.resumeUploading = false;
      state.resumeProgress = 0;
      showErr('Upload failed. Check your connection and try again.');
      render();
    };
    xhr.send(fd);
  }

  function paintResumeBar() {
    var i = document.querySelector('#gritObBody .bar i');
    if (i) i.style.width = Math.max(3, state.resumeProgress) + '%';
  }

  function removeResume() {
    if (state.resumeUploading) return;
    var had = state.resumeUrl;
    state.resumeUrl = '';
    state.resumeName = '';
    state.resumeDraft = '';
    cacheResume(null, null);
    render();
    if (had) {
      putResume({ remove: true }).then(function (d) {
        if (!d.success) showErr(d.message || 'Could not remove the resume.');
      });
    }
  }

  function saveResumeLink() {
    var draft = (state.resumeDraft || '').trim();
    if (!draft) return Promise.resolve(true);
    if (draft === state.resumeUrl) return Promise.resolve(true);
    if (!/^https?:\/\/.+/i.test(draft)) { showErr('Resume link must start with http:// or https://'); return Promise.resolve(false); }
    return putResume({ resumeUrl: draft, resumeName: 'Resume link' }).then(function (d) {
      if (!d.success) { showErr(d.message || 'Could not save the resume link.'); return false; }
      state.resumeUrl = draft;
      state.resumeName = 'Resume link';
      cacheResume(draft, 'Resume link');
      return true;
    });
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
    var ready = skip ? Promise.resolve(true) : saveResumeLink();
    ready
      .then(function (ok) {
        if (!ok) { submitting = false; btn.disabled = false; btn.textContent = 'Finish'; return null; }
        return fetch(API + (skip ? '/auth/skip-onboarding' : '/auth/onboarding'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
          body: JSON.stringify(body),
        })
          .then(function (r) { return r.json(); });
      })
      .then(function (d) {
        if (!d) return;
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
      var t = e.target.closest ? e.target.closest('[data-role],[data-chipdel],[data-dellink],[data-delsample],#gritObAddLink,#gritObAddSample,#gritObResumeRemove') : null;
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
        return;
      }
      if (t.id === 'gritObResumeRemove') {
        removeResume();
      }
    });
    body.addEventListener('change', function (e) {
      if (e.target && e.target.id === 'gritObResumeFile') uploadResume(e.target.files && e.target.files[0]);
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
    if (u.resumeUrl) {
      state.resumeUrl = String(u.resumeUrl);
      state.resumeName = String(u.resumeName || 'Resume');
    } else {
      state.resumeUrl = '';
      state.resumeName = '';
    }
    if (!state.resumeUrl) state.resumeDraft = '';
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
