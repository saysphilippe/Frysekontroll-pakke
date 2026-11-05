// Etiketter til Niimbot B21: QR-kode til venstre, navn og plassering til høyre. BLE-protokollen ligger i niimbot.js.
import { B21, PX_PER_MM } from "./niimbot.js";

export const SIZES = [[50, 30], [50, 25], [50, 15], [40, 30], [40, 20], [30, 20], [30, 15], [25, 15]];
export const DEFAULT_SIZE = [40, 30];

const store = {
  get: (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* lagring kan være blokkert */ } },
};
// Ruller vi har målt på strekkoden fra RFID-brikken. Skriveren oppgir ikke alltid størrelsen selv.
export const KNOWN_ROLLS = { "6971501227743": [40, 20] };
// Størrelsen på rullen husker vi per rull (strekkoden fra RFID-brikken), ellers siste valgte størrelse.
const rollKey = (barCode) => `fk.rull.${barCode || "siste"}`;
export function rememberedSize(barCode) {
  if (KNOWN_ROLLS[barCode]) return KNOWN_ROLLS[barCode];
  const m = /^(\d+)x(\d+)$/.exec(store.get(rollKey(barCode)) || store.get(rollKey("")));
  return m ? [Number(m[1]), Number(m[2])] : null;
}
export function rememberSize(barCode, wMm, hMm) {
  store.set(rollKey(barCode), `${wMm}x${hMm}`);
  store.set(rollKey(""), `${wMm}x${hMm}`);
}

// Adressen til mappen appen ligger i (på GitHub Pages ligger den under /<repo>/, ikke i roten).
export const appBase = () => new URL(".", location.href).href;
export const itemUrl = (id, base = appBase()) => `${base}#/v/${id}`;
// Hver pakke har egen kode: skanningen åpner akkurat denne pakken, og den kan bare tas ut én gang.
export const packUrl = (id, base = appBase()) => `${base}#/p/${id}`;
export const placeText = (p) => (p.freezer ? (p.drawer ? `${p.freezer} · ${p.drawer}` : p.freezer) : "");

function qrMatrix(text) {
  const qr = globalThis.qrcode(0, "L");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  return { n, dark: (r, c) => qr.isDark(r, c) };
}

function fitLines(ctx, text, maxW, size, maxLines) {
  for (let s = size; s >= 12; s -= 2) {
    ctx.font = `700 ${s}px sans-serif`;
    const words = text.split(/\s+/).filter(Boolean), lines = [];
    let cur = "";
    for (const w of words) {
      const t = cur ? `${cur} ${w}` : w;
      if (ctx.measureText(t).width <= maxW || !cur) cur = t; else { lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    if (lines.length <= maxLines && lines.every((l) => ctx.measureText(l).width <= maxW)) return { lines, size: s };
  }
  ctx.font = "700 12px sans-serif";
  return { lines: [text.slice(0, 18)], size: 12 };
}

// Tegner etiketten svart på hvitt. Bredden (wMm) går på tvers av skrivehodet og kappes til 48 mm.
export function drawLabel(canvas, { title, sub, url, wMm, hMm }) {
  const w = Math.min(B21.headPx, Math.round(wMm * PX_PER_MM)), h = Math.round(hMm * PX_PER_MM);
  canvas.width = w; canvas.height = h;
  const c = canvas.getContext("2d");
  c.fillStyle = "white"; c.fillRect(0, 0, w, h);
  c.fillStyle = "black"; c.textBaseline = "top";
  const pad = 8, qrSide = Math.min(h - pad * 2, Math.floor(w * 0.58));
  const { n, dark } = qrMatrix(url);
  const cell = Math.max(1, Math.floor(qrSide / (n + 4))); // 2 moduler stille sone på hver side
  const off = Math.floor((h - cell * (n + 4)) / 2) + cell * 2;
  for (let r = 0; r < n; r++) for (let q = 0; q < n; q++) if (dark(r, q)) c.fillRect(pad + cell * 2 + q * cell, off + r * cell, cell, cell);
  const tx = pad + cell * (n + 4) + 6, tw = w - tx - pad;
  if (tw < 40) return canvas; // for smal etikett til tekst ved siden av koden
  const { lines, size } = fitLines(c, title.slice(0, 80), tw, Math.floor(h / 5), sub ? 3 : 4);
  const line = Math.round(size * 1.15), subSize = Math.max(14, Math.floor(size * 0.8));
  const blockH = lines.length * line + (sub ? subSize + 6 : 0);
  let y = Math.max(pad, Math.floor((h - blockH) / 2));
  const cx = tx + tw / 2;
  c.textAlign = "center";
  c.font = `700 ${size}px sans-serif`;
  for (const l of lines) { c.fillText(l, cx, y); y += line; }
  if (sub) {
    c.font = `600 ${subSize}px sans-serif`;
    c.fillText(sub.slice(0, 24), cx, y + 6);
  }
  c.textAlign = "start";
  return canvas;
}
