/* Grit&Gigs shared UI behaviors (vanilla, progressive enhancement).
   Only elements carrying data-ui="…" are touched, so page scripts keep working.
   Components: tabs, segmented, dropdown/menu, modal, drawer, mobile menu, toast. */
(function () {
  'use strict';

  function qs(sel, root) { return (root || document).querySelector(sel); }
  function qsa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  /* — Tabs: <div data-ui="tabs"> with .tab[role=tab][aria-controls] + panels — */
  qsa('[data-ui="tabs"]').forEach(function (group) {
    var tabs = qsa('.tab', group);
    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () {
        tabs.forEach(function (t) {
          t.classList.toggle('active', t === tab);
          t.setAttribute('aria-selected', t === tab ? 'true' : 'false');
          var panel = t.getAttribute('aria-controls') && document.getElementById(t.getAttribute('aria-controls'));
          if (panel) panel.hidden = t !== tab;
        });
      });
    });
  });

  /* — Segmented control: <div data-ui="segmented"> with .segmented-btn — */
  qsa('[data-ui="segmented"]').forEach(function (group) {
    var btns = qsa('.segmented-btn', group);
    btns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        btns.forEach(function (b) {
          var on = b === btn;
          b.classList.toggle('active', on);
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
      });
    });
  });

  /* — Dropdown: <div class="dropdown" data-ui="dropdown"> button[data-ui="dropdown-toggle"] + .menu — */
  function closeAllMenus(except) {
    qsa('.menu.open').forEach(function (m) { if (m !== except) m.classList.remove('open'); });
  }
  qsa('[data-ui="dropdown"]').forEach(function (dd) {
    var toggle = qs('[data-ui="dropdown-toggle"]', dd);
    var menu = qs('.menu', dd);
    if (!toggle || !menu) return;
    toggle.setAttribute('aria-haspopup', 'true');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = !menu.classList.contains('open');
      closeAllMenus(menu);
      menu.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    menu.addEventListener('click', function (e) { e.stopPropagation(); });
  });
  document.addEventListener('click', function () { closeAllMenus(); });

  /* — Modal: open [data-ui="modal-open"="#id"], close [data-ui="modal-close"] inside — */
  var lastFocus = null;
  function openModal(id) {
    var overlay = document.getElementById(id.replace('#', ''));
    if (!overlay) return;
    lastFocus = document.activeElement;
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
    var focusable = qs('button, a, input, select, textarea', overlay);
    if (focusable) focusable.focus();
  }
  function closeModal(overlay) {
    overlay.classList.remove('open');
    overlay.setAttribute('aria-hidden', 'true');
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  qsa('[data-ui="modal-open"]').forEach(function (trigger) {
    trigger.addEventListener('click', function () { openModal(trigger.getAttribute('data-ui-target') || '#'); });
  });
  qsa('.modal-overlay').forEach(function (overlay) {
    if (overlay.id) overlay.setAttribute('aria-hidden', overlay.classList.contains('open') ? 'false' : 'true');
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeModal(overlay);
    });
    qsa('[data-ui="modal-close"]', overlay).forEach(function (btn) {
      btn.addEventListener('click', function () { closeModal(overlay); });
    });
  });

  /* — Drawer: [data-ui="drawer-open"="#id"] / [data-ui="drawer-close"] — */
  qsa('[data-ui="drawer-open"]').forEach(function (trigger) {
    trigger.addEventListener('click', function () {
      var target = document.getElementById(trigger.getAttribute('data-ui-target') || '');
      if (!target) return;
      var overlay = qs('.drawer-overlay');
      target.classList.add('open');
      if (overlay) overlay.classList.add('open');
    });
  });
  qsa('[data-ui="drawer-close"]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      qsa('.drawer.open').forEach(function (d) { d.classList.remove('open'); });
      qsa('.drawer-overlay.open').forEach(function (o) { o.classList.remove('open'); });
    });
  });

  /* — Mobile menu: [data-ui="menu-toggle"="#mobile-menu"] — */
  qsa('[data-ui="menu-toggle"]').forEach(function (trigger) {
    trigger.addEventListener('click', function () {
      var menu = document.getElementById(trigger.getAttribute('data-ui-target') || '');
      if (!menu) return;
      var open = menu.classList.toggle('open');
      trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  });

  /* — Escape closes overlays — */
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    closeAllMenus();
    qsa('.modal-overlay.open').forEach(closeModal);
    qsa('.drawer.open').forEach(function (d) { d.classList.remove('open'); });
    qsa('.drawer-overlay.open').forEach(function (o) { o.classList.remove('open'); });
  });

  /* — Toast API: window.UI.toast(message, type?) — */
  function toast(message, type) {
    var el = document.createElement('div');
    el.className = 'toast' + (type ? ' toast-' + type : '');
    el.setAttribute('role', 'status');
    el.textContent = message;
    document.body.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('show'); });
    setTimeout(function () {
      el.classList.remove('show');
      setTimeout(function () { el.remove(); }, 400);
    }, 3200);
  }

  window.UI = { toast: toast, openModal: openModal };
})();
