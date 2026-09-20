(function () {
  var c = window.community;
  function $(x) { return document.getElementById(x); }
  if (!c) return;

  var API = '/api';
  var convs = [];
  var groups = [];
  var activeConv = null;
  var activeGroupId = null;
  var socket = null;
  var meId = null;
  var me = c.me();
  if (me && me.id) meId = me.id;

  var q = new URLSearchParams(location.search);
  var sharePostId = q.get('share');
  var startUserId = q.get('to');

  // ── socket ──
  function connectSocket() {
    if (!socket && c.token() && window.io) {
      socket = io('/', { auth: { token: c.token() } });
      socket.on('message:new', function (m) {
        if (activeConv && m.conversationId === activeConv.id) {
          renderMessage(m);
          markRead(activeConv.id);
        }
        refreshConversations();
      });
      socket.on('notification:new', function (n) {
        if (n.type === 'NEW_MESSAGE' && n.conversationId) {
          if (!activeConv || n.conversationId !== activeConv.id) refreshConversations();
        }
      });
      socket.on('connect_error', function () { socket = null; });
    }
  }
  function joinConversation(convId) {
    if (socket && convId) socket.emit('conversation:join', { conversationId: convId });
  }
  function leaveConversation(convId) {
    if (socket && convId) socket.emit('conversation:leave', { conversationId: convId });
  }

  // ── conversations list ──
  function convName(cv) {
    if (cv.isGroup) return cv.groupName || 'Group';
    var o = cv.otherUser;
    return (o && (o.firstName || o.lastName)) ? String(o.firstName || '') + ' ' + String(o.lastName || '') : 'Member';
  }
  function convAvatar(cv) {
    if (!cv.isGroup) return c.avatarFor(cv.otherUser || {});
    return '';
  }
  function strip(html) {
    var d = document.createElement('div');
    d.innerHTML = String(html || '');
    return d.textContent || '';
  }

  function refreshConversations() {
    if (!c.token()) { renderNotAuthed(); return; }
    c.api('/messages/conversations').then(function (r) {
      if (!r.ok) return;
      convs = (r.d.data && r.d.data.conversations) || [];
      renderConversations();
      bumpMsgBadge();
    });
  }
  function bumpMsgBadge() {
    var n = 0;
    convs.forEach(function (cv) { n += Number(cv.unreadCount || 0); });
    var b = $('msgBadge');
    if (b) { b.style.display = n > 0 ? '' : 'none'; b.textContent = n > 9 ? '9+' : n; }
  }

  function renderConversations() {
    var el = $('convList');
    el.innerHTML = '';
    var term = ($('convSearch').value || '').trim().toLowerCase();
    var filtered = convs.filter(function (cv) { return !term || convName(cv).toLowerCase().indexOf(term) !== -1; });
    if (!filtered.length) {
      el.innerHTML = '<div style="padding:20px;text-align:center;color:var(--dusk,#6b7280);font-size:13px;">No chats yet. Message someone from their profile, or share a post!</div>';
      return;
    }
    filtered.forEach(function (cv) {
      var unread = Number(cv.unreadCount || 0);
      var last = (cv.lastMessage && cv.lastMessage.messageText) ? strip(cv.lastMessage.messageText).slice(0, 60) : (cv.lastMessage && cv.lastMessage.attachments && cv.lastMessage.attachments.length ? '[Attachment]' : 'Say hello');
      var lastAt = cv.lastMessage ? c.timeAgo(cv.lastMessage.createdAt) : '';
      var name = convName(cv);
      var av = cv.isGroup
        ? '<div class="av" style="display:flex;align-items:center;justify-content:center;background:#f0e9ff;color:#6C3FE8;font-weight:800;">👥</div>'
        : '<img class="av" src="' + c.esc(convAvatar(cv)) + '" alt=""/>';
      var item = document.createElement('div');
      item.className = 'conv' + (activeConv && activeConv.id === cv.id ? ' on' : '');
      item.innerHTML = av +
        '<div class="cv"><div class="cname">' + c.esc(name) + (cv.isGroup ? ' <span style="color:var(--blue,#5599ff);font-size:10px;font-weight:700;">GROUP</span>' : '') + '</div>' +
        '<div class="clast">' + c.esc(last) + '</div></div>' +
        '<div class="cmeta">' + (lastAt ? '<div>' + c.esc(lastAt) + '</div>' : '') + (unread ? '<div class="badge">' + unread + '</div>' : '') + '</div>';
      item.addEventListener('click', function () { openConv(cv.id); });
      el.appendChild(item);
    });
  }

  // ── open a conversation ──
  function showChatUi() {
    $('msgEmpty').style.display = 'none';
    $('thread').style.display = 'block';
    $('composer').style.display = 'flex';
    $('mhead').style.display = 'flex';
  }
  function openConv(convId) {
    if (activeConv) leaveConversation(activeConv.id);
    var cv = null;
    for (var i = 0; i < convs.length; i++) if (convs[i].id === convId) { cv = convs[i]; break; }
    if (!cv) return;
    activeConv = cv;
    activeGroupId = null;
    if (cv.isGroup) activeGroupId = cv.conversationId || cv.id;
    joinConversation(convId);
    renderConversations();
    renderHeader(cv);
    showChatUi();
    $('thread').innerHTML = '<div class="loading">Loading messages…</div>';
    c.api('/messages/conversations/' + convId + '/messages').then(function (r) {
      if (!r.ok) { $('thread').innerHTML = '<div class="empty">Could not load messages</div>'; return; }
      $('thread').innerHTML = '';
      var msgs = (r.d.data && r.d.data.messages) || [];
      msgs.forEach(function (m) { renderMessage(m); });
      scrollBottom();
    });
    markRead(convId);
    if (cv.isGroup && cv.groupId) { activeGroupId = cv.groupId; }
  }

  function renderHeader(cv) {
    var name = convName(cv);
    var sub = '';
    var av = '';
    var acts = '';
    if (cv.isGroup) {
      av = '<div class="av" style="display:flex;align-items:center;justify-content:center;background:#f0e9ff;color:#6C3FE8;font-weight:800;">👥</div>';
      var mem = (cv.members && cv.members.length ? cv.members.length : 1) + ' members';
      sub = mem;
      acts = '<button data-gd="1">Info</button>';
    } else {
      av = '<img class="av" src="' + c.esc(convAvatar(cv)) + '" alt=""/>';
      sub = (cv.otherUser && cv.otherUser.city) ? c.esc(cv.otherUser.city) : 'Grit&Gigs member';
    }
    $('mhead').innerHTML = av + '<div class="t"><div class="nm">' + c.esc(name) + '</div><div class="sub">' + c.esc(sub) + '</div></div>' +
      '<div class="acts">' + acts + '</div>';
    var gd = $('mhead').querySelector('[data-gd]');
    if (gd) gd.addEventListener('click', function () { openGroupDetail(activeGroupId); });
  }

  function renderMessage(m) {
    var mine = m.senderId === meId;
    var sender = m.sender || {};
    var bubble = c.esc(m.messageText || '');
    var atts = '';
    (m.attachments || []).forEach(function (a) {
      var u = a.url || '';
      var t = a.type || '';
      if (/^image\//.test(t) || /\.(png|jpe?g|webp|gif)(\?|$)/i.test(u)) {
        atts += '<div class="att"><img src="' + c.esc(u) + '" alt=""/></div>';
      } else {
        atts += '<div class="att"><a href="' + c.esc(u) + '" target="_blank" rel="noopener">' + c.esc(a.name || 'Attachment — open') + '</a></div>';
      }
    });
    var av = '<img class="av" src="' + c.esc(c.avatarFor(sender)) + '" alt="" style="width:28px;height:28px;border-radius:50%;object-fit:cover;background:var(--line,#eee);"/>';
    var el = document.createElement('div');
    el.className = 'msg' + (mine ? ' mine' : '');
    el.innerHTML = (mine ? '' : av) + '<div class="bubble">' + bubble + atts + '</div>' + '<div class="mt">' + c.timeAgo(m.createdAt || new Date().toISOString()) + '</div>';
    $('thread').appendChild(el);
  }
  function scrollBottom() { var t = $('thread'); t.scrollTop = t.scrollHeight; }

  // ── send ──
  function sendMessage() {
    if (!activeConv) return;
    var text = $('msgBox').value.trim();
    var atts = window._pendingAtts || [];
    if (!text && !atts.length) return;
    var btn = $('sendBtn');
    btn.disabled = true;
    c.api('/messages/conversations/' + activeConv.id + '/messages', { method: 'POST', body: { messageText: text, attachments: atts } }).then(function (r) {
      btn.disabled = false;
      if (!r.ok) { c.toast(r.d.message || 'Failed to send', true); return; }
      $('msgBox').value = '';
      window._pendingAtts = [];
      var attNames = atts.map(function (a) { return a.name; }).join(', ');
      if (!text) text = 'Sent file' + (attNames ? ': ' + attNames : '');
      renderMessage({ senderId: meId, sender: me, messageText: text, attachments: atts, createdAt: new Date().toISOString() });
      scrollBottom();
      refreshConversations();
    });
  }

  // ── attachments ──
  function handleAttach(files) {
    if (!files.length) return;
    var fd = new FormData();
    for (var i = 0; i < files.length; i++) fd.append('files', files[i]);
    c.toast('Uploading…');
    fetch(API + '/messages/upload', { method: 'POST', headers: { 'Authorization': 'Bearer ' + c.token() }, body: fd })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.success) { c.toast(d.message || 'Upload failed', true); return; }
        var atts = (d.data ? d.data.files : []) || [];
        if (atts.length) {
          var prepped = atts.map(function (f) { return { name: f.name || 'File', url: f.url, type: f.mimeType || '' }; });
          window._pendingAtts = (window._pendingAtts || []).concat(prepped);
          c.toast('Attached ' + prepped.length + ' file(s) — press Send');
        }
      })
      .catch(function () { c.toast('Network error', true); });
  }

  // ── groups ──
  function loadGroups() {
    if (!c.token()) return;
    c.api('/messages/groups').then(function (r) {
      if (!r.ok) return;
      groups = (r.d.data && r.d.data.groups) || [];
      renderGroups();
    });
  }
  function renderGroups() {
    var el = $('groupPane');
    el.innerHTML = '<button class="primary" id="grpNew" style="margin-bottom:4px;">+ Create group</button>';
    $('grpNew').addEventListener('click', function () { openGroupModal(); });
    if (!groups.length) {
      el.innerHTML += '<div style="padding:20px;text-align:center;color:var(--dusk,#6b7280);font-size:13px;">No groups yet. Create one or join an open group.</div>';
      return;
    }
    groups.forEach(function (g) {
      var card = document.createElement('div');
      card.className = 'grp';
      card.innerHTML = '<div class="gi">' + c.esc((g.name || '?').charAt(0).toUpperCase()) + '</div>' +
        '<div class="gn"><b>' + c.esc(g.name) + '</b><div>' + c.esc(g.description || '') + ' · ' + g.memberCount + ' members</div></div>' +
        (g.joined ? '<button class="in">Joined</button><button class="open" data-gopen="' + g.conversationId + '">Open</button>' : '<button class="join" data-gjoin="' + g.id + '">Join</button>');
      var jb = card.querySelector('[data-gjoin]');
      if (jb) jb.addEventListener('click', function () {
        c.api('/messages/groups/' + g.id + '/join', { method: 'POST' }).then(function (r) {
          if (!r.ok) { c.toast(r.d.message || 'Failed', true); return; }
          c.toast('Joined!');
          loadGroups();
          refreshConversations();
          c.api('/community/quota').catch(function () {});
        });
      });
      var ob = card.querySelector('[data-gopen]');
      if (ob) ob.addEventListener('click', function () { openConv(g.conversationId); });
      el.appendChild(card);
    });
  }
  function openGroupModal() {
    $('groupName').value = '';
    $('groupDesc').value = '';
    $('groupErr').textContent = '';
    $('groupModal').classList.add('open');
  }
  function openGroupDetail(groupId) {
    if (!groupId) return;
    c.api('/messages/groups/' + groupId).then(function (r) {
      if (!r.ok) return;
      var d = r.d.data;
      $('gdName').textContent = d.group.name;
      $('gdDesc').textContent = d.group.description || '';
      $('gdMembers').innerHTML = (d.members || []).map(function (m) {
        return '<div class="m"><img src="' + c.esc(c.avatarFor(m)) + '" alt=""/><span>' + c.esc(String(m.firstName || '') + ' ' + String(m.lastName || '')) + '</span></div>';
      }).join('') || '<div style="color:var(--dusk,#6b7280);font-size:13px;">No members yet.</div>';
      var isOwner = d.group.ownerId === meId;
      $('gdInviteWrap').style.display = isOwner ? 'flex' : 'none';
      $('gdErr').textContent = '';
      $('groupDetailModal').classList.add('open');
    });
  }

  // ── share flow ──
  function loadShare() {
    if (!sharePostId) return;
    if (!c.token()) { c.openLogin(); return; }
    c.api('/community/posts/' + sharePostId).then(function (r) {
      if (!r.ok) return;
      var row = r.d.data, p = row.post || row, author = row.author || {};
      var preview = '<span class="kind-stamp">' + (p.kind || 'POST') + '</span> "' + c.esc(String(p.content || '').slice(0, 60)) + '" — by ' + c.esc(author.firstName || 'member');
      $('sharePreview').innerHTML = preview;
      window._share = { postId: sharePostId, kind: p.kind || 'POST', title: author.firstName || 'a member' };
      renderShareTargets();
      $('shareModal').classList.add('open');
    });
  }
  function shareLinkText() {
    var s = window._share || {};
    return 'Shared a ' + (s.kind || 'post') + ' with you on Grit&Gigs:\n' + location.origin + '/explore.html?post=' + encodeURIComponent(s.postId) + '\n';
  }
  function renderShareTargets() {
    var el = $('shareTargets');
    el.innerHTML = '';
    convs.forEach(function (cv) {
      var row = document.createElement('div');
      row.className = 'conv';
      row.innerHTML = '<div class="cv"><div class="cname">' + c.esc(convName(cv)) + '</div></div>';
      row.addEventListener('click', function () { doShare(cv.id); });
      el.appendChild(row);
    });
    var authorRow = document.createElement('div');
    authorRow.className = 'conv';
    authorRow.innerHTML = '<div class="cv"><div class="cname">💬 Message the author</div></div>';
    authorRow.addEventListener('click', function () {
      var authorId = window._shareAuthorId;
      if (!authorId) { $('shareErr').textContent = 'Author id unavailable'; return; }
      c.api('/messages/conversations/with/' + authorId, { method: 'POST' }).then(function (r) {
        if (!r.ok) { $('shareErr').textContent = r.d.message || 'Failed'; return; }
        $('shareModal').classList.remove('open');
        refreshConversations();
        setTimeout(function () { openConv(r.d.data.conversation.id || r.d.data.id); }, 50);
        setTimeout(function () { $('msgBox').value = shareLinkText(); $('msgBox').focus(); }, 150);
      });
    });
    el.appendChild(authorRow);
  }
  function doShare(convId) {
    var note = ($('shareNote').value || '').trim();
    var text = shareLinkText() + (note ? note : '');
    c.api('/messages/conversations/' + convId + '/messages', { method: 'POST', body: { messageText: text, attachments: [] } }).then(function (r) {
      if (!r.ok) { $('shareErr').textContent = r.d.message || 'Failed'; return; }
      $('shareModal').classList.remove('open');
      c.toast('Sent!');
      refreshConversations();
      setTimeout(function () { openConv(convId); }, 100);
    });
  }

  // ── not authed ──
  function renderNotAuthed() {
    $('convList').innerHTML = '<div style="padding:20px;text-align:center;color:var(--dusk,#6b7280);font-size:13px;">Sign in to see your messages.</div><button class="primary" id="joinBtn" style="margin:0 auto;display:block;">Sign in</button>';
    var b = $('joinBtn');
    if (b) b.addEventListener('click', function () { c.openLogin(); });
  }

  // ── mark read ──
  function markRead(convId) {
    c.api('/messages/conversations/' + convId + '/read', { method: 'PUT' }).catch(function () {});
  }

  // ── wiring ──
  $('#sendBtn').addEventListener('click', sendMessage);
  $('#msgBox').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  $('#attFile').addEventListener('change', function () { handleAttach(this.files); this.value = ''; });
  $('#convSearch').addEventListener('input', renderConversations);

  $('#tabChats').addEventListener('click', function () {
    $('tabChats').classList.add('on'); $('tabGroups').classList.remove('on');
    $('convList').style.display = ''; $('groupPane').style.display = 'none';
  });
  $('#tabGroups').addEventListener('click', function () {
    $('tabGroups').classList.add('on'); $('tabChats').classList.remove('on');
    $('convList').style.display = 'none'; $('groupPane').style.display = '';
    loadGroups();
  });

  $('#newChat').addEventListener('click', function () {
    if (!c.token()) { c.openLogin(); return; }
    $('newChatId').value = ''; $('newChatErr').textContent = '';
    $('newChatModal').classList.add('open');
  });
  $('#newChatOk').addEventListener('click', function () {
    var raw = ($('newChatId').value || '').trim();
    if (!raw) { $('newChatErr').textContent = 'Paste a profile id'; return; }
    var id = raw.indexOf('id=') !== -1 ? decodeURIComponent(raw.split('id=').pop().split('&')[0]) : raw;
    c.api('/messages/conversations/with/' + encodeURIComponent(id), { method: 'POST' }).then(function (r) {
      if (!r.ok) { $('newChatErr').textContent = r.d.message || 'Failed'; return; }
      $('newChatModal').classList.remove('open');
      refreshConversations();
      setTimeout(function () { openConv(r.d.data.id || r.d.data.conversation.id); }, 100);
    });
  });
  $('#newChatCancel').addEventListener('click', function () { $('newChatModal').classList.remove('open'); });
  $('#newChatModal').addEventListener('click', function (e) { if (e.target === this) this.classList.remove('open'); });

  $('#groupOk').addEventListener('click', function () {
    var name = ($('groupName').value || '').trim();
    if (!name) { $('groupErr').textContent = 'Give your group a name'; return; }
    c.api('/messages/groups', { method: 'POST', body: { name: name, description: ($('groupDesc').value || '').trim() } }).then(function (r) {
      if (!r.ok) { $('groupErr').textContent = r.d.message || 'Failed'; return; }
      $('groupModal').classList.remove('open');
      c.toast('Group created!');
      loadGroups();
      refreshConversations();
      setTimeout(function () { openConv(r.d.data.conversationId); }, 120);
    });
  });
  $('#groupCancel').addEventListener('click', function () { $('groupModal').classList.remove('open'); });
  $('#groupModal').addEventListener('click', function (e) { if (e.target === this) this.classList.remove('open'); });

  $('#gdInviteOk').addEventListener('click', function () {
    var id = ($('gdInviteId').value || '').trim();
    if (!id || !activeGroupId) return;
    c.api('/messages/groups/' + activeGroupId + '/invite', { method: 'POST', body: { userId: id } }).then(function (r) {
      if (!r.ok) { $('gdErr').textContent = r.d.message || 'Failed'; return; }
      $('gdInviteId').value = '';
      c.toast('Invite sent!');
      openGroupDetail(activeGroupId);
    });
  });
  $('#gdClose').addEventListener('click', function () { $('groupDetailModal').classList.remove('open'); });
  $('#groupDetailModal').addEventListener('click', function (e) { if (e.target === this) this.classList.remove('open'); });

  $('#shareCancel').addEventListener('click', function () { $('shareModal').classList.remove('open'); });
  $('#shareModal').addEventListener('click', function (e) { if (e.target === this) this.classList.remove('open'); });

  // ── boot ──
  if (me && me.id) {
    var av = document.getElementById('navAv');
    if (av) av.src = c.avatarFor(me);
  }
  refreshConversations();
  connectSocket();

  // If a share requested, fetch the post then open targets (also captures author id).
  if (sharePostId) {
    c.api('/community/posts/' + sharePostId).then(function (r) {
      if (!r.ok) return;
      var row = r.d.data, author = row.author || {};
      window._shareAuthorId = author.id;
      loadShare();
    });
  } else if (startUserId) {
    c.api('/messages/conversations/with/' + encodeURIComponent(startUserId), { method: 'POST' }).then(function (r) {
      if (!r.ok) return;
      refreshConversations();
      setTimeout(function () { openConv(r.d.data.id || r.d.data.conversation.id); }, 100);
    });
  }

  // reconnect if a fresh access token appears after refresh failure
  setInterval(function () {
    if (!socket && c.token()) { connectSocket(); joinConversation(activeConv ? activeConv.id : null); }
  }, 60000);
})();