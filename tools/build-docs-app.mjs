/*
 * Monta docs/app/ como copia de producao exata do app web da raiz.
 * Nao reescreve o bundle: apenas copia os arquivos publicos e carimba a
 * versao web no atributo zg="..." (o runtime continua corrigindo pela
 * versao instalada quando roda dentro do MSIX/Android).
 *
 * Uso: node tools/build-docs-app.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "docs", "app");
const WEB_VERSION = "1.25.15";

const FILES = [
  "index.html",
  "sync-ui.js",
  "sync-ui.css",
  "terms-modal.js",
  "terms-modal.css",
  "manifest.webmanifest",
  "sw.js",
  "politica-de-privacidade.html",
  "termos-de-servico.html",
  "aviso-legal.html",
];

const ICONS = [
  "apple-touch-icon.png",
  "icon-32.png",
  "icon-192.png",
  "icon-512.png",
  "maskable-512.png",
  "Square150x150Logo.png",
];

fs.mkdirSync(path.join(out, "icons"), { recursive: true });

for (const name of FILES) {
  fs.copyFileSync(path.join(root, name), path.join(out, name));
}
for (const name of ICONS) {
  fs.copyFileSync(path.join(root, "icons", name), path.join(out, "icons", name));
}

const indexPath = path.join(out, "index.html");
let html = fs.readFileSync(indexPath, "utf8");
if (!/zg="[0-9.]+"/.test(html)) throw new Error('carimbo zg="..." nao encontrado em index.html');
html = html.replace(/zg="[0-9.]+"/, 'zg="' + WEB_VERSION + '"');
fs.writeFileSync(indexPath, html, "utf8");

console.log("docs/app atualizado: " + FILES.length + " arquivos + " + ICONS.length + " icones");
console.log("versao web carimbada: " + WEB_VERSION);
