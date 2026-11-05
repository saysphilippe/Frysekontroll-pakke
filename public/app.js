// Frysekontroll: web-appen. Ruter: #/ (varer), #/ny (frys ned), #/v/<id> (en vare; det er hit QR-koden på etiketten peker), #/steder.
import { Niimbot, LABEL_TYPE, B21, NiimbotError } from "./niimbot.js";
import { SIZES, DEFAULT_SIZE, KNOWN_ROLLS, rememberedSize, rememberSize, drawLabel, itemUrl, packUrl, placeText, appBase } from "./label.js";
import { MODE } from "./config.js";

// Lokal variant (GitHub Pages): Workeren kjøres i nettleseren, se lokal.js. I den delte varianten lastes den aldri.
const lokal = MODE === "lokal" ? await import("./lokal.js") : null;
if (lokal) await lokal.start();

const app = document.getElementById("app");
const nav = document.getElementById("nav");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const state = { vision: false, places: [], nw: null, view: "", itemId: "", item: null, q: "", place: "", all: false, sort: "", me: "", facets: { tags: [], freezers: [], people: [] }, f: { freezer: "", tags: [], exp: "", by: "", from: "", to: "", multi: false } };

// ---------- API ----------
class NeedLogin extends Error {}
// Enhetskode: tilfeldig, lagres i nettleseren og sendes med hvert kall. Varen husker koden til enheten som la den inn.
const deviceId = (() => {
  const make = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  try { let d = localStorage.getItem("fk-device"); if (!/^[a-f0-9]{32}$/.test(d || "")) { d = make(); localStorage.setItem("fk-device", d); } return d; } catch { return make(); }
})();
async function api(method, path, body, retried = false) {
  const headers = { "x-device": deviceId, ...(body ? { "content-type": "application/json" } : {}) };
  const res = await fetch(path, { method, credentials: "same-origin", headers, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401 && path !== "/api/login" && path !== "/api/unlock") { showLogin(); throw new NeedLogin(); }
  const data = await res.json().catch(() => ({}));
  // En annen enhet enn den som la inn varen må skrive passordet på nytt. Etterpå prøves det samme kallet én gang til.
  if (res.status === 403 && data.error === "password-needed" && !retried) { await askUnlock(); return api(method, path, body, true); }
  if (!res.ok) throw Object.assign(new Error(data.error || `http-${res.status}`), { code: data.error, status: res.status });
  return data;
}
function askUnlock() {
  return new Promise((resolve, reject) => {
    const box = document.createElement("div");
    box.className = "unlock"; box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "true");
    box.innerHTML = `<form class="card"><h2>Skriv passordet</h2><p class="muted">Denne varen ble lagt inn fra en annen enhet. Skriv passordet ditt for å endre den. Det gjelder denne enheten til du logger ut.</p>
      <label>Passord<input type="password" id="unlock-pw" autocomplete="current-password" required></label>
      <div class="msg err" id="unlock-msg" hidden></div>
      <div class="row"><button class="btn" type="submit">Lås opp</button><button class="btn sec" type="button" id="unlock-cancel">Avbryt</button></div></form>`;
    document.body.append(box);
    const input = box.querySelector("#unlock-pw"), msg = box.querySelector("#unlock-msg");
    input.focus();
    const done = (fn) => { box.remove(); fn(); };
    box.querySelector("#unlock-cancel").addEventListener("click", () => done(() => reject(Object.assign(new Error("cancelled"), { code: "cancelled" }))));
    box.querySelector("form").addEventListener("submit", async (e) => {
      e.preventDefault();
      try { await api("POST", "/api/unlock", { password: input.value }); done(resolve); }
      catch (err) { if (err instanceof NeedLogin) return done(() => reject(err)); msg.textContent = say(err); msg.hidden = false; input.select(); }
    });
  });
}
const ERR = {
  "password-needed": "Skriv passordet for å endre denne varen.", cancelled: "Avbrutt.",
  "wrong-password": "Feil navn eller passord.", "already-taken": "Denne pakken er allerede tatt ut.", expires: "Datoen er ikke gyldig.", password: "Passordet må være minst 8 tegn.", self: "Du kan ikke fjerne deg selv.", "not-taken": "Pakken ligger allerede i fryseren.", "too-many": "For mange forsøk. Vent en time.", "not-enough": "Det er ikke så mange igjen.", "in-use": "Det ligger varer her. Flytt dem først.",
  name: "Skriv et navn.", qty: "Antall må være 1 til 99.", place: "Velg hvor den skal ligge.", photo: "Bildet kunne ikke brukes.", "no-key": "Bildetolking er ikke slått på.", "vision-failed": "Fikk ikke tolket bildet. Skriv navnet selv.",
};
const say = (e) => ERR[e?.code] || (e instanceof NiimbotError ? e.message : e?.name === "NotFoundError" ? "Ingen skriver valgt." : "Noe gikk galt. Prøv igjen.");

// ---------- Innlogging ----------
function showLogin() {
  nav.hidden = true;
  app.innerHTML = `<form class="card login" id="login"><h1>Frysekontroll</h1><p class="muted">Logg inn med navn og eget passord, eller bare familiens felles passord (la navnet stå tomt).</p>
    <label>Navn (valgfritt)<input id="login-name" autocomplete="username" maxlength="30"></label>
    <label>Passord<input type="password" id="pw" autocomplete="current-password" autofocus required></label>
    <div id="login-msg" class="msg err" hidden></div><button class="btn" type="submit">Logg inn</button></form>`;
}
app.addEventListener("submit", async (e) => {
  if (e.target.id !== "login") return;
  e.preventDefault();
  const msg = document.getElementById("login-msg");
  try { await api("POST", "/api/login", { name: document.getElementById("login-name").value.trim(), password: document.getElementById("pw").value }); await start(); }
  catch (err) { msg.textContent = say(err); msg.hidden = false; }
});

// ---------- Skriver (Niimbot via Bluetooth) ----------
const printer = new Niimbot();
const ps = { source: "", note: "", paper: null, roll: null, battery: null, w: DEFAULT_SIZE[0], h: DEFAULT_SIZE[1], density: B21.densityDefault, busy: false, msg: "", err: "" };
const canBt = () => !!navigator.bluetooth;
printer.onChange = () => { if (!printer.connected) { ps.paper = null; ps.roll = null; ps.battery = null; ps.source = ""; } paintPrinter(); };
const printerBox = () => document.getElementById("printer");
function printerHtml() {
  if (!canBt()) return `<div class="card"><h2>Skriver</h2><p class="muted">Denne nettleseren kan ikke koble til skriveren via Bluetooth. Bruk Chrome på Android, eller Bluefy på iPhone.</p></div>`;
  const sizes = SIZES.map(([w, h]) => `<option value="${w}x${h}"${w === ps.w && h === ps.h ? " selected" : ""}>${w} × ${h} mm</option>`).join("");
  return `<div class="card"><h2>Skriver</h2>
    ${ps.note ? `<p class="muted" role="status">${esc(ps.note)}</p>` : ""}${printer.connected ? `<p class="muted">Tilkoblet${ps.battery != null ? ` · batteri ${ps.battery}` : ""}${ps.paper ? ` · rull ${ps.paper.widthMm} × ${ps.paper.heightMm} mm` : ""}</p>${ps.source ? `<p class="muted">${esc(ps.source)}${ps.roll ? ` Rullens strekkode: ${esc(ps.roll.barCode)}.` : ""}</p>` : ""}` : `<p class="muted">Ikke tilkoblet.</p>`}
    <div class="row">
      ${printer.connected ? `<button class="btn sec" data-act="p-disconnect" type="button">Koble fra</button>` : `<button class="btn" data-act="p-connect" type="button"${ps.busy ? " disabled" : ""}>Koble til skriver</button><button class="btn sec" data-act="p-connect-all" type="button"${ps.busy ? " disabled" : ""}>Vis alle enheter (feilsøking)</button>`}
      <button class="btn sec" data-act="p-test" type="button"${ps.busy ? " disabled" : ""}>Print testetikett</button>
      <label class="grow">Størrelse<select id="p-size">${sizes}</select></label>
    </div>
    ${ps.err ? `<div class="msg err">${esc(ps.err)}</div>` : ""}${ps.msg ? `<div class="msg ok">${esc(ps.msg)}</div>` : ""}</div>`;
}
function paintPrinter() { const b = printerBox(); if (b) b.innerHTML = printerHtml(); }
async function afterConnect() {
  ps.roll = (await printer.readLabel()) || null; ps.battery = await printer.battery(); ps.paper = await printer.readPaper();
  const known = KNOWN_ROLLS[ps.roll?.barCode];
  if (known) {
    // En rull vi har målt går foran skriverens eget svar, som kan være feil for denne rullen.
    [ps.w, ps.h] = known;
    ps.source = ps.paper && (ps.paper.widthMm !== known[0] || ps.paper.heightMm !== known[1]) ? `Rullen er kjent (${known[0]} × ${known[1]} mm). Skriveren oppga ${ps.paper.widthMm} × ${ps.paper.heightMm} mm, men den målte størrelsen brukes.` : "Rullen er kjent, og størrelsen stemmer med skriveren.";
  } else if (ps.paper) { ps.w = ps.paper.widthMm; ps.h = ps.paper.heightMm; ps.source = "Størrelsen er lest fra skriveren."; rememberSize(ps.roll?.barCode, ps.w, ps.h); }
  else {
    const s = rememberedSize(ps.roll?.barCode);
    if (s) [ps.w, ps.h] = s;
    ps.source = !ps.roll ? "Skriveren oppga ikke størrelsen, og fant ingen rull (RFID). Velg størrelsen selv."
      : s ? "Skriveren oppga ikke størrelsen. Størrelsen er husket fra sist. Velg riktig størrelse én gang, så huskes den for denne rullen."
        : "Skriveren oppga ikke størrelsen, og rullen er ikke kjent. Velg størrelsen selv.";
  }
}
async function connectPrinter(all = false) {
  ps.err = ""; ps.msg = ""; ps.busy = true; paintPrinter();
  try { await printer.connect({ all }); await afterConnect(); } catch (e) { ps.err = say(e); }
  ps.busy = false; paintPrinter();
}
// «Frys ned» prøver å koble til en skriver nettleseren allerede kjenner (ingen valgliste). Finnes ingen, eller svarer den ikke,
// står knappen «Koble til skriver» klar.
async function autoConnect() {
  if (!canBt() || printer.connected || ps.busy) return;
  ps.err = ""; ps.msg = ""; ps.note = "Kobler til skriveren …"; ps.busy = true; paintPrinter();
  try {
    await printer.connect({ silent: true });
    await afterConnect();
  } catch (e) {
    ps.note = "";
    // Første gang åpnes ikke valglisten av seg selv: i Bluefy på iPhone kan den ikke lukkes og blokkerer siden. Knappen «Koble til skriver» åpner den.
    if (e?.noKnownDevice) { ps.msg = ""; ps.note = "Trykk «Koble til skriver» for å velge skriveren."; ps.busy = false; return paintPrinter(); }
    if (e?.name === "NotFoundError" || e?.name === "SecurityError") ps.msg = "";
    else ps.err = e?.silentFailed ? "Fant ikke skriveren. Slå den på, og trykk «Koble til skriver»." : say(e);
  }
  ps.note = ""; ps.busy = false; paintPrinter();
}
// Én etikett per pakke, hver med pakkens egen QR-kode. Varer fra før pakkene fantes har ingen pakker og får varens kode.
// Skriver etikett nummer `from` og utover (`count` stk) og returnerer hvor mange appen fikk sendt. Skjermen holdes våken under utskrift:
// sovner telefonen midt i, stopper utskriften (og telleren under viser hvor langt den kom).
async function printLabels(item, count, from = 0) {
  ps.err = ""; ps.msg = "";
  const packs = item.packs || [];
  const total = packs.length || item.qty;
  const n = Math.max(0, Math.min(count, total - from));
  let done = 0, lock = null;
  ps.busy = true; paintPrinter(); paintLabels(item.id);
  try {
    try { lock = (await navigator.wakeLock?.request("screen")) || null; } catch { /* meldes under */ }
    ps.note = lock ? "Skjermen holdes våken mens det skrives ut." : "Nettleseren lot ikke appen holde skjermen våken. Slå av automatisk lås i telefonens innstillinger, eller rør skjermen innimellom.";
    paintPrinter();
    for (let i = 0; i < n; i++) {
      const k = from + i;
      const cv = document.createElement("canvas");
      drawLabel(cv, { title: item.name, sub: placeText(item), url: packs.length ? packUrl(packs[k]) : itemUrl(item.id), wMm: ps.w, hMm: ps.h });
      await printer.print(cv, { density: ps.density, copies: 1, labelType: LABEL_TYPE.gap });
      done++;
      setPrinted(item.id, from + done);
      paintLabels(item.id);
    }
    ps.msg = `Sendte ${done} etikett${done === 1 ? "" : "er"} til skriveren.`;
  } catch (e) { ps.err = `${say(e)} Appen fikk sendt ${done} av ${n}.`; }
  try { await lock?.release(); } catch { /* ingenting å frigi */ }
  ps.note = "";
  ps.busy = false; paintPrinter(); paintLabels(item.id);
  return done;
}
// Hvor mange etiketter som er skrevet ut per vare, husket på denne enheten. Du bekrefter tallet selv (feltet «Skrevet ut»),
// siden appen bare vet hvor mange den sendte, ikke hvor mange som kom ut av skriveren.
const printedKey = (id) => `fk-printed-${id}`;
function getPrinted(id) { try { return Math.max(0, Math.round(Number(localStorage.getItem(printedKey(id)))) || 0); } catch { return 0; } }
function setPrinted(id, n) { try { localStorage.setItem(printedKey(id), String(Math.max(0, n))); } catch { /* uten lagring starter telleren på 0 */ } }
const batchSize = { n: 10 };
// Tekstene som avhenger av «Skrevet ut» og «Skriv ut om gangen». Settes også mens du skriver, uten å tegne kortet på nytt (feltet mister ellers fokus).
function labelsInfo() {
  const it = state.item, total = it.packs.length || it.qty;
  const done = Math.min(getPrinted(it.id), total), left = total - done;
  const next = Math.min(batchSize.n, left);
  return { total, done, left, status: left === 0 ? "Alle etikettene er skrevet ut." : `${left} igjen.`, label: left === 0 ? "Ferdig" : `Skriv ut ${next} (nr. ${done + 1}–${done + next})`, disabled: left === 0 || ps.busy };
}
function updateLabelsInfo() {
  const i = labelsInfo(), st = document.getElementById("l-status"), b = document.getElementById("l-print");
  if (st) st.textContent = i.status;
  if (b) { b.textContent = i.label; b.disabled = i.disabled; }
}
function labelsHtml() {
  const it = state.item, { total, done, status, label, disabled } = labelsInfo();
  return `<div class="card"><h2>Etiketter</h2>
    <p class="muted">${total} etikett${total === 1 ? "" : "er"} til denne varen. Skriv inn hvor mange som faktisk er skrevet ut, så fortsetter utskriften derfra.</p>
    <div class="row">
      <label class="grow">Skrevet ut<input id="l-done" type="number" min="0" max="${total}" inputmode="numeric" value="${done}"></label>
      <label class="grow">Skriv ut om gangen<input id="l-batch" type="number" min="1" max="99" inputmode="numeric" value="${batchSize.n}"></label>
    </div>
    <p class="muted" id="l-status" role="status">${status}</p>
    <button class="btn" id="l-print" data-act="print" type="button"${disabled ? " disabled" : ""}>${label}</button>
    <div class="row"><button class="btn sec" data-act="print-reset" type="button">Start på nytt (0 skrevet ut)</button></div></div>`;
}
function paintLabels(id) { const b = document.getElementById("labels"); if (b && state.item && (id == null || state.item.id === id)) b.innerHTML = labelsHtml(); }
// Én testetikett i valgt størrelse, uten å røre telleren for noen vare.
async function printTest() {
  if (!printer.connected) { ps.err = "Koble til skriveren først."; ps.msg = ""; return paintPrinter(); }
  ps.err = ""; ps.msg = ""; ps.busy = true; paintPrinter();
  try {
    const cv = document.createElement("canvas");
    drawLabel(cv, { title: "Testetikett", sub: `Frysekontroll · ${ps.w} × ${ps.h} mm`, url: appBase(), wMm: ps.w, hMm: ps.h });
    await printer.print(cv, { density: ps.density, copies: 1, labelType: LABEL_TYPE.gap });
    ps.msg = "Sendte en testetikett til skriveren.";
  } catch (e) { ps.err = say(e); }
  ps.busy = false; paintPrinter();
}
// Antall etiketter følger antallet på varen (feltet «Antall pakker» ved ny vare, «Igjen» ved eksisterende).
const copiesNow = (qty) => Math.max(1, Math.min(99, Math.round(Number(qty)) || 1));

// ---------- Bilde ----------
async function fileToJpeg(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, 1000 / Math.max(bmp.width, bmp.height));
  const cv = document.createElement("canvas");
  cv.width = Math.round(bmp.width * scale); cv.height = Math.round(bmp.height * scale);
  cv.getContext("2d").drawImage(bmp, 0, 0, cv.width, cv.height);
  for (const q of [0.8, 0.65, 0.5, 0.4]) { const url = cv.toDataURL("image/jpeg", q); if (url.length < 590_000) return url; }
  throw new Error("photo");
}

// ---------- Visninger ----------
const placeOptions = (sel) => state.places.map((p) => `<option value="${p.id}"${Number(sel) === p.id ? " selected" : ""}>${esc(placeText(p))}</option>`).join("");
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const dateText = (d) => { const [y, m, dd] = d.split("-"); return `${Number(dd)}.${Number(m)}.${y}`; };
// Utløpsdato: «Utløpt» når datoen er passert (en kjent dato, ikke en regel om hvor lenge noe holder).
const expiryChip = (it) => (it.expires ? `<span class="chip ${it.expires < today() ? "late" : "date"}">${it.expires < today() ? "Utløpt " : "Utløper "}${dateText(it.expires)}</span>` : "");
const thumb = (it) => (it.photo ? `<img class="thumb" src="/api/items/${it.id}/photo" alt="" loading="lazy">` : `<div class="thumb none" aria-hidden="true">🧊</div>`);

const packs = (n) => (n === 1 ? "pakke" : "pakker");
// Ett kort per vare: bilde, navn (maks to linjer), sted, utløp og noen få stikkord, og antall som en tydelig brikke til høyre.
function itemCard(it) {
  const more = it.tags.length > 3 ? `<span class="chip more">+${it.tags.length - 3}</span>` : "";
  const meta = `${expiryChip(it)}${it.tags.slice(0, 3).map((t) => `<span class="chip">${esc(t)}</span>`).join("")}${more}`;
  return `<li><a class="item" href="#/v/${it.id}" aria-label="${esc(it.name)}, ${it.qty} ${packs(it.qty)}, ${esc(placeText(it) || "uten sted")}">${thumb(it)}
    <span class="item-main"><b class="item-name">${esc(it.name)}</b><span class="place">${esc(placeText(it) || "Uten sted")}</span>${meta ? `<span class="chips">${meta}</span>` : ""}</span>
    <span class="qty" aria-hidden="true"><b>${it.qty}</b><small>${packs(it.qty)}</small></span></a></li>`;
}
function itemRows(items) {
  if (!items.length) {
    return activeFilters() || state.q
      ? `<div class="empty"><p><b>Ingen varer passer.</b></p><p class="muted">Prøv et annet søk, eller fjern filtrene.</p><button class="btn sec" data-act="f-reset" type="button">Nullstill filter</button></div>`
      : `<div class="empty"><p><b>Fryserne er tomme.</b></p><p class="muted">Ta bilde av det første du fryser ned, så havner det her.</p><a class="btn" href="#/ny">Frys ned</a></div>`;
  }
  const total = items.reduce((n, i) => n + i.qty, 0);
  return `<p class="count muted" role="status">${items.length} ${items.length === 1 ? "vare" : "varer"} · ${total} ${packs(total)}</p><ul class="list">${items.map(itemCard).join("")}</ul>`;
}
const activeFilters = () => [state.place, state.f.freezer, state.f.tags.length, state.f.exp, state.f.by, state.f.from, state.f.to, state.f.multi, state.all, state.sort].filter(Boolean).length;
async function loadList() {
  const box = document.getElementById("results");
  if (!box) return;
  try {
    const f = state.f, p = new URLSearchParams({ q: state.q, today: today() });
    if (state.place) p.set("place", state.place);
    if (f.freezer) p.set("freezer", f.freezer);
    for (const t of f.tags) p.append("tag", t);
    for (const k of ["exp", "by", "from", "to"]) if (f[k]) p.set(k, f[k]);
    if (f.multi) p.set("multi", "1");
    if (state.all) p.set("all", "1");
    if (state.sort) p.set("sort", state.sort);
    box.innerHTML = itemRows((await api("GET", `/api/items?${p}`)).items);
  } catch (e) { if (!(e instanceof NeedLogin)) box.innerHTML = `<div class="msg err">${esc(say(e))}</div>`; }
}
const opt = (value, label, sel) => `<option value="${esc(value)}"${value === sel ? " selected" : ""}>${esc(label)}</option>`;
function filterHtml() {
  const f = state.f, fc = state.facets;
  const placesIn = state.places.filter((p) => !f.freezer || p.freezer === f.freezer);
  return `<div class="row">
      <label class="grow">Fryser<select id="f-freezer">${opt("", "Alle fryserne", f.freezer)}${fc.freezers.map((z) => opt(z, z, f.freezer)).join("")}</select></label>
      <label class="grow">Skuff / sted<select id="f-place">${opt("", "Alle", String(state.place))}${placesIn.map((p) => opt(String(p.id), placeText(p), String(state.place))).join("")}</select></label></div>
    <div><b class="muted">Stikkord</b><div class="chips">${fc.tags.length ? fc.tags.map((t) => `<button type="button" class="chip tag" data-act="f-tag" data-tag="${esc(t.tag)}" aria-pressed="${f.tags.includes(t.tag)}">${esc(t.tag)} ${t.n}</button>`).join("") : '<span class="muted">Ingen ennå</span>'}</div></div>
    <div class="row">
      <label class="grow">Utløp<select id="f-exp">${opt("", "Alle", f.exp)}${opt("expired", "Utløpt", f.exp)}${opt("dated", "Har dato", f.exp)}${opt("undated", "Uten dato", f.exp)}</select></label>
      <label class="grow">Lagt inn av<select id="f-by">${opt("", "Alle", f.by)}${fc.people.map((n) => opt(n || "-", n || "Felles passord", f.by)).join("")}</select></label></div>
    <div class="row">
      <label class="grow">Lagt inn fra<input type="date" id="f-from" value="${esc(f.from)}"></label>
      <label class="grow">Lagt inn til<input type="date" id="f-to" value="${esc(f.to)}"></label></div>
    <div class="row">
      <label class="chk"><input type="checkbox" id="f-multi"${f.multi ? " checked" : ""}> Flere enn én pakke</label>
      <label class="chk"><input type="checkbox" id="f-all"${state.all ? " checked" : ""}> Vis også tomme</label>
      <label class="chk"><input type="checkbox" id="f-sort"${state.sort ? " checked" : ""}> Utløper først</label></div>
    <button class="btn sec" data-act="f-reset" type="button">Nullstill filter</button>`;
}
function paintFilters() {
  const box = document.getElementById("filters-body"), n = activeFilters();
  if (box) box.innerHTML = filterHtml();
  const sum = document.getElementById("filters-sum");
  if (sum) sum.textContent = n ? `Filter (${n} valgt)` : "Filter";
}
async function viewList() {
  app.innerHTML = `<h1>Hva ligger i fryseren?</h1>
    <div class="card search"><label class="sr" for="q">Søk</label><input id="q" type="search" placeholder="Søk: laks, brød, kjøttdeig …" value="${esc(state.q)}" autocomplete="off"></div>
    <details class="card" id="filters"${activeFilters() ? " open" : ""}><summary><b id="filters-sum">Filter</b></summary><div id="filters-body" class="filters"></div></details>
    <div id="results"><p class="muted">Laster …</p></div>`;
  paintFilters();
  loadList();
  try { state.facets = await api("GET", "/api/facets"); paintFilters(); } catch (e) { if (e instanceof NeedLogin) return; }
}

function newState() { return { photo: "", name: "", desc: "", tags: "", qty: 1, expires: "", placeId: state.places[0]?.id || "", msg: "", err: "", busy: false }; }
function viewNew() {
  const n = (state.nw ||= newState());
  app.innerHTML = `<h1>Frys ned</h1>
    <div class="card"><h2>1. Bilde</h2>
      ${n.photo ? `<img class="hero" src="${n.photo}" alt="Bilde av varen">` : `<p class="muted">Ta bilde av varen, så foreslår jeg navn og søkeord.</p>`}
      <label class="btn big pickbtn">${n.photo ? "Ta nytt bilde" : "Ta bilde"}<input id="photo" type="file" accept="image/*" capture="environment" class="sr"></label>
      ${n.msg ? `<div class="msg">${esc(n.msg)}</div>` : ""}</div>
    <div class="card"><h2>2. Hva er det?</h2>
      <label>Navn<input id="n-name" value="${esc(n.name)}" maxlength="80" autocomplete="off"></label>
      <label>Beskrivelse<textarea id="n-desc" maxlength="240">${esc(n.desc)}</textarea></label>
      <label>Stikkord (skilt med komma)<input id="n-tags" value="${esc(n.tags)}" autocomplete="off"></label>
      <label>Best før / utløper (valgfritt)<input id="n-expires" type="date" value="${esc(n.expires)}"></label></div>
    <div class="card"><h2>3. Hvor mange og hvor?</h2>
      <div class="row"><label class="grow">Antall pakker<input id="n-qty" type="number" min="1" max="99" inputmode="numeric" value="${n.qty}"></label>
      <label class="grow">Plassering<select id="n-place">${placeOptions(n.placeId)}</select></label></div>
      <p class="muted">Sted og skuffer legges til under <a href="#/steder">Steder</a>.</p></div>
    <div id="printer">${printerHtml()}</div>
    ${n.err ? `<div class="msg err">${esc(n.err)}</div>` : ""}
    <button class="btn big" data-act="save-print" type="button"${n.busy ? " disabled" : ""}>Lagre og skriv ut etiketter</button>
    <button class="btn sec" data-act="save" type="button"${n.busy ? " disabled" : ""}>Lagre uten å skrive ut</button>`;
}
async function saveNew(print) {
  const n = state.nw;
  n.err = "";
  const body = { expires: n.expires || undefined, name: n.name, desc: n.desc, tags: n.tags, qty: n.qty, placeId: Number(n.placeId), photo: n.photo || undefined };
  if (print && !printer.connected) { n.err = "Koble til skriveren først, eller velg «Lagre uten å skrive ut»."; return viewNew(); }
  n.busy = true; viewNew();
  try {
    const { item } = await api("POST", "/api/items", body);
    const copies = print ? copiesNow(n.qty) : 0;
    state.nw = null;
    location.hash = `#/v/${item.id}`;
    if (copies) await printLabels({ ...item, photo: !!n.photo }, copies);
  } catch (e) { if (e instanceof NeedLogin) return; n.busy = false; n.err = say(e); viewNew(); }
}
async function onPhoto(file) {
  const n = state.nw;
  n.msg = ""; n.err = "";
  try { n.photo = await fileToJpeg(file); } catch { n.err = ERR.photo; return viewNew(); }
  n.msg = state.vision ? "Tolker bildet …" : "";
  viewNew();
  if (!state.vision) return;
  try {
    const r = await api("POST", "/api/vision", { photo: n.photo });
    n.name = r.name; n.desc = r.desc; n.tags = r.tags.join(", "); if (r.expires) n.expires = r.expires; n.msg = "Forslag fra bildet. Rett det som ikke stemmer.";
  } catch (e) { if (e instanceof NeedLogin) return; n.msg = say(e); }
  if (location.hash === "#/ny") viewNew();
}

async function viewItem(id) {
  app.innerHTML = `<p class="muted">Laster …</p>`;
  let item;
  try { item = (await api("GET", `/api/items/${id}`)).item; } catch (e) { if (e instanceof NeedLogin) return; app.innerHTML = `<div class="msg err">${e.status === 404 ? "Fant ikke varen." : esc(say(e))}</div><a href="#/">Til varelisten</a>`; return; }
  state.item = item;
  paintItem();
}
function paintItem(msg = "") {
  const it = state.item;
  app.innerHTML = `<a href="#/">← Alle varer</a>
    ${it.photo ? `<img class="hero" src="/api/items/${it.id}/photo" alt="Bilde av ${esc(it.name)}">` : ""}
    <div class="card"><h1>${esc(it.name)}</h1>
      ${it.desc ? `<p>${esc(it.desc)}</p>` : ""}
      <div class="place">${esc(placeText(it) || "Uten sted")}</div>
      <div class="chips">${expiryChip(it)}${it.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join("")}</div></div>
    <div class="card"><div class="stock"><div><b>Igjen</b><div class="muted">${it.qty === 0 ? "Tom" : it.qty === 1 ? "pakke" : "pakker"}</div></div><div class="qty" id="qty">${it.qty}</div></div>
      ${msg ? `<div class="msg ok" role="status">${esc(msg)}</div>` : ""}
      <button class="btn big" data-act="take" type="button"${it.qty < 1 ? " disabled" : ""}>Ta ut 1</button>
      <div class="row"><button class="btn sec" data-act="add" type="button">Legg tilbake 1</button></div></div>
    <div id="printer">${printerHtml()}</div>
    <div id="labels">${labelsHtml()}</div>
    <p class="muted">${it.packs.length ? `${it.packs.length} pakke${it.packs.length === 1 ? "" : "r"} med egen kode ligger i fryseren.` : "Denne varen er lagt inn før hver pakke fikk egen kode: etiketten bruker varens kode."}</p>
    <div id="history" class="card"><h2>Historikk</h2><p class="muted">Laster …</p></div>
    <details class="card"><summary><b>Endre</b></summary>
      <label>Navn<input id="e-name" value="${esc(it.name)}" maxlength="80"></label>
      <label>Beskrivelse<textarea id="e-desc" maxlength="240">${esc(it.desc)}</textarea></label>
      <label>Stikkord<input id="e-tags" value="${esc(it.tags.join(", "))}"></label>
      <label>Best før / utløper<input id="e-expires" type="date" value="${esc(it.expires)}"></label>
      <label>Plassering<select id="e-place">${placeOptions(it.placeId)}</select></label>
      <button class="btn" data-act="edit" type="button">Lagre endringer</button>
      <button class="btn bad" data-act="delete" type="button">Slett varen</button></details>`;
  loadHistory(); // historikken hentes på nytt etter hver endring
}
const MOVE = { new: "Lagt inn", add: "Lagt inn", take: "Tatt ut", undo: "Lagt tilbake" };
async function loadHistory() {
  const box = document.getElementById("history");
  if (!box || !state.item) return;
  try {
    const { moves } = await api("GET", `/api/items/${state.item.id}/moves`);
    box.innerHTML = `<h2>Historikk</h2>${moves.length ? `<ul class="list">${moves.map((m) => `<li class="muted">${esc(new Date(m.ts).toLocaleString("nb-NO", { dateStyle: "short", timeStyle: "short" }))} · ${esc(MOVE[m.kind] || m.kind)} ${Math.abs(m.delta)}${m.actor ? ` · ${esc(m.actor)}` : ""}</li>`).join("")}</ul>` : '<p class="muted">Ingen endringer ennå.</p>'}`;
  } catch (e) { if (!(e instanceof NeedLogin)) box.innerHTML = ""; }
}
async function changeStock(kind) {
  try { const { item } = await api("POST", `/api/items/${state.item.id}/${kind}`, { n: 1 }); item.photo = state.item.photo; state.item = item;
    paintItem(kind === "take" ? (item.qty === 0 ? "Tatt ut. Nå er det tomt." : `Tatt ut 1. Det er ${item.qty} igjen.`) : `Lagt tilbake. Det er ${item.qty} igjen.`); }
  catch (e) { if (!(e instanceof NeedLogin)) paintItem(say(e)); }
}

async function viewPack(id, msg = "") {
  let data;
  try { data = await api("GET", `/api/packs/${id}`); } catch (e) { if (e instanceof NeedLogin) return; app.innerHTML = `<div class="msg err">${e.status === 404 ? "Fant ikke pakken. Koden kan høre til en vare som er slettet." : esc(say(e))}</div><a href="#/">Til varelisten</a>`; return; }
  const it = data.item, taken = data.pack.taken;
  app.innerHTML = `<a href="#/">← Alle varer</a>
    ${it.photo ? `<img class="hero" src="/api/items/${it.id}/photo" alt="Bilde av ${esc(it.name)}">` : ""}
    <div class="card"><h1>${esc(it.name)}</h1><div class="place">${esc(placeText(it) || "Uten sted")}</div><div class="chips">${expiryChip(it)}</div>
      <div class="stock"><div><b>Igjen i fryseren</b><div class="muted">av denne varen</div></div><div class="qty">${it.qty}</div></div>
      ${msg ? `<div class="msg ok" role="status">${esc(msg)}</div>` : ""}
      ${taken ? `<div class="msg">Denne pakken ble tatt ut ${esc(new Date(taken).toLocaleString("nb-NO", { dateStyle: "short", timeStyle: "short" }))}.</div><button class="btn sec" data-act="pack-undo" data-id="${id}" type="button">Legg tilbake i fryseren</button>`
        : `<button class="btn big" data-act="pack-take" data-id="${id}" type="button">Ta ut denne pakken</button>`}
      <a href="#/v/${it.id}">Se hele varen</a></div>`;
}

async function viewFamily(msg = "", ok = false) {
  let data;
  try { data = await api("GET", "/api/users"); } catch (e) { if (e instanceof NeedLogin) return; return; }
  state.me = data.me;
  app.innerHTML = `<h1>Familie</h1><p class="muted">${state.me ? `Du er innlogget som ${esc(state.me)}.` : "Du er innlogget med det felles passordet."} Med eget navn og passord ser familien hvem som tok ut hva. Det felles passordet virker fortsatt.</p>
    <div class="card"><h2>Medlemmer</h2>${data.users.length ? data.users.map((n) => `<div class="row"><span class="grow">${esc(n)}</span><button class="btn sec" data-act="del-user" data-id="${esc(n)}" type="button">Fjern</button></div>`).join("") : '<p class="muted">Ingen ennå.</p>'}</div>
    <form class="card" id="user-form"><h2>Legg til, eller bytt passord</h2>
      <label>Navn<input id="u-name" maxlength="30" autocomplete="off" required></label>
      <label>Passord (minst 8 tegn)<input id="u-pw" type="password" minlength="8" maxlength="200" autocomplete="new-password" required></label>
      ${msg ? `<div class="msg ${ok ? "ok" : "err"}">${esc(msg)}</div>` : ""}<button class="btn" type="submit">Lagre</button></form>
    <div class="card"><h2>Logg ut</h2><p class="muted">Logger ut denne enheten og fjerner passordopplåsingen. Neste gang må du logge inn og skrive passordet på nytt for å endre varer som er lagt inn fra andre enheter.</p><button class="btn sec" data-act="logout" type="button">Logg ut</button></div>`;
}

async function viewPlaces(msg = "") {
  try { state.places = (await api("GET", "/api/places")).places; } catch (e) { if (e instanceof NeedLogin) return; }
  const groups = {};
  for (const p of state.places) (groups[p.freezer] ||= []).push(p);
  app.innerHTML = `<h1>Steder</h1><p class="muted">Fryserne og skuffene du kan legge varer i.</p>
    ${Object.entries(groups).map(([f, list]) => `<div class="card"><h2>${esc(f)}</h2>${list.map((p) => `<div class="row"><span class="grow">${esc(p.drawer || "Hele fryseren")}</span>
      <button class="btn sec" data-act="del-place" data-id="${p.id}" type="button">Fjern</button></div>`).join("")}</div>`).join("")}
    <form class="card" id="place-form"><h2>Legg til</h2>
      <label>Fryser<input id="pl-freezer" list="freezers" maxlength="40" required><datalist id="freezers">${Object.keys(groups).map((f) => `<option value="${esc(f)}">`).join("")}</datalist></label>
      <label>Skuff (valgfritt)<input id="pl-drawer" maxlength="40" placeholder="Skuff 1"></label>
      ${msg ? `<div class="msg err">${esc(msg)}</div>` : ""}<button class="btn" type="submit">Legg til</button></form>`;
}

// ---------- Hendelser ----------
let timer;
app.addEventListener("input", (e) => {
  const t = e.target, n = state.nw;
  if (t.id === "q") { state.q = t.value; clearTimeout(timer); timer = setTimeout(loadList, 250); }
  else if (n && t.id === "n-name") n.name = t.value;
  else if (n && t.id === "n-desc") n.desc = t.value;
  else if (n && t.id === "n-tags") n.tags = t.value;
  else if (n && t.id === "n-expires") n.expires = t.value;
  else if (t.id === "l-done" && state.item) { const tot = state.item.packs.length || state.item.qty; setPrinted(state.item.id, Math.min(tot, Math.max(0, Math.round(Number(t.value)) || 0))); updateLabelsInfo(); }
  else if (t.id === "l-batch") { batchSize.n = Math.max(1, Math.min(99, Math.round(Number(t.value)) || 1)); updateLabelsInfo(); }
  else if (n && t.id === "n-qty") { n.qty = Math.max(1, Math.min(99, Math.round(Number(t.value)) || 1)); }
});
app.addEventListener("change", (e) => {
  const t = e.target, n = state.nw;
  if (t.id === "f-freezer") { state.f.freezer = t.value; if (state.place && !state.places.some((p) => String(p.id) === String(state.place) && (!t.value || p.freezer === t.value))) state.place = ""; paintFilters(); loadList(); }
  else if (t.id === "f-place") { state.place = t.value; paintFilters(); loadList(); }
  else if (["f-exp", "f-by", "f-from", "f-to"].includes(t.id)) { state.f[t.id.slice(2)] = t.value; paintFilters(); loadList(); }
  else if (t.id === "f-multi") { state.f.multi = t.checked; paintFilters(); loadList(); }
  else if (t.id === "f-all") { state.all = t.checked; paintFilters(); loadList(); }
  else if (t.id === "f-sort") { state.sort = t.checked ? "expires" : ""; paintFilters(); loadList(); }
  else if (t.id === "photo" && t.files[0]) onPhoto(t.files[0]);
  else if (n && t.id === "n-place") n.placeId = t.value;
  else if (t.id === "p-size") { const [w, h] = t.value.split("x").map(Number); ps.w = w; ps.h = h; rememberSize(ps.roll?.barCode, w, h); }
});
let armed = null;
const twoStep = (btn, label) => { if (armed === btn.dataset.act + (btn.dataset.id || "")) return true; armed = btn.dataset.act + (btn.dataset.id || ""); const old = btn.textContent; btn.textContent = label; setTimeout(() => { armed = null; if (btn.isConnected) btn.textContent = old; }, 4000); return false; };
app.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const act = b.dataset.act;
  if (act === "f-tag") { const t = b.dataset.tag, i = state.f.tags.indexOf(t); if (i >= 0) state.f.tags.splice(i, 1); else state.f.tags.push(t); paintFilters(); return loadList(); }
  if (act === "f-reset") { state.place = ""; state.all = false; state.sort = ""; state.f = { freezer: "", tags: [], exp: "", by: "", from: "", to: "", multi: false }; paintFilters(); return loadList(); }
  if (act === "logout") { try { await api("POST", "/api/logout"); } catch { /* uansett utlogget lokalt */ } if (printer.connected) printer.disconnect(); return showLogin(); }
  if (act === "p-connect") return connectPrinter();
  if (act === "p-connect-all") return connectPrinter(true);
  if (act === "p-test") return printTest();
  if (act === "p-disconnect") return printer.disconnect();
  if (act === "save") return saveNew(false);
  if (act === "save-print") return saveNew(true);
  if (act === "take" || act === "add") return changeStock(act);
  if (act === "print") {
    if (!printer.connected) { ps.err = "Koble til skriveren først."; return paintPrinter(); }
    const it = state.item, total = it.packs.length || it.qty, from = Math.min(getPrinted(it.id), total);
    return printLabels(it, batchSize.n, from);
  }
  if (act === "print-reset") { setPrinted(state.item.id, 0); return paintLabels(); }
  if (act === "edit") {
    try { const { item } = await api("PATCH", `/api/items/${state.item.id}`, { name: document.getElementById("e-name").value, desc: document.getElementById("e-desc").value, tags: document.getElementById("e-tags").value, expires: document.getElementById("e-expires").value, placeId: Number(document.getElementById("e-place").value) });
      item.photo = state.item.photo; state.item = item; paintItem("Endringene er lagret."); } catch (err) { if (!(err instanceof NeedLogin)) paintItem(say(err)); }
    return;
  }
  if (act === "delete") {
    if (!twoStep(b, "Trykk igjen for å slette")) return;
    try { await api("DELETE", `/api/items/${state.item.id}`); location.hash = "#/"; } catch (err) { if (!(err instanceof NeedLogin)) paintItem(say(err)); }
    return;
  }
  if (act === "pack-take" || act === "pack-undo") {
    try { await api("POST", `/api/packs/${b.dataset.id}/${act === "pack-take" ? "take" : "undo"}`); viewPack(b.dataset.id, act === "pack-take" ? "Tatt ut. Pakken er telt ned." : "Lagt tilbake."); }
    catch (err) { if (!(err instanceof NeedLogin)) viewPack(b.dataset.id, say(err)); }
    return;
  }
  if (act === "del-user") {
    if (!twoStep(b, "Trykk igjen")) return;
    try { await api("DELETE", `/api/users/${encodeURIComponent(b.dataset.id)}`); viewFamily("Fjernet.", true); } catch (err) { if (!(err instanceof NeedLogin)) viewFamily(say(err)); }
    return;
  }
  if (act === "del-place") {
    if (!twoStep(b, "Trykk igjen")) return;
    try { await api("DELETE", `/api/places/${b.dataset.id}`); viewPlaces(); } catch (err) { if (!(err instanceof NeedLogin)) viewPlaces(say(err)); }
  }
});
app.addEventListener("submit", async (e) => {
  if (e.target.id === "user-form") {
    e.preventDefault();
    try { await api("POST", "/api/users", { name: document.getElementById("u-name").value, password: document.getElementById("u-pw").value }); viewFamily("Lagret.", true); }
    catch (err) { if (!(err instanceof NeedLogin)) viewFamily(say(err)); }
    return;
  }
  if (e.target.id !== "place-form") return;
  e.preventDefault();
  try { await api("POST", "/api/places", { freezer: document.getElementById("pl-freezer").value, drawer: document.getElementById("pl-drawer").value }); viewPlaces(); }
  catch (err) { if (!(err instanceof NeedLogin)) viewPlaces(say(err)); }
});
// Bilder som ikke lar seg hente (slettet eller utløpt økt) byttes ut med en nøytral rute.
app.addEventListener("error", (e) => { const t = e.target; if (t.tagName === "IMG" && t.classList.contains("thumb")) { const d = document.createElement("div"); d.className = "thumb none"; d.textContent = "🧊"; t.replaceWith(d); } }, true);

// ---------- Ruting ----------
async function route() {
  const h = location.hash || "#/";
  nav.querySelectorAll("a").forEach((a) => (a.getAttribute("href") === h || (h.startsWith("#/v/") && a.dataset.nav === "liste") ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
  const m = /^#\/v\/([a-z2-9]{8})$/.exec(h);
  if (m) return viewItem(m[1]);
  const p = /^#\/p\/([a-z2-9]{8})$/.exec(h);
  if (p) return viewPack(p[1]);
  if (h === "#/familie") return lokal ? lokal.viewBackup(app) : viewFamily();
  if (h === "#/ny") { viewNew(); autoConnect(); return; }
  if (h === "#/steder") return viewPlaces();
  return viewList();
}
window.addEventListener("hashchange", route);

async function start() {
  try {
    const me = await api("GET", "/api/me");
    state.vision = !!me.vision;
    state.places = (await api("GET", "/api/places")).places;
  } catch (e) { if (e instanceof NeedLogin) return; app.innerHTML = `<div class="msg err">${esc(say(e))}</div>`; return; }
  nav.hidden = false;
  route();
}
start();
