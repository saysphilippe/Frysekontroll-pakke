// Rene hjelpefunksjoner for Workeren: rensing av tekst, øktbevis (HMAC) og tolking av svaret fra bildetolkingen.
const enc = new TextEncoder();

export const clip = (v, n) => String(v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

// Stikkord: små bokstaver, unike, maks 12 stykker à 24 tegn. Tar imot liste eller komma-/mellomromsskilt tekst.
export function cleanTags(v) {
  const list = Array.isArray(v) ? v : String(v ?? "").split(/[,;\n]+/);
  const out = [];
  for (const t of list) {
    const s = clip(t, 24).toLowerCase();
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= 12) break;
  }
  return out;
}

export const searchText = (name, descr, tags) => `${name} ${descr} ${tags}`.toLowerCase();

// Kort id uten tegn som ligner hverandre; står i QR-koden.
export function makeId() {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

export const isId = (s) => /^[a-z2-9]{8}$/.test(String(s || ""));

// ---------- Økt ----------
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function hmac(secret, text) {
  const key = await crypto.subtle.importKey("raw", enc.encode(`frysekontroll|${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", key, enc.encode(text)));
}
// Samme tid uavhengig av hvor mange tegn som stemmer.
export function sameText(a, b) {
  const x = enc.encode(String(a)), y = enc.encode(String(b));
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] || 0) ^ (y[i] || 0);
  return d === 0;
}
export async function passwordOk(given, secret) {
  if (!secret) return false;
  // Sammenlignes som sammendrag, så lengden på passordet ikke lekker.
  return sameText(await hmac(secret, `pw|${given}`), await hmac(secret, `pw|${secret}`));
}
export const SESSION_DAYS = 30;
export async function makeSession(secret, now = Date.now()) {
  const exp = Math.floor(now / 1000) + SESSION_DAYS * 86400;
  return `v1.${exp}.${await hmac(secret, `sess|${exp}`)}`;
}
export async function sessionOk(token, secret, now = Date.now()) {
  const m = /^v1\.(\d{1,12})\.([A-Za-z0-9_-]{20,64})$/.exec(String(token || ""));
  if (!m || !secret) return false;
  if (Number(m[1]) < Math.floor(now / 1000)) return false;
  return sameText(await hmac(secret, `sess|${m[1]}`), m[2]);
}
export const cookieOf = (header, name) => {
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
};

// ---------- Bildetolking ----------
// Svaret fra modellen er data, ikke instruksjoner: bare tre felt, rensede og kortet ned.
export function parseVision(text) {
  const m = /\{[\s\S]*\}/.exec(String(text || ""));
  if (!m) return null;
  let o;
  try { o = JSON.parse(m[0]); } catch { return null; }
  if (!o || typeof o !== "object") return null;
  const name = clip(o.name, 80);
  if (!name) return null;
  return { name, desc: clip(o.desc, 240), tags: cleanTags(o.tags), expires: validDate(o.expires) };
}

export const PHOTO_RE = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/;
export const PHOTO_MAX = 600_000; // tegn base64 (omtrent 450 kB)
export function photoOf(dataUrl) {
  const m = PHOTO_RE.exec(String(dataUrl || ""));
  return m && m[1].length <= PHOTO_MAX ? m[1] : null;
}

// ---------- Dato, navn og personlige passord ----------
// Gyldig kalenderdato som YYYY-MM-DD, ellers tom tekst.
export function validDate(v) {
  const s = String(v ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "";
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : "";
}
export const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,29}$/u;
export const cleanName = (v) => { const s = clip(v, 30); return NAME_RE.test(s) ? s : ""; };
export const PASSWORD_MIN = 8;

const toB64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = (s) => Uint8Array.from(atob(String(s).replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
// PBKDF2 med 100 000 runder (tak i Workers). Saltet er tilfeldig per bruker.
export async function hashPassword(password, saltB64) {
  const salt = saltB64 ? fromB64u(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100_000 }, key, 256);
  return { salt: toB64u(salt), hash: toB64u(new Uint8Array(bits)) };
}
export async function userPasswordOk(password, row) {
  if (!row) { await hashPassword(String(password), toB64u(new Uint8Array(16))); return false; } // samme arbeid enten brukeren finnes eller ikke
  return sameText((await hashPassword(String(password), row.salt)).hash, row.hash);
}

// Økt med navn (v2): navnet er med i signaturen, så det ikke kan byttes. Tom tekst = felles passord.
export async function makeUserSession(secret, name = "", now = Date.now()) {
  const exp = Math.floor(now / 1000) + SESSION_DAYS * 86400;
  const n = toB64u(enc.encode(name));
  return `v2.${exp}.${n}.${await hmac(secret, `sess2|${exp}|${n}`)}`;
}
// Gir { name } for en gyldig økt (v1 eller v2), ellers null.
export async function sessionUser(token, secret, now = Date.now()) {
  if (!secret) return null;
  const t = String(token || "");
  const v2 = /^v2\.(\d{1,12})\.([A-Za-z0-9_-]{0,80})\.([A-Za-z0-9_-]{20,64})$/.exec(t);
  if (v2) {
    if (Number(v2[1]) < Math.floor(now / 1000) || !sameText(await hmac(secret, `sess2|${v2[1]}|${v2[2]}`), v2[3])) return null;
    try { return { name: new TextDecoder().decode(fromB64u(v2[2])) }; } catch { return null; }
  }
  return (await sessionOk(t, secret, now)) ? { name: "" } : null;
}

// ---------- Enhet og opplåsing ----------
// Hver enhet har en tilfeldig kode (32 hex-tegn) som nettleseren lagrer og sender med. Serveren lagrer bare en nøklet hash av den.
// Varen husker enheten som la den inn. En annen enhet må skrive passordet på nytt (opplåsing) før den kan endre varen.
export const deviceHash = async (secret, id) => (/^[a-f0-9]{32}$/.test(String(id || "")) && secret ? await hmac(secret, `dev|${id}`) : "");
// Opplåsingsbeviset gjelder én enhet og ett navn, og varer like lenge som en økt.
export async function makeUnlock(secret, name, dev, now = Date.now()) {
  const exp = Math.floor(now / 1000) + SESSION_DAYS * 86400;
  return `u1.${exp}.${await hmac(secret, `unlock|${exp}|${name}|${dev}`)}`;
}
export async function unlockOk(token, secret, name, dev, now = Date.now()) {
  const m = /^u1\.(\d{1,12})\.([A-Za-z0-9_-]{20,64})$/.exec(String(token || ""));
  if (!m || !dev || !secret || Number(m[1]) < Math.floor(now / 1000)) return false;
  return sameText(await hmac(secret, `unlock|${m[1]}|${name}|${dev}`), m[2]);
}
