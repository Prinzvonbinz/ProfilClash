"use strict";

/*
 * PROFILE CLASH
 * Cloudflare Worker + Durable Objects + WebSockets
 *
 * Funktionen:
 * - Multiplayer-Lobbys für 2–20 Spieler
 * - Sechsstellige Lobby-Codes
 * - Bereitschaftssystem und Spieleinstellungen
 * - Synchronisierte Spielrunden
 * - Geheime Antworten
 * - Punktesystem und Ranglisten
 * - Keine doppelten Personen innerhalb einer Partie
 * - Persönlichkeitsdaten aus Wikidata
 */

const MAX_PLAYERS = 20;
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. WebSocket immer zuerst
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("WebSocket erforderlich.", { status: 426 });
      }
      const mode = url.searchParams.get("mode");
      let code = (url.searchParams.get("room") || "").toUpperCase();

      if (!["create", "join"].includes(mode)) {
        return new Response("Ungültiger Verbindungsmodus.", { status: 400 });
      }

      if (mode === "create") {
        let found = false;
        for (let attempt = 0; attempt < 10; attempt++) {
          code = createRoomCode();
          const id = env.ROOMS.idFromName(code);
          const room = env.ROOMS.get(id);
          const response = await room.fetch(new Request("https://internal/_exists"));
          const result = await response.json();
          if (!result.exists) { found = true; break; }
        }
        if (!found) return new Response("Keine freie Lobby.", { status: 503 });
      } else if (!/^[A-Z0-9]{6}$/.test(code)) {
        return new Response("Ungültiger Lobby-Code.", { status: 400 });
      }

      const id = env.ROOMS.idFromName(code);
      const room = env.ROOMS.get(id);
      const target = new URL(request.url);
      target.searchParams.set("room", code);
      return room.fetch(new Request(target.toString(), request));
    }

    // 2. Assets danach - WICHTIG!
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("PROFILE CLASH Multiplayer-Server", { status: 200 });
  }
};

function createRoomCode() {
  const random = new Uint8Array(6);
  crypto.getRandomValues(random);

  return Array.from(random, value =>
    CODE_CHARS[value % CODE_CHARS.length]
  ).join("");
}


/* =========================================================
   DURABLE OBJECT: EINE INSTANZ PRO LOBBY
   ========================================================= */

export class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.state = null;

    this.loaded = this.ctx.storage.get("gameState").then(data => {
      this.state = data || null;
    });
  }

  async load() {
    await this.loaded;
  }

  async save() {
    if (this.state) {
      await this.ctx.storage.put("gameState", this.state);
    } else {
      await this.ctx.storage.delete("gameState");
    }
  }

  async fetch(request) {
    await this.load();

    const url = new URL(request.url);

    if (url.pathname === "/_exists") {
      return Response.json({
        exists: Boolean(this.state)
      });
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket erforderlich.", {
        status: 426
      });
    }const mode = url.searchParams.get("mode");
    const code = url.searchParams.get("room");
    const clientId = url.searchParams.get("clientId");
    const username = cleanUsername(
      url.searchParams.get("username")
    );

    if (!clientId || !username) {
      return new Response("Benutzername oder Spieler-ID fehlt.", {
        status: 400
      });
    }

    if (mode === "create") {
      if (this.state) {
        return new Response("Diese Lobby existiert bereits.", {
          status: 409
        });
      }

      this.state = {
        code,
        phase: "lobby",
        hostId: clientId,

        players: [],
        settings: {
          rounds: 10,
          missingCount: 2,
          visibleCount: 8
        },

        roundsTotal: 10,
        roundIndex: 1,

        profile: null,
        missingKeys: [],
        answersByPlayer: {},
        roundResult: null,

        history: [],
        usedPersonIds: []
      };

      await this.save();
    }

    if (!this.state) {
      return new Response("Diese Lobby existiert nicht.", {
        status: 404
      });
    }

    if (this.state.code !== code) {
      return new Response("Lobby-Code stimmt nicht.", {
        status: 400
      });
    }

    if (this.state.phase !== "lobby") {
      const existing = this.state.players.some(
        player => player.id === clientId
      );

      if (!existing) {
        return new Response("Diese Partie läuft bereits.", {
          status: 409
        });
      }
    }

    const existingPlayer = this.state.players.find(
      player => player.id === clientId
    );

    if (!existingPlayer && this.state.players.length >= MAX_PLAYERS) {
      return new Response("Die Lobby ist voll.", {
        status: 409
      });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.ctx.acceptWebSocket(server);

    server.serializeAttachment({
      clientId,
      username
    });

    if (existingPlayer) {
      existingPlayer.username = username;
    } else {
      this.state.players.push({
        id: clientId,
        username,
        ready: false,
        submitted: false,
        score: 0
      });
    }

    if (!this.state.hostId) {
      this.state.hostId = clientId;
    }

    await this.save();

    server.send(JSON.stringify({
      type: "connected"
    }));

    await this.broadcast();

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  async webSocketMessage(ws, message) {
    await this.load();

    if (!this.state) return;

    let data;

    try {
      const text = typeof message === "string"
        ? message
        : new TextDecoder().decode(message);

      data = JSON.parse(text);
    } catch {
      this.sendError(ws, "Ungültige Nachricht.");
      return;
    }

    const attachment = ws.deserializeAttachment();

    if (!attachment?.clientId) return;

    const player = this.state.players.find(
      item => item.id === attachment.clientId
    );

    if (!player) {
      this.sendError(ws, "Du bist nicht mehr in dieser Lobby.");
      return;
    }

    try {
      switch (data.type) {

        case "ready": {
          if (this.state.phase !== "lobby") return;

          player.ready = Boolean(data.ready);

          await this.save();
          await this.broadcast();
          break;
        }

        case "setSettings": {
          this.requireHost(player.id);

          if (this.state.phase !== "lobby") {
            throw new Error(
              "Einstellungen können nur in der Lobby geändert werden."
            );
          }

          this.state.settings = validateSettings(data.settings);

          await this.save();
          await this.broadcast();
          break;
        }case "startGame": {
          this.requireHost(player.id);

          if (this.state.phase !== "lobby") {
            throw new Error("Die Partie läuft bereits.");
          }

          if (this.state.players.length < 2) {
            throw new Error("Mindestens zwei Spieler werden benötigt.");
          }

          if (!this.state.players.every(item => item.ready)) {
            throw new Error(
              "Alle Spieler müssen zuerst bereit sein."
            );
          }

          this.state.settings = validateSettings(data.settings);
          this.state.roundsTotal = this.state.settings.rounds;
          this.state.roundIndex = 1;
          this.state.history = [];
          this.state.usedPersonIds = [];

          for (const item of this.state.players) {
            item.score = 0;
            item.submitted = false;
          }

          await this.startRound();
          break;
        }

        case "submit": {
          if (this.state.phase !== "playing") {
            throw new Error("Diese Runde nimmt keine Antworten an.");
          }

          if (player.submitted) {
            throw new Error("Du hast bereits geantwortet.");
          }

          const answers = {};
          const allowed = new Set(this.state.missingKeys);

          if (
            !data.answers ||
            typeof data.answers !== "object" ||
            Array.isArray(data.answers)
          ) {
            throw new Error("Ungültige Antworten.");
          }

          for (const key of allowed) {
            const value = data.answers[key];

            if (
              typeof value !== "string" ||
              !value.trim() ||
              value.length > 150
            ) {
              throw new Error(
                "Bitte beantworte alle fehlenden Informationen."
              );
            }

            answers[key] = value.trim();
          }

          if (Object.keys(data.answers).some(
            key => !allowed.has(key)
          )) {
            throw new Error("Unbekannte Antwortfelder.");
          }

          this.state.answersByPlayer[player.id] = answers;
          player.submitted = true;

          await this.save();

          if (this.state.players.every(item => item.submitted)) {
            this.finishRound();
          }

          await this.save();
          await this.broadcast();
          break;
        }

        case "nextRound": {
          this.requireHost(player.id);

          if (this.state.phase !== "reveal") {
            throw new Error("Die Runde wurde noch nicht ausgewertet.");
          }

          if (this.state.roundIndex >= this.state.roundsTotal) {
            throw new Error("Die letzte Runde ist bereits beendet.");
          }

          this.state.roundIndex++;

          await this.startRound();
          break;
        }

        case "finishGame": {
          this.requireHost(player.id);

          if (this.state.phase !== "reveal") {
            throw new Error("Die Runde muss zuerst ausgewertet werden.");
          }

          this.state.phase = "results";

          await this.save();
          await this.broadcast();
          break;
        }

        case "returnLobby": {
          this.requireHost(player.id);

          if (this.state.phase !== "results") {
            throw new Error("Die Partie ist noch nicht beendet.");
          }

          this.state.phase = "lobby";
          this.state.profile = null;
          this.state.missingKeys = [];
          this.state.answersByPlayer = {};
          this.state.roundResult = null;
          this.state.history = [];
          this.state.usedPersonIds = [];
          this.state.roundIndex = 1;

          for (const item of this.state.players) {
            item.score = 0;
            item.ready = false;item.submitted = false;
          }

          await this.save();
          await this.broadcast();
          break;
        }

        default:
          throw new Error("Unbekannter Spielbefehl.");
      }
    } catch (error) {
      this.sendError(ws, error.message || "Aktion fehlgeschlagen.");
    }
  }

  requireHost(clientId) {
    if (this.state.hostId !== clientId) {
      throw new Error("Nur der Host darf diese Aktion ausführen.");
    }
  }

  sendError(ws, message) {
    try {
      ws.send(JSON.stringify({
        type: "error",
        message
      }));
    } catch {}
  }

  async broadcast() {
    const sockets = this.ctx.getWebSockets();

    for (const ws of sockets) {
      if (ws.readyState !== 1) continue;

      try {
        const attachment = ws.deserializeAttachment();

        ws.send(JSON.stringify({
          type: "state",
          state: this.publicState(attachment?.clientId)
        }));
      } catch {}
    }
  }

  publicState(clientId) {
    const result = structuredClone(this.state);

    // Interne Daten niemals direkt an Spieler senden.
    delete result.usedPersonIds;
    delete result.answersByPlayer;

    if (result.phase === "playing" && result.profile) {
      result.profile.fields = result.profile.fields.map(field => {
        if (result.missingKeys.includes(field.key)) {
          return {
            ...field,
            value: null
          };
        }

        return field;
      });

      result.myAnswers =
        this.state.answersByPlayer?.[clientId] || null;

      result.roundResult = null;
    }

    return result;
  }

  async startRound() {
    this.state.phase = "lobby";
    this.state.profile = null;
    this.state.missingKeys = [];
    this.state.answersByPlayer = {};
    this.state.roundResult = null;

    await this.save();
    await this.broadcast();

    try {
      const profile = await fetchRandomProfile(
        this.state.usedPersonIds,
        this.state.settings.visibleCount,
        this.state.settings.missingCount
      );

      this.state.profile = profile;
      this.state.usedPersonIds.push(profile.id);

      this.state.missingKeys = shuffle(
        profile.fields.map(field => field.key)
      ).slice(0, this.state.settings.missingCount);

      for (const player of this.state.players) {
        player.submitted = false;
      }

      this.state.phase = "playing";

      await this.save();
      await this.broadcast();

    } catch (error) {
      this.state.phase = "lobby";

      await this.save();
      await this.broadcast();

      throw new Error(
        "Persönlichkeitsdaten konnten nicht geladen werden. " +
        "Bitte versuche es erneut. " + error.message
      );
    }
  }

  finishRound() {
    const profile = this.state.profile;

    const results = this.state.players.map(player => {
      const answers =
        this.state.answersByPlayer[player.id] || {};

      const fieldPoints = {};
      let points = 0;

      for (const key of this.state.missingKeys) {
        const field = profile.fields.find(
          item => item.key === key
        );

        if (!field) continue;

        const earned = calculatePoints(
          answers[key],
          field.value
        );

        fieldPoints[key] = earned;
        points += earned;
      }

      player.score += points;

      return {
        id: player.id,
        username: player.username,
        answers,
        fieldPoints,
        points
      };
    });

    this.state.roundResult = {
      answers: results
    };

    this.state.history.push({
      round: this.state.roundIndex,
      category: profile.name,
      personId: profile.id,
      answers: results
    });

    this.state.phase = "reveal";
  }

  async webSocketClose(ws) {await this.removeSocketPlayer(ws);
  }

  async webSocketError(ws) {
    await this.removeSocketPlayer(ws);
  }

  async removeSocketPlayer(ws) {
    await this.load();

    if (!this.state) return;

    const attachment = ws.deserializeAttachment();
    const clientId = attachment?.clientId;

    if (!clientId) return;

    // Ein anderer Tab desselben Spielers darf ihn nicht entfernen.
    const stillConnected = this.ctx.getWebSockets().some(other => {
      if (other === ws || other.readyState !== 1) return false;

      return other.deserializeAttachment()?.clientId === clientId;
    });

    if (stillConnected) return;

    this.state.players = this.state.players.filter(
      player => player.id !== clientId
    );

    delete this.state.answersByPlayer[clientId];

    if (this.state.players.length === 0) {
      this.state = null;
      await this.save();
      return;
    }

    if (this.state.hostId === clientId) {
      this.state.hostId = this.state.players[0].id;
    }

    await this.save();
    await this.broadcast();
  }
}


/* =========================================================
   EINSTELLUNGEN
   ========================================================= */

function validateSettings(settings = {}) {
  const rounds = Number(settings.rounds);
  const missingCount = Number(settings.missingCount);
  const visibleCount = Number(settings.visibleCount);

  if (
    !Number.isInteger(rounds) ||
    rounds < 1 ||
    rounds > 100
  ) {
    throw new Error("Spielrunden müssen zwischen 1 und 100 liegen.");
  }

  if (
    !Number.isInteger(visibleCount) ||
    visibleCount < 2 ||
    visibleCount > 30
  ) {
    throw new Error(
      "Die Anzahl der Informationen muss zwischen 2 und 30 liegen."
    );
  }

  if (
    !Number.isInteger(missingCount) ||
    missingCount < 1 ||
    missingCount >= visibleCount
  ) {
    throw new Error(
      "Die Anzahl fehlender Informationen ist ungültig."
    );
  }

  return {
    rounds,
    missingCount,
    visibleCount
  };
}

function cleanUsername(value) {
  return String(value || "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim()
    .slice(0, 20);
}


/* =========================================================
   WIKIDATA: ECHTE PERSÖNLICHKEITEN
   ========================================================= */

async function fetchRandomProfile(
  usedIds,
  visibleCount,
  missingCount
) {
  const excluded = usedIds
    .map(id => String(id).split("/").pop())
    .filter(id => /^Q\d+$/.test(id));

  const exclusionFilter = excluded.length
    ? `FILTER(?person NOT IN (${excluded.map(id => "wd:" + id).join(", ")}))`
    : "";

  const query = `
SELECT ?person ?personLabel
 (SAMPLE(?image) AS ?imageUrl)
 (SAMPLE(?birthDate) AS ?birthDateValue)
 (SAMPLE(?birthPlaceLabel) AS ?birthPlaceName)
 (SAMPLE(?occupationLabel) AS ?occupationName)
 (SAMPLE(?citizenshipLabel) AS ?citizenshipName)
 (SAMPLE(?deathDate) AS ?deathDateValue)
 (SAMPLE(?awardLabel) AS ?awardName)
 (SAMPLE(?educationLabel) AS ?educationName)
 (SAMPLE(?notableWorkLabel) AS ?notableWorkName)
 (SAMPLE(?positionLabel) AS ?positionName)
 (SAMPLE(?fieldLabel) AS ?fieldName)
 (SAMPLE(?employerLabel) AS ?employerName)
 (SAMPLE(?memberLabel) AS ?memberName)
 (SAMPLE(?fatherLabel) AS ?fatherName)
 (SAMPLE(?motherLabel) AS ?motherName)
 (SAMPLE(?spouseLabel) AS ?spouseName)
WHERE {
  ?person wdt:P31 wd:Q5;
          wdt:P569 ?birthDate;
          wdt:P18 ?image.

  FILTER(YEAR(?birthDate) >= 1700)
  ${exclusionFilter}

  OPTIONAL { ?person wdt:P19 ?birthPlace. }
  OPTIONAL { ?person wdt:P106 ?occupation. }
  OPTIONAL { ?person wdt:P27 ?citizenship. }
  OPTIONAL { ?person wdt:P570 ?deathDate. }
  OPTIONAL { ?person wdt:P166 ?award. }
  OPTIONAL { ?person wdt:P69 ?education. }OPTIONAL { ?person wdt:P800 ?notableWork. }
  OPTIONAL { ?person wdt:P39 ?position. }
  OPTIONAL { ?person wdt:P101 ?field. }
  OPTIONAL { ?person wdt:P108 ?employer. }
  OPTIONAL { ?person wdt:P463 ?member. }
  OPTIONAL { ?person wdt:P22 ?father. }
  OPTIONAL { ?person wdt:P25 ?mother. }
  OPTIONAL { ?person wdt:P26 ?spouse. }

  SERVICE wikibase:label {
    bd:serviceParam wikibase:language "de,en".
    ?person rdfs:label ?personLabel.
    ?birthPlace rdfs:label ?birthPlaceLabel.
    ?occupation rdfs:label ?occupationLabel.
    ?citizenship rdfs:label ?citizenshipLabel.
    ?award rdfs:label ?awardLabel.
    ?education rdfs:label ?educationLabel.
    ?notableWork rdfs:label ?notableWorkLabel.
    ?position rdfs:label ?positionLabel.
    ?field rdfs:label ?fieldLabel.
    ?employer rdfs:label ?employerLabel.
    ?member rdfs:label ?memberLabel.
    ?father rdfs:label ?fatherLabel.
    ?mother rdfs:label ?motherLabel.
    ?spouse rdfs:label ?spouseLabel.
  }
}
GROUP BY ?person ?personLabel
ORDER BY RAND()
LIMIT 40
`;

  const endpoint = new URL(
    "https://query.wikidata.org/sparql"
  );

  endpoint.searchParams.set("query", query);
  endpoint.searchParams.set("format", "json");

  const response = await fetch(endpoint, {
    headers: {
      Accept: "application/sparql-results+json",
      "User-Agent": "ProfileClash/1.0 (multiplayer quiz)"
    },
    signal: AbortSignal.timeout(20000)
  });

  if (!response.ok) {
    throw new Error("Wikidata antwortet momentan nicht.");
  }

  const json = await response.json();
  const bindings = json.results?.bindings || [];

  const candidates = shuffle(bindings);

  for (const item of candidates) {
    const id = item.person?.value;

    if (!id || excluded.includes(id.split("/").pop())) {
      continue;
    }

    const birthYear = readYear(item.birthDateValue?.value);

    if (!birthYear) continue;

    const fields = [];

    function add(key, label, value, unit = "") {
      if (value === undefined || value === null || value === "") {
        return;
      }

      fields.push({
        key,
        label,
        value,
        unit
      });
    }

    add("birthYear", "Geburtsjahr", birthYear);

    add(
      "birthPlace",
      "Geburtsort",
      item.birthPlaceName?.value
    );

    add(
      "occupation",
      "Beruf",
      item.occupationName?.value
    );

    add(
      "citizenship",
      "Staatsangehörigkeit",
      item.citizenshipName?.value
    );

    const deathYear = readYear(item.deathDateValue?.value);

    if (deathYear) {
      add("deathYear", "Todesjahr", deathYear);
    }

    add("award", "Auszeichnung", item.awardName?.value);
    add("education", "Ausbildung", item.educationName?.value);
    add("notableWork", "Bekanntes Werk", item.notableWorkName?.value);
    add("position", "Position", item.positionName?.value);
    add("field", "Fachgebiet", item.fieldName?.value);
    add("employer", "Arbeitgeber", item.employerName?.value);
    add("member", "Mitgliedschaft", item.memberName?.value);
    add("father", "Vater", item.fatherName?.value);
    add("mother", "Mutter", item.motherName?.value);
    add("spouse", "Ehepartner", item.spouseName?.value);

    if (fields.length <= missingCount) continue;

    const selectedFields = shuffle(fields).slice(
      0,
      Math.min(visibleCount, fields.length)
    );

    if (selectedFields.length <= missingCount) continue;

    const name = item.personLabel?.value || "Unbekannte Person";

    const occupation = item.occupationName?.value;
    const citizenship = item.citizenshipName?.value;

    const description = [
      occupation,
      citizenship
    ].filter(Boolean).join(" · ");

    return {
      id,
      name,
      description: description || "Echte Persönlichkeit",image: item.imageUrl?.value || "",
      updatedAt:
        "Abgerufen am " +
        new Date().toLocaleDateString("de-DE") +
        " · Wikidata",
      fields: selectedFields
    };
  }

  throw new Error(
    "Keine geeignete neue Persönlichkeit gefunden."
  );
}

function readYear(value) {
  if (!value) return null;

  const match = String(value).match(/^(-?\d{4,})/);

  if (!match) return null;

  const year = Number(match[1]);

  return Number.isSafeInteger(year) ? year : null;
}


/* =========================================================
   PUNKTEBERECHNUNG
   ========================================================= */

function normalizeAnswer(value) {
  return String(value ?? "")
    .toLocaleLowerCase("de-DE")
    .replace(/\s+/g, "");
}

function calculatePoints(answer, correct) {
  const submitted = normalizeAnswer(answer);
  const solution = normalizeAnswer(correct);

  if (!submitted || !solution) return 0;

  if (submitted === solution) {
    return 100;
  }

  const submittedNumber = Number(
    String(answer).trim().replace(",", ".")
  );

  const correctNumber = Number(correct);

  if (
    Number.isFinite(submittedNumber) &&
    Number.isFinite(correctNumber) &&
    String(answer).trim() !== ""
  ) {
    const difference = Math.abs(
      submittedNumber - correctNumber
    );

    return Math.max(
      0,
      Math.round(100 / (1 + difference))
    );
  }

  // Bei Wörtern wird die Schreibweise verglichen.
  // Eine feste alphabetische Rangliste aller möglichen Wörter
  // existiert nicht; deshalb verwenden wir Zeichenähnlichkeit.

  const distance = levenshtein(submitted, solution);

  const length = Math.max(
    submitted.length,
    solution.length,
    1
  );

  return Math.max(
    0,
    Math.round(100 * (1 - distance / length))
  );
}

function levenshtein(a, b) {
  const previous = Array.from(
    { length: b.length + 1 },
    (_, index) => index
  );

  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0];

    previous[0] = i;

    for (let j = 1; j <= b.length; j++) {
      const old = previous[j];

      const cost = a[i - 1] === b[j - 1] ? 0 : 1;

      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + cost
      );

      diagonal = old;
    }
  }

  return previous[b.length];
}


/* =========================================================
   HILFSFUNKTIONEN
   ========================================================= */

function shuffle(array) {
  const result = [...array];

  for (let i = result.length - 1; i > 0; i--) {
    const random = new Uint32Array(1);

    crypto.getRandomValues(random);

    const j = random[0] % (i + 1);

    [result[i], result[j]] = [result[j], result[i]];
  }

  return result;
}
