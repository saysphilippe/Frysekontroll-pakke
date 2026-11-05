import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { makeEnv, client } from "./helpers/fake-env.mjs";

const setup = async () => {
  const env = makeEnv(); const c = client(worker, env); await c.login();
  await c.res("GET", "/api/places"); // Fryseboks = 1, Fryseskap = 2
  const kari = client(worker, env);
  await c.res("POST", "/api/users", { name: "Kari", password: "kari-passord-1" });
  await kari.call("POST", "/api/login", { name: "Kari", password: "kari-passord-1" });
  const mk = (cl, o) => cl.res("POST", "/api/items", { qty: 1, placeId: 1, ...o }).then((r) => r.body.item);
  const laks = await mk(c, { name: "Laks", tags: "fisk, laks", qty: 3, expires: "2026-01-05" });
  const erter = await mk(kari, { name: "Erter", tags: "grønnsaker", placeId: 2, expires: "2027-06-01" });
  const brod = await mk(c, { name: "Brød", tags: "brød", placeId: 2 });
  const names = async (qs) => (await c.res("GET", `/api/items?sort=expires&${qs}`)).body.items.map((i) => i.name);
  return { env, c, kari, laks, erter, brod, names };
};

test("filter på fryser, skuff og stikkord (alle valgte stikkord må passe)", async () => {
  const { names } = await setup();
  assert.deepEqual(await names("freezer=Fryseskap"), ["Erter", "Brød"]);
  assert.deepEqual(await names("place=1"), ["Laks"]);
  assert.deepEqual(await names("tag=fisk"), ["Laks"]);
  assert.deepEqual(await names("tag=fisk&tag=laks"), ["Laks"]);
  assert.deepEqual(await names("tag=fisk&tag=brød"), []);
  assert.deepEqual(await names("tag=lak"), [], "et stikkord er hele ordet, ikke en del av det");
});

test("filter på utløp: utløpt, har dato, uten dato (i forhold til dagens dato fra klienten)", async () => {
  const { names } = await setup();
  assert.deepEqual(await names("exp=expired&today=2026-11-01"), ["Laks"]);
  assert.deepEqual(await names("exp=expired&today=2025-01-01"), [], "ingenting er utløpt i fjor");
  assert.deepEqual(await names("exp=dated"), ["Laks", "Erter"]);
  assert.deepEqual(await names("exp=undated"), ["Brød"]);
});

test("filter på hvem som la inn (navn, eller «-» for felles passord) og på flere pakker", async () => {
  const { names } = await setup();
  assert.deepEqual(await names("by=Kari"), ["Erter"]);
  assert.deepEqual(await names("by=-"), ["Laks", "Brød"]);
  assert.deepEqual(await names("multi=1"), ["Laks"]);
});

test("filter på når varen ble lagt inn, og filtrene kan kombineres", async () => {
  const { names, env, c } = await setup();
  const idag = new Date().toISOString().slice(0, 10);
  assert.equal((await names(`from=${idag}&to=${idag}`)).length, 3);
  assert.deepEqual(await names("to=2020-01-01"), []);
  assert.deepEqual(await names("from=2099-01-01"), []);
  env.DB.raw.exec("UPDATE items SET frozen = 1000000000000 WHERE name = 'Brød'"); // 2001
  assert.deepEqual(await names("to=2005-01-01"), ["Brød"]);
  assert.deepEqual(await names("freezer=Fryseskap&exp=dated"), ["Erter"]);
  assert.deepEqual(await names("q=erter&freezer=Fryseboks"), []);
  void c;
});

test("tomme og ugyldige filterverdier endrer ikke svaret, og tegn som % og ' er trygge", async () => {
  const { names } = await setup();
  assert.equal((await names("exp=&by=&from=ikke&to=32.13.2026&tag=")).length, 3);
  assert.deepEqual(await names("tag=%25"), []);
  assert.deepEqual(await names("freezer=%27%20OR%201%3D1%20--"), []);
  assert.deepEqual(await names("by=%27%20OR%201%3D1"), []);
});

test("valgene i filtrene: stikkord med antall, fryserne og hvem som har lagt inn varer", async () => {
  const { c } = await setup();
  const f = (await c.res("GET", "/api/facets")).body;
  assert.deepEqual(f.tags.find((t) => t.tag === "laks"), { tag: "laks", n: 1 });
  assert.deepEqual(f.freezers, ["Fryseboks", "Fryseskap"]);
  assert.deepEqual(f.people, ["", "Kari"]);
  assert.equal((await client(worker, makeEnv()).res("GET", "/api/facets")).status, 401);
});

test("tomme varer teller ikke i stikkordvalgene", async () => {
  const { c, laks } = await setup();
  await c.res("POST", `/api/items/${laks.id}/take`, { n: 3 });
  const f = (await c.res("GET", "/api/facets")).body;
  assert.ok(!f.tags.some((t) => t.tag === "laks"));
});
