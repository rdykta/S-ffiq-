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
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
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
};

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
  const cur = room.current ? { ...room.current, answers: undefined, correct: undefined } : null;
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
const WEIGHTS = { nie: 3, wer: 3, trivia: 3, oder: 2, schaetz: 2, wop: 1 };
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

function clearTimer(room) { if (room.timer) { clearTimeout(room.timer); room.timer = null; } }

function nextRound(room) {
  clearTimer(room);
  room.round += 1;
  room.phase = "question";
  const cat = nextCat(room);
  const connected = room.order.filter((id) => room.players[id].connected);
  let cur = { type: cat, label: CATS[cat], answers: {} };

  if (cat === "nie") cur.text = pick(room, "nie");
  else if (cat === "wer") cur.text = pick(room, "wer");
  else if (cat === "schaetz") { const q = pick(room, "schaetz"); cur.text = q.q; cur.answer = q.a; cur.unit = q.unit; }
  else if (cat === "trivia") { const q = pick(room, "trivia"); cur.text = q.q; cur.options = q.o; cur.correct = q.c; }
  else if (cat === "oder") { const o = pick(room, "oder"); cur.text = "Entweder oder?"; cur.options = o; }
  else if (cat === "wop") {
    cur.target = rand(connected.length ? connected : room.order);
    cur.text = "Wahrheit oder Pflicht?";
    cur.stage = "choose"; // choose -> task
  }
  if (room.timerSec > 0 && cat !== "wop") {
    const sec = cat === "schaetz" ? room.timerSec + 10 : room.timerSec;
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
  } else if (cur.type === "trivia") {
    const wrong = ids.filter((id) => A[id] !== cur.correct);
    const right = ids.filter((id) => A[id] === cur.correct);
    res.answer = cur.options[cur.correct];
    res.votes = cur.options.map((o, i) => ({ name: o, n: ids.filter((id) => A[id] === i).length }));
    wrong.forEach((id) => give(id, 1));
    res.drinkers = wrong.map((id) => ({ id, name: P[id].name, n: 1 }));
    res.lines.push(!ids.length ? "Keiner hat geantwortet." : right.length === ids.length ? "Alle richtig. Streber." : right.length ? `${right.length} von ${ids.length} wussten's.` : "Keiner wusste es. Alle trinken.");
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
      if (Object.keys(room.current.answers).length) return resolve(room);
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
    if (room.phase === "question" && room.current.type !== "wop" && Object.keys(room.current.answers).length && allAnswered(room)) resolve(room);
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
