/*
 * Prepara o conteúdo web do app Android a partir da FONTE ÚNICA do projeto
 * (C:\APPS\Caderno de Cuidado\index.html e companhia). Nada do app web é
 * reescrito à mão aqui: só são feitas as três intervenções necessárias e
 * documentadas para rodar dentro do Capacitor:
 *
 *   1. viewport-fit=cover (áreas seguras do Android);
 *   2. carrega android.css e android-bridge.js (ponte com o app nativo);
 *   3. carimba a versão do pacote no rodapé (regra 2.2) e troca a expressão
 *      "neste navegador" por "neste aparelho".
 *
 * O restante é cópia byte a byte. A conferência de SHA256 do que foi
 * empacotado é feita por scripts/check-artifact.mjs (regra A5).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const androidDir = path.resolve(here, "..");
const srcDir = path.resolve(androidDir, "..");
const overlayDir = path.join(androidDir, "web-overlay");
const outDir = path.join(androidDir, "www");

const pkg = JSON.parse(fs.readFileSync(path.join(androidDir, "package.json"), "utf8"));
const VERSION = pkg.version;

const COPY = [
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

// Somente os ícones realmente referenciados pelo app/manifesto (o restante
// da pasta icons/ é material de loja e não deve inflar o AAB).
const ICONS = [
  "apple-touch-icon.png",
  "icon-32.png",
  "icon-192.png",
  "icon-512.png",
  "maskable-512.png",
  "Square150x150Logo.png",
];

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

fs.rmSync(outDir, { recursive: true, force: true });
const iconOut = path.join(outDir, "icons");
fs.mkdirSync(iconOut, { recursive: true });

for (const name of COPY) {
  fs.copyFileSync(path.join(srcDir, name), path.join(outDir, name));
}
for (const name of ICONS) {
  fs.copyFileSync(path.join(srcDir, "icons", name), path.join(iconOut, name));
}
fs.copyFileSync(path.join(overlayDir, "android.css"), path.join(outDir, "android.css"));
fs.copyFileSync(path.join(overlayDir, "android-bridge.js"), path.join(outDir, "android-bridge.js"));

// ---- index.html: intervenções mínimas e explícitas -------------------------
const indexPath = path.join(outDir, "index.html");
let html = fs.readFileSync(indexPath, "utf8");
const before = html;

const viewportBefore = '<meta name="viewport" content="width=device-width,initial-scale=1">';
const viewportAfter = '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">';
if (!html.includes(viewportBefore)) throw new Error("viewport esperado não encontrado");
html = html.replace(viewportBefore, viewportAfter);

if (!html.includes("</head>")) throw new Error("</head> não encontrado");
html = html.replace(
  "</head>",
  '  <link rel="stylesheet" href="./android.css">\n  <meta name="cc-build" content="android-' + VERSION + '">\n</head>'
);

// A ponte precisa existir ANTES de terms-modal.js/sync-ui.js (defer).
const deferTag = '<script src="./terms-modal.js" defer></script>';
if (!html.includes(deferTag)) throw new Error("tag do terms-modal.js não encontrada");
html = html.replace(deferTag, '<script src="./android-bridge.js"></script>' + deferTag);

let stamped = false;
html = html.replace(/zg="[0-9.]+"/, (m) => {
  stamped = true;
  return 'zg="' + VERSION + '"';
});
if (!stamped) throw new Error('carimbo zg="..." não encontrado');

const browserText = "Dados salvos neste navegador";
if (html.includes(browserText)) html = html.split(browserText).join("Dados salvos neste aparelho");

if (html === before) throw new Error("nenhuma intervenção aplicada ao index.html");
fs.writeFileSync(indexPath, html, "utf8");

// ---- manifesto: id/start_url relativos já servem; só confere presença -----
const manifest = JSON.parse(fs.readFileSync(path.join(outDir, "manifest.webmanifest"), "utf8"));
if (manifest.start_url !== "./") throw new Error("manifest.start_url inesperado");

// ---- relatório ------------------------------------------------------------
console.log("Conteúdo web preparado em " + outDir);
console.log("Versão carimbada: " + VERSION);
for (const name of [...COPY, "android.css", "android-bridge.js"]) {
  const p = path.join(outDir, name);
  console.log("  " + name.padEnd(28) + sha256(fs.readFileSync(p)).slice(0, 16));
}
