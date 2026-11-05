// Lokal variant (GitHub Pages): samme Worker-kode som i den delte varianten, men kjørt i nettleseren mot en SQLite (sql.js, WebAssembly).
// Databasen lagres i IndexedDB på denne enheten. Ingen konto, ingen server. Varene deles ikke med andre enheter.
import { makeSession } from "./src/logic.js";

const IDB_NAME = "frysekontroll-lokal", IDB_STORE = "db", IDB_KEY = "database";
const idb = () => new Promise((res, rej) => { const r = indexedDB.open(IDB_NAME, 1); r.onupgradeneeded = () => r.result.createObjectStore(IDB_STORE); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const idbGet = async () => { const d = await idb(); return new Promise((res, rej) => { const q = d.transaction(IDB_STORE).objectStore(IDB_STORE).get(IDB_KEY); q.onsuccess = () => res(q.result || null); q.onerror = () => rej(q.error); }); };
const idbPut = async (bytes) => { const d = await idb(); return new Promise((res, rej) => { const t = d.transaction(IDB_STORE, "readwrite"); t.objectStore(IDB_STORE).put(bytes, IDB_KEY); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); };

const loadScript = (src) => new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("Kunne ikke laste " + src)); document.head.append(s); });

let db, SQL, save = Promise.resolve();
const persist = () => { save = save.then(() => idbPut(db.export())).catch(() => {}); return save; };

// D1-grensesnittet som Workeren bruker (prepare/bind/first/all/run/batch), over sql.js.
function bound(sql, args) {
  return {
    _run: () => db.run(sql, args),
    first: async () => { const st = db.prepare(sql); try { st.bind(args); return st.step() ? st.getAsObject() : null; } finally { st.free(); } },
    all: async () => { const st = db.prepare(sql), results = []; try { st.bind(args); while (st.step()) results.push(st.getAsObject()); } finally { st.free(); } return { results }; },
    run: async () => { db.run(sql, args); return { meta: { changes: db.getRowsModified() } }; },
  };
}
const D1 = {
  prepare: (sql) => ({ bind: (...args) => bound(sql, args), ...bound(sql, []) }),
  batch: async (list) => {
    db.run("BEGIN");
    try { for (const s of list) s._run(); db.run("COMMIT"); } catch (err) { db.run("ROLLBACK"); throw err; }
    return list.map(() => ({}));
  },
};

const secretOf = () => {
  let s = "";
  try { s = localStorage.getItem("fk-lokal-hemmelighet") || ""; } catch { /* uten lagring gjelder hemmeligheten bare denne økten */ }
  if (!/^[a-f0-9]{64}$/.test(s)) {
    s = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
    try { localStorage.setItem("fk-lokal-hemmelighet", s); } catch { /* se over */ }
  }
  return s;
};

export async function start() {
  const base = new URL(".", import.meta.url).href;
  await loadScript(base + "vendor/sql-wasm.js");
  SQL = await window.initSqlJs({ locateFile: (f) => base + "vendor/" + f });
  const saved = await idbGet().catch(() => null);
  db = saved ? new SQL.Database(saved) : new SQL.Database();
  db.run(await (await fetch(base + "migrations/0001_init.sql")).text());
  const { api } = await import("./src/worker.js");
  const env = { DB: D1, FRYS_PASSWORD: secretOf() };
  const token = await makeSession(env.FRYS_PASSWORD);
  try { navigator.storage?.persist?.(); } catch { /* valgfritt */ }

  // Workeren leser bare request.headers.get(...). Cookie-headeren kan ikke settes på en ekte Request i nettleseren, så den legges på her.
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    if (!/\/api\//.test(url.pathname)) return nativeFetch(input, init);
    const path = url.pathname.slice(url.pathname.indexOf("/api/"));
    const method = (init.method || "GET").toUpperCase();
    const given = new Headers(init.headers || {});
    const headers = { cookie: `fk=${token}`, "x-device": given.get("x-device") || "", "content-type": given.get("content-type") || "" };
    const req = new Request(url.origin + path + url.search, { method, body: ["GET", "HEAD"].includes(method) ? undefined : init.body });
    Object.defineProperty(req, "headers", { value: { get: (n) => headers[String(n).toLowerCase()] || null } });
    const res = await api(req, env, new URL(req.url));
    if (method !== "GET" && method !== "HEAD") await persist();
    return res;
  };

  // Bilder er vanlige <img src="/api/…">, som nettleseren ellers henter selv. Her hentes de fra databasen og vises som blob.
  const fixImgs = (root) => root.querySelectorAll?.('img[src*="/api/items/"]:not([data-lokal])').forEach(async (img) => {
    img.dataset.lokal = "1";
    try { const r = await window.fetch(img.getAttribute("src")); if (r.ok) img.src = URL.createObjectURL(await r.blob()); } catch { /* bildet vises ikke */ }
  });
  new MutationObserver((list) => list.forEach((m) => m.addedNodes.forEach((n) => n.nodeType === 1 && fixImgs(n.parentNode || n)))).observe(document.getElementById("app"), { childList: true, subtree: true });

  document.body.dataset.modus = "lokal";
  const nav = document.querySelector('#nav a[href="#/familie"]');
  if (nav) nav.textContent = "Kopi";
}

// Siden «Kopi»: last ned eller gjenopprett hele databasen. Nettleseren kan slette lagrede data (for eksempel ved «tøm nettleserdata»).
export function viewBackup(app, message = "") {
  app.innerHTML = `<h1>Sikkerhetskopi</h1>
    <div class="card"><p>Varene ligger bare i denne nettleseren, på denne enheten. Last ned en kopi av og til, og alltid før du tømmer nettleserdata eller bytter telefon.</p>
      ${message ? `<div class="msg ok" role="status">${message}</div>` : ""}
      <div class="row"><button class="btn" id="kopi-ned" type="button">Last ned sikkerhetskopi</button></div></div>
    <div class="card"><h2>Gjenopprett</h2><p class="muted">Velger du en kopi, erstattes alt som ligger her nå.</p>
      <label>Fil<input type="file" id="kopi-opp" accept=".sqlite,.db,application/octet-stream"></label></div>`;
  document.getElementById("kopi-ned").onclick = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([db.export()], { type: "application/octet-stream" }));
    a.download = `frysekontroll-${new Date().toISOString().slice(0, 10)}.sqlite`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  document.getElementById("kopi-opp").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const next = new SQL.Database(new Uint8Array(await f.arrayBuffer()));
      next.exec("SELECT COUNT(*) FROM items"); // feiler hvis det ikke er en Frysekontroll-database
      db = next;
      await persist();
      viewBackup(app, "Gjenopprettet.");
    } catch { viewBackup(app, ""); app.querySelector(".card").insertAdjacentHTML("beforeend", `<div class="msg err" role="alert">Filen er ikke en Frysekontroll-kopi.</div>`); }
  };
}
