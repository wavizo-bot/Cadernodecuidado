/*
 * Conferência do AAB antes de subir para a Play (regras A1/A2/A3/A5 e 2.3).
 * Uso: node scripts/check-artifact.mjs [caminho-do-aab]
 * Sai com código 1 em qualquer divergência.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const androidDir = path.resolve(here, "..");
const projectDir = path.resolve(androidDir, "..");
const gradleDir = path.join(androidDir, "android");

const pkg = JSON.parse(fs.readFileSync(path.join(androidDir, "package.json"), "utf8"));
const capCfg = JSON.parse(fs.readFileSync(path.join(androidDir, "capacitor.config.json"), "utf8"));
const expectedAppId = capCfg.appId;
const versionCode = fs.readFileSync(path.join(androidDir, "version-code.txt"), "utf8").trim();
const aab = path.resolve(process.argv[2] || path.join(gradleDir, "app", "build", "outputs", "bundle", "release", "app-release.aab"));
const www = path.join(androidDir, "www");

const problems = [];
const notes = [];

function fail(msg) {
  problems.push(msg);
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

if (!fs.existsSync(aab)) {
  console.error("AAB não encontrado: " + aab);
  process.exit(1);
}
if (!/^\d+$/.test(versionCode)) fail("version-code.txt não é inteiro: " + versionCode);

// Lê o ZIP do AAB sem dependência extra. No Windows usamos o bsdtar de
// C:\Windows\System32 (o tar do Git Bash é GNU e trata "C:" como host).
const TAR = process.platform === "win32"
  ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
  : "tar";

function zipList(zip) {
  return execFileSync(TAR, ["-tf", zip], { encoding: "utf8" })
    .split(/\r?\n/).filter(Boolean);
}
function zipRead(zip, entry) {
  return execFileSync(TAR, ["-xOf", zip, entry], { encoding: null, maxBuffer: 64 * 1024 * 1024 });
}

let entries;
try {
  entries = zipList(aab);
} catch (e) {
  console.error("Não foi possível ler o AAB com tar: " + e.message);
  process.exit(1);
}

if (!entries.includes("BUNDLE-METADATA/com.android.tools.build.obfuscation/proguard.map")) {
  fail("mapping.txt (proguard.map) ausente do AAB — regra A2");
}

// A5: cada arquivo da fonte web empacotada deve bater byte a byte.
let compared = 0;
if (!fs.existsSync(www)) {
  fail("android/www não existe; rode npm run stage");
} else {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? walk(p) : [p];
  });
  for (const file of walk(www)) {
    const rel = path.relative(www, file).split(path.sep).join("/");
    const entry = "base/assets/public/" + rel;
    if (!entries.includes(entry)) {
      fail("fonte web ausente no AAB: " + entry);
      continue;
    }
    const a = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    const b = crypto.createHash("sha256").update(zipRead(aab, entry)).digest("hex");
    compared++;
    if (a !== b) fail("conteúdo divergente no AAB: " + entry);
  }
}

// Segredo OAuth: o JSON vai no pacote (regra 3.3), mas nunca um keystore.
for (const n of entries) {
  if (/\.(jks|keystore)$/i.test(n)) fail("keystore dentro do AAB: " + n);
}
if (!entries.includes("base/assets/google-client.json")) {
  fail("google-client.json ausente do AAB: o login Google não funcionaria");
}

// 2.3: nada de caractere de substituição nem BOM na fonte web.
for (const file of [path.join(www, "index.html"), path.join(www, "android.css"), path.join(www, "android-bridge.js")]) {
  if (!fs.existsSync(file)) continue;
  const buf = fs.readFileSync(file);
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) fail("BOM UTF-8 em " + path.basename(file));
  const text = buf.toString("utf8");
  if (text.includes("\uFFFD")) fail("U+FFFD em " + path.basename(file));
}
for (const name of ["index.html", "sync-ui.js", "terms-modal.js", "politica-de-privacidade.html", "termos-de-servico.html"]) {
  const file = path.join(www, name);
  if (!fs.existsSync(file)) continue;
  if (fs.readFileSync(file, "utf8").includes("\uFFFD")) fail("U+FFFD em " + name);
}

// Versão: bundletool-all.jar é opcional; se existir, confere o manifesto real.
const bt = path.join(androidDir, "build", "bundletool-all.jar");
if (fs.existsSync(bt)) {
  const java = process.env.JAVA_HOME
    ? path.join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java")
    : "java";
  try {
    const out = execFileSync(java, ["-jar", bt, "dump", "manifest", "--bundle", aab], {
      encoding: "utf8", maxBuffer: 16 * 1024 * 1024
    });
    const vc = /android:versionCode="(\d+)"/.exec(out);
    const vn = /android:versionName="([^"]+)"/.exec(out);
    const pkgName = /package="([^"]+)"/.exec(out);
    if (!vc) fail("versionCode não encontrado no manifesto do AAB");
    else if (vc[1] !== versionCode) fail(`versionCode do AAB (${vc[1]}) != version-code.txt (${versionCode})`);
    if (!vn) fail("versionName não encontrado no AAB");
    else if (vn[1] !== pkg.version) fail(`versionName do AAB (${vn[1]}) != package.json (${pkg.version})`);
    if (!pkgName || pkgName[1] !== expectedAppId) fail("package inesperado no AAB: " + (pkgName && pkgName[1]) + " (esperado " + expectedAppId + ")");
    notes.push(`manifesto: ${pkgName && pkgName[1]} v${vn && vn[1]} (code ${vc && vc[1]})`);
  } catch (e) {
    fail("bundletool falhou: " + e.message);
  }
} else {
  notes.push("bundletool-all.jar ausente: versão do AAB não conferida (rode com o jar em android/build/).");
}

notes.push(`assets web conferidos: ${compared}`);
const size = (fs.statSync(aab).size / 1024 / 1024).toFixed(2);
notes.push(`AAB: ${size} MB`);

console.log("== Conferência do AAB ==");
console.log("arquivo: " + aab);
for (const n of notes) console.log("  · " + n);
if (problems.length) {
  console.log("\nFALHOU:");
  for (const p of problems) console.log("  ✗ " + p);
  process.exit(1);
}
console.log("\nOK: AAB apto a subir.");
