/* Rolli-Kids-App: Login, Team-Verwaltung und Datenanbindung an Supabase.
   Stellt dieselbe Schnittstelle bereit wie die Claude-Seite (claude.use),
   damit das Lexikon unverändert weiterläuft. */
(function () {
  "use strict";
  var SB_URL = "https://fmmbamwyyfwuofrosjdr.supabase.co";
  var SB_KEY = "sb_publishable_K3Fnn2XaA3fuJbk1uwVU8w_o2gSg3U1";
  var DOMAIN = "rolli-kids.example.com";
  var ROLLEN = { admin: "Admin", trainer: "Trainerin", leser: "Nur lesen" };

  var sb = window.supabase.createClient(SB_URL, SB_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: "rk-auth" }
  });

  var ME = null, PROF = null, readyRes, ready = new Promise(function (r) { readyRes = r; });

  /* ---------- kleine Helfer ---------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function clone(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }
  var CP = "rk-cache:";
  function cGet(k) { try { var v = localStorage.getItem(CP + k); return v == null ? undefined : JSON.parse(v); } catch (e) { return undefined; } }
  function cSet(k, v) { try { localStorage.setItem(CP + k, JSON.stringify(v)); } catch (e) {} }
  function cClear() { try { Object.keys(localStorage).forEach(function (k) { if (k.indexOf(CP) === 0) localStorage.removeItem(k); }); } catch (e) {} }

  async function team(body) {
    var r = await sb.functions.invoke("team", { body: body });
    if (r.error) {
      var m = "Das hat nicht geklappt. Bitte nochmal versuchen.";
      try { var j = await r.error.context.json(); if (j && j.error) m = j.error; } catch (e) {}
      throw new Error(m);
    }
    return r.data;
  }

  /* ---------- Datenbank im Stil der Claude-Seite ---------- */
  var collL = [], docL = [];
  function dsnap(id, data) { return { id: id, exists: data !== undefined && data !== null, data: function () { return data == null ? undefined : clone(data); } }; }
  function csnap(map) { return { docs: Object.keys(map).map(function (id) { return dsnap(id, map[id]); }), size: Object.keys(map).length, empty: !Object.keys(map).length }; }
  function emitColl(L) { try { L.cb(csnap(L.map)); } catch (e) { console.error(e); } }
  function emitDoc(L) { try { L.cb(dsnap(L.id, L.data)); } catch (e) { console.error(e); } }

  function applyLocal(coll, id, data) {
    collL.forEach(function (L) {
      if (L.coll !== coll) return;
      if (data == null) delete L.map[id]; else L.map[id] = clone(data);
      cSet("c:" + coll, L.map); emitColl(L);
    });
    docL.forEach(function (L) {
      if (L.path !== coll + "/" + id) return;
      L.data = data == null ? undefined : clone(data);
      cSet("d:" + L.path, L.data === undefined ? null : L.data); emitDoc(L);
    });
  }

  async function fetchColl(L) {
    var all = {}, from = 0;
    while (true) {
      var r = await sb.from("docs").select("doc_id,data").eq("coll", L.coll).range(from, from + 999);
      if (r.error) { if (L.err && !L.cached) L.err(r.error); return; }
      r.data.forEach(function (x) { all[x.doc_id] = x.data; });
      if (r.data.length < 1000) break;
      from += 1000;
    }
    L.map = all; L.cached = true; cSet("c:" + L.coll, all); emitColl(L);
  }
  async function fetchDoc(L) {
    var r = await sb.from("docs").select("data").eq("path", L.path).maybeSingle();
    if (r.error) { if (L.err && !L.cached) L.err(r.error); return; }
    L.data = r.data ? r.data.data : undefined; L.cached = true;
    cSet("d:" + L.path, L.data === undefined ? null : L.data); emitDoc(L);
  }
  function refetchAll() { collL.forEach(fetchColl); docL.forEach(fetchDoc); }

  function startRealtime() {
    sb.channel("rk-docs")
      .on("postgres_changes", { event: "*", schema: "public", table: "docs" }, function (p) {
        var row = p.eventType === "DELETE" ? p.old : p.new;
        if (!row) return;
        var path = row.path || "", coll = row.coll, id = row.doc_id;
        if (!coll && path) { var i = path.lastIndexOf("/"); coll = path.slice(0, i); id = path.slice(i + 1); }
        if (!coll) return;
        applyLocal(coll, id, p.eventType === "DELETE" ? null : row.data);
      })
      .subscribe(function (status) { if (status === "SUBSCRIBED") refetchAll(); });
    document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") refetchAll(); });
    window.addEventListener("online", refetchAll);
  }

  function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  function docRef(coll, id) {
    var path = coll + "/" + id;
    var ref = {
      id: id, path: path,
      get: async function () {
        var r = await sb.from("docs").select("data").eq("path", path).maybeSingle();
        if (r.error) { var c = cGet("d:" + path); if (c !== undefined) return dsnap(id, c); throw r.error; }
        var d = r.data ? r.data.data : undefined; cSet("d:" + path, d === undefined ? null : d);
        return dsnap(id, d);
      },
      set: async function (data) {
        var d = clone(data) || {};
        var r = await sb.from("docs").upsert({ path: path, coll: coll, doc_id: id, data: d }, { onConflict: "path" }).select("path");
        if (r.error) throw r.error;
        if (!r.data || !r.data.length) throw new Error("Keine Berechtigung.");
        applyLocal(coll, id, d);
      },
      update: async function (patch) {
        var s = await ref.get(); var cur = s.data() || {};
        Object.keys(patch || {}).forEach(function (k) { cur[k] = clone(patch[k]); });
        return ref.set(cur);
      },
      delete: async function () {
        var r = await sb.from("docs").delete().eq("path", path).select("path");
        if (r.error) throw r.error;
        if (!r.data || !r.data.length) {
          var chk = await sb.from("docs").select("path").eq("path", path).maybeSingle();
          if (chk.data) throw new Error("Keine Berechtigung.");
        }
        applyLocal(coll, id, null);
      },
      onSnapshot: function (cb, err) {
        var L = { path: path, id: id, cb: cb, err: err };
        var c = cGet("d:" + path);
        if (c !== undefined) { L.data = c === null ? undefined : c; L.cached = true; setTimeout(function () { emitDoc(L); }, 0); }
        docL.push(L); fetchDoc(L);
        return function () { docL = docL.filter(function (x) { return x !== L; }); };
      }
    };
    return ref;
  }
  function collRef(coll) {
    return {
      id: coll,
      doc: function (id) { return docRef(coll, id == null ? newId() : String(id)); },
      add: async function (data) { var r = docRef(coll, newId()); await r.set(data); return r; },
      get: async function () { var L = { coll: coll, map: {}, cb: function () {} }; await fetchColl(L); return csnap(L.map); },
      onSnapshot: function (cb, err) {
        var L = { coll: coll, map: {}, cb: cb, err: err };
        var c = cGet("c:" + coll);
        if (c) { L.map = c; L.cached = true; setTimeout(function () { emitColl(L); }, 0); }
        collL.push(L); fetchColl(L);
        return function () { collL = collL.filter(function (x) { return x !== L; }); };
      }
    };
  }
  var DB = {
    collection: collRef,
    doc: function (p) { var i = String(p).lastIndexOf("/"); return docRef(p.slice(0, i), p.slice(i + 1)); }
  };

  var USER = {
    id: async function () { return ME; },
    me: async function () { return { id: ME, name: PROF ? PROF.name : "" }; },
    isOwner: function () { return !!PROF && PROF.role === "admin"; },
    canEdit: function () { return !!PROF && PROF.role === "admin"; },
    can: async function (n) { return n === "data.write" ? (!!PROF && PROF.role !== "leser") : null; },
    profiles: async function (ids) {
      var o = {};
      if (!ids || !ids.length) return o;
      var r = await sb.from("profiles").select("id,name").in("id", ids);
      (r.data || []).forEach(function (p) { o[p.id] = { id: p.id, name: p.name }; });
      return o;
    },
    search: async function () { return []; }
  };

  var DOWNLOADS = {
    save: async function (o) {
      var blob = o.data instanceof Blob ? o.data : new Blob([o.data], { type: "application/octet-stream" });
      var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = o.filename || "datei";
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
      return "saved";
    }
  };

  window.claude = {
    use: async function (name) {
      await ready;
      if (name === "db") return DB;
      if (name === "user") return USER;
      if (name === "downloads") return DOWNLOADS;
      return null; /* "sample" (KI in der Seite) gibt es in der App nicht */
    }
  };

  /* ---------- Oberfläche: Login, Konto, Team ---------- */
  var CSS = "" +
    "#rk-gate{position:fixed;inset:0;z-index:1000;background:var(--bg,#F2F5F6);color:var(--fg,#16282B);display:flex;align-items:center;justify-content:center;padding:24px;overflow:auto;font-family:var(--f-body,system-ui,sans-serif)}" +
    "#rk-gate[hidden],#rk-panel[hidden]{display:none!important}" +
    ".rk-box{width:100%;max-width:380px;background:var(--surface,#fff);border:1.5px solid var(--line,#D5DEE0);border-radius:16px;padding:24px}" +
    ".rk-box h2{font-family:var(--f-display,system-ui);font-size:24px;margin:0 0 4px}" +
    ".rk-box p{margin:0 0 14px;color:var(--muted,#5B6E72);font-size:15px;line-height:1.45}" +
    ".rk-f{display:block;margin:0 0 12px;font-size:14px;font-weight:700}" +
    ".rk-f input,.rk-f select{display:block;width:100%;box-sizing:border-box;margin-top:4px;font:inherit;font-size:16px;font-weight:400;padding:10px 12px;border:1.5px solid var(--line,#D5DEE0);border-radius:10px;background:var(--bg,#fff);color:var(--fg,#16282B);min-height:44px}" +
    ".rk-btn{font:inherit;font-size:16px;font-weight:700;width:100%;min-height:46px;border:0;border-radius:10px;background:var(--accent,#1F3437);color:var(--accent-fg,#fff);cursor:pointer}" +
    ".rk-btn2{font:inherit;font-size:14px;min-height:40px;padding:6px 12px;border:1.5px solid var(--line,#D5DEE0);border-radius:10px;background:var(--bg,#fff);color:var(--fg,#16282B);cursor:pointer}" +
    ".rk-btn:disabled{opacity:.6}" +
    ".rk-msg{min-height:20px;font-size:14px;margin:8px 0 0;color:var(--muted)}.rk-msg.err{color:#C62828}.rk-msg.ok{color:var(--ok,#2E7D32)}" +
    "#rk-panel{position:fixed;inset:0;z-index:900;background:rgba(10,20,22,.45);display:flex;justify-content:flex-end}" +
    ".rk-side{width:100%;max-width:440px;height:100%;overflow:auto;background:var(--surface,#fff);color:var(--fg);padding:20px 18px calc(24px + env(safe-area-inset-bottom,0px));box-sizing:border-box;font-family:var(--f-body,system-ui)}" +
    ".rk-side h2{font-family:var(--f-display,system-ui);font-size:22px;margin:0}.rk-side h3{font-size:16px;margin:22px 0 8px}" +
    ".rk-head{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px}" +
    ".rk-row{border:1.5px solid var(--line);border-radius:12px;padding:10px 12px;margin:0 0 8px}" +
    ".rk-row b{font-size:15px}.rk-row small{display:block;color:var(--muted);font-size:13px;margin-top:2px}" +
    ".rk-row details summary{cursor:pointer;color:var(--muted);font-size:14px;margin-top:6px}" +
    ".rk-acts{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}" +
    ".rk-tag{display:inline-block;font-size:12px;padding:1px 8px;border-radius:99px;background:var(--accent-soft,#E2E8E9);margin-left:6px;vertical-align:1px}" +
    ".rk-tag.off{background:#FDE0DE;color:#8E1B1B}" +
    "#rkacct{float:right;margin:4px 6px 0 0;display:inline-flex;gap:5px;align-items:center}" +
    "#rkacct .rk-offi{display:none;width:16px;height:16px;color:var(--warn,#B26A00)}#rkacct.off .rk-offi{display:inline}";

  function injectUI() {
    var st = document.createElement("style"); st.textContent = CSS; document.head.appendChild(st);
    var g = document.createElement("div"); g.id = "rk-gate"; g.innerHTML = '<div class="rk-box"><h2>Rolli-Kids</h2><p>Lädt …</p></div>'; document.body.appendChild(g);
    var p = document.createElement("div"); p.id = "rk-panel"; p.hidden = true; document.body.appendChild(p);
    p.addEventListener("click", function (e) { if (e.target === p) p.hidden = true; });
    var hb = $("helpbtn");
    if (hb) {
      var b = document.createElement("button"); b.type = "button"; b.className = "btn3"; b.id = "rkacct";
      b.innerHTML = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true" style="width:16px;height:16px"><circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/></svg><span id="rkacct-n">Konto</span><svg class="rk-offi" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M7 18h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 9a4.5 4.5 0 0 0 1 9z"/><path d="M3 3l18 18"/></svg>';
      hb.parentNode.insertBefore(b, hb);
      b.addEventListener("click", openPanel);
      var setOff = function () { var o = !navigator.onLine; b.classList.toggle("off", o); b.title = o ? "Offline: du siehst den letzten gespeicherten Stand" : ""; };
      window.addEventListener("online", setOff); window.addEventListener("offline", setOff); setOff();
    }
  }

  function gate(html) { var g = $("rk-gate"); g.hidden = false; g.innerHTML = '<div class="rk-box">' + html + "</div>"; }
  function busy(btn, on, txt) { btn.disabled = on; if (txt) btn.textContent = txt; }

  function showLogin(msg) {
    gate('<h2>Rolli-Kids</h2><p>Melde dich mit dem Namen und Passwort an, die du von deinem Admin bekommen hast.</p>' +
      '<form id="rk-lf" autocomplete="on"><label class="rk-f">Benutzername<input id="rk-u" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required></label>' +
      '<label class="rk-f">Passwort<input id="rk-p" type="password" name="password" autocomplete="current-password" required></label>' +
      '<button class="rk-btn" id="rk-lb">Anmelden</button><p class="rk-msg' + (msg ? " err" : "") + '" id="rk-lm">' + esc(msg || "") + "</p></form>" +
      '<p style="margin:10px 0 0;font-size:13px">Passwort vergessen? Dein Admin kann es neu setzen.</p>');
    $("rk-lf").addEventListener("submit", async function (e) {
      e.preventDefault();
      var u = $("rk-u").value.trim().toLowerCase(), pw = $("rk-p").value, m = $("rk-lm"), btn = $("rk-lb");
      if (!u || !pw) { m.className = "rk-msg err"; m.textContent = "Bitte Name und Passwort eingeben."; return; }
      busy(btn, true, "Melde an …"); m.textContent = "";
      var r = await sb.auth.signInWithPassword({ email: u + "@" + DOMAIN, password: pw });
      if (r.error) {
        busy(btn, false, "Anmelden"); m.className = "rk-msg err";
        m.textContent = navigator.onLine ? "Name oder Passwort stimmt nicht." : "Keine Internetverbindung.";
        return;
      }
      afterLogin(r.data.session);
    });
    setTimeout(function () { var u = $("rk-u"); if (u) u.focus(); }, 50);
  }

  function showSetup() {
    gate('<h2>Ersteinrichtung</h2><p>Es gibt noch keinen Admin. Lege jetzt dein eigenes Admin-Konto an. Danach ist diese Seite gesperrt.</p>' +
      '<form id="rk-sf"><label class="rk-f">Dein Name<input id="rk-sn" required placeholder="Mehmet"></label>' +
      '<label class="rk-f">Benutzername<input id="rk-su" autocapitalize="none" spellcheck="false" required placeholder="mehmet"></label>' +
      '<label class="rk-f">Passwort (mind. 8 Zeichen)<input id="rk-sp" type="password" autocomplete="new-password" required></label>' +
      '<label class="rk-f">Passwort wiederholen<input id="rk-sp2" type="password" autocomplete="new-password" required></label>' +
      '<button class="rk-btn" id="rk-sb">Admin anlegen</button><p class="rk-msg" id="rk-sm"></p></form>');
    $("rk-sf").addEventListener("submit", async function (e) {
      e.preventDefault();
      var n = $("rk-sn").value.trim(), u = $("rk-su").value.trim().toLowerCase(), p = $("rk-sp").value, m = $("rk-sm"), btn = $("rk-sb");
      m.className = "rk-msg err";
      if (p !== $("rk-sp2").value) { m.textContent = "Die Passwörter sind nicht gleich."; return; }
      busy(btn, true, "Lege an …");
      try {
        await team({ action: "setup", name: n, username: u, password: p });
        var r = await sb.auth.signInWithPassword({ email: u + "@" + DOMAIN, password: p });
        if (r.error) throw new Error("Konto angelegt, aber Anmeldung klappt nicht. Bitte neu laden.");
        afterLogin(r.data.session);
      } catch (err) { busy(btn, false, "Admin anlegen"); m.textContent = err.message; }
    });
  }

  async function afterLogin(session) {
    ME = session.user.id;
    var r = await sb.from("profiles").select("id,username,name,role,aktiv").eq("id", ME).maybeSingle();
    if (r.error) {
      PROF = cGet("me");
      if (!PROF || PROF.id !== ME) { showLogin(navigator.onLine ? "Verbindung klappt gerade nicht. Bitte gleich nochmal." : "Keine Internetverbindung."); return; }
    } else if (!r.data || !r.data.aktiv) {
      await sb.auth.signOut(); cClear(); ME = null;
      showLogin("Dein Zugang ist gesperrt. Melde dich bei deinem Admin.");
      return;
    } else { PROF = r.data; cSet("me", PROF); }
    var n = $("rkacct-n"); if (n) n.textContent = PROF.name.split(" ")[0];
    $("rk-gate").hidden = true;
    startRealtime();
    readyRes();
  }

  /* ---------- Konto-Seite ---------- */
  function openPanel() {
    var p = $("rk-panel"); p.hidden = false;
    var admin = PROF && PROF.role === "admin";
    p.innerHTML = '<div class="rk-side" role="dialog" aria-label="Konto">' +
      '<div class="rk-head"><h2>' + esc(PROF.name) + '</h2><button class="rk-btn2" id="rk-x">Schließen</button></div>' +
      '<p style="margin:0;color:var(--muted)">Angemeldet als <b>' + esc(PROF.username) + "</b> · " + esc(ROLLEN[PROF.role]) + "</p>" +
      '<h3>Mein Passwort ändern</h3><form id="rk-pw"><label class="rk-f">Neues Passwort (mind. 8 Zeichen)<input id="rk-np" type="password" autocomplete="new-password"></label>' +
      '<button class="rk-btn2">Speichern</button><p class="rk-msg" id="rk-pm"></p></form>' +
      (admin ? '<h3>Team</h3><div id="rk-team"><p class="rk-msg">Lädt …</p></div>' +
        '<details class="rk-row"><summary style="font-weight:700;color:var(--fg)">Neue Person anlegen</summary><form id="rk-new" style="margin-top:10px">' +
        '<label class="rk-f">Name<input id="rk-nn" placeholder="Anna Huber"></label>' +
        '<label class="rk-f">Benutzername (zum Anmelden)<input id="rk-nu" autocapitalize="none" spellcheck="false" placeholder="anna"></label>' +
        '<label class="rk-f">Startpasswort (mind. 8 Zeichen)<input id="rk-npw" placeholder="wird ihr mitgeteilt"></label>' +
        '<label class="rk-f">Rolle<select id="rk-nr"><option value="trainer">Trainerin: lesen und eintragen</option><option value="leser">Nur lesen</option><option value="admin">Admin</option></select></label>' +
        '<button class="rk-btn">Anlegen</button><p class="rk-msg" id="rk-nm"></p></form></details>' +
        '<h3>Sicherung</h3><p style="font-size:14px;color:var(--muted);margin:0 0 8px">Alle Spiele als Datei speichern oder aus einer Datei einspielen (z. B. daten.json aus dem alten Lexikon). Gleiche Spiele werden überschrieben, nichts wird gelöscht.</p>' +
        '<div class="rk-acts"><button class="rk-btn2" id="rk-exp">Spiele speichern</button><label class="rk-btn2" style="display:inline-flex;align-items:center">Spiele einspielen<input type="file" id="rk-imp" accept=".json,application/json" hidden></label></div><p class="rk-msg" id="rk-im"></p>' : "") +
      '<h3></h3><button class="rk-btn2" id="rk-out">Abmelden</button></div>';
    $("rk-x").onclick = function () { p.hidden = true; };
    $("rk-out").onclick = async function () { await sb.auth.signOut(); cClear(); try { localStorage.removeItem("rk-mein"); localStorage.removeItem("rk-heute"); } catch (e) {} location.reload(); };
    $("rk-pw").onsubmit = async function (e) {
      e.preventDefault(); var v = $("rk-np").value, m = $("rk-pm");
      if (v.length < 8) { m.className = "rk-msg err"; m.textContent = "Mindestens 8 Zeichen."; return; }
      var r = await sb.auth.updateUser({ password: v });
      m.className = "rk-msg " + (r.error ? "err" : "ok"); m.textContent = r.error ? "Hat nicht geklappt." : "Passwort geändert.";
      if (!r.error) $("rk-np").value = "";
    };
    if (admin) { loadTeam(); bindAdmin(); }
  }

  async function loadTeam() {
    var box = $("rk-team"); if (!box) return;
    try {
      var d = await team({ action: "list" });
      box.innerHTML = d.list.map(function (u) {
        var me = u.id === ME;
        return '<div class="rk-row" data-uid="' + esc(u.id) + '"><b>' + esc(u.name) + "</b>" + (u.aktiv ? "" : '<span class="rk-tag off">gesperrt</span>') +
          "<small>" + esc(u.username) + " · " + esc(ROLLEN[u.role]) + (me ? " · das bist du" : "") + "</small>" +
          (me ? "" : '<details><summary>Bearbeiten</summary><div class="rk-acts">' +
            '<select class="rk-btn2" data-act="role">' + Object.keys(ROLLEN).map(function (r) { return '<option value="' + r + '"' + (r === u.role ? " selected" : "") + ">" + ROLLEN[r] + "</option>"; }).join("") + "</select>" +
            '<button class="rk-btn2" data-act="pw">Neues Passwort</button>' +
            '<button class="rk-btn2" data-act="aktiv">' + (u.aktiv ? "Sperren" : "Entsperren") + "</button>" +
            '<button class="rk-btn2" data-act="del">Löschen</button></div><p class="rk-msg"></p></details>') + "</div>";
      }).join("");
    } catch (e) { box.innerHTML = '<p class="rk-msg err">' + esc(e.message) + "</p>"; }
  }

  function bindAdmin() {
    var box = $("rk-team");
    box.addEventListener("change", async function (e) {
      var s = e.target.closest('[data-act="role"]'); if (!s) return;
      var row = s.closest("[data-uid]"), m = row.querySelector(".rk-msg");
      try { await team({ action: "update", id: row.dataset.uid, role: s.value }); m.className = "rk-msg ok"; m.textContent = "Rolle geändert."; setTimeout(loadTeam, 900); }
      catch (err) { m.className = "rk-msg err"; m.textContent = err.message; }
    });
    box.addEventListener("click", async function (e) {
      var b = e.target.closest("button[data-act]"); if (!b) return;
      var row = b.closest("[data-uid]"), id = row.dataset.uid, m = row.querySelector(".rk-msg"), act = b.dataset.act;
      m.className = "rk-msg";
      try {
        if (act === "pw") {
          var acts = b.parentNode;
          if (!row.querySelector(".rk-pwf")) {
            var f = document.createElement("form"); f.className = "rk-pwf rk-acts";
            f.innerHTML = '<input class="rk-btn2" style="flex:1;min-width:140px" placeholder="Neues Passwort (8+)"><button class="rk-btn2">Setzen</button>';
            acts.after(f);
            f.onsubmit = async function (ev) {
              ev.preventDefault(); var v = f.querySelector("input").value;
              try { await team({ action: "update", id: id, password: v }); m.className = "rk-msg ok"; m.textContent = "Passwort gesetzt. Teile es der Person mit."; f.remove(); }
              catch (err) { m.className = "rk-msg err"; m.textContent = err.message; }
            };
            f.querySelector("input").focus();
          }
          return;
        }
        if (act === "aktiv") { await team({ action: "update", id: id, aktiv: b.textContent === "Entsperren" }); loadTeam(); return; }
        if (act === "del") {
          if (b.dataset.sure !== "1") { b.dataset.sure = "1"; b.textContent = "Wirklich löschen?"; return; }
          await team({ action: "delete", id: id }); loadTeam(); return;
        }
      } catch (err) { m.className = "rk-msg err"; m.textContent = err.message; }
    });
    $("rk-new").onsubmit = async function (e) {
      e.preventDefault(); var m = $("rk-nm"), btn = e.target.querySelector("button");
      busy(btn, true, "Lege an …");
      try {
        await team({ action: "create", name: $("rk-nn").value, username: $("rk-nu").value.trim().toLowerCase(), password: $("rk-npw").value, role: $("rk-nr").value });
        m.className = "rk-msg ok"; m.textContent = "Angelegt. Gib ihr Benutzername und Passwort weiter.";
        ["rk-nn", "rk-nu", "rk-npw"].forEach(function (i) { $(i).value = ""; }); loadTeam();
      } catch (err) { m.className = "rk-msg err"; m.textContent = err.message; }
      busy(btn, false, "Anlegen");
    };
    $("rk-exp").onclick = async function () {
      var m = $("rk-im");
      try {
        var s = await collRef("spiele").get();
        var out = { stand: new Date().toISOString().slice(0, 10), spiele: s.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); }) };
        await DOWNLOADS.save({ filename: "rolli-kids-spiele-" + out.stand + ".json", data: new Blob([JSON.stringify(out, null, 1)], { type: "application/json" }) });
        m.className = "rk-msg ok"; m.textContent = out.spiele.length + " Spiele gespeichert.";
      } catch (err) { m.className = "rk-msg err"; m.textContent = "Speichern hat nicht geklappt."; }
    };
    $("rk-imp").onchange = async function (e) {
      var file = e.target.files[0], m = $("rk-im"); if (!file) return;
      m.className = "rk-msg"; m.textContent = "Lese Datei …";
      try {
        var j = JSON.parse(await file.text());
        var list = Array.isArray(j) ? j : (j.spiele || []);
        list = list.filter(function (x) { return x && x.id && x.n; });
        if (!list.length) throw new Error("In der Datei sind keine Spiele.");
        var rows = list.map(function (x) { var d = clone(x); var id = String(d.id); delete d.id; return { path: "spiele/" + id, coll: "spiele", doc_id: id, data: d }; });
        for (var i = 0; i < rows.length; i += 100) {
          m.textContent = "Spiele einspielen … " + Math.min(i + 100, rows.length) + " von " + rows.length;
          var r = await sb.from("docs").upsert(rows.slice(i, i + 100), { onConflict: "path" });
          if (r.error) throw new Error("Einspielen hat nicht geklappt: " + r.error.message);
        }
        m.className = "rk-msg ok"; m.textContent = rows.length + " Spiele eingespielt.";
        refetchAll();
      } catch (err) { m.className = "rk-msg err"; m.textContent = err.message; }
      e.target.value = "";
    };
  }

  /* ---------- Start ---------- */
  async function boot() {
    injectUI();
    var s = await sb.auth.getSession();
    if (s.data && s.data.session) { afterLogin(s.data.session); return; }
    try { var st = await team({ action: "status" }); if (st && st.setup) { showSetup(); return; } } catch (e) {}
    showLogin();
  }
  sb.auth.onAuthStateChange(function (ev) { if (ev === "SIGNED_OUT" && ME) location.reload(); });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    window.addEventListener("load", function () { navigator.serviceWorker.register("sw.js").catch(function () {}); });
  }
})();
