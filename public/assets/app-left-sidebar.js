/* Shared desktop application sidebar */
(function () {
  var path = location.pathname.replace(/\/$/, '') || '/';
  var items = [
    ['Home', '/feed', '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.7V21h14V9.7"/>'],
    ['Prep', '/prep', '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/><path d="M9 7.5h6"/>'],
    ['Search', '/explore.html', '<circle cx="11" cy="11" r="7"/><path d="m16.3 16.3 4.2 4.2"/>'],
    ['Messages', '/messages.html', '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m3.5 7 8.5 6 8.5-6"/>'],
    ['Inbox', '/notifications.html', '<path d="M12 20.3 4.9 13a4.7 4.7 0 0 1 6.6-6.6l.5.5.5-.5A4.7 4.7 0 0 1 19 13Z"/>'],
    ['Orders', '/orders.html', '<path d="M21 8.2 12 3 3 8.2v7.6L12 21l9-5.2Z"/><path d="M3.3 8.3 12 13.3l8.7-5"/><path d="M12 13.3V21"/>'],
    ['Wallet', '/wallet.html', '<rect x="2.5" y="5" width="19" height="14" rx="3"/><path d="M16 10h5.5v4H16a2 2 0 0 1 0-4Z"/>']
  ];

  function isActive(href) {
    if (href === '/feed') return path === '/feed';
    if (href === '/prep') return path === '/prep' || path.indexOf('/prep/') === 0;
    return path === href;
  }

  function makeSidebar() {
    if (document.querySelector('.app-left-sidebar')) return;
    var nav = document.createElement('nav');
    nav.className = 'app-left-sidebar';
    nav.setAttribute('aria-label', 'Primary navigation');
    nav.innerHTML = items.map(function (item) {
      return '<a class="app-side-link' + (isActive(item[1]) ? ' active' : '') + '" href="' + item[1] + '" title="' + item[0] + '">' +
        '<span class="app-side-icon"><svg viewBox="0 0 24 24" aria-hidden="true">' + item[2] + '</svg></span>' +
        '<span class="app-side-label">' + item[0] + '</span></a>';
    }).join('') + '<a class="app-side-link app-side-profile" href="/profile.html" id="appSideProfile" title="Profile"><span class="app-side-icon"><img id="appSideAvatar" src="https://api.dicebear.com/9.x/initials/svg?seed=grit&backgroundColor=f0f0f0&textColor=262626" alt="" /></span><span class="app-side-label">Profile</span></a>';
    document.body.insertBefore(nav, document.body.firstChild);
    document.body.classList.add('desktop-app-shell');

    var header = document.querySelector('.topnav');
    if (header) header.classList.add('app-shell-topnav');
  }

  function syncAvatar() {
    var source = document.getElementById('navAv');
    var avatar = document.getElementById('appSideAvatar');
    var profile = document.getElementById('appSideProfile');
    var navProfile = document.getElementById('navProfile');
    if (source && avatar && source.src && !source.src.includes('dicebear.com/9.x/initials/svg?seed=grit')) avatar.src = source.src;
    if (navProfile && profile) profile.href = navProfile.href;
  }

  function start() {
    makeSidebar();
    syncAvatar();
    setInterval(syncAvatar, 1000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
