const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { WebSocketServer } = require("ws");
const Q = require("./questions");

const PORT = process.env.PORT || 3000;
const rooms = new Map(); // code -> room

// ---------- statischer Webserver ----------
const server = http.createServer((req, res) => {
  const file = path.join(__dirname, "public", "index.html");
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store, max-age=0" });
  fs.createReadStream(file).pipe(res);
});
const wss = new WebSocketServer({ server });

// Heartbeat: tote Verbindungen (Handy im Standby, Proxy hat die Leitung gekappt) erkennen und wegräumen,
// damit der Spieler sauber als "getrennt" gilt und sein nächster Rejoin nicht mit einer Leiche kollidiert.
const HEARTBEAT_MS = Number(process.env.SUEFFIQ_HEARTBEAT_MS) || 30000;
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) { /* egal */ }
  }
}, HEARTBEAT_MS).unref();

// ---------- Hilfen ----------
const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
const shuffle = (a) => a.map((v) => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map((x) => x[1]);
function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let c;
  do { c = Array.from({ length: 4 }, () => rand(chars)).join(""); } while (rooms.has(c));
  return c;
}
const uid = () => Math.random().toString(36).slice(2, 10);

const CATS = {
  nie: "Ich hab noch nie",
  wer: "Wer würde eher",
  schaetz: "Schätzfrage",
  wop: "Wahrheit oder Pflicht",
  oder: "Entweder oder",
  trivia: "Trivia",
  werbinich: "Wer bin ich?",
  song: "Song-Quiz",
  bild: "Wer bin ich? (Bild)",
  malen: "Montagsmaler",
  regel: "Regeln & Events",
  logo: "Logo-Quiz",
};
const RULE_MIN = 10, RULE_MAX = 30, RULE_MAX_ACTIVE = 2; // Regel gilt 10–30 Runden, höchstens 2 gleichzeitig
const BLUR_STAGES = 5;
const HINT_MS = 7000;
const DRAW_SEC = 60;            // Zeichenzeit pro Runde (fest, unabhängig von der Antwortzeit)
const DRAW_COLORS = ["#1b0f2b", "#e63946", "#1d6fe0", "#2a9d3f", "#f5b82e", "#8b5a2b", "#ff4f8b", "#fff7e6"]; // letzter = Radierer (Papierfarbe)
const DRAW_MAX_STROKES = 600, DRAW_MAX_POINTS = 40000;

// Freitext-Vergleich: Akzente/Satzzeichen weg, Nachname reicht, kleine Tippfehler ok
function norm(s) {
  return String(s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ß/g, "ss")
    .replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}
function lev(a, b) {
  const m = a.length, n = b.length, d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let k = 1; k <= n; k++) d[0][k] = k;
  for (let i = 1; i <= m; i++) for (let k = 1; k <= n; k++)
    d[i][k] = Math.min(d[i - 1][k] + 1, d[i][k - 1] + 1, d[i - 1][k - 1] + (a[i - 1] === b[k - 1] ? 0 : 1));
  return d[m][n];
}
const STOP = new Set(["the","a","an","der","die","das","ein","eine","und","and","of","feat","ft","mit","von","i","you","me","my","in","on","to","it"]);
function words(n) { return n.split(" ").filter((w) => w.length >= 3 && !STOP.has(w)); }
// target: { name, alt: [] }  → Kandidaten: voller Name, Alternativen, Nachname (bei Personen)
function candidates(target, isPerson) {
  const full = norm(target.name).replace(/\(.*?\)/g, " ").replace(/\s+/g, " ").trim();
  const c = [full, ...(target.alt || []).map(norm)];
  const toks = full.split(" ");
  if (isPerson && toks.length > 1 && toks[toks.length - 1].length >= 4) c.push(toks[toks.length - 1]);
  const noStop = words(full).join(" "); if (noStop && noStop !== full) c.push(noStop);
  return c.filter(Boolean);
}
function matchesTarget(guess, target, isPerson) {
  const g = norm(guess); if (g.length < 3) return false;
  const gns = words(g).join(" ") || g;
  return candidates(target, isPerson).some((c) => {
    if (c === g || c === gns) return true;
    const cw = words(c); if (cw.length > 1 && cw[0].length >= 6 && (g === cw[0] || gns === cw[0])) return true; // "Atemlos" reicht
    const tol = c.length >= 12 ? 3 : c.length >= 8 ? 2 : c.length >= 5 ? 1 : 0;
    return lev(c, g) <= tol || lev(c, gns) <= tol;
  });
}
function nearTarget(guess, target, isPerson) {
  const g = norm(guess); if (g.length < 3) return false;
  const gw = words(g);
  return candidates(target, isPerson).some((c) => {
    if (c.length >= 6 && lev(c, g) <= Math.max(3, Math.floor(c.length / 3))) return true;
    if (g.length >= 4 && (c.includes(g) || g.includes(c))) return true;
    const cw = words(c);
    return gw.some((w) => cw.some((x) => x === w || (w.length >= 4 && x.length >= 4 && (lev(w, x) <= 1 || x.startsWith(w) || w.startsWith(x)))));
  });
}
function guessTarget(cur) {
  if (cur.type === "werbinich" || cur.type === "bild") return { t: cur.person, person: true };
  if (cur.type === "malen") return { t: cur.word, person: false };
  if (cur.type === "logo") return { t: cur.brand, person: false };
  return { t: { name: cur.song.t, alt: [] }, person: false };
}
const CHATTY = ["werbinich", "song", "bild", "malen", "logo"];

function createRoom() {
  const code = makeCode();
  const room = {
    code,
    hostId: null,
    players: {},
    order: [],
    categories: Object.keys(CATS),
    timerSec: 30,
    nsfw: true,   // 18+-Fragen mit dazumischen (Roundmaster kann's in der Lobby abschalten)
    deck: [],
    lastCat: null,
    lastDrawer: null,
    rules: [],       // aktive Regeln: { text, g, endRound }
    phase: "lobby",
    round: 0,
    current: null,
    used: {},
    history: [],
  };
  rooms.set(code, room);
  return room;
}

function publicState(room, forId) {
  const players = room.order.map((id) => {
    const p = room.players[id];
    return { id, name: p.name, drinks: p.drinks, connected: p.connected, answered: room.current ? room.current.answers[id] !== undefined : false };
  });
  let cur = room.current ? { ...room.current, answers: undefined, correct: undefined } : null;
  if (cur && cur.type === "werbinich") cur = { ...cur, person: undefined, hints: cur.person.hints.slice(0, cur.revealed), hintCount: cur.person.hints.length, solvedBy: Object.keys(cur.solved || {}) };
  if (cur && cur.type === "song") cur = { ...cur, song: undefined, solvedBy: Object.keys(cur.solved || {}) };
  if (cur && cur.type === "bild") cur = { ...cur, person: undefined, page: undefined, stages: BLUR_STAGES, solvedBy: Object.keys(cur.solved || {}) };
  if (cur && cur.type === "logo") cur = { ...cur, brand: undefined, page: undefined, stages: BLUR_STAGES, solvedBy: Object.keys(cur.solved || {}) };
  if (cur && cur.type === "malen") cur = { ...cur, word: forId === cur.drawer ? cur.word.name : undefined, wordLen: cur.word.name.length, strokes: undefined, colors: DRAW_COLORS, solvedBy: Object.keys(cur.solved || {}) };
  return {
    code: room.code,
    hostId: room.hostId,
    you: forId,
    players,
    categories: room.categories,
    cats: CATS,
    timerSec: room.timerSec,
    nsfw: room.nsfw,
    rules: room.rules.map((r) => ({ text: r.text })),
    now: Date.now(),
    phase: room.phase,
    round: room.round,
    current: cur,
    result: room.phase === "results" ? room.lastResult : null,
  };
}

// Nachricht an alle (außer optional einem) – für Zeichenstriche, die nicht den ganzen State brauchen
function relay(room, msg, exceptId) {
  const raw = JSON.stringify(msg);
  for (const id of room.order) {
    const p = room.players[id];
    if (id !== exceptId && p.ws && p.ws.readyState === 1) p.ws.send(raw);
  }
}

function broadcast(room) {
  for (const id of room.order) {
    const p = room.players[id];
    if (p.ws && p.ws.readyState === 1) {
      p.ws.send(JSON.stringify({ t: "state", s: publicState(room, id) }));
    }
  }
}

// Fragenpool: Basisfragen, bei 18+ zusätzlich die NSFW-Fragen der Kategorie hintendran.
// Die Indizes der Basisfragen bleiben dabei stabil, deshalb überlebt "used" ein Umschalten.
function poolFor(room, cat) {
  const extra = room.nsfw && Q.nsfw && Q.nsfw[cat];
  return extra && extra.length ? Q[cat].concat(extra) : Q[cat];
}
function pick(room, cat) {
  const pool = poolFor(room, cat);
  room.used[cat] = (room.used[cat] || []).filter((i) => i < pool.length);
  if (room.used[cat].length >= pool.length) room.used[cat] = [];
  const free = pool.map((_, i) => i).filter((i) => !room.used[cat].includes(i));
  const i = rand(free);
  room.used[cat].push(i);
  return pool[i];
}


// Artikelbild aus der Wikipedia. Personen: deutsche Wikipedia (i. d. R. Wikimedia Commons, frei lizenziert).
// Figuren (Eintrag mit en): englische Wikipedia, weil die deutsche für Zeichentrickfiguren meist kein Bild hat;
// dort dürfen auch nicht-freie Figurenbilder im Artikel stehen (pilicense=any). Danach Fallback auf die deutsche.
const imageCache = new Map();
async function wikiImage(lang, term, anyLicense) {
  const params = { action: "query", generator: "search", gsrsearch: term, gsrlimit: "1", gsrnamespace: "0", prop: "pageimages", piprop: "thumbnail|name", pithumbsize: "640", format: "json" };
  if (anyLicense) params.pilicense = "any";
  const url = `https://${lang}.wikipedia.org/w/api.php?` + new URLSearchParams(params);
  try {
    const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "SueffIQ/1.0 (Partyspiel; Wikipedia-Artikelbilder)" } }); clearTimeout(to);
    const d = await r.json();
    const pg = Object.values((d.query || {}).pages || {})[0];
    if (pg && pg.thumbnail && pg.thumbnail.source) return { url: pg.thumbnail.source, page: pg.title, lang };
  } catch (e) { /* nächster Versuch */ }
  return null;
}
async function findImage(person) {
  if (process.env.SUEFFIQ_STUB_IMAGE) return { url: process.env.SUEFFIQ_STUB_IMAGE, page: person.name, lang: person.en ? "en" : "de" };
  if (imageCache.has(person.name)) return imageCache.get(person.name);
  const tries = person.en ? [["en", person.en, true], ["de", person.name, false]] : [["de", person.name, false], ["de", person.alt[0], false]];
  let res = null;
  for (const [lang, term, any] of tries) { if (term) res = await wikiImage(lang, term, any); if (res) break; }
  imageCache.set(person.name, res); return res;
}

// Markenlogo als Bild: Vektorsymbol aus questions.js auf hellem Grund, direkt als Data-URI.
// Kein Netzabruf – dadurch keine fehlenden Dateien und kein Warten vor der Runde.
function logoImage(brand) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-3 -3 30 30"><rect x="-3" y="-3" width="30" height="30" fill="#FFF7E6"/><path d="${brand.path}" fill="#${brand.hex}"/></svg>`;
  return "data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64");
}

// Song-Vorschau aus dem iTunes-Katalog (öffentliche Such-API, 30-Sekunden-Preview)
const previewCache = new Map();
async function findPreview(song) {
  const key = song.a + "|" + song.t;
  if (process.env.SUEFFIQ_STUB_PREVIEW) return { url: process.env.SUEFFIQ_STUB_PREVIEW, art: "" };
  if (previewCache.has(key)) return previewCache.get(key);
  const url = "https://itunes.apple.com/search?" + new URLSearchParams({ term: `${song.a} ${song.t}`, entity: "song", country: "DE", limit: "5" });
  try {
    const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(url, { signal: ctrl.signal }); clearTimeout(to);
    const d = await r.json();
    const hit = (d.results || []).find((x) => x.previewUrl && norm(x.artistName).includes(norm(song.a).split(" ")[0])) || (d.results || []).find((x) => x.previewUrl);
    const res = hit ? { url: hit.previewUrl, art: hit.artworkUrl100 } : null;
    previewCache.set(key, res);
    return res;
  } catch (e) { return null; }
}
// "Zufällig, aber gleichmäßig": Kartenstapel mit jeder gewählten Kategorie genau einmal,
// gemischt. Ist der Stapel leer, wird neu gemischt – nie dieselbe Kategorie zweimal hintereinander.
function nextCat(room) {
  const cats = room.categories;
  if (cats.length === 1) return cats[0];
  if (!room.deck.length) room.deck = shuffle(cats.slice());
  let c = room.deck.shift();
  if (c === room.lastCat && room.deck.length) { room.deck.push(c); c = room.deck.shift(); }
  room.lastCat = c;
  return c;
}

function clearTimer(room) {
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
  if (room.hintTimer) { clearInterval(room.hintTimer); room.hintTimer = null; }
}

// Neue Regel ziehen: keine aus einer Gruppe, die schon aktiv ist; {Y}-Regeln nur ab 2 Spielern; nichts doppelt
function drawRule(room, players) {
  const P = room.players, pool = Q.regel;
  const activeG = new Set(room.rules.map((r) => r.g).filter(Boolean));
  const ok = (r) => !(r.g && activeG.has(r.g)) && !(players.length < 2 && /\{Y\}/.test(r.t));
  room.used.regel = room.used.regel || [];
  let free = pool.map((_, i) => i).filter((i) => !room.used.regel.includes(i) && ok(pool[i]));
  if (!free.length) { room.used.regel = []; free = pool.map((_, i) => i).filter((i) => ok(pool[i])); }
  if (!free.length) return null;
  const i = rand(free); room.used.regel.push(i);
  const x = rand(players), y = rand(players.filter((id) => id !== x)) || x;
  const text = pool[i].t.replace(/\{X\}/g, P[x].name).replace(/\{Y\}/g, P[y].name);
  return { text, g: pool[i].g, endRound: room.round + RULE_MIN + Math.floor(Math.random() * (RULE_MAX - RULE_MIN + 1)) };
}

async function nextRound(room) {
  clearTimer(room);
  room.round += 1;
  room.phase = "question";
  // Fällige Regeln zuerst: eigener Screen "Regel aufgehoben", die normale Kategorie kommt danach dran
  const due = room.rules.filter((r) => room.round >= r.endRound);
  if (due.length) {
    room.rules = room.rules.filter((r) => !due.includes(r));
    room.current = { type: "regel", label: CATS.regel, mode: "end", ended: due.map((r) => r.text), text: "Regel aufgehoben", answers: {} };
    return broadcast(room);
  }
  let cat = nextCat(room);
  // Schon zwei Regeln aktiv? Dann kommt stattdessen die nächste Kategorie aus dem Stapel
  if (cat === "regel" && room.rules.length >= RULE_MAX_ACTIVE && room.categories.length > 1) { cat = nextCat(room); }
  let songPick = null;
  if (cat === "song") {
    for (let i = 0; i < 4 && !songPick; i++) {
      const sng = pick(room, "song");
      const pv = await findPreview(sng);
      if (pv) songPick = { ...sng, ...pv };
    }
    if (!songPick) { cat = room.categories.find((c) => c !== "song") || "trivia"; room.lastCat = cat; }
  }
  let bildPick = null;
  if (cat === "bild") {
    for (let i = 0; i < 4 && !bildPick; i++) {
      const per = pick(room, "bild");
      const im = await findImage(per);
      if (im) bildPick = { person: per, ...im };
    }
    if (!bildPick) { cat = room.categories.find((c) => !["bild", "song"].includes(c)) || "trivia"; room.lastCat = cat; }
  }
  const logoPick = cat === "logo" ? pick(room, "logo") : null;
  const connected = room.order.filter((id) => room.players[id].connected);
  let cur = { type: cat, label: CATS[cat], answers: {} };

  if (cat === "nie") cur.text = pick(room, "nie");
  else if (cat === "wer") cur.text = pick(room, "wer");
  else if (cat === "schaetz") { const q = pick(room, "schaetz"); cur.text = q.q; cur.answer = q.a; cur.unit = q.unit; }
  else if (cat === "werbinich") {
    cur.person = pick(room, "werbinich"); cur.text = "Wer bin ich?"; cur.revealed = 1; cur.chat = []; cur.solved = {};
    const n = cur.person.hints.length, sec = (n * HINT_MS) / 1000;
    cur.deadline = Date.now() + n * HINT_MS; cur.total = sec; cur.started = Date.now();
    const round = room.round;
    room.hintTimer = setInterval(() => {
      if (room.phase !== "question" || room.round !== round) return clearInterval(room.hintTimer);
      if (cur.revealed < n) { cur.revealed++; broadcast(room); }
      else { clearInterval(room.hintTimer); room.hintTimer = null; resolve(room); }
    }, HINT_MS);
  }
  else if (cat === "bild" || cat === "logo") {
    if (cat === "bild") {
      cur.person = bildPick.person; cur.image = bildPick.url; cur.page = bildPick.page; cur.lang = bildPick.lang;
      cur.fic = !!bildPick.person.en; // Figur: Bild komplett einpassen statt beschneiden
      cur.text = "Wer bin ich?";
    } else {
      cur.brand = logoPick; cur.image = logoImage(logoPick); cur.fic = true;
      cur.text = "Welche Marke ist das?";
    }
    cur.revealed = 1; cur.chat = []; cur.solved = {};
    cur.deadline = Date.now() + BLUR_STAGES * HINT_MS; cur.total = (BLUR_STAGES * HINT_MS) / 1000;
    const round = room.round;
    room.hintTimer = setInterval(() => {
      if (room.phase !== "question" || room.round !== round) return clearInterval(room.hintTimer);
      if (cur.revealed < BLUR_STAGES) { cur.revealed++; broadcast(room); }
      else { clearInterval(room.hintTimer); room.hintTimer = null; resolve(room); }
    }, HINT_MS);
  }
  else if (cat === "regel") {
    const rule = room.rules.length < RULE_MAX_ACTIVE ? drawRule(room, connected.length ? connected : room.order) : null;
    if (rule) { room.rules.push(rule); cur.mode = "new"; cur.rule = rule.text; cur.text = "Neue Regel!"; }
    else { cur.mode = "full"; cur.text = "Regeln voll"; }
  }
  else if (cat === "malen") {
    // Zeichner: zufällig unter den Verbundenen, aber nicht derselbe wie beim letzten Mal
    const pool = connected.length ? connected : room.order;
    const cand = pool.filter((id) => id !== room.lastDrawer);
    cur.drawer = rand(cand.length ? cand : pool); room.lastDrawer = cur.drawer;
    cur.word = pick(room, "malen"); cur.text = "Was wird gezeichnet?";
    cur.chat = []; cur.solved = {}; cur.strokes = []; cur.points = 0;
    cur.deadline = Date.now() + DRAW_SEC * 1000; cur.total = DRAW_SEC; cur.started = Date.now();
    const round = room.round;
    room.timer = setTimeout(() => {
      if (room.phase === "question" && room.round === round) resolve(room);
    }, DRAW_SEC * 1000 + 300);
  }
  else if (cat === "song") {
    cur.text = "Welcher Song ist das?"; cur.preview = songPick.url; cur.art = songPick.art;
    cur.song = { t: songPick.t, a: songPick.a }; cur.chat = []; cur.solved = {};
  }
  else if (cat === "trivia") { const q = pick(room, "trivia"); cur.text = q.q; cur.options = q.o; cur.correct = q.c; }
  else if (cat === "oder") { const o = pick(room, "oder"); cur.text = "Entweder oder?"; cur.options = o; }
  else if (cat === "wop") {
    cur.target = rand(connected.length ? connected : room.order);
    cur.text = "Wahrheit oder Pflicht?";
    cur.stage = "choose"; // choose -> task
  }
  if (room.timerSec > 0 && !["wop", "werbinich", "bild", "malen", "regel", "logo"].includes(cat)) {
    const sec = cat === "schaetz" ? room.timerSec + 10 : cat === "song" ? room.timerSec + 15 : room.timerSec;
    cur.deadline = Date.now() + sec * 1000;
    cur.total = sec;
    const round = room.round;
    room.timer = setTimeout(() => {
      if (room.phase === "question" && room.round === round) { room.current.timedOut = true; resolve(room); }
    }, sec * 1000 + 300);
  }
  room.current = cur;
  broadcast(room);
}

function resolve(room) {
  const cur = room.current;
  const A = cur.answers;
  const ids = Object.keys(A);
  const P = room.players;
  const give = (id, n) => { P[id].drinks += n; };
  let res = { type: cur.type, text: cur.text, lines: [], drinkers: [] };

  if (cur.type === "nie") {
    const yes = ids.filter((id) => A[id] === "ja");
    yes.forEach((id) => give(id, 1));
    res.drinkers = yes.map((id) => ({ id, name: P[id].name, n: 1 }));
    res.lines.push(yes.length ? `${yes.length} von ${ids.length} haben's getan.` : "Niemand hat's getan. Alle brav.");
  } else if (cur.type === "wer") {
    const count = {};
    ids.forEach((id) => { count[A[id]] = (count[A[id]] || 0) + 1; });
    const max = Math.max(0, ...Object.values(count));
    const top = Object.keys(count).filter((id) => count[id] === max && P[id]);
    top.forEach((id) => give(id, 2));
    res.drinkers = top.map((id) => ({ id, name: P[id].name, n: 2 }));
    res.votes = Object.entries(count).filter(([id]) => P[id]).map(([id, n]) => ({ name: P[id].name, n })).sort((a, b) => b.n - a.n);
    res.lines.push(top.length > 1 ? "Gleichstand – alle Erstplatzierten trinken." : "Die Runde hat entschieden.");
  } else if (cur.type === "schaetz") {
    const diffs = ids.map((id) => ({ id, name: P[id].name, guess: A[id], diff: Math.abs(Number(A[id]) - cur.answer) })).sort((a, b) => b.diff - a.diff);
    res.answer = cur.answer; res.unit = cur.unit;
    res.guesses = diffs.slice().reverse();
    if (diffs[0]) { give(diffs[0].id, 3); res.drinkers.push({ id: diffs[0].id, name: diffs[0].name, n: 3 }); }
    if (diffs[1] && diffs.length > 2) { give(diffs[1].id, 1); res.drinkers.push({ id: diffs[1].id, name: diffs[1].name, n: 1 }); }
    if (diffs.length) res.lines.push(`Am nächsten dran: ${diffs[diffs.length - 1].name}.`);
  } else if (cur.type === "oder") {
    const a = ids.filter((id) => A[id] === 0), b = ids.filter((id) => A[id] === 1);
    res.votes = [{ name: cur.options[0], n: a.length }, { name: cur.options[1], n: b.length }];
    let losers = [];
    if (!ids.length) res.lines.push("Keiner hat gewählt.");
    else if (a.length === b.length) { res.lines.push("Unentschieden – alle trinken 1."); losers = ids; }
    else { losers = a.length < b.length ? a : b; res.lines.push(`Mehrheit für ${a.length > b.length ? cur.options[0] : cur.options[1]}. Die Minderheit trinkt.`); }
    losers.forEach((id) => give(id, 1));
    res.drinkers = losers.map((id) => ({ id, name: P[id].name, n: 1 }));
  } else if (cur.type === "song") {
    res.text = ""; res.answer = cur.song.t; res.artist = cur.song.a; res.chat = cur.chat;
    const connected = room.order.filter((id) => P[id].connected);
    connected.forEach((id) => { if (!cur.solved[id]) { give(id, 2); res.drinkers.push({ id, name: P[id].name, n: 2 }); } });
    const solvers = connected.filter((id) => cur.solved[id]).sort((a, b) => cur.solved[a].t - cur.solved[b].t);
    res.lines.push(solvers.length ? `Am schnellsten: ${P[solvers[0]].name}.` : "Keiner hat's erkannt.");
    res.solvers = solvers.map((id) => ({ name: P[id].name }));
    cur.timedOut = false;
  } else if (cur.type === "trivia") {
    const wrong = ids.filter((id) => A[id] !== cur.correct);
    const right = ids.filter((id) => A[id] === cur.correct);
    res.answer = cur.options[cur.correct];
    res.votes = cur.options.map((o, i) => ({ name: o, n: ids.filter((id) => A[id] === i).length }));
    wrong.forEach((id) => give(id, 1));
    res.drinkers = wrong.map((id) => ({ id, name: P[id].name, n: 1 }));
    res.lines.push(!ids.length ? "Keiner hat geantwortet." : right.length === ids.length ? "Alle richtig. Streber." : right.length ? `${right.length} von ${ids.length} wussten's.` : "Keiner wusste es. Alle trinken.");
  } else if (cur.type === "werbinich" || cur.type === "bild" || cur.type === "logo") {
    res.text = ""; res.answer = cur.type === "logo" ? cur.brand.name : cur.person.name; res.chat = cur.chat;
    if (cur.type === "bild") { res.image = cur.image; res.page = cur.page; res.lang = cur.lang; res.fic = cur.fic; }
    if (cur.type === "logo") { res.image = cur.image; res.fic = true; }
    const connected = room.order.filter((id) => P[id].connected);
    connected.forEach((id) => {
      const sv = cur.solved[id];
      const n = sv ? 0 : cur.type === "logo" ? 2 : 3;
      if (n > 0) { give(id, n); res.drinkers.push({ id, name: P[id].name, n }); }
    });
    const solvers = connected.filter((id) => cur.solved[id]).sort((a, b) => cur.solved[a].t - cur.solved[b].t);
    const unit = cur.type === "bild" || cur.type === "logo" ? "Stufe" : "Tipp";
    res.lines.push(solvers.length ? `Am schnellsten: ${P[solvers[0]].name} bei ${unit} ${cur.solved[solvers[0]].hint}.` : "Keiner hat's erraten.");
    res.solvers = solvers.map((id) => ({ name: P[id].name, hint: cur.solved[id].hint }));
    cur.timedOut = false;
  } else if (cur.type === "malen") {
    res.text = ""; res.answer = cur.word.name; res.chat = cur.chat; res.drawer = P[cur.drawer] ? P[cur.drawer].name : "?";
    const guessers = room.order.filter((id) => P[id].connected && id !== cur.drawer);
    const solvers = guessers.filter((id) => cur.solved[id]).sort((a, b) => cur.solved[a].t - cur.solved[b].t);
    res.solvers = solvers.map((id) => ({ name: P[id].name, sec: cur.solved[id].sec }));
    if (cur.aborted) res.lines.push("Der Zeichner ist abgehauen – keiner trinkt.");
    else {
      guessers.forEach((id) => { if (!cur.solved[id]) { give(id, 2); res.drinkers.push({ id, name: P[id].name, n: 2 }); } });
      if (guessers.length && !solvers.length && P[cur.drawer]) {
        give(cur.drawer, 3); res.drinkers.push({ id: cur.drawer, name: P[cur.drawer].name, n: 3 });
        res.lines.push(`Keiner hat's erkannt – ${res.drawer} zeichnet wie ein Fuß und trinkt 3.`);
      } else if (solvers.length) res.lines.push(`Am schnellsten: ${P[solvers[0]].name} nach ${cur.solved[solvers[0]].sec} s.`);
      else res.lines.push("Keine Rater da – Übungsrunde.");
    }
    cur.timedOut = false;
  } else if (cur.type === "wop") {
    res.text = cur.task || cur.text;
    if (cur.refused) { give(cur.target, 3); res.drinkers.push({ id: cur.target, name: P[cur.target].name, n: 3 }); res.lines.push(`${P[cur.target].name} hat gekniffen.`); }
    else res.lines.push(`${P[cur.target].name} hat's durchgezogen. Respekt.`);
  }
  if (cur.timedOut) {
    const late = room.order.filter((id) => P[id].connected && A[id] === undefined);
    late.forEach((id) => { give(id, 1); res.drinkers.push({ id, name: P[id].name, n: 1 }); });
    if (late.length) res.lines.push(`Zeit abgelaufen – ${late.map((id) => P[id].name).join(", ")} ${late.length === 1 ? "war" : "waren"} zu langsam.`);
  }
  clearTimer(room);
  if (cur.type === "malen") room.lastStrokes = cur.strokes;
  room.lastResult = res;
  room.phase = "results";
  room.history.push(res);
  broadcast(room);
}

function allAnswered(room) {
  const connected = room.order.filter((id) => room.players[id].connected);
  return connected.every((id) => room.current.answers[id] !== undefined);
}

// ---------- WebSocket ----------
wss.on("connection", (ws) => {
  let room = null, me = null;
  const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
  const err = (m) => send({ t: "error", m });
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (raw) => {
    ws.isAlive = true;
    let m; try { m = JSON.parse(raw); } catch { return; }

    if (m.t === "create") {
      room = createRoom();
      me = uid();
      room.players[me] = { name: (m.name || "Host").slice(0, 16), drinks: 0, connected: true, ws };
      room.order.push(me);
      room.hostId = me;
      send({ t: "joined", code: room.code, id: me });
      return broadcast(room);
    }

    if (m.t === "join") {
      const r = rooms.get(String(m.code || "").toUpperCase().trim());
      if (!r) return err("Diesen Code gibt es nicht.");
      room = r; me = uid();
      room.players[me] = { name: (m.name || "Gast").slice(0, 16), drinks: 0, connected: true, ws };
      room.order.push(me);
      send({ t: "joined", code: room.code, id: me });
      return broadcast(room);
    }

    if (m.t === "rejoin") {
      const r = rooms.get(m.code);
      if (!r || !r.players[m.id]) return send({ t: "reset" });
      room = r; me = m.id;
      const old = room.players[me].ws;
      room.players[me].ws = ws; room.players[me].connected = true;
      // Alte Verbindung desselben Spielers (vor Reload/Standby) aktiv schließen – ihr close-Event ist dann harmlos
      if (old && old !== ws) { try { old.close(); } catch (e) { /* egal */ } }
      send({ t: "joined", code: room.code, id: me });
      return broadcast(room);
    }

    if (m.t === "ping") return send({ t: "pong" });
    if (!room || !me) return;
    const isHost = me === room.hostId;

    if (m.t === "categories" && isHost) {
      const c = (m.cats || []).filter((k) => CATS[k]);
      if (c.length) { room.categories = c; room.deck = []; }
      return broadcast(room);
    }
    if (m.t === "nsfw" && isHost) { room.nsfw = !!m.on; return broadcast(room); }
    if (m.t === "timer" && isHost) {
      const v = Number(m.sec);
      if ([0, 15, 30, 45, 60].includes(v)) room.timerSec = v;
      return broadcast(room);
    }
    if (m.t === "start" && isHost) {
      if (room.order.filter((id) => room.players[id].connected).length < 1) return err("Niemand da.");
      return nextRound(room);
    }
    if (m.t === "next" && isHost && room.phase === "results") return nextRound(room);
    if (m.t === "skip" && isHost && room.phase === "question") return nextRound(room);
    if (m.t === "end" && isHost) { clearTimer(room); room.phase = "end"; return broadcast(room); }
    if (m.t === "host" && isHost && room.players[m.id]) { room.hostId = m.id; return broadcast(room); }
    if (m.t === "kick" && isHost && room.players[m.id] && m.id !== me) {
      const p = room.players[m.id]; if (p.ws) { p.ws.send(JSON.stringify({ t: "reset" })); p.ws.close(); }
      delete room.players[m.id]; room.order = room.order.filter((x) => x !== m.id);
      return broadcast(room);
    }

    if (m.t === "guess" && room.phase === "question" && CHATTY.includes(room.current.type)) {
      const cur = room.current, text = String(m.v || "").trim().slice(0, 60);
      if (!text || cur.solved[me]) return;
      if (cur.type === "malen" && me === cur.drawer) return; // der Zeichner rät nicht mit
      const name = room.players[me].name, tg = guessTarget(cur);
      if (matchesTarget(text, tg.t, tg.person)) {
        cur.solved[me] = { hint: cur.revealed || 0, t: Date.now(), sec: Math.round((Date.now() - (cur.started || Date.now())) / 1000) };
        cur.chat.push({ sys: true, text: `${name} hat es erraten!` });
      } else {
        cur.chat.push({ name, text });
        if (nearTarget(text, tg.t, tg.person)) send({ t: "near" });
      }
      if (cur.chat.length > 60) cur.chat.shift();
      if (cur.type === "malen") {
        // Alle Rater durch? Dann sofort auswerten.
        const guessers = room.order.filter((id) => room.players[id].connected && id !== cur.drawer);
        if (guessers.length && guessers.every((id) => cur.solved[id])) return resolve(room);
      }
      return broadcast(room);
    }

    // Montagsmaler: Striche des Zeichners entgegennehmen und an die anderen weiterreichen
    if (m.t === "stroke" && room.phase === "question" && room.current.type === "malen" && room.current.drawer === me) {
      const cur = room.current;
      const id = String(m.id || "").slice(0, 16);
      const pts = Array.isArray(m.p) ? m.p.slice(0, 400).map(Number) : [];
      if (!id || !pts.length || pts.length % 2 || pts.some((v) => !Number.isFinite(v) || v < -0.05 || v > 1.05)) return;
      let st = cur.strokes.length && cur.strokes[cur.strokes.length - 1].id === id ? cur.strokes[cur.strokes.length - 1] : null;
      if (!st) {
        if (cur.strokes.length >= DRAW_MAX_STROKES) return;
        const c = DRAW_COLORS.includes(m.c) ? m.c : DRAW_COLORS[0];
        const w = Math.min(40, Math.max(1, Number(m.w) || 6));
        st = { id, c, w, p: [] }; cur.strokes.push(st);
      }
      if (cur.points + pts.length / 2 > DRAW_MAX_POINTS) return;
      st.p.push(...pts); cur.points += pts.length / 2;
      return relay(room, { t: "draw", round: room.round, s: { id, c: st.c, w: st.w, p: pts } }, me);
    }
    if (m.t === "clear" && room.phase === "question" && room.current.type === "malen" && room.current.drawer === me) {
      room.current.strokes = []; room.current.points = 0;
      return relay(room, { t: "draw", round: room.round, clear: true }, me);
    }
    if (m.t === "drawSync") {
      const cur = room.current;
      if (room.phase === "question" && cur && cur.type === "malen") return send({ t: "draw", round: room.round, full: true, strokes: cur.strokes });
      if (room.phase === "results" && room.lastResult && room.lastResult.type === "malen") return send({ t: "draw", round: room.round, full: true, strokes: room.lastStrokes || [] });
      return;
    }
    if (m.t === "answer" && room.phase === "question") {
      const cur = room.current;
      if (cur.type === "wop") {
        if (me !== cur.target) return;
        if (cur.stage === "choose") {
          cur.choice = m.v === "wahrheit" ? "wahrheit" : "pflicht";
          cur.task = pick(room, cur.choice);
          cur.stage = "task";
          return broadcast(room);
        }
        return;
      }
      if (cur.type === "schaetz") { const n = Number(m.v); if (!Number.isFinite(n)) return; cur.answers[me] = n; }
      else if (cur.type === "wer") { if (!room.players[m.v]) return; cur.answers[me] = m.v; }
      else if (cur.type === "oder") { cur.answers[me] = m.v === 1 ? 1 : 0; }
      else if (cur.type === "trivia") { const i = Number(m.v); if (![0,1,2,3].includes(i)) return; cur.answers[me] = i; }
      else if (cur.type === "nie") { cur.answers[me] = m.v === "ja" ? "ja" : "nein"; }
      if (allAnswered(room)) return resolve(room);
      return broadcast(room);
    }

    if (m.t === "wopDone" && isHost && room.phase === "question" && room.current.type === "wop") {
      room.current.refused = !!m.refused;
      return resolve(room);
    }
    if (m.t === "force" && isHost && room.phase === "question" && room.current.type !== "wop") {
      if (room.current.type === "regel") return nextRound(room);
      if (CHATTY.includes(room.current.type) || Object.keys(room.current.answers).length) return resolve(room);
      return nextRound(room);
    }
  });

  ws.on("close", () => {
    if (!room || !me || !room.players[me]) return;
    // Veraltete Verbindung: Der Spieler hängt längst an einer neueren – nichts anfassen
    if (room.players[me].ws !== ws) return;
    room.players[me].connected = false;
    room.players[me].ws = null;
    // Host weg? Nächsten verbundenen Spieler zum Roundmaster machen.
    if (room.hostId === me) {
      const next = room.order.find((id) => room.players[id].connected);
      if (next) room.hostId = next;
    }
    if (room.phase === "question" && room.current.type === "malen" && room.current.drawer === me) { room.current.aborted = true; resolve(room); }
    else if (room.phase === "question" && !["wop", ...CHATTY].includes(room.current.type) && Object.keys(room.current.answers).length && allAnswered(room)) resolve(room);
    else broadcast(room);
    // Leere Räume nach 10 Minuten aufräumen
    setTimeout(() => {
      if (rooms.has(room.code) && !room.order.some((id) => room.players[id].connected)) rooms.delete(room.code);
    }, 30 * 60 * 1000);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === "IPv4" && !i.internal).map((i) => i.address);
  console.log("\n  Trinkspiel läuft!\n");
  console.log(`  Du selbst:        http://localhost:${PORT}`);
  ips.forEach((ip) => console.log(`  Freunde im WLAN:  http://${ip}:${PORT}`));
  console.log("\n  Beenden mit Strg+C\n");
});
