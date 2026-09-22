const { Client } = require("ssh2");
const c = new Client();
const H = { host: "162.19.81.122", port: 20141, username: "root", password: "Cdr7Km2Xp9QwErT4", readyTimeout: 90000, keepaliveInterval: 30000 };
let out = "";
const ADD = {};
ADD.NAV = [
 '<a href="/feed" class="on" title="Home"><svg viewBox="0 0 24 24"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.7V21h14V9.7"/></svg></a>',
 '<a href="/search.html" title="Search"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.4"/><path d="M16.2 16.2 21 21"/></svg></a>',
 '<a href="/inbox.html" title="Inbox"><svg viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M3 14.5h4.4l1.6 2.4h6l1.6-2.4H21"/></svg></a>',
 '<a href="/notifications.html" title="Notifications"><svg viewBox="0 0 24 24"><path d="M6 10a6 6 0 0 1 12 0v4l1.8 2.6H4.2L6 14z"/><path d="M12 20.5a2.4 2.4 0 0 0 2.3-1.8h-4.6A2.4 2.4 0 0 0 12 20.5z"/></svg></a>',
 '<a href="/orders.html" title="Orders"><svg viewBox="0 0 24 24"><path d="M4 6h16l-1.5 13.5a2 2 0 0 1-2 1.8H7.5a2 2 0 0 1-2-1.8Z"/><path d="M4 6h16"/><path d="M9 10v4a3 3 0 0 0 6 0v-4"/></svg></a>',
 '<a href="/wallet.html" title="Wallet"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="15" rx="2.5"/><path d="M3 10h18"/><circle cx="16" cy="15" r="1.6"/></svg></a>',
 '<a href="#profile" id="navProfile" title="Profile"><svg viewBox="0 0 24 24"><circle cx="12" cy="8.4" r="3.9"/><path d="M4.5 20.5c1.7-3.9 4.4-5.9 7.5-5.9s5.8 2 7.5 5.9"/></svg></a>'
].join("");

const CSS = "<style>#profileModal{display:none;position:fixed;inset:0;background:rgba(16,12,32,.55);z-index:120;align-items:center;justify-content:center;padding:18px}#profileModal.open{display:flex}.pm-wrap{position:relative;background:#fff;border-radius:18px;padding:24px;width:100%;max-width:380px;box-shadow:0 20px 50px rgba(20,10,60,.28)}.pm-wrap .x{position:absolute;top:14px;right:14px;border:none;background:none;font-size:1.2rem;color:#999;cursor:pointer}.pm-wrap .hd{display:flex;align-items:center;gap:12px;margin-bottom:14px}.pm-wrap .av{width:56px;height:56px;border-radius:50%;background:#f0ebff;display:flex;align-items:center;justify-content:center;font-size:1.4rem;color:#6C3FE8;font-weight:700;letter-spacing:.5px}.pm-wrap .nm{font-size:1.15rem;font-weight:800;color:#1a1a2e}.pm-wrap .hdline{color:#6C3FE8;font-size:.85rem;font-weight:600}.pm-wrap .st{display:flex;gap:8px;margin:16px 0}.pm-wrap .st div{flex:1;background:#faf9ff;border:1px solid #eee;border-radius:12px;padding:10px;text-align:center}.pm-wrap .st b{display:block;font-size:1.05rem;color:#1a1a2e}.pm-wrap .st span{font-size:.75rem;color:#999}.pm-wrap .bio{color:#444;font-size:.92rem;border-top:1px solid #f0f0f5;padding-top:14px;margin:4px 0 16px}.pm-wrap .act{display:flex;gap:10px}.pm-wrap .act a{flex:1;text-align:center;text-decoration:none;border-radius:12px;padding:11px 8px;font-weight:700;font-size:.9rem}.pm-wrap .ep{background:linear-gradient(135deg,#6C3FE8,#8a2be2);color:#fff}.pm-wrap .st2{background:#f4f1ff;color:#6C3FE8}</style>";

const MODAL = '<div id="profileModal"><div class="pm-wrap"><button class="x" id="pmClose">&times;</button>'+
'<div class="hd"><div class="av" id="pmAv">A</div><div><div class="nm" id="pmName">Ajith Kumar</div><div class="hdline" id="pmHeadline">Full Stack Developer</div></div></div>'+
'<div class="st"><div><b id="pmPosts">0</b><span>posts</span></div><div><b id="pmFollow">0</b><span>followers</span></div><div><b id="pmLikes">0</b><span>likes</span></div></div>'+
'<div class="bio" id="pmBio">Seeking for a full stack developer</div>'+
'<div class="act"><a class="ep" href="/settings.html">Edit profile</a><a class="st2" href="/settings.html">Settings</a></div>'+
'</div></div>';

c.on("ready", () => {
  c.sftp((err, sftp) => {
    if (err) { out += "[SFTP-ERR] " + err.message; return c.end(); }
    sftp.readFile("/opt/gritgigs/public/feed.html", (e, buf) => {
      if (e) { out += "[READ-ERR] " + e.message; return c.end(); }
      let s = buf.toString("utf8");
      // 1) replace the nav icon container
      const iStart = s.indexOf('<div class="icons">');
      let navDone = false;
      if (iStart >= 0) {
        const iEnd = s.indexOf("</div>", iStart);
        if (iEnd > iStart) {
          s = s.slice(0, iStart) + '<div class="icons">' + ADD.NAV + "</div>" + s.slice(iEnd + "</div>".length);
          navDone = true;
        }
      }
      out += "[NAV] " + (navDone ? "OK" : "NO-NAV-CONTAINER");
      // 2) inject CSS into head
      if (s.indexOf("#profileModal") < 0) {
        const hi = s.indexOf("</head>");
        if (hi >= 0) {
          s = s.slice(0, hi) + CSS + s.slice(hi);
          out += " [CSS-IN]";
        }
      }
      // 3) inject modal HTML before </body>
      if (s.indexOf('id="profileModal"') < 0) {
        const bi = s.indexOf("</body>");
        if (bi >= 0) {
          s = s.slice(0, bi) + MODAL + s.slice(bi);
          out += " [MODAL-IN]";
        }
      }
      // 4) wire up open/close
      if (s.indexOf("navProfile") >= 0 && s.indexOf("pmOpenWire") < 0) {
        const script = '<script>(function(){var w=function(i){return document.getElementById(i)};var np=w("navProfile"),mm=w("profileModal");if(!np||!mm)return;np.addEventListener("click",function(ev){ev.preventDefault();var c=window.core||window.community;var l=function(u){u=u||{};w("pmName").textContent=u.firstName||u.displayName||u.username||"Ajith Kumar";w("pmHeadline").textContent=u.headline||u.tagline||"Full Stack Developer";w("pmBio").textContent=u.bio||u.about||"Seeking for a full stack developer";w("pmAv").textContent=((u.firstName||"A")[0]||"A");w("pmPosts").textContent=u.posts||0;w("pmFollow").textContent=u.followers||0;w("pmLikes").textContent=u.likes||0;mm.classList.add("open");};if(c&&c.api){c.api("/users/me").then(function(r){l(r&&r.data)}).catch(function(){l()})}else l();});w("pmClose").addEventListener("click",function(){mm.classList.remove("open")});mm.addEventListener("click",function(e){if(e.target===mm)mm.classList.remove("open")});window.pmOpenWire=1;})();</script>';
        const bi = s.indexOf("</body>");
        if (bi >= 0) { s = s.slice(0, bi) + script + s.slice(bi); out += " [WIRE-IN]"; }
      }
      sftp.writeFile("/opt/gritgigs/public/feed.html", Buffer.from(s, "utf8"), (we) => {
        if (we) { out += " [WRITE-ERR] " + we.message; return c.end(); }
        out += " [WRITTEN]\n";
        c.exec("echo ===PUBLIC-FEED-NAV-LIVE===; curl -s --max-time 25 https://gritandgigs.in/feed | grep -oE 'title=\"(Home|Search|Inbox|Notifications|Orders|Wallet|Profile)\"' | sort -u; echo ===PROFILE-MODAL-PRESENT===; curl -s --max-time 25 https://gritandgigs.in/feed | grep -cE 'id=\"profileModal\"|id=\"navProfile\"|id=\"pmEdit\"'; echo ===EDIT-PROFILE-LINK===; curl -s --max-time 25 https://gritandgigs.in/feed | grep -cE 'href=\"/settings.html\"' ; echo DONE", (e2, stream) => {
          if (e2) { out += " [EXEC-ERR] " + e2.message; return c.end(); }
          let b = "";
          stream.on("data", d => b += d.toString());
          stream.stderr.on("data", d => b += d.toString());
          stream.on("close", () => { out += "\n" + b.trim(); c.end(); });
        });
      });
    });
  });
});
c.on("error", e => { out += " [CONN-ERR] " + (e.code || e.message); c.end(); });
c.on("close", () => { console.log(out.trim()); process.exit(0); });
c.connect(H);
