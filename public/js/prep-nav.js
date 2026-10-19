// Prep nav icon. Injected client-side only when the server says FEATURE_PREP
// is on, so with the flag off the icon row is byte-for-byte what it was
// before (src/lib/nav-badge.test.ts keeps guarding the static markup). The
// new icon is inserted FIRST in the row, ahead of the Home/Feed button, so
// Prep leads the nav wherever it appears.
(function () {
  "use strict";
  var ICONS = ".topnav .icons";
  function inject(enabled) {
    if (!enabled) return;
    var row = document.querySelector(ICONS);
    if (!row) return;
    if (row.querySelector('a[href="/prep"]')) return;
    var a = document.createElement("a");
    a.href = "/prep";
    a.title = "Prep";
    a.setAttribute("data-prep-nav", "1");
    a.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>' +
      '<path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/>' +
      '<path d="M9 7.5h6"/>' +
      "</svg>";
    var first = row.firstElementChild;
    if (first) row.insertBefore(a, first);
    else row.appendChild(a);
  }
  fetch("/api/prep/flag", { credentials: "same-origin" })
    .then(function (r) { return r.json(); })
    .then(function (d) { inject(!!(d && d.success && d.data && d.data.enabled)); })
    .catch(function () { /* flag off or offline: keep the nav untouched */ });
})();
