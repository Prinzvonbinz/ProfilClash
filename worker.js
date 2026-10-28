"use strict";
const MAX_PLAYERS = 20;
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("WebSocket erforderlich.", { status: 426 });
      }
      const mode = url.searchParams.get("mode");
      let code = (url.searchParams.get("room") || "").toUpperCase();
      if (!["create", "join"].includes(mode)) return new Response("Ungültiger Modus.", { status: 400 });
      if (mode === "create") {
        let found = false;
        for (let i = 0; i < 10; i++) {
          code = createRoomCode();
          const id = env.ROOMS.idFromName(code);
          const room = env.ROOMS.get(id);
          const res = await room.fetch(new Request("https://internal/_exists"));
          const j = await res.json();
          if (!j.exists) { found = true; break; }
        }
        if (!found) return new Response("Keine freie Lobby.", { status: 503 });
      } else if (!/^[A-Z0-9]{6}$/.test(code)) {
        return new Response("Ungültiger Code.", { status: 400 });
      }
      const id = env.ROOMS.idFromName(code);
      const room = env.ROOMS.get(id);
      const target = new URL(request.url);
      target.searchParams.set("room", code);
      return room.fetch(new Request(target.toString(), request));
    }
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("PROFILE CLASH Server läuft.", { status: 200 });
  }
};

function createRoomCode() {
  const r = new Uint8Array(6);
  crypto.getRandomValues(r);
  return Array.from(r, v => CODE_CHARS[v % CODE_CHARS.length]).join("");
}

export class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env; this.state = null;
    this.loaded = this.ctx.storage.get("gameState").then(d => { this.state = d || null; });
  }
  async load() { await this.loaded; }
  async save() { if (this.state) await this.ctx.storage.put("gameState", this.state); else await this.ctx.storage.delete("gameState"); }
  async fetch(request) {
    await this.load();
    const url = new URL(request.url);
    if (url.pathname === "/_exists") return Response.json({ exists: Boolean(this.state) });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket erforderlich.", { status: 426 });
    const mode = url.searchParams.get("mode"), code = url.searchParams.get("room"), clientId = url.searchParams.get("clientId"), username = cleanUsername(url.searchParams.get("username"));
    if (!clientId || !username) return new Response("Name oder ID fehlt.", { status: 400 });
    if (mode === "create") {
      if (this.state) return new Response("Lobby existiert bereits.", { status: 409 });
      this.state = { code, phase: "lobby", hostId: clientId, players: [], settings: { rounds: 10, missingCount: 2, visibleCount: 8 }, roundsTotal: 10, roundIndex: 1, profile: null, missingKeys: [], answersByPlayer: {}, roundResult: null, history: [], usedPersonIds: [] };
      await this.save();
    }
    if (!this.state) return new Response("Lobby nicht gefunden.", { status: 404 });
    if (this.state.code !== code) return new Response("Code falsch.", { status: 400 });
    if (this.state.phase !== "lobby") {
      const ex = this.state.players.some(p => p.id === clientId);
      if (!ex) return new Response("Spiel läuft bereits.", { status: 409 });
    }
    const existingPlayer = this.state.players.find(p => p.id === clientId);
    if (!existingPlayer && this.state.players.length >= MAX_PLAYERS) return new Response("Lobby voll.", { status: 409 });
    const pair = new WebSocketPair(); const client = pair[0]; const server = pair[1];
    this.ctx.acceptWebSocket(server); server.serializeAttachment({ clientId, username });
    if (existingPlayer) existingPlayer.username = username;
    else this.state.players.push({ id: clientId, username, ready: false, submitted: false, score: 0 });
    if (!this.state.hostId) this.state.hostId = clientId;
    await this.save(); server.send(JSON.stringify({ type: "connected" })); await this.broadcast();
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws, message) {
    await this.load(); if (!this.state) return;
    let data; try { const t = typeof message === "string" ? message : new TextDecoder().decode(message); data = JSON.parse(t); } catch { this.sendError(ws, "Ungültige Nachricht."); return; }
    const att = ws.deserializeAttachment(); if (!att?.clientId) return;
    const player = this.state.players.find(p => p.id === att.clientId);
    if (!player) { this.sendError(ws, "Nicht mehr in Lobby."); return; }
    try {
      switch (data.type) {
        case "ready": if (this.state.phase !== "lobby") return; player.ready = Boolean(data.ready); await this.save(); await this.broadcast(); break;
        case "setSettings": this.requireHost(player.id); if (this.state.phase !== "lobby") throw new Error("Nur in Lobby."); this.state.settings = validateSettings(data.settings); await this.save(); await this.broadcast(); break;
        case "startGame": this.requireHost(player.id); if (this.state.phase !== "lobby") throw new Error("Läuft bereits."); if (this.state.players.length < 2) throw new Error("Mindestens 2 Spieler."); if (!this.state.players.every(p => p.ready)) throw new Error("Alle müssen bereit sein."); this.state.settings = validateSettings(data.settings); this.state.roundsTotal = this.state.settings.rounds; this.state.roundIndex = 1; this.state.history = []; this.state.usedPersonIds = []; for (const p of this.state.players) { p.score = 0; p.submitted = false; } await this.startRound(); break;
        case "submit": if (this.state.phase !== "playing") throw new Error("Keine Antworten mehr."); if (player.submitted) throw new Error("Schon geantwortet."); const answers = {}; const allowed = new Set(this.state.missingKeys); if (!data.answers || typeof data.answers !== "object" || Array.isArray(data.answers)) throw new Error("Ungültige Antworten."); for (const k of allowed) { const v = data.answers[k]; if (typeof v !== "string" || !v.trim() || v.length > 150) throw new Error("Bitte alle Felder ausfüllen."); answers[k] = v.trim(); } if (Object.keys(data.answers).some(k => !allowed.has(k))) throw new Error("Unbekanntes Feld."); this.state.answersByPlayer[player.id] = answers; player.submitted = true; await this.save(); if (this.state.players.every(p => p.submitted)) this.finishRound(); await this.save(); await this.broadcast(); break;
        case "nextRound": this.requireHost(player.id); if (this.state.phase !== "reveal") throw new Error("Noch nicht ausgewertet."); if (this.state.roundIndex >= this.state.roundsTotal) throw new Error("Letzte Runde."); this.state.roundIndex++; await this.startRound(); break;
        case "finishGame": this.requireHost(player.id); if (this.state.phase !== "reveal") throw new Error("Erst auswerten."); this.state.phase = "results"; await this.save(); await this.broadcast(); break;
        case "returnLobby": this.requireHost(player.id); if (this.state.phase !== "results") throw new Error("Noch nicht beendet."); this.state.phase = "lobby"; this.state.profile = null; this.state.missingKeys = []; this.state.answersByPlayer = {}; this.state.roundResult = null; this.state.history = []; this.state.usedPersonIds = []; this.state.roundIndex = 1; for (const p of this.state.players) { p.score = 0; p.ready = false; p.submitted = false; } await this.save(); await this.broadcast(); break;
        default: throw new Error("Unbekannter Befehl.");
      }
    } catch (e) { this.sendError(ws, e.message || "Fehler."); }
  }
  requireHost(id) { if (this.state.hostId !== id) throw new Error("Nur Host darf das."); }
  sendError(ws, m) { try { ws.send(JSON.stringify({ type: "error", message: m })); } catch {} }
  async broadcast() { for (const ws of this.ctx.getWebSockets()) { if (ws.readyState !== 1) continue; try { const a = ws.deserializeAttachment(); ws.send(JSON.stringify({ type: "state", state: this.publicState(a?.clientId) })); } catch {} } }
  publicState(clientId) {
    const result = JSON.parse(JSON.stringify(this.state));
    delete result.usedPersonIds; delete result.answersByPlayer;
    if (result.phase === "playing" && result.profile) {
      result.profile.fields = result.profile.fields.map(f => { if (result.missingKeys.includes(f.key)) return { ...f, value: null }; return f; });
      result.myAnswers = this.state.answersByPlayer?.[clientId] || null; result.roundResult = null;
    }
    return result;
  }
  async startRound() {
    this.state.phase = "lobby"; this.state.profile = null; this.state.missingKeys = []; this.state.answersByPlayer = {}; this.state.roundResult = null;
    await this.save(); await this.broadcast();
    try {
      const profile = await fetchRandomProfile(this.state.usedPersonIds, this.state.settings.visibleCount, this.state.settings.missingCount);
      this.state.profile = profile; this.state.usedPersonIds.push(profile.id);
      this.state.missingKeys = shuffle(profile.fields.map(f => f.key)).slice(0, this.state.settings.missingCount);
      for (const p of this.state.players) p.submitted = false;
      this.state.phase = "playing"; await this.save(); await this.broadcast();
    } catch (e) { this.state.phase = "lobby"; await this.save(); await this.broadcast(); throw new Error(e.message); }
  }
  finishRound() {
    const profile = this.state.profile;
    const results = this.state.players.map(player => {
      const answers = this.state.answersByPlayer[player.id] || {}; const fieldPoints = {}; let points = 0;
      for (const key of this.state.missingKeys) { const field = profile.fields.find(f => f.key === key); if (!field) continue; const earned = calculatePoints(answers[key], field.value); fieldPoints[key] = earned; points += earned; }
      player.score += points; return { id: player.id, username: player.username, answers, fieldPoints, points };
    });
    this.state.roundResult = { answers: results }; this.state.history.push({ round: this.state.roundIndex, category: profile.name, personId: profile.id, answers: results }); this.state.phase = "reveal";
  }
  async webSocketClose(ws) { await this.removeSocketPlayer(ws); }
  async webSocketError(ws) { await this.removeSocketPlayer(ws); }
  async removeSocketPlayer(ws) {
    await this.load(); if (!this.state) return; const a = ws.deserializeAttachment(); const clientId = a?.clientId; if (!clientId) return;
    const still = this.ctx.getWebSockets().some(o => { if (o === ws || o.readyState !== 1) return false; return o.deserializeAttachment()?.clientId === clientId; });
    if (still) return;
    this.state.players = this.state.players.filter(p => p.id !== clientId); delete this.state.answersByPlayer[clientId];
    if (this.state.players.length === 0) { this.state = null; await this.save(); return; }
    if (this.state.hostId === clientId) this.state.hostId = this.state.players[0].id; await this.save(); await this.broadcast();
  }
}
function validateSettings(s = {}) { const r = Number(s.rounds), m = Number(s.missingCount), v = Number(s.visibleCount); if (!Number.isInteger(r) || r < 1 || r > 100) throw new Error("Runden 1-100"); if (!Number.isInteger(v) || v < 2 || v > 30) throw new Error("Infos 2-30"); if (!Number.isInteger(m) || m < 1 || m >= v) throw new Error("Fehlende Infos ungültig"); return { rounds: r, missingCount: m, visibleCount: v }; }
function cleanUsername(v) { return String(v || "").replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, 20); }
async function fetchRandomProfile(usedIds, visibleCount, missingCount) {
  const excluded = usedIds.map(id => String(id).split("/").pop()).filter(id => /^Q\d+$/.test(id));
  const exclusionFilter = excluded.length ? `FILTER(?person NOT IN (${excluded.map(id => "wd:" + id).join(", ")}))` : "";
  const query = `SELECT ?person ?personLabel (SAMPLE(?image) AS ?imageUrl) (SAMPLE(?birthDate) AS ?birthDateValue) (SAMPLE(?birthPlaceLabel) AS ?birthPlaceName) (SAMPLE(?occupationLabel) AS ?occupationName) (SAMPLE(?citizenshipLabel) AS ?citizenshipName) (SAMPLE(?deathDate) AS ?deathDateValue) (SAMPLE(?awardLabel) AS ?awardName) (SAMPLE(?educationLabel) AS ?educationName) (SAMPLE(?notableWorkLabel) AS ?notableWorkName) (SAMPLE(?positionLabel) AS ?positionName) (SAMPLE(?fieldLabel) AS ?fieldName) (SAMPLE(?employerLabel) AS ?employerName) (SAMPLE(?memberLabel) AS ?memberName) (SAMPLE(?fatherLabel) AS ?fatherName) (SAMPLE(?motherLabel) AS ?motherName) (SAMPLE(?spouseLabel) AS ?spouseName) WHERE { ?person wdt:P31 wd:Q5; wdt:P569 ?birthDate; wdt:P18 ?image. FILTER(YEAR(?birthDate) >= 1700) ${exclusionFilter} OPTIONAL { ?person wdt:P19 ?birthPlace. } OPTIONAL { ?person wdt:P106 ?occupation. } OPTIONAL { ?person wdt:P27 ?citizenship. } OPTIONAL { ?person wdt:P570 ?deathDate. } OPTIONAL { ?person wdt:P166 ?award. } OPTIONAL { ?person wdt:P69 ?education. } OPTIONAL { ?person wdt:P800 ?notableWork. } OPTIONAL { ?person wdt:P39 ?position. } OPTIONAL { ?person wdt:P101 ?field. } OPTIONAL { ?person wdt:P108 ?employer. } OPTIONAL { ?person wdt:P463 ?member. } OPTIONAL { ?person wdt:P22 ?father. } OPTIONAL { ?person wdt:P25 ?mother. } OPTIONAL { ?person wdt:P26 ?spouse. } SERVICE wikibase:label { bd:serviceParam wikibase:language "de,en". ?person rdfs:label ?personLabel. ?birthPlace rdfs:label ?birthPlaceLabel. ?occupation rdfs:label ?occupationLabel. ?citizenship rdfs:label ?citizenshipLabel. ?award rdfs:label ?awardLabel. ?education rdfs:label ?educationLabel. ?notableWork rdfs:label ?notableWorkLabel. ?position rdfs:label ?positionLabel. ?field rdfs:label ?fieldLabel. ?employer rdfs:label ?employerLabel. ?member rdfs:label ?memberLabel. ?father rdfs:label ?fatherLabel. ?mother rdfs:label ?motherLabel. ?spouse rdfs:label ?spouseLabel. } } GROUP BY ?person ?personLabel ORDER BY RAND() LIMIT 40`;
  const endpoint = new URL("https://query.wikidata.org/sparql"); endpoint.searchParams.set("query", query); endpoint.searchParams.set("format", "json");
  const response = await fetch(endpoint, { headers: { Accept: "application/sparql-results+json", "User-Agent": "ProfileClash/1.0" }, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error("Wikidata down"); const json = await response.json(); const bindings = json.results?.bindings || []; const candidates = shuffle(bindings);
  for (const item of candidates) {
    const id = item.person?.value; if (!id || excluded.includes(id.split("/").pop())) continue; const birthYear = readYear(item.birthDateValue?.value); if (!birthYear) continue;
    const fields = []; const add = (k,l,v,u="")=>{ if(v===undefined||v===null||v==="")return; fields.push({key:k,label:l,value:v,unit:u}) };
    add("birthYear","Geburtsjahr",birthYear); add("birthPlace","Geburtsort",item.birthPlaceName?.value); add("occupation","Beruf",item.occupationName?.value); add("citizenship","Staatsangehörigkeit",item.citizenshipName?.value); const dy=readYear(item.deathDateValue?.value); if(dy) add("deathYear","Todesjahr",dy); add("award","Auszeichnung",item.awardName?.value); add("education","Ausbildung",item.educationName?.value); add("notableWork","Bekanntes Werk",item.notableWorkName?.value); add("position","Position",item.positionName?.value); add("field","Fachgebiet",item.fieldName?.value); add("employer","Arbeitgeber",item.employerName?.value); add("member","Mitgliedschaft",item.memberName?.value); add("father","Vater",item.fatherName?.value); add("mother","Mutter",item.motherName?.value); add("spouse","Ehepartner",item.spouseName?.value);
    if (fields.length <= missingCount) continue; const sel = shuffle(fields).slice(0, Math.min(visibleCount, fields.length)); if (sel.length <= missingCount) continue;
    const name = item.personLabel?.value || "Unbekannte Person"; const desc = [item.occupationName?.value, item.citizenshipName?.value].filter(Boolean).join(" · ");
    return { id, name, description: desc||"Echte Persönlichkeit", image: item.imageUrl?.value||"", updatedAt: "Abgerufen am "+new Date().toLocaleDateString("de-DE")+" · Wikidata", fields: sel };
  }
  throw new Error("Keine Person gefunden");
}
function readYear(v){ if(!v) return null; const m=String(v).match(/^(-?\d{4,})/); if(!m) return null; const y=Number(m[1]); return Number.isSafeInteger(y)?y:null; }
function normalizeAnswer(v){ return String(v??"").toLocaleLowerCase("de-DE").replace(/\s+/g,""); }
function calculatePoints(a,c){ const s=normalizeAnswer(a), sol=normalizeAnswer(c); if(!s||!sol) return 0; if(s===sol) return 100; const sn=Number(String(a).trim().replace(",",".")), cn=Number(c); if(Number.isFinite(sn)&&Number.isFinite(cn)&&String(a).trim()!==""){ const d=Math.abs(sn-cn); return Math.max(0,Math.round(100/(1+d))); } const dist=levenshtein(s,sol), len=Math.max(s.length,sol.length,1); return Math.max(0,Math.round(100*(1-dist/len))); }
function levenshtein(a,b){ const prev=Array.from({length:b.length+1},(_,i)=>i); for(let i=1;i<=a.length;i++){let diag=prev[0]; prev[0]=i; for(let j=1;j<=b.length;j++){const old=prev[j]; const cost=a[i-1]===b[j-1]?0:1; prev[j]=Math.min(prev[j]+1,prev[j-1]+1,diag+cost); diag=old}} return prev[b.length]; }
function shuffle(arr){ const r=[...arr]; for(let i=r.length-1;i>0;i--){ const x=new Uint32Array(1); crypto.getRandomValues(x); const j=x[0]%(i+1); [r[i],r[j]]=[r[j],r[i]] } return r; }
