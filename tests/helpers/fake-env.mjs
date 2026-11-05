// Testmiljø: D1 bygd på node:sqlite lastet med migrations/0001_init.sql. Bare syntetiske data.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

const SCHEMA = readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8");

export function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  const bound = (sql, args) => {
    const st = () => db.prepare(sql);
    return {
      _run: () => st().run(...args),
      first: async () => st().get(...args) ?? null,
      all: async () => ({ results: st().all(...args) }),
      run: async () => ({ meta: st().run(...args) }),
    };
  };
  return {
    raw: db,
    prepare: (sql) => ({ bind: (...args) => bound(sql, args), ...bound(sql, []) }),
    batch: async (list) => {
      db.exec("BEGIN");
      try { for (const s of list) s._run(); db.exec("COMMIT"); } catch (err) { db.exec("ROLLBACK"); throw err; }
      return list.map(() => ({}));
    },
  };
}

export const PASSWORD = "testpassord-1";
export const makeEnv = (extra = {}) => ({ DB: makeDb(), FRYS_PASSWORD: PASSWORD, ASSETS: { fetch: async () => new Response("<html></html>", { headers: { "content-type": "text/html" } }) }, ...extra });

const ORIGIN = "https://frysekontroll.example";
// Kaller Workeren som nettleseren: cookies settes etter innlogging og sendes med videre. Hver klient har en enhetskode (x-device).
export const DEVICE_A = "a".repeat(32), DEVICE_B = "b".repeat(32);
export function client(worker, env, device = DEVICE_A) {
  let cookie = "", unlock = "";
  const call = async (method, path, body, headers = {}) => {
    const cookies = [cookie, unlock].filter(Boolean).join("; ");
    const init = { method, headers: { ...(cookies ? { cookie: cookies } : {}), ...(device ? { "x-device": device } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers } };
    if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
    const res = await worker.fetch(new Request(ORIGIN + path, init), env);
    for (const set of res.headers.getSetCookie()) {
      const pair = set.split(";")[0];
      if (pair.startsWith("fku=")) unlock = pair.replace(/^fku=$/, "");
      else if (pair.startsWith("fk=")) cookie = pair.replace(/^fk=$/, "");
    }
    return res;
  };
  return {
    call, res: async (...a) => { const r = await call(...a); return { status: r.status, body: await r.clone().json().catch(() => null), headers: r.headers, raw: r }; },
    login: async (password = PASSWORD) => call("POST", "/api/login", { password }),
    get cookie() { return cookie; }, set cookie(v) { cookie = v; },
    get unlock() { return unlock; },
    // Samme innlogging på en annen enhet: kopierer økt-cookien, men ikke opplåsingen.
    other(dev = DEVICE_B) { const c = client(worker, env, dev); c.cookie = cookie; return c; },
  };
}
export const JPEG = "data:image/jpeg;base64," + Buffer.from("ikke-et-ekte-bilde-men-gyldig-base64").toString("base64");
