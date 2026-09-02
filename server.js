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
};
const BLUR_STAGES = 5;
const HINT_MS = 7000;

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
  return cur.type === "werbinich" || cur.type === "bild" ? { t: cur.person, person: true } : { t: { name: cur.song.t, alt: [] }, person: false };
}

function createRoom() {
  const code = makeCode();
  const room = {
    code,
    hostId: null,
    players: {},
    order: [],
    categories: Object.keys(CATS),
    timerSec: 30,
    deck: [],
    lastCat: null,
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
  return {
    code: room.code,
    hostId: room.hostId,
    you: forId,
    players,
    categories: room.categories,
    cats: CATS,
    timerSec: room.timerSec,
    now: Date.now(),
    phase: room.phase,
    round: room.round,
    current: cur,
    result: room.phase === "results" ? room.lastResult : null,
  };
}

function broadcast(room) {
  for (const id of room.order) {
    const p = room.players[id];
    if (p.ws && p.ws.readyState === 1) {
      p.ws.send(JSON.stringify({ t: "state", s: publicState(room, id) }));
    }
  }
}

function pick(room, cat) {
  const pool = Q[cat];
  room.used[cat] = room.used[cat] || [];
  if (room.used[cat].length >= pool.length) room.used[cat] = [];
  const free = pool.map((_, i) => i).filter((i) => !room.used[cat].includes(i));
  const i = rand(free);
  room.used[cat].push(i);
  return pool[i];
}

// "Zufällig, aber nicht zufällig": gewichteter Kartenstapel, jede Kategorie kommt
// im Verhältnis der Gewichte dran, nie zweimal hintereinander, Wahrheit/Pflicht selten.
const WEIGHTS = { nie: 3, wer: 3, trivia: 3, oder: 2, schaetz: 2, wop: 1, werbinich: 2, song: 2, bild: 2 };

// Personenbild aus der deutschen Wikipedia (Artikelbild, i. d. R. Wikimedia Commons, frei lizenziert)
const imageCache = new Map();
async function findImage(person) {
  if (process.env.SUEFFIQ_STUB_IMAGE) return { url: process.env.SUEFFIQ_STUB_IMAGE, page: person.name };
  if (imageCache.has(person.name)) return imageCache.get(person.name);
  const names = [person.name, ...person.alt];
  for (const n of names.slice(0, 2)) {
    const url = "https://de.wikipedia.org/w/api.php?" + new URLSearchParams({ action: "query", generator: "search", gsrsearch: n, gsrlimit: "1", gsrnamespace: "0", prop: "pageimages", piprop: "thumbnail|name", pithumbsize: "640", format: "json" });
    try {
      const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 4000);
      const r = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "SueffIQ/1.0 (Partyspiel; Wikipedia-Artikelbilder)" } }); clearTimeout(to);
      const d = await r.json();
      const pg = Object.values((d.query || {}).pages || {})[0];
      if (pg && pg.thumbnail && pg.thumbnail.source) {
        const res = { url: pg.thumbnail.source, page: pg.title };
        imageCache.set(person.name, res); return res;
      }
    } catch (e) { /* nächster Versuch */ }
  }
  imageCache.set(person.name, null); return null;
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
function nextCat(room) {
  const cats = room.categories;
  if (cats.length === 1) return cats[0];
  if (!room.deck.length) {
    let d = [];
    cats.forEach((c) => { for (let i = 0; i < (WEIGHTS[c] || 2); i++) d.push(c); });
    // Mischen, dann direkte Wiederholungen entzerren
    d = shuffle(d);
    for (let i = 1; i < d.length; i++) {
      if (d[i] === d[i - 1]) {
        const j = d.findIndex((x, k) => k > i && x !== d[i - 1] && (k + 1 >= d.length || d[k + 1] !== d[i]));
        if (j > 0) [d[i], d[j]] = [d[j], d[i]];
      }
    }
    room.deck = d;
  }
  let c = room.deck.shift();
  if (c === room.lastCat && room.deck.length) { room.deck.push(c); c = room.deck.shift(); }
  room.lastCat = c;
  return c;
}

function clearTimer(room) {
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
  if (room.hintTimer) { clearInterval(room.hintTimer); room.hintTimer = null; }
}

async function nextRound(room) {
  clearTimer(room);
  room.round += 1;
  room.phase = "question";
  let cat = nextCat(room);
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
      const per = pick(room, "werbinich");
      const im = await findImage(per);
      if (im) bildPick = { person: per, ...im };
    }
    if (!bildPick) { cat = room.categories.find((c) => !["bild", "song"].includes(c)) || "trivia"; room.lastCat = cat; }
  }
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
  else if (cat === "bild") {
    cur.person = bildPick.person; cur.image = bildPick.url; cur.page = bildPick.page;
    cur.text = "Wer bin ich?"; cur.revealed = 1; cur.chat = []; cur.solved = {};
    cur.deadline = Date.now() + BLUR_STAGES * HINT_MS; cur.total = (BLUR_STAGES * HINT_MS) / 1000;
    const round = room.round;
    room.hintTimer = setInterval(() => {
      if (room.phase !== "question" || room.round !== round) return clearInterval(room.hintTimer);
      if (cur.revealed < BLUR_STAGES) { cur.revealed++; broadcast(room); }
      else { clearInterval(room.hintTimer); room.hintTimer = null; resolve(room); }
    }, HINT_MS);
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
  if (room.timerSec > 0 && !["wop", "werbinich", "bild"].includes(cat)) {
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
  } else if (cur.type === "werbinich" || cur.type === "bild") {
    res.text = ""; res.answer = cur.person.name; res.chat = cur.chat;
    if (cur.type === "bild") { res.image = cur.image; res.page = cur.page; }
    const connected = room.order.filter((id) => P[id].connected);
    connected.forEach((id) => {
      const sv = cur.solved[id];
      const n = sv ? 0 : 3;
      if (n > 0) { give(id, n); res.drinkers.push({ id, name: P[id].name, n }); }
    });
    const solvers = connected.filter((id) => cur.solved[id]).sort((a, b) => cur.solved[a].t - cur.solved[b].t);
    const unit = cur.type === "bild" ? "Stufe" : "Tipp";
    res.lines.push(solvers.length ? `Am schnellsten: ${P[solvers[0]].name} bei ${unit} ${cur.solved[solvers[0]].hint}.` : "Keiner hat's erraten.");
    res.solvers = solvers.map((id) => ({ name: P[id].name, hint: cur.solved[id].hint }));
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

  ws.on("message", (raw) => {
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
      room.players[me].ws = ws; room.players[me].connected = true;
      send({ t: "joined", code: room.code, id: me });
      return broadcast(room);
    }

    if (m.t === "ping") return;
    if (!room || !me) return;
    const isHost = me === room.hostId;

    if (m.t === "categories" && isHost) {
      const c = (m.cats || []).filter((k) => CATS[k]);
      if (c.length) { room.categories = c; room.deck = []; }
      return broadcast(room);
    }
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

    if (m.t === "guess" && room.phase === "question" && ["werbinich", "song", "bild"].includes(room.current.type)) {
      const cur = room.current, text = String(m.v || "").trim().slice(0, 60);
      if (!text || cur.solved[me]) return;
      const name = room.players[me].name, tg = guessTarget(cur);
      if (matchesTarget(text, tg.t, tg.person)) {
        cur.solved[me] = { hint: cur.revealed || 0, t: Date.now() };
        cur.chat.push({ sys: true, text: `${name} hat es erraten!` });
      } else {
        cur.chat.push({ name, text });
        if (nearTarget(text, tg.t, tg.person)) send({ t: "near" });
      }
      if (cur.chat.length > 60) cur.chat.shift();
      return broadcast(room);
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
      if (["werbinich", "song", "bild"].includes(room.current.type) || Object.keys(room.current.answers).length) return resolve(room);
      return nextRound(room);
    }
  });

  ws.on("close", () => {
    if (!room || !me || !room.players[me]) return;
    room.players[me].connected = false;
    room.players[me].ws = null;
    // Host weg? Nächsten verbundenen Spieler zum Roundmaster machen.
    if (room.hostId === me) {
      const next = room.order.find((id) => room.players[id].connected);
      if (next) room.hostId = next;
    }
    if (room.phase === "question" && !["wop", "werbinich", "song", "bild"].includes(room.current.type) && Object.keys(room.current.answers).length && allAnswered(room)) resolve(room);
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
