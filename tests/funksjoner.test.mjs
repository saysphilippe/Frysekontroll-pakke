import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { makeEnv, client, PASSWORD } from "./helpers/fake-env.mjs";

const session = async () => { const env = makeEnv(); const c = client(worker, env); assert.equal((await c.login()).status, 200); return { env, c }; };
const newItem = async (c, o = {}) => (await c.res("POST", "/api/items", { name: "Laks 400 g", desc: "Pakke med laksefilet", tags: "fisk, laks", qty: 3, placeId: 1, ...o })).body.item;
const places = async (c) => (await c.res("GET", "/api/places")).body.places; // gir fryserne fra start (id 1 og 2)

// ---------- Utløpsdato ----------
test("utløpsdato: valgfri, må være en ekte dato, kan endres, og sorteringen legger de som utløper først øverst", async () => {
  const { c } = await session(); await places(c);
  const a = await newItem(c, { name: "Sent", expires: "2027-03-01" });
  const b = await newItem(c, { name: "Tidlig", expires: "2026-12-24" });
  const u = await newItem(c, { name: "Uten dato" });
  assert.equal(a.expires, "2027-03-01"); assert.equal(u.expires, "");
  assert.deepEqual((await c.res("GET", "/api/items?sort=expires")).body.items.map((i) => i.name), ["Tidlig", "Sent", "Uten dato"]);
  for (const bad of ["2026-02-30", "i morgen", "2026-13-01", "26-1-1"]) assert.equal((await c.res("POST", "/api/items", { name: "X", qty: 1, placeId: 1, expires: bad })).status, 400, bad);
  assert.equal((await c.res("PATCH", `/api/items/${b.id}`, { expires: "2027-01-15" })).body.item.expires, "2027-01-15");
  assert.equal((await c.res("PATCH", `/api/items/${b.id}`, { expires: "" })).body.item.expires, "", "tom tekst fjerner datoen");
  assert.equal((await c.res("PATCH", `/api/items/${b.id}`, { expires: "feil" })).status, 400);
});

// ---------- Pakker: én QR per pakke ----------
test("hver pakke får egen kode; skanning tar ut akkurat den pakken, én gang", async () => {
  const { c } = await session(); await places(c);
  const it = await newItem(c, { qty: 3 });
  assert.equal(it.packs.length, 3); assert.equal(new Set(it.packs).size, 3);
  const [p1, p2] = it.packs;
  const r1 = await c.res("POST", `/api/packs/${p1}/take`);
  assert.equal(r1.status, 200); assert.equal(r1.body.item.qty, 2); assert.equal(r1.body.item.packs.length, 2);
  const again = await c.res("POST", `/api/packs/${p1}/take`);
  assert.equal(again.status, 409); assert.equal(again.body.error, "already-taken"); assert.equal(again.body.item.qty, 2, "en ny skanning av samme pakke teller ikke ned igjen");
  assert.equal((await c.res("GET", `/api/packs/${p1}`)).body.pack.taken > 0, true);
  assert.equal((await c.res("GET", `/api/packs/${p2}`)).body.pack.taken, 0);
  assert.equal((await c.res("POST", `/api/packs/${p1}/undo`)).body.item.qty, 3);
  assert.equal((await c.res("POST", `/api/packs/${p1}/undo`)).status, 409, "kan ikke legges tilbake to ganger");
  assert.equal((await c.res("GET", "/api/packs/aaaaaaaa")).status, 404);
});

test("to skanninger av samme pakke samtidig gir bare ett uttak", async () => {
  const { c } = await session(); await places(c);
  const it = await newItem(c, { qty: 2 });
  const rs = await Promise.all([1, 2, 3].map(() => c.res("POST", `/api/packs/${it.packs[0]}/take`)));
  assert.equal(rs.filter((r) => r.status === 200).length, 1);
  assert.equal((await c.res("GET", `/api/items/${it.id}`)).body.item.qty, 1);
});

test("«Ta ut» på varen bruker de eldste pakkene, og «legg tilbake» lager nye pakker med nye koder", async () => {
  const { c } = await session(); await places(c);
  const it = await newItem(c, { qty: 3 });
  const after = (await c.res("POST", `/api/items/${it.id}/take`, { n: 2 })).body.item;
  assert.equal(after.packs.length, 1);
  const added = (await c.res("POST", `/api/items/${it.id}/add`, { n: 2 })).body.item;
  assert.equal(added.qty, 3); assert.equal(added.packs.length, 3);
  const taken = it.packs.filter((p) => !after.packs.includes(p));
  assert.ok(!taken.some((p) => added.packs.includes(p)), "nye pakker, ikke de som ble tatt ut");
});

test("varer fra før pakkene fantes (uten pakker) virker som før", async () => {
  const { c, env } = await session(); await places(c);
  const it = await newItem(c, { qty: 2 });
  env.DB.raw.exec("DELETE FROM packs");
  const r = await c.res("POST", `/api/items/${it.id}/take`, { n: 1 });
  assert.equal(r.body.item.qty, 1); assert.deepEqual(r.body.item.packs, []);
});

test("sletter du en vare, forsvinner pakkene også, og kodene gir 404", async () => {
  const { c, env } = await session(); await places(c);
  const it = await newItem(c, { qty: 2 });
  await c.res("DELETE", `/api/items/${it.id}`);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM packs").get().n, 0);
  assert.equal((await c.res("GET", `/api/packs/${it.packs[0]}`)).status, 404);
});

// ---------- Egne innlogginger ----------
const addUser = (c, name = "Kari", password = "kari-passord-1") => c.res("POST", "/api/users", { name, password });
const loginAs = (k, name, password) => k.call("POST", "/api/login", { name, password });

test("familiemedlem: logger inn med navn og eget passord, og økten bærer navnet", async () => {
  const { env, c } = await session();
  assert.equal((await addUser(c)).status, 200);
  const k = client(worker, env);
  assert.equal((await loginAs(k, "kari", "kari-passord-1")).status, 200); // små bokstaver skal også gå
  assert.equal((await k.res("GET", "/api/me")).body.name, "Kari");
  assert.equal((await c.res("GET", "/api/me")).body.name, "", "felles passord har ikke navn");
});

test("passordene lagres ikke i klartekst, og feil passord for et navn avvises", async () => {
  const { env, c } = await session();
  await addUser(c);
  const row = env.DB.raw.prepare("SELECT * FROM users").get();
  assert.ok(!JSON.stringify(row).includes("kari-passord-1")); assert.ok(row.salt.length >= 20 && row.hash.length >= 40);
  const k = client(worker, env);
  assert.equal((await loginAs(k, "Kari", "feil-passord-1")).status, 401);
  assert.equal((await loginAs(k, "Finnes ikke", "kari-passord-1")).status, 401);
  assert.equal((await loginAs(k, "Kari", PASSWORD)).status, 401, "det felles passordet kan ikke brukes sammen med et navn");
});

test("uttak og endringer logges med hvem som gjorde det", async () => {
  const { env, c } = await session(); await places(c);
  await addUser(c);
  const k = client(worker, env);
  await loginAs(k, "Kari", "kari-passord-1");
  const it = await newItem(k, { qty: 2 });
  await k.res("POST", `/api/packs/${it.packs[0]}/take`);
  await c.res("POST", `/api/items/${it.id}/take`, { n: 1 });
  const moves = (await c.res("GET", `/api/items/${it.id}/moves`)).body.moves;
  assert.deepEqual(moves.map((m) => [m.kind, m.actor]), [["take", ""], ["take", "Kari"], ["new", "Kari"]]);
});

test("fjernes et medlem, mister økten gyldighet med en gang; du kan ikke fjerne deg selv", async () => {
  const { env, c } = await session();
  await addUser(c); await addUser(c, "Ola", "ola-passord-12");
  const k = client(worker, env);
  await loginAs(k, "Kari", "kari-passord-1");
  assert.equal((await k.res("GET", "/api/me")).status, 200);
  assert.equal((await k.res("DELETE", "/api/users/Kari")).body.error, "self");
  assert.equal((await c.res("DELETE", "/api/users/Kari")).status, 200);
  assert.equal((await k.res("GET", "/api/me")).status, 401);
  assert.deepEqual((await c.res("GET", "/api/users")).body.users, ["Ola"]);
});

test("ugyldig navn og for kort passord avvises; samme navn på nytt bytter passordet", async () => {
  const { env, c } = await session();
  assert.equal((await addUser(c, "<b>", "langt-nok-passord")).status, 400);
  assert.equal((await addUser(c, "", "langt-nok-passord")).status, 400);
  assert.equal((await addUser(c, "Kari", "kort")).status, 400);
  await addUser(c, "Kari", "forste-passord-1"); await addUser(c, "Kari", "andre-passord-2");
  const k = client(worker, env);
  assert.equal((await loginAs(k, "Kari", "forste-passord-1")).status, 401);
  assert.equal((await loginAs(k, "Kari", "andre-passord-2")).status, 200);
});

test("en økt med byttet navn godtas ikke", async () => {
  const { env, c } = await session();
  await addUser(c, "Kari", "kari-passord-1"); await addUser(c, "Ola", "ola-passord-12");
  const k = client(worker, env);
  await loginAs(k, "Kari", "kari-passord-1");
  const [v, exp, , sig] = k.cookie.replace(/^fk=/, "").split(".");
  k.cookie = `fk=${v}.${exp}.${Buffer.from("Ola").toString("base64url")}.${sig}`;
  assert.equal((await k.res("GET", "/api/me")).status, 401, "navnet er med i signaturen");
});

test("uten innlogging kommer ingen til de nye rutene", async () => {
  const c = client(worker, makeEnv());
  for (const [m, p] of [["GET", "/api/users"], ["POST", "/api/users"], ["DELETE", "/api/users/Kari"], ["GET", "/api/packs/aaaaaaaa"], ["POST", "/api/packs/aaaaaaaa/take"]]) {
    assert.equal((await c.res(m, p, m === "POST" ? {} : undefined)).status, 401, `${m} ${p}`);
  }
});

test("bildetolking leser også datoen på pakken, men bare hvis den er en gyldig dato", async () => {
  const mk = (expires) => makeEnv({ AI: { run: async () => ({ response: JSON.stringify({ name: "Brød", desc: "", tags: [], expires }) }) } });
  for (const [reply, forventet] of [["2027-02-14", "2027-02-14"], ["14.02.2027", ""], ["2027-02-31", ""], ["", ""], [20270214, ""]]) {
    const env = mk(reply); const c = client(worker, env); await c.login();
    const photo = "data:image/jpeg;base64," + Buffer.from("x").toString("base64");
    assert.equal((await c.res("POST", "/api/vision", { photo })).body.expires, forventet, String(reply));
  }
});
