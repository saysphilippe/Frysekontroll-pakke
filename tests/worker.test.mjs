import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { makeEnv, client, PASSWORD, JPEG, DEVICE_B } from "./helpers/fake-env.mjs";

const session = async (extra) => { const env = makeEnv(extra); const c = client(worker, env); assert.equal((await c.login()).status, 200); return { env, c }; };
const newItem = async (c, o = {}) => {
  const { body } = await c.res("GET", "/api/places");
  return (await c.res("POST", "/api/items", { name: "Laks 400 g", desc: "Pakke med laksefilet", tags: "fisk, laks", qty: 3, placeId: body.places[0].id, ...o })).body.item;
};

test("alt under /api/ krever innlogging, bortsett fra /api/login", async () => {
  const c = client(worker, makeEnv());
  for (const [m, p] of [["GET", "/api/items"], ["GET", "/api/places"], ["GET", "/api/me"], ["POST", "/api/items"], ["GET", "/api/items/abcdefgh/photo"], ["POST", "/api/vision"]]) {
    assert.equal((await c.res(m, p, m === "POST" ? {} : undefined)).status, 401, `${m} ${p}`);
  }
});

test("innlogging: riktig passord gir en HttpOnly, Secure og SameSite=Strict cookie; feil passord gir 401", async () => {
  const c = client(worker, makeEnv());
  assert.equal((await c.login("feil")).status, 401);
  const r = await c.login();
  const set = r.headers.get("set-cookie");
  assert.match(set, /^fk=v2\./); assert.match(set, /HttpOnly/); assert.match(set, /Secure/); assert.match(set, /SameSite=Strict/);
  assert.equal((await c.res("GET", "/api/me")).status, 200);
});

test("passordet står ikke i svar, og en forfalsket eller utløpt økt avvises", async () => {
  const { c } = await session();
  c.cookie = c.cookie.slice(0, -2) + "xx";
  assert.equal((await c.res("GET", "/api/me")).status, 401);
  const env = makeEnv();
  const c2 = client(worker, env);
  await c2.login();
  assert.doesNotMatch(await (await c2.call("GET", "/api/me")).text(), new RegExp(PASSWORD));
});

test("20 feil passord låser innloggingen i en time, også for riktig passord", async () => {
  const c = client(worker, makeEnv());
  for (let i = 0; i < 20; i++) assert.equal((await c.login("feil")).status, 401);
  assert.equal((await c.login()).status, 429);
});

test("uten FRYS_PASSWORD kommer ingen inn", async () => {
  const c = client(worker, makeEnv({ FRYS_PASSWORD: "" }));
  assert.equal((await c.login("")).status, 401);
});

test("skrivende kall fra en annen opprinnelse avvises", async () => {
  const { c } = await session();
  assert.equal((await c.res("POST", "/api/places", { freezer: "X" }, { origin: "https://evil.example" })).status, 403);
});

test("steder: de to fryserne finnes fra start; skuff legges til; sted med varer kan ikke fjernes", async () => {
  const { c } = await session();
  const first = (await c.res("GET", "/api/places")).body.places;
  assert.deepEqual(first.map((p) => p.freezer), ["Fryseboks", "Fryseskap"]);
  const added = (await c.res("POST", "/api/places", { freezer: "Fryseskap", drawer: "Skuff 2" })).body.places;
  const drawer = added.find((p) => p.drawer === "Skuff 2");
  assert.ok(drawer);
  await newItem(c, { placeId: drawer.id });
  assert.equal((await c.res("DELETE", `/api/places/${drawer.id}`)).status, 409);
});

test("ny vare: lagres med antall, plass, bilde, og søk finner den på navn, beskrivelse og stikkord", async () => {
  const { c } = await session();
  const it = await newItem(c, { photo: JPEG });
  assert.equal(it.qty, 3); assert.equal(it.freezer, "Fryseboks"); assert.equal(it.photo, true); assert.deepEqual(it.tags, ["fisk", "laks"]);
  for (const q of ["laks", "LAKS", "laksefilet", "fisk", "laks fisk"]) assert.equal((await c.res("GET", `/api/items?q=${encodeURIComponent(q)}`)).body.items.length, 1, q);
  assert.equal((await c.res("GET", "/api/items?q=brød")).body.items.length, 0);
  const photo = await c.res("GET", `/api/items/${it.id}/photo`);
  assert.equal(photo.status, 200); assert.equal(photo.headers.get("content-type"), "image/jpeg");
});

test("søket tåler % og _ som vanlige tegn", async () => {
  const { c } = await session();
  await newItem(c);
  assert.equal((await c.res("GET", "/api/items?q=%25")).body.items.length, 0);
  assert.equal((await c.res("GET", "/api/items?q=_")).body.items.length, 0);
});

test("ta ut teller ned, kan ikke gå under null, og tomme varer skjules fra listen men finnes med all=1", async () => {
  const { c } = await session();
  const it = await newItem(c, { qty: 2 });
  assert.equal((await c.res("POST", `/api/items/${it.id}/take`, { n: 1 })).body.item.qty, 1);
  assert.equal((await c.res("POST", `/api/items/${it.id}/take`, { n: 1 })).body.item.qty, 0);
  assert.equal((await c.res("POST", `/api/items/${it.id}/take`, { n: 1 })).status, 409);
  assert.equal((await c.res("GET", "/api/items")).body.items.length, 0);
  assert.equal((await c.res("GET", "/api/items?all=1")).body.items.length, 1);
  assert.equal((await c.res("POST", `/api/items/${it.id}/add`, { n: 2 })).body.item.qty, 2);
  const moves = (await c.res("GET", `/api/items/${it.id}/moves`)).body.moves;
  assert.deepEqual(moves.map((m) => m.delta), [2, -1, -1, 2], "nyeste først; uttaket som ble avvist er ikke med");
  assert.equal(moves.reduce((s, m) => s + m.delta, 0), 2, "summen av alle endringer er antallet som er igjen");
});

test("to uttak om gangen kan aldri ta ut mer enn det som er igjen", async () => {
  const { c } = await session();
  const it = await newItem(c, { qty: 1 });
  const rs = await Promise.all([1, 2, 3, 4].map(() => c.res("POST", `/api/items/${it.id}/take`, { n: 1 })));
  assert.equal(rs.filter((r) => r.status === 200).length, 1);
  assert.equal((await c.res("GET", `/api/items/${it.id}`)).body.item.qty, 0);
});

test("ugyldig input avvises: antall, plass, bilde, id", async () => {
  const { c } = await session();
  const places = (await c.res("GET", "/api/places")).body.places;
  for (const bad of [{ qty: 0 }, { qty: 100 }, { qty: "x" }, { name: "  " }, { placeId: 99999 }, { placeId: null }, { photo: "data:image/png;base64,AAAA" }, { photo: "data:image/jpeg;base64,<script>" }]) {
    const r = await c.res("POST", "/api/items", { name: "A", qty: 1, placeId: places[0].id, ...bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal((await c.res("GET", "/api/items/ABCDEFGH")).status, 404);
  assert.equal((await c.res("GET", "/api/items/aaaaaaaa")).status, 404);
  assert.equal((await c.res("POST", "/api/items", "{ikke json")).status, 400);
});

test("tekst renses: kontrolltegn fjernes, lengder kappes, stikkord blir små og unike", async () => {
  const { c } = await session();
  const it = await newItem(c, { name: "A\u0000B\nC " + "x".repeat(200), tags: "Laks, laks, FISK," + Array.from({ length: 30 }, (_, i) => "t" + i).join(",") });
  assert.ok(it.name.length <= 80); assert.doesNotMatch(it.name, /[\u0000-\u001f]/);
  assert.ok(it.tags.length <= 12); assert.equal(new Set(it.tags).size, it.tags.length); assert.ok(it.tags.every((t) => t === t.toLowerCase()));
});

test("endre og slett: PATCH oppdaterer søket, DELETE fjerner varen med bilde og historikk", async () => {
  const { c, env } = await session();
  const it = await newItem(c, { photo: JPEG });
  const places = (await c.res("GET", "/api/places")).body.places;
  const r = await c.res("PATCH", `/api/items/${it.id}`, { name: "Torsk", placeId: places[1].id });
  assert.equal(r.body.item.freezer, "Fryseskap");
  assert.equal((await c.res("GET", "/api/items?q=torsk")).body.items.length, 1);
  assert.equal((await c.res("GET", "/api/items?q=laks")).body.items.length, 1, "beskrivelsen nevner fortsatt laks");
  assert.equal((await c.res("PATCH", `/api/items/${it.id}`, { placeId: 12345 })).status, 400);
  assert.equal((await c.res("DELETE", `/api/items/${it.id}`)).status, 200);
  for (const t of ["items", "photos", "moves"]) assert.equal(env.DB.raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0, t);
});

const fakeAi = (reply, calls = []) => ({ run: async (model, input) => { calls.push({ model, input }); return typeof reply === "function" ? reply() : reply; } });

test("bildetolking: av uten AI-binding, og svaret fra modellen renses", async () => {
  const { c } = await session();
  assert.equal((await c.res("GET", "/api/me")).body.vision, false);
  assert.equal((await c.res("POST", "/api/vision", { photo: JPEG })).status, 501);
  const calls = [];
  const { c: c2 } = await session({ AI: fakeAi({ response: 'Her er svaret: {"name":"Kjøttdeig 500 g","desc":"Rød pakke","tags":["Kjøtt","kjøttdeig"],"ekstra":"ignoreres"}' }, calls) });
  assert.equal((await c2.res("GET", "/api/me")).body.vision, true);
  const r = await c2.res("POST", "/api/vision", { photo: JPEG });
  assert.equal(r.status, 200); assert.deepEqual(r.body, { name: "Kjøttdeig 500 g", desc: "Rød pakke", tags: ["kjøtt", "kjøttdeig"], expires: "" });
  assert.ok(calls[0].model.startsWith("@cf/"), "modellen er en Workers AI-modell");
  const parts = calls[0].input.messages[0].content;
  assert.ok(parts.some((p) => p.type === "image_url" && p.image_url.url.startsWith("data:image/jpeg;base64,")), "bildet sendes med");
});

test("bildetolking: svar uten JSON, tom tekst og feil fra modellen gir 502 uten å velte appen", async () => {
  for (const reply of [{ response: "ingen json her" }, { response: "" }, {}, () => { throw new Error("modell nede"); }]) {
    const { c } = await session({ AI: fakeAi(reply) });
    assert.equal((await c.res("POST", "/api/vision", { photo: JPEG })).status, 502);
  }
});

test("bildetolking tar imot svaret som objekt (JSON-modus) og i OpenAI-form", async () => {
  const { c } = await session({ AI: fakeAi({ response: { name: "Brød", desc: "", tags: ["brød"] } }) });
  assert.equal((await c.res("POST", "/api/vision", { photo: JPEG })).body.name, "Brød");
  const { c: c2 } = await session({ AI: fakeAi({ choices: [{ message: { content: '{"name":"Erter"}' } }] }) });
  assert.equal((await c2.res("POST", "/api/vision", { photo: JPEG })).body.name, "Erter");
});

test("bildetolking begrenses til 60 per time", async () => {
  const { c } = await session({ AI: fakeAi({ response: '{"name":"A"}' }) });
  for (let i = 0; i < 60; i++) assert.equal((await c.res("POST", "/api/vision", { photo: JPEG })).status, 200);
  assert.equal((await c.res("POST", "/api/vision", { photo: JPEG })).status, 429);
});

test("alle svar har sikkerhetshoder, og sidene sendes med dem", async () => {
  const env = makeEnv();
  const c = client(worker, env);
  const r = await worker.fetch(new Request("https://frysekontroll.example/"), env);
  assert.match(r.headers.get("content-security-policy"), /default-src 'none'/);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  const api = await c.call("GET", "/api/me");
  assert.match(api.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(api.headers.get("cache-control"), "no-store");
});

test("http omdirigeres til https", async () => {
  const r = await worker.fetch(new Request("http://frysekontroll.example/"), makeEnv());
  assert.equal(r.status, 301); assert.match(r.headers.get("location"), /^https:/);
});

// ---------- Enhet og opplåsing ----------

test("enheten som la inn varen kan endre den; en annen enhet får 403 password-needed", async () => {
  const { c } = await session();
  const item = await newItem(c);
  assert.equal((await c.res("POST", `/api/items/${item.id}/take`, { n: 1 })).status, 200);
  const other = c.other();
  for (const [m, p, b] of [["POST", `/api/items/${item.id}/take`, { n: 1 }], ["POST", `/api/items/${item.id}/add`, { n: 1 }], ["PATCH", `/api/items/${item.id}`, { name: "Annet" }], ["DELETE", `/api/items/${item.id}`], ["POST", `/api/packs/${item.packs[0]}/take`, {}]]) {
    const r = await other.res(m, p, b);
    assert.equal(r.status, 403, `${m} ${p}`); assert.equal(r.body.error, "password-needed");
  }
  // Å se på varen er fritt.
  assert.equal((await other.res("GET", `/api/items/${item.id}`)).status, 200);
  assert.equal((await c.res("GET", `/api/items/${item.id}`)).body.item.qty, 2);
});

test("opplåsing med riktig passord gjelder den enheten, ikke andre, og feil passord gir 401", async () => {
  const { c } = await session();
  const item = await newItem(c);
  const other = c.other();
  assert.equal((await other.res("POST", "/api/unlock", { password: "feil" })).status, 401);
  assert.equal((await other.res("POST", `/api/items/${item.id}/take`, { n: 1 })).status, 403);
  const r = await other.res("POST", "/api/unlock", { password: PASSWORD });
  assert.equal(r.status, 200);
  assert.match(r.headers.getSetCookie().join(), /fku=u1\./);
  assert.match(r.headers.getSetCookie().join(), /HttpOnly/);
  assert.equal((await other.res("POST", `/api/items/${item.id}/take`, { n: 1 })).status, 200);
  assert.equal((await other.res("PATCH", `/api/items/${item.id}`, { name: "Nytt" })).status, 200);
  // Samme økt og opplåsing på en tredje enhet virker ikke.
  const third = c.other("c".repeat(32)); third.cookie = c.cookie;
  const t = await third.res("POST", `/api/items/${item.id}/take`, { n: 1 });
  assert.equal(t.status, 403);
});

test("opplåsingen kan ikke flyttes til en annen enhet eller et annet navn", async () => {
  const { c } = await session();
  const item = await newItem(c);
  const other = c.other();
  await other.res("POST", "/api/unlock", { password: PASSWORD });
  const stolen = c.other("d".repeat(32));
  stolen.cookie = c.cookie;
  const r = await stolen.call("POST", `/api/items/${item.id}/take`, { n: 1 }, { cookie: `${c.cookie}; ${other.unlock}` });
  assert.equal(r.status, 403);
});

test("uten gyldig enhetskode kan ingen endre, og varer fra før (uten enhet) krever opplåsing", async () => {
  const { env, c } = await session();
  const item = await newItem(c);
  const none = client(worker, env, ""); none.cookie = c.cookie;
  assert.equal((await none.res("POST", `/api/items/${item.id}/take`, { n: 1 })).status, 403);
  assert.equal((await none.res("POST", "/api/unlock", { password: PASSWORD })).status, 400);
  await env.DB.prepare("UPDATE items SET device = '' WHERE id = ?").bind(item.id).run();
  assert.equal((await c.res("POST", `/api/items/${item.id}/take`, { n: 1 })).status, 403);
  assert.equal((await c.res("POST", "/api/unlock", { password: PASSWORD })).status, 200);
  assert.equal((await c.res("POST", `/api/items/${item.id}/take`, { n: 1 })).status, 200);
});

test("utlogging fjerner opplåsingen; feil opplåsingspassord teller med i grensen på 20", async () => {
  const { c } = await session();
  const r = await c.res("POST", "/api/logout", {});
  const set = r.headers.getSetCookie().join();
  assert.match(set, /fk=; Max-Age=0/); assert.match(set, /fku=; Max-Age=0/);
  const s2 = await session();
  for (let i = 0; i < 20; i++) assert.equal((await s2.c.other().res("POST", "/api/unlock", { password: "feil" })).status, 401);
  assert.equal((await s2.c.other().res("POST", "/api/unlock", { password: PASSWORD })).status, 429);
});

test("med eget navn låses det opp med det personlige passordet, ikke det felles", async () => {
  const env = makeEnv();
  const admin = client(worker, env); await admin.login();
  await admin.res("POST", "/api/users", { name: "Kari", password: "kari-passord-1" });
  const kari = client(worker, env, DEVICE_B);
  assert.equal((await kari.call("POST", "/api/login", { name: "Kari", password: "kari-passord-1" })).status, 200);
  const item = await newItem(admin);
  assert.equal((await kari.res("POST", `/api/items/${item.id}/take`, { n: 1 })).status, 403);
  assert.equal((await kari.res("POST", "/api/unlock", { password: PASSWORD })).status, 401);
  assert.equal((await kari.res("POST", "/api/unlock", { password: "kari-passord-1" })).status, 200);
  assert.equal((await kari.res("POST", `/api/items/${item.id}/take`, { n: 1 })).status, 200);
});
