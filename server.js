const http = require("node:http");
const fs = require("node:fs");
const { randomBytes, randomInt } = require("node:crypto");

const html = fs.readFileSync(__dirname + "/index.html");
const rooms = new Map();

const fail = message => {
throw new Error(message);
};

const check = (
ok,
message = "Diese Aktion ist gerade nicht möglich."
) => {
if (!ok) fail(message);
};

const token = () => randomBytes(24).toString("hex");
const number = card => Number.isInteger(card);

function shuffle(cards) {
for (let i = cards.length - 1; i > 0; i--) {
const j = randomInt(i + 1);
[cards[i], cards[j]] = [cards[j], cards[i]];
}
return cards;
}

function deck() {
const cards = [];

for (let value = 0; value <= 9; value++) {
const count = value === 9 ? 9 : 4;

for (let i = 0; i < count; i++) {
  cards.push(value);
}
}

for (const [card, count] of [
["Tausch", 9],
["Spähen", 7],
["Zweimal", 5]
]) {
for (let i = 0; i < count; i++) {
cards.push(card);
}
}

return shuffle(cards);
}

function draw(room) {
if (!room.deck.length) {
const top = room.pile.pop();
room.deck = shuffle(room.pile);
room.pile = top === undefined ? [] : [top];
}

check(room.deck.length, "Keine Karten mehr vorhanden.");
return room.deck.pop();
}

function player(name) {
name = String(name || "").trim().slice(0, 20);
check(name, "Gib einen Namen ein.");

return {
id: token(),
name,
hand: [],
total: 0,
score: 0,
ready: false,
seen: Date.now(),
requests: []
};
}

function round(room) {
room.round++;
room.deck = deck();
room.pile = [];
room.turn = (room.round - 1) % room.players.length;
room.phase = "setup";
room.step = "draw";
room.held = null;
room.mode = "";
room.peek = null;
room.knocker = null;
room.remaining = null;

for (const person of room.players) {
person.hand = Array.from({ length: 4 }, () => draw(room));
person.ready = false;
}

room.pile.push(draw(room));
room.message = "Merkt euch eure beiden äußeren Karten.";
}

function done(room, message) {
room.step = "end";
room.held = null;
room.peek = null;
room.mode = "";
room.message = message;
}

function scoreRound(room) {
for (let offset = 0; offset < room.players.length; offset++) {
const position =
(room.knocker + offset) % room.players.length;

const person = room.players[position];

for (let i = 0; i < 4; i++) {
  if (!number(person.hand[i])) {
    room.pile.push(person.hand[i]);

    let card = draw(room);

    while (!number(card)) {
      room.pile.push(card);
      card = draw(room);
    }

    person.hand[i] = card;
  }
}

person.score = person.hand.reduce((sum, value) => sum + value, 0);
person.total += person.score;
}

room.phase =
room.round >= room.players.length ? "finished" : "result";

room.message =
room.phase === "finished"
? "Partie beendet – die wenigsten Punkte gewinnen!"
: "Runde ausgewertet.";
}

function endTurn(room, knock) {
if (knock) {
check(room.knocker === null);

room.knocker = room.turn;
room.remaining = room.players.length - 1;

room.message =
  room.players[room.turn].name +
  " hat geklopft! Alle anderen sind noch einmal dran.";
} else if (room.knocker !== null) {
room.remaining--;

if (room.remaining === 0) {
  scoreRound(room);
  return;
}
}

room.turn = (room.turn + 1) % room.players.length;
room.step = "draw";
room.mode = "";
room.held = null;
room.peek = null;
}

function act(room, person, body) {
const me = room.players.indexOf(person);

const ownIndex = () => {
check(
Number.isInteger(body.index) &&
body.index >= 0 &&
body.index < 4
);

return body.index;
};

if (body.action === "start") {
check(
me === 0 &&
room.phase === "lobby" &&
room.players.length >= 2
);

round(room);
return;
}

if (body.action === "next") {
check(
me === 0 &&
["result", "finished"].includes(room.phase)
);

if (room.phase === "finished") {
  room.round = 0;
  room.players.forEach(p => p.total = 0);
}

round(room);
return;
}

if (body.action === "ready") {
check(room.phase === "setup" && !person.ready);
person.ready = true;

if (room.players.every(p => p.ready)) {
  room.phase = "play";
  room.message = "Los geht’s!";
}

return;
}

check(
room.phase === "play" && room.turn === me,
"Du bist gerade nicht am Zug."
);

const step = room.step;

if (body.action === "draw") {
check(step === "draw");

room.held = draw(room);
room.mode = "";
room.step = "held";
return;
}

if (body.action === "take") {
check(step === "draw" && number(room.pile.at(-1)));

room.held = room.pile.pop();
room.mode = "forced";
room.step = "held";
return;
}

if (body.action === "replace") {
check(step === "held" && number(room.held));

const index = ownIndex();

room.pile.push(person.hand[index]);
person.hand[index] = room.held;

done(room, person.name + " hat eine eigene Karte ersetzt.");
return;
}

if (body.action === "discard") {
check(step === "held" && room.mode === "");

room.pile.push(room.held);
done(room, person.name + " hat eine Karte abgelegt.");
return;
}

if (body.action === "second") {
check(step === "held" && room.mode === "first");

room.pile.push(room.held);
room.held = draw(room);
room.mode = "forced";
return;
}

if (body.action === "use") {
check(step === "held" && !number(room.held));

const card = room.held;

room.pile.push(card);
room.held = null;
room.mode = "";

if (card === "Zweimal") {
  room.held = draw(room);
  room.mode = "first";
  room.step = "held";
} else {
  room.step = card === "Spähen" ? "peek" : "swap";
}

return;
}

if (body.action === "peek") {
check(step === "peek");

room.peek = ownIndex();
room.step = "reveal";
return;
}

if (body.action === "close") {
check(step === "reveal");

done(room, person.name + " hat eine eigene Karte angeschaut.");
return;
}

if (body.action === "swap") {
check(step === "swap");

const index = ownIndex();
const other = body.other;
const otherIndex = body.otherIndex;

check(
  Number.isInteger(other) &&
  other >= 0 &&
  other < room.players.length &&
  other !== me
);

check(
  Number.isInteger(otherIndex) &&
  otherIndex >= 0 &&
  otherIndex < 4
);

const opponent = room.players[other];

[person.hand[index], opponent.hand[otherIndex]] =
  [opponent.hand[otherIndex], person.hand[index]];

done(
  room,
  person.name +
  " hat Karte " + (index + 1) +
  " mit " + opponent.name +
  "s Karte " + (otherIndex + 1) +
  " getauscht."
);

return;
}

if (body.action === "end" || body.action === "knock") {
check(step === "end");
endTurn(room, body.action === "knock");
return;
}

fail("Unbekannte Aktion.");
}

function view(room, person) {
const me = room.players.indexOf(person);
const mine = me === room.turn;
const revealed = ["result", "finished"].includes(room.phase);

return {
code: room.code,
version: room.version,
me,
phase: room.phase,
round: room.round,
turn: room.turn,
step: room.step,
mode: mine ? room.mode : "",
held: mine ? room.held : null,
top: room.pile?.at(-1) ?? null,
knocker: room.knocker,
remaining: room.remaining,
message: room.message,

players: room.players.map((p, playerIndex) => ({
  name: p.name,
  total: p.total,
  score: p.score,
  ready: p.ready,
  online: Date.now() - p.seen < 20000,

  hand: p.hand.map((card, cardIndex) => {
    const initialPeek =
      room.phase === "setup" &&
      !person.ready &&
      (cardIndex === 0 || cardIndex === 3);

    const actionPeek =
      room.phase === "play" &&
      mine &&
      room.step === "reveal" &&
      room.peek === cardIndex;

    const canSee =
      revealed ||
      (playerIndex === me && (initialPeek || actionPeek));

    return canSee ? card : null;
  })
}))
};
}

async function api(req, res) {
const send = (status, data) => {
res.writeHead(status, {
"Content-Type": "application/json",
"Cache-Control": "no-store"
});

res.end(JSON.stringify(data));
};

try {
check(
req.method === "POST" &&
(req.headers["content-type"] || "")
.startsWith("application/json")
);

let raw = "";

for await (const chunk of req) {
  raw += chunk;
  check(raw.length < 8192, "Anfrage zu groß.");
}

const body = JSON.parse(raw);
check(body && typeof body === "object", "Ungültige Anfrage.");

if (req.url === "/api/create") {
  check(rooms.size < 200, "Server voll. Versuche es später.");

  const person = player(body.name);
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;

  do {
    code = Array.from(
      { length: 6 },
      () => alphabet[randomInt(alphabet.length)]
    ).join("");
  } while (rooms.has(code));

  const room = {
    code,
    players: [person],
    phase: "lobby",
    round: 0,
    version: 1,
    touched: Date.now(),
    message: "Warte auf deine Freunde."
  };

  rooms.set(code, room);

  send(200, {
    token: person.id,
    state: view(room, person)
  });

  return;
}

const code = String(body.code || "").trim().toUpperCase();
const room = rooms.get(code);

if (!room) {
  send(404, {
    error:
      "Lobby nicht gefunden. Sie wurde beendet oder der Server neu gestartet."
  });
  return;
}

if (req.url === "/api/join") {
  check(room.phase === "lobby", "Diese Partie läuft bereits.");
  check(room.players.length < 6, "Die Lobby ist voll.");

  const person = player(body.name);

  check(
    !room.players.some(
      p => p.name.toLowerCase() === person.name.toLowerCase()
    ),
    "Dieser Name ist schon vergeben."
  );

  room.players.push(person);
  room.version++;
  room.touched = Date.now();

  send(200, {
    token: person.id,
    state: view(room, person)
  });

  return;
}

const person = room.players.find(p => p.id === body.token);

if (!person) {
  send(401, {
    error: "Dein Zugang zu dieser Lobby ist ungültig."
  });
  return;
}

person.seen = Date.now();
room.touched = person.seen;

if (req.url === "/api/action") {
  check(
    typeof body.request === "string" &&
    body.request.length <= 100
  );

  if (!person.requests.includes(body.request)) {
    check(
      body.version === room.version,
      "Spielstand geändert. Bitte versuche die Aktion erneut."
    );

    act(room, person, body);
    room.version++;
    person.requests.push(body.request);

    if (person.requests.length > 30) {
      person.requests.shift();
    }
  }
} else {
  check(req.url === "/api/state");
}

send(200, { state: view(room, person) });
} catch (error) {
send(400, {
error:
error instanceof SyntaxError
? "Ungültige Anfrage."
: error.message
});
}
}

const server = http.createServer((req, res) => {
res.setHeader("X-Content-Type-Options", "nosniff");
res.setHeader("Referrer-Policy", "no-referrer");

res.setHeader(
"Content-Security-Policy",
"default-src 'self'; " +
"script-src 'self' 'unsafe-inline'; " +
"style-src 'self' 'unsafe-inline'; " +
"connect-src 'self'; " +
"frame-ancestors 'none'; " +
"base-uri 'none'"
);

if (req.url.startsWith("/api/")) {
api(req, res);
return;
}

if (req.method === "GET" && req.url === "/biber.png") {
try {
const picture = fs.readFileSync(__dirname + "/biber.png");

  res.writeHead(200, {
    "Content-Type": "image/png",
    "Cache-Control": "public, max-age=3600"
  });

  res.end(picture);
} catch {
  res.writeHead(404);
  res.end();
}

return;
}

if (
req.method === "GET" &&
(req.url === "/" || req.url.startsWith("/?"))
) {
res.writeHead(200, {
"Content-Type": "text/html; charset=utf-8",
"Cache-Control": "no-store"
});

res.end(html);
} else {
res.writeHead(404);
res.end("Nicht gefunden");
}
});

server.requestTimeout = 15000;

server.listen(
process.env.PORT || 3000,
"0.0.0.0",
() => console.log("Spielserver bereit")
);

setInterval(() => {
for (const [code, room] of rooms) {
if (Date.now() - room.touched > 6 * 60 * 60 * 1000) {
rooms.delete(code);
}
}
}, 60000).unref();
