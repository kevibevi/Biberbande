const http = require("node:http");
const fs = require("node:fs");
const { randomBytes, randomInt } = require("node:crypto");

const html = fs.readFileSync(__dirname + "/index.html");
const rooms = new Map();

const check = (
  ok,
  message = "Diese Aktion ist gerade nicht möglich."
) => {
  if (!ok) throw new Error(message);
};

const numeric = card => Number.isInteger(card);

function shuffle(cards) {
  for (let i = cards.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }

  return cards;
}

function newDeck() {
  const cards = [];

  for (let value = 0; value <= 9; value++) {
    for (let i = 0; i < (value === 9 ? 9 : 4); i++) {
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

function newPlayer(name) {
  name = String(name || "").trim().slice(0, 20);
  check(name, "Gib einen Namen ein.");

  return {
    id: randomBytes(24).toString("hex"),
    name,
    hand: [],
    total: 0,
    score: 0,
    ready: false,
    seen: Date.now(),
    requests: []
  };
}

function beginRound(room) {
  room.round++;
  room.deck = newDeck();
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
    const person =
      room.players[(room.knocker + offset) % room.players.length];

    for (let i = 0; i < 4; i++) {
      if (!numeric(person.hand[i])) {
        room.pile.push(person.hand[i]);

        let card = draw(room);

        while (!numeric(card)) {
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
    room.message = room.players[room.turn].name + " hat geklopft!";
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

  const index = () => {
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

    beginRound(room);
    return;
  }

  if (body.action === "next") {
    check(
      me === 0 &&
      ["result", "finished"].includes(room.phase)
    );

    if (room.phase === "finished") {
      room.round = 0;
      room.players.forEach(player => player.total = 0);
    }

    beginRound(room);
    return;
  }

  if (body.action === "ready") {
    check(room.phase === "setup" && !person.ready);
    person.ready = true;

    if (room.players.every(player => player.ready)) {
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
    check(step === "draw" && numeric(room.pile.at(-1)));

    room.held = room.pile.pop();
    room.mode = "forced";
    room.step = "held";
    return;
  }

  if (body.action === "replace") {
    check(step === "held" && numeric(room.held));

    const i = index();

    room.pile.push(person.hand[i]);
    person.hand[i] = room.held;

    done(
      room,
      person.name + " hat Karte " + (i + 1) + " ersetzt."
    );

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
    check(step === "held" && !numeric(room.held));

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

    room.peek = index();
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

    const i = index();
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

    [person.hand[i], opponent.hand[otherIndex]] =
      [opponent.hand[otherIndex], person.hand[i]];

    done(
      room,
      person.name +
      " hat Karte " + (i + 1) +
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

  check(false, "Unbekannte Aktion.");
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

    players: room.players.map((player, playerIndex) => ({
      name: player.name,
      total: player.total,
      score: player.score,
      ready: player.ready,
      online: Date.now() - player.seen < 20000,

      hand: player.hand.map((card, cardIndex) => {
        const initial =
          room.phase === "setup" &&
          !person.ready &&
          (cardIndex === 0 || cardIndex === 3);

        const peek =
          room.phase === "play" &&
          mine &&
          room.step === "reveal" &&
          room.peek === cardIndex;

        const canSee =
          revealed ||
          (playerIndex === me && (initial || peek));

        return canSee ? card : null;
      })
    }))
  };
}

// Beschreibt Kartenbewegungen und wer die Vorderseite sehen darf.
function animation(room, person, body, before) {
  const actor = room.players.indexOf(person);
  const moves = [];

  const move = (from, to, card, audience = actor) => {
    moves.push({ from, to, card, audience });
  };

  const hand = (playerIndex, cardIndex) =>
    "hand:" + playerIndex + ":" + cardIndex;

  const held = "held:" + actor;
  let type = body.action;

  if (body.action === "start" || body.action === "next") {
    type = "deal";

    room.players.forEach((player, playerIndex) => {
      player.hand.forEach((card, cardIndex) => {
        move(
          "deck",
          hand(playerIndex, cardIndex),
          null,
          "none"
        );
      });
    });

    move("deck", "discard", room.pile.at(-1), "all");
  } else if (body.action === "draw") {
    move("deck", held, room.held);
  } else if (body.action === "take") {
    move("discard", held, room.held, "all");
  } else if (body.action === "replace") {
    move(
      hand(actor, body.index),
      "discard",
      before.own,
      "all"
    );

    move(held, hand(actor, body.index), before.held);
  } else if (body.action === "discard") {
    move(held, "discard", before.held, "all");
  } else if (body.action === "second") {
    move(held, "discard", before.held, "all");
    move("deck", held, room.held);
  } else if (body.action === "use") {
    move(held, "discard", before.held, "all");

    if (before.held === "Zweimal") {
      move("deck", held, room.held);
    }
  } else if (body.action === "swap") {
    move(
      hand(actor, body.index),
      hand(body.other, body.otherIndex),
      null,
      "none"
    );

    move(
      hand(body.other, body.otherIndex),
      hand(actor, body.index),
      null,
      "none"
    );
  }

  if (
    ["result", "finished"].includes(room.phase) &&
    body.action === "end"
  ) {
    type = "score";
  }

  return {
    type,
    actor,
    moves,
    index: Number.isInteger(body.index) ? body.index : null
  };
}

// Speichert für jeden Spieler eine eigene, gefilterte Ansicht.
function record(room, info) {
  const frames = room.players.map((person, viewer) => ({
    version: room.version,
    type: info.type,
    actor: info.actor,
    index: info.index ?? null,

    moves: info.moves.map(movement => ({
      from: movement.from,
      to: movement.to,

      card:
        movement.audience === "all" ||
        movement.audience === viewer
          ? movement.card
          : null
    })),

    state: view(room, person)
  }));

  // Kopie anlegen, damit spätere Züge alte Ereignisse nicht verändern.
  room.events.push(
    JSON.parse(JSON.stringify({
      version: room.version,
      frames
    }))
  );

  if (room.events.length > 80) {
    room.events.shift();
  }
}

function reply(room, person, since) {
  const viewer = room.players.indexOf(person);

  const earliest = room.events.length
    ? room.events[0].version - 1
    : room.version;

  const valid =
    Number.isInteger(since) &&
    since >= earliest &&
    since <= room.version;

  const events = valid
    ? room.events
        .filter(event => event.version > since)
        .map(event => event.frames[viewer])
    : [];

  const complete = valid && events.every(Boolean);

  return {
    state: view(room, person),
    events: complete ? events : [],
    resync: !complete
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

      const person = newPlayer(body.name);
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
        events: [],
        touched: Date.now(),
        message: "Warte auf deine Freunde."
      };

      rooms.set(code, room);

      send(200, {
        token: person.id,
        ...reply(room, person)
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

      const person = newPlayer(body.name);

      check(
        !room.players.some(
          player =>
            player.name.toLowerCase() === person.name.toLowerCase()
        ),
        "Dieser Name ist schon vergeben."
      );

      room.players.push(person);
      room.version++;
      room.touched = Date.now();

      record(room, {
        type: "join",
        actor: room.players.length - 1,
        moves: []
      });

      send(200, {
        token: person.id,
        ...reply(room, person)
      });

      return;
    }

    const person = room.players.find(
      player => player.id === body.token
    );

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

        const before = {
          held: room.held,
          own: person.hand[body.index]
        };

        act(room, person, body);
        room.version++;

        record(
          room,
          animation(room, person, body, before)
        );

        person.requests.push(body.request);

        if (person.requests.length > 30) {
          person.requests.shift();
        }
      }
    } else {
      check(req.url === "/api/state");
    }

    send(200, reply(room, person, body.since));
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

  if (
    req.method === "GET" &&
    ["/biber.png", "/karten.png"].includes(req.url)
  ) {
    try {
      const picture = fs.readFileSync(__dirname + req.url);

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
  () => console.log("Biberabend: Animation-Server bereit")
);

setInterval(() => {
  for (const [code, room] of rooms) {
    if (Date.now() - room.touched > 6 * 60 * 60 * 1000) {
      rooms.delete(code);
    }
  }
}, 60000).unref();
