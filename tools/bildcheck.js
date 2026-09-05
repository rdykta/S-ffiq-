// Bild-Check: holt für alle Einträge der Kategorie "Wer bin ich? (Bild)" das Bild, das im Spiel
// gezeigt würde, und schreibt eine HTML-Übersicht. Damit sieht man in einer Minute, welche Bilder
// taugen. Aufruf:  node tools/bildcheck.js            (nur Figuren)
//                  node tools/bildcheck.js alle       (Figuren und Personen)
const fs = require("fs");
const path = require("path");
const Q = require("../questions");

// findImage aus dem Server wiederverwenden, damit exakt dasselbe Bild geprüft wird wie im Spiel
const srvPath = path.join(__dirname, "..", "server.js");
const Module = require("module");
const m = new Module(srvPath);
m.filename = srvPath;
m.paths = Module._nodeModulePaths(path.dirname(srvPath));
const quiet = console.log;
console.log = () => {};
m._compile(fs.readFileSync(srvPath, "utf8") + "\nmodule.exports = { findImage };", srvPath);
console.log = quiet;
const { findImage } = m.exports;

const alle = process.argv[2] === "alle";
const liste = Q.bild.filter((p) => alle || p.en);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

(async () => {
  console.log(`Prüfe ${liste.length} Einträge – das dauert ein bis zwei Minuten …`);
  const rows = [];
  for (let i = 0; i < liste.length; i += 5) {
    const teil = liste.slice(i, i + 5);
    const res = await Promise.all(teil.map((p) => findImage(p).catch(() => null)));
    teil.forEach((p, k) => rows.push({ p, r: res[k] }));
    process.stdout.write(`\r${Math.min(i + 5, liste.length)}/${liste.length}`);
  }
  const ohne = rows.filter((x) => !x.r);
  const html = `<!doctype html><meta charset="utf-8"><title>SüffIQ Bild-Check</title>
<style>body{font:14px system-ui;background:#1B0F2B;color:#FFF3DC;margin:16px}
h1{font-size:20px}.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
.c{background:#26153B;border-radius:10px;padding:8px;text-align:center}
.c img{width:100%;height:150px;object-fit:contain;background:#FFF7E6;border-radius:6px}
.n{font-weight:700;margin-top:6px}.s{color:#A392BD;font-size:12px;word-break:break-all}
.bad{color:#FF4F8B}</style>
<h1>Bild-Check – ${rows.length} Einträge, ${ohne.length} ohne brauchbares Bild</h1>
<p class="s">Ohne Bild wird der Eintrag im Spiel übersprungen. Wer schlecht aussieht: Namen notieren und in <code>questions.js</code> unter <code>bild</code> streichen.</p>
${ohne.length ? `<p class="bad">Ohne Bild: ${ohne.map((x) => esc(x.p.name)).join(", ")}</p>` : ""}
<div class="g">${rows.filter((x) => x.r).map((x) => `<div class="c"><img src="${esc(x.r.url)}" loading="lazy" alt=""><div class="n">${esc(x.p.name)}</div><div class="s">${esc(x.r.page || "")}</div></div>`).join("")}</div>`;
  const out = path.join(__dirname, "..", "bildcheck.html");
  fs.writeFileSync(out, html);
  console.log(`\nFertig. ${rows.length - ohne.length} mit Bild, ${ohne.length} ohne.`);
  console.log(`Übersicht: ${out}  – im Browser öffnen.`);
  process.exit(0);
})();
