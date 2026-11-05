// Niimbot B21: protokoll over Bluetooth LE (Web Bluetooth). Pakkeformatet og utskriftsflyten
// følger den åpne dokumentasjonen i niimbluelib (MultiMote, MIT): 55 55 <kommando> <lengde> <data> <xor> AA AA.
// Ren logikk (pakker, bitmap, RFID) er eksportert og testes i tests/niimbot.test.mjs; BLE-delen trenger en nettleser.

export const SERVICE = "e7810a71-73ae-499d-8c15-faa9aef0c3f2";
const TX = { connect: 0xc1, printerInfo: 0x40, rfidInfo: 0x1a, paperInfo: 0x59, setDensity: 0x21, setLabelType: 0x23, printStart: 0x01, printClear: 0x20, printQuantity: 0x15, printStatus: 0xa3, printEnd: 0xf3, pageStart: 0x03, pageEnd: 0xe3, setPageSize: 0x13, bitmapRow: 0x85, bitmapRowIndexed: 0x83, emptyRow: 0x84, checkLine: 0x86, heartbeat: 0xdc };
// Svarkode for hver forespørsel (commandsMap i niimbluelib). Bare de vi bruker.
const RX = { 0xc1: [0xc2], 0x40: [0x41, 0x42, 0x43, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x4b, 0x4c, 0x4d, 0x4e, 0x4f], 0x1a: [0x1b], 0x20: [0x30], 0x15: [0x16], 0xa3: [0xb3], 0x59: [0x69], 0x21: [0x31], 0x23: [0x33], 0x01: [0x02], 0xf3: [0xf4], 0x03: [0x04], 0xe3: [0xe4], 0x13: [0x14], 0xdc: [0xdd, 0xde, 0xdf, 0xd9] };
const ONE_WAY = new Set([TX.bitmapRow, TX.bitmapRowIndexed, TX.emptyRow]);

// Det vi vet om B21 (id 768 i niimbluelib): 203 dpi, skrivehode 384 piksler (48 mm), tetthet 1–5.
export const B21 = { dpi: 203, headPx: 384, densityMin: 1, densityMax: 5, densityDefault: 3 };
export const PX_PER_MM = B21.dpi / 25.4;
// B21S: referansen bruker d110-flyten, men den skriver to like etiketter (4-byte sidestørrelse). b1-flyten (6-byte størrelse med antall) gir én, målt 31.10.2026.
// Modell-ID fra skriveren (printer_models.ts i niimbluelib) og utskriftsflyten hver modell bruker.
export const MODELS = { 768: ["B21", "b21"], 769: ["B21-L2B", "l2b"], 771: ["B21-C2B", "b1"], 775: ["B21-C2B", "b1"], 776: ["B21S-C2B", "b1"], 777: ["B21S", "b1"], 785: ["B21 Pro", "v4"] };
export const LABEL_TYPE = { gap: 1, black: 2, continuous: 3, transparent: 5 };

export const u16 = (n) => [(n >> 8) & 0xff, n & 0xff];

export function packet(cmd, data = []) {
  const d = Uint8Array.from(data);
  let sum = cmd ^ d.length;
  for (const b of d) sum ^= b;
  const out = new Uint8Array(d.length + 7);
  out.set([0x55, 0x55, cmd, d.length], 0);
  out.set(d, 4);
  out.set([sum, 0xaa, 0xaa], 4 + d.length);
  return cmd === TX.connect ? Uint8Array.from([3, ...out]) : out; // Connect har ekstra 0x03 først
}

// Leser én pakke; kaster ved feil format eller sjekksum.
export function parsePacket(buf) {
  if (buf.length < 7 || buf[0] !== 0x55 || buf[1] !== 0x55) throw new Error("Ugyldig pakke");
  const len = buf[3];
  if (buf.length !== len + 7) throw new Error("Ugyldig pakkelengde");
  if (buf[len + 5] !== 0xaa || buf[len + 6] !== 0xaa) throw new Error("Ugyldig pakkeslutt");
  const data = buf.slice(4, 4 + len);
  let sum = buf[2] ^ len;
  for (const b of data) sum ^= b;
  if (sum !== buf[4 + len]) throw new Error("Feil sjekksum");
  return { cmd: buf[2], data };
}

// Splitter en samling mottatte byte i hele pakker (printeren kan sende flere i ett varsel, eller halve).
export function splitPackets(buf) {
  const out = [];
  let i = 0;
  while (i + 7 <= buf.length) {
    if (buf[i] !== 0x55 || buf[i + 1] !== 0x55) { i++; continue; }
    const end = i + buf[i + 3] + 7;
    if (end > buf.length) break;
    out.push(buf.slice(i, end));
    i = end;
  }
  return { packets: out, rest: buf.slice(i) };
}

const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

// Etikettrullens RFID-brikke: det Niimbot-appen bruker for å kjenne igjen rullen.
export function parseRfid(data) {
  const info = { tagPresent: false, uuid: "", barCode: "", serialNumber: "", total: -1, used: -1, type: 0 };
  if (data.length <= 1) return info;
  let p = 0;
  const u8 = () => data[p++];
  const str = () => { const n = u8(); const s = String.fromCharCode(...data.slice(p, p + n)); p += n; return s; };
  info.tagPresent = true;
  info.uuid = hex(data.slice(p, p + 8)); p += 8;
  info.barCode = str();
  info.serialNumber = str();
  info.total = (u8() << 8) | u8();
  info.used = (u8() << 8) | u8();
  info.type = u8();
  return info;
}

// Etikettens mål slik skriveren måler dem (kommando 0x59, 18 byte): bredde og høyde i tidels mm.
// Gir null når svaret ikke har riktig lengde (ingen etikett i, eller en modell som svarer annerledes).
export function parsePaperInfo(data) {
  if (data.length !== 18) return null;
  const u = (i) => (data[i] << 8) | data[i + 1];
  const info = { gapMm: u(5) / 10, heightMm: u(7) / 10, widthMm: u(11) / 10, type: data[4] };
  return info.widthMm > 0 && info.heightMm > 0 ? info : null;
}

// Svart-hvitt-bilde til rader på 8 piksler per byte, med gjentakelser og tomme rader slått sammen.
// `isBlack(x, y)` gir true for svart. Kolonnene fylles ut til hele byte.
export function encodeBitmap(width, height, isBlack) {
  const cols = Math.ceil(width / 8) * 8;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = new Uint8Array(cols / 8);
    let black = 0;
    for (let x = 0; x < width; x++) if (isBlack(x, y)) { row[x >> 3] |= 1 << (7 - (x & 7)); black++; }
    const prev = rows[rows.length - 1];
    const kind = black ? "pixels" : "void";
    if (prev && prev.kind === kind && (kind === "void" || prev.data.every((v, i) => v === row[i]))) prev.repeat++;
    else rows.push({ kind, y, repeat: 1, data: row, black });
    if (y % 200 === 199) rows.push({ kind: "check", y, repeat: 0, black: 0 });
  }
  return { cols, rows: height, list: rows };
}

// Antall svarte piksler i en rad, slik printeren venter det (modus «total»: [0, lav, høy] i tre byte).
export function countBlack(data) {
  let n = 0;
  for (const v of data) for (let b = 0; b < 8; b++) if (v & (1 << b)) n++;
  return n;
}

export function bitmapPackets(img) {
  const out = [];
  for (const r of img.list) {
    if (r.kind === "check") { out.push(packet(TX.checkLine, [...u16(r.y), 1])); continue; }
    if (r.kind === "void") { out.push(packet(TX.emptyRow, [...u16(r.y), r.repeat])); continue; }
    if (r.black <= 6) {
      const idx = [];
      r.data.forEach((v, bytePos) => { for (let bit = 0; bit < 8; bit++) if (v & (1 << (7 - bit))) idx.push(...u16(bytePos * 8 + bit)); });
      out.push(packet(TX.bitmapRowIndexed, [...u16(r.y), 0, r.black & 0xff, (r.black >> 8) & 0xff, r.repeat, ...idx]));
      continue;
    }
    const total = countBlack(r.data);
    out.push(packet(TX.bitmapRow, [...u16(r.y), 0, total & 0xff, (total >> 8) & 0xff, r.repeat, ...r.data]));
  }
  return out;
}

export class NiimbotError extends Error {}

export class Niimbot {
  constructor() {
    this.dev = null; this.chan = null; this.buf = new Uint8Array(0); this.waiters = []; this.queue = Promise.resolve();
    this.onChange = () => {};
    this.model = null; this.log = []; this.onLog = () => {};
  }
  #log(dir, text) {
    const line = `${new Date().toISOString().slice(11, 23)} ${dir} ${text}`;
    this.log.push(line);
    if (this.log.length > 300) this.log.shift();
    console.debug(`[niimbot] ${line}`);
    this.onLog(line);
  }
  static supported() { return typeof navigator !== "undefined" && !!navigator.bluetooth; }
  get connected() { return !!this.chan && !!this.dev?.gatt?.connected; }
  get name() { return this.dev?.name || ""; }

  // silent: koble til en skriver nettleseren allerede har fått tillatelse til (uten valgliste). Gir feil med noKnownDevice hvis det ikke finnes
  // noen (første gang, eller nettleseren støtter ikke getDevices), og silentFailed hvis skriveren ikke svarer (slått av eller utenfor rekkevidde).
  // all: feilsøking. Viser alle Bluetooth-enheter i nærheten (ikke bare de som heter «B…»), for å se hva skriveren kaller seg.
  async connect({ silent = false, all = false } = {}) {
    if (!Niimbot.supported()) throw new NiimbotError("Nettleseren støtter ikke Bluetooth. Bruk Chrome eller Edge på PC eller Android.");
    if (silent) {
      const known = (await Promise.race([navigator.bluetooth.getDevices?.() ?? [], new Promise((r) => setTimeout(() => r([]), 3000))]).catch(() => [])) || [];
      const dev = known.find((d) => /^B/.test(d.name || ""));
      if (!dev) throw Object.assign(new NiimbotError("Ingen tidligere skriver."), { noKnownDevice: true });
      this.dev = dev;
    } else if (all) {
      this.dev = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: [SERVICE] });
    } else {
      // B-modeller heter «B21-…». Filtrerer også på tjenesten, som i niimbluelib.
      this.dev = await navigator.bluetooth.requestDevice({ filters: [{ namePrefix: "B" }, { services: [SERVICE] }], optionalServices: [SERVICE] });
    }
    this.dev.addEventListener("gattserverdisconnected", () => { this.chan = null; this.onChange(); });
    let server;
    try {
      server = await Promise.race([this.dev.gatt.connect(), new Promise((_, rej) => setTimeout(() => rej(new Error("tidsavbrudd")), silent ? 8000 : 30000))]);
    } catch (e) {
      try { this.dev.gatt.disconnect(); } catch { /* ikke tilkoblet */ }
      throw silent ? Object.assign(new NiimbotError("Skriveren svarer ikke."), { silentFailed: true }) : e;
    }
    let chan;
    for (const s of await server.getPrimaryServices()) {
      if (s.uuid.length < 5) continue;
      for (const c of await s.getCharacteristics()) if (c.properties.notify && c.properties.writeWithoutResponse) { chan = c; break; }
      if (chan) break;
    }
    if (!chan) { server.disconnect(); throw new NiimbotError("Fant ikke riktig Bluetooth-kanal på skriveren."); }
    chan.addEventListener("characteristicvaluechanged", (e) => this.#rx(new Uint8Array(e.target.value.buffer)));
    await chan.startNotifications();
    this.chan = chan;
    await this.send(TX.connect);
    try {
      const d = await this.info(8);
      const id = d.length === 1 ? d[0] << 8 : (d[0] << 8) | d[1];
      this.model = { id, name: MODELS[id]?.[0] || `ukjent (${id})`, flow: MODELS[id]?.[1] || "b21" };
    } catch { this.model = null; }
    this.#log("INFO", `modell ${JSON.stringify(this.model)}`);
    this.onChange();
  }
  disconnect() { try { this.dev?.gatt?.disconnect(); } catch { /* allerede frakoblet */ } this.chan = null; this.onChange(); }

  #rx(bytes) {
    const all = new Uint8Array(this.buf.length + bytes.length);
    all.set(this.buf); all.set(bytes, this.buf.length);
    const { packets, rest } = splitPackets(all);
    this.buf = rest;
    for (const raw of packets) {
      let p;
      try { p = parsePacket(raw); } catch { this.#log("RX?", hex(raw)); continue; }
      this.#log("RX", `${p.cmd.toString(16)} ${hex(p.data)}`);
      const i = this.waiters.findIndex((w) => w.ids.includes(p.cmd) || p.cmd === 0xdb);
      if (i >= 0) { const [w] = this.waiters.splice(i, 1); clearTimeout(w.timer); p.cmd === 0xdb ? w.reject(new NiimbotError(`Skriveren meldte feil (kode ${p.data[0] ?? "?"}). Sjekk at dekselet er lukket og at det er etiketter i.`)) : w.resolve(p); }
    }
  }

  // Sender én pakke og venter på svaret (hvis den har et). Pakker køes, så to kall aldri flettes.
  send(cmd, data = [1], timeout = 5000) {
    const run = async () => {
      if (!this.chan) throw new NiimbotError("Skriveren er ikke koblet til.");
      const ids = RX[cmd];
      const reply = ONE_WAY.has(cmd) || !ids ? null : new Promise((resolve, reject) => {
        const w = { ids, resolve, reject, timer: setTimeout(() => { this.waiters.splice(this.waiters.indexOf(w), 1); reject(new NiimbotError("Skriveren svarte ikke i tide.")); }, timeout) };
        this.waiters.push(w);
      });
      await new Promise((r) => setTimeout(r, 20));
      this.#log("TX", `${cmd.toString(16)} ${hex(Uint8Array.from(data))}`);
      await this.chan.writeValueWithoutResponse(packet(cmd, data));
      return reply;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  // Leser etiketten i skriveren (RFID), som Niimbot-appen gjør. Gir null når rullen mangler brikke.
  async readLabel() {
    const r = parseRfid((await this.send(TX.rfidInfo)).data);
    return r.tagPresent ? r : null;
  }
  // Størrelsen på etiketten i skriveren, i mm, eller null. Samme spørsmål som Niimbot-appen stiller.
  async readPaper() {
    try { return parsePaperInfo((await this.send(TX.paperInfo)).data); } catch { return null; }
  }
  async info(key) { return (await this.send(TX.printerInfo, [key])).data; }
  async battery() { try { return (await this.info(10))[0]; } catch { return null; } }

  // Skriver ut `copies` eksemplarer av et lerret. Lerretets bredde går på tvers av skrivehodet.
  async print(canvas, { density = B21.densityDefault, labelType = LABEL_TYPE.gap, copies = 1, skipQuantity = false, flow: forceFlow } = {}) {
    const ctx = canvas.getContext("2d");
    const { width, height } = canvas;
    if (width > B21.headPx) throw new NiimbotError(`Etiketten er for bred (${width} piksler, skrivehodet tar ${B21.headPx}).`);
    const px = ctx.getImageData(0, 0, width, height).data;
    const img = encodeBitmap(width, height, (x, y) => { const i = (y * width + x) * 4; return px[i + 3] > 127 && (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000 < 128; });
    const pages = bitmapPackets(img);
    const flow = forceFlow || this.model?.flow || "b21";
    if (flow === "v4") throw new NiimbotError(`Modellen ${this.model.name} bruker en nyere utskriftsprotokoll som ikke er lagt inn ennå.`);
    const ok = async (cmd, data, timeout) => (await this.send(cmd, data, timeout)).data[0] === 1;
    const until = async (fn, tries, ms, what) => { for (let i = 0; i < tries; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, ms)); } throw new NiimbotError(`Skriveren godtok ikke «${what}».`); };
    const dens = Math.min(B21.densityMax, Math.max(B21.densityMin, density));
    this.#log("INFO", `utskrift: flyt ${flow}, ${img.cols}x${img.rows}, ${pages.length} pakker, ${copies} stk`);
    await this.send(TX.setDensity, [dens]);
    await this.send(TX.setLabelType, [labelType]);
    await this.send(TX.printStart, flow === "b1" ? [...u16(copies), 0, 0, 0, 0, 0] : [1]);
    try {
      if (flow === "b1") {
        await this.send(TX.pageStart);
        await this.send(TX.setPageSize, [...u16(img.rows), ...u16(img.cols), ...u16(copies)]);
        for (const p of pages) await this.#raw(p);
        await this.send(TX.pageEnd, [1], 10000);
        await this.#pollStatus(copies);
      } else if (flow === "d110") {
        await this.send(TX.printClear);
        await this.send(TX.pageStart);
        await this.send(TX.setPageSize, [...u16(img.rows), ...u16(img.cols)]);
        if (!skipQuantity) await this.send(TX.printQuantity, u16(copies));
        for (const p of pages) await this.#raw(p);
        await this.send(TX.pageEnd, [1], 10000);
        await this.#pollStatus(copies);
      } else if (flow === "l2b") {
        for (let c = 0; c < copies; c++) {
          await until(() => ok(TX.pageStart), 5, 500, "start side");
          await this.send(TX.setPageSize, [...u16(img.rows), ...u16(img.cols)]);
          for (const p of pages) await this.#raw(p);
          await until(() => ok(TX.pageEnd), 20, 500, "slutt side");
        }
      } else {
        for (let c = 0; c < copies; c++) {
          await this.send(TX.pageStart);
          await this.send(TX.setPageSize, [...u16(img.rows), ...u16(img.cols)]);
          for (const p of pages) await this.#raw(p);
          await this.send(TX.pageEnd, [1], 10000);
        }
        // Printeren avslutter først når siste side er ferdig; vi spør til den godtar.
        for (let i = 0; i < 40; i++) {
          if ((await this.send(TX.printEnd)).data[0] === 1) return;
          await new Promise((r) => setTimeout(r, 300));
        }
        throw new NiimbotError("Utskriften ble ikke ferdig i tide.");
      }
    } catch (e) {
      this.#log("FEIL", e.message);
      try { await this.send(TX.printEnd); } catch { /* ignorer, skriveren er kanskje frakoblet */ }
      throw e;
    }
    try { await this.send(TX.printEnd); } catch { /* ferdig uansett */ }
  }
  async #pollStatus(pages) {
    for (let i = 0; i < 60; i++) {
      const d = (await this.send(TX.printStatus, [1], 5000)).data;
      if (((d[0] << 8) | d[1]) >= pages) return;
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new NiimbotError("Utskriften ble ikke ferdig i tide.");
  }
  async #raw(p) {
    // Bitmappakkene har ingen svar; de går gjennom samme kø så rekkefølgen holder.
    const run = async () => { await new Promise((r) => setTimeout(r, 10)); this.#log("TX", `rad ${hex(p.slice(2, 4))}…`); await this.chan.writeValueWithoutResponse(p); };
    const q = this.queue.then(run, run);
    this.queue = q.catch(() => {});
    return q;
  }
}
