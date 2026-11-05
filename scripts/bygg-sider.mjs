// Bygger den lokale varianten (GitHub Pages) i mappen _site: nettsiden, Worker-koden som kjøres i nettleseren, og databaseskjemaet.
// Bruk: npm run bygg:sider
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(root, "_site");
rmSync(out, { recursive: true, force: true });
cpSync(join(root, "public"), out, { recursive: true });
mkdirSync(join(out, "src"), { recursive: true });
for (const f of ["worker.js", "logic.js"]) cpSync(join(root, "src", f), join(out, "src", f));
mkdirSync(join(out, "migrations"), { recursive: true });
cpSync(join(root, "migrations", "0001_init.sql"), join(out, "migrations", "0001_init.sql"));
writeFileSync(join(out, "config.js"), 'export const MODE = "lokal";\n');
// GitHub Pages skal ikke tolke filene som Jekyll.
writeFileSync(join(out, ".nojekyll"), "");
console.log("Bygget i _site/");
