/* Docked AI Companion (Gigi) — injected on every page that includes it. */
(function () {
  if (window.__gritCompanion) return;
  window.__gritCompanion = true;

  var NAME = "Gigi";
  var TOKEN_KEY = "se_token";
  var USER_KEY = "se_user";
  var HISTORY_MAX = 24;

  function token() { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch (e) { return ""; } }
  function user() { try { return JSON.parse(localStorage.getItem(USER_KEY) || "null"); } catch (e) { return null; } }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  var history = [];
  var open = false;

  // ---- DOM
  var root = document.createElement("div");
  root.id = "grit-companion";
  root.innerHTML =
    '<button type="button" class="gc-fab" aria-label="Open AI assistant" aria-expanded="false">' +
      '<span class="gc-fab-dot" aria-hidden="true"></span>' +
      '<span class="gc-fab-label">Ask ' + NAME + "</span>" +
    "</button>" +
    '<div class="gc-panel" role="dialog" aria-label="' + NAME + ' AI assistant" hidden>' +
      '<div class="gc-head">' +
        "<div><strong>" + NAME + '</strong> <span class="gc-ai-badge">AI</span>' +
        '<div class="gc-sub">AI assistant · not a human</div></div>' +
        '<button type="button" class="gc-close" aria-label="Close">&times;</button>' +
      "</div>" +
      '<div class="gc-msgs" aria-live="polite"></div>' +
      '<div class="gc-confirm" hidden></div>' +
      '<form class="gc-form">' +
        '<input class="gc-input" type="text" maxlength="2000" placeholder="Ask about jobs, prep, barter…" autocomplete="off"/>' +
        '<button class="gc-send" type="submit">Send</button>' +
      "</form>" +
    "</div>";
  document.addEventListener("DOMContentLoaded", function () {
    document.body.appendChild(root);
  });
  if (document.body) document.body.appendChild(root);

  var fab = root.querySelector(".gc-fab");
  var panel = root.querySelector(".gc-panel");
  var msgs = root.querySelector(".gc-msgs");
  var form = root.querySelector(".gc-form");
  var input = root.querySelector(".gc-input");
  var confirmBox = root.querySelector(".gc-confirm");

  function addMsg(role, text) {
    var el = document.createElement("div");
    el.className = "gc-msg gc-msg-" + role;
    el.innerHTML = (role === "assistant" ? '<span class="gc-who">' + NAME + "</span>" : "") + esc(text).replace(/\n/g, "<br/>");
    msgs.appendChild(el);
    msgs.scrollTop = msgs.scrollHeight;
  }

  function greeting() {
    var u = user();
    return u && u.firstName
      ? "Hi " + u.firstName + " — I'm " + NAME + ", the AI assistant on Grit&Gigs. What are you working on?"
      : "Hi — I'm " + NAME + ", the AI assistant on Grit&Gigs. What are you working on?";
  }

  function setOpen(v) {
    open = v;
    panel.hidden = !v;
    fab.setAttribute("aria-expanded", v ? "true" : "false");
    if (v && !msgs.childElementCount) addMsg("assistant", greeting());
    if (v) input.focus();
  }
  fab.addEventListener("click", function () { setOpen(!open); });
  root.querySelector(".gc-close").addEventListener("click", function () { setOpen(false); });

  function send(text) {
    addMsg("user", text);
    history.push({ role: "user", content: text });
    if (history.length > HISTORY_MAX) history = history.slice(-HISTORY_MAX);
    var typing = document.createElement("div");
    typing.className = "gc-msg gc-msg-assistant gc-typing";
    typing.textContent = NAME + " is typing…";
    msgs.appendChild(typing);
    msgs.scrollTop = msgs.scrollHeight;

    var headers = { "Content-Type": "application/json" };
    if (token()) headers.Authorization = "Bearer " + token();
    fetch("/api/companion/chat", {
      method: "POST",
      headers: headers,
      body: JSON.stringify({ message: text, history: history.slice(0, -1) }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        typing.remove();
        var reply = d && d.success && d.data && d.data.reply ? d.data.reply : (d && d.message) || "I couldn't answer that.";
        addMsg("assistant", reply);
        history.push({ role: "assistant", content: reply });
        if (history.length > HISTORY_MAX) history = history.slice(-HISTORY_MAX);
      })
      .catch(function () {
        typing.remove();
        addMsg("assistant", "I couldn't reach the assistant. Try again in a moment.");
      });
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    input.value = "";
    send(text);
  });

  // ---- confirm card: any companion-proposed UI action asks first
  function confirmAction(label, onConfirm) {
    confirmBox.hidden = false;
    confirmBox.innerHTML =
      "<strong>Confirm action</strong>" +
      "<p>" + esc(label) + " You'll review everything before anything is submitted.</p>" +
      '<div class="gc-confirm-acts">' +
      '<button type="button" class="gc-confirm-yes">Continue</button>' +
      '<button type="button" class="gc-confirm-no">Not now</button>' +
      "</div>";
    confirmBox.querySelector(".gc-confirm-yes").addEventListener("click", function () {
      confirmBox.hidden = true;
      onConfirm();
    });
    confirmBox.querySelector(".gc-confirm-no").addEventListener("click", function () {
      confirmBox.hidden = true;
    });
  }

  window.GritCompanion = {
    open: function () { setOpen(true); },
    close: function () { setOpen(false); },
    confirm: confirmAction,
    name: NAME,
  };
})();
