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
      let code = (url.searchParams.get("room") || "").toUpperCase();
      const mode = url.searchParams.get("mode");

      if (!["create", "join"].includes(mode)) return new Response("Ungültiger Modus", { status: 400 });

      // Bei create einfach neuen Code erzeugen, keine Exists-Abfrage mehr
      if (mode === "create") {
        if (!/^[A-Z0-9]{6}$/.test(code)) code = createRoomCode();
      }
      
      if (!/^[A-Z0-9]{6}$/.test(code)) return new Response("Ungültiger Code", { status: 400 });

      const id = env.ROOMS.idFromName(code);
      const room = env.ROOMS.get(id);
      // Direkt weiterleiten, keine Vorab-Prüfung
      return room.fetch(request);
    }

    // Assets (dein index.html)
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("PROFILE CLASH Server läuft", { status: 200 });
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
    const mode = url.searchParams.get("mode");
    const code = (url.searchParams.get("room") || "").toUpperCase();
    const clientId = url.searchParams.get("clientId");
    const username = String(url.searchParams.get("username")||"").replace(/[\u0000-\u001F\u007F]/g,"").trim().slice(0,20);

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("426", {status:426});
    if (!clientId || !username) return new Response("Name fehlt", {status:400});
    if (!/^[A-Z0-9]{6}$/.test(code)) return new Response("Code falsch", {status:400});

    if (mode === "create") {
      if (this.state) return new Response("Lobby existiert", {status:409});
      this.state = { code, phase:"lobby", hostId:clientId, players:[], settings:{rounds:10,missingCount:2,visibleCount:8}, roundsTotal:10, roundIndex:1, profile:null, missingKeys:[], answersByPlayer:{}, roundResult:null, history:[], usedPersonIds:[] };
      await this.save();
    }

    if (!this.state) return new Response("Lobby nicht gefunden", {status:404});
    if (this.state.code !== code) return new Response("Code mismatch", {status:400});
    if (this.state.phase !== "lobby" && !this.state.players.some(p=>p.id===clientId)) return new Response("Spiel läuft", {status:409});

    const existing = this.state.players.find(p=>p.id===clientId);
    if (!existing && this.state.players.length >= MAX_PLAYERS) return new Response("Voll", {status:409});

    const pair = new WebSocketPair(); const client=pair[0], server=pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({clientId,username});

    if (existing) existing.username=username;
    else this.state.players.push({id:clientId,username,ready:false,submitted:false,score:0});
    if (!this.state.hostId) this.state.hostId=clientId;

    await this.save();
    server.send(JSON.stringify({type:"connected"}));
    await this.broadcast();
    return new Response(null,{status:101,webSocket:client});
  }

  async webSocketMessage(ws, message){
    await this.load(); if(!this.state) return;
    let data; try{ data=JSON.parse(typeof message==="string"?message:new TextDecoder().decode(message)); }catch{ this.sendError(ws,"Ungültige Nachricht"); return; }
    const att=ws.deserializeAttachment(); const player=this.state.players.find(p=>p.id===att.clientId); if(!player) return;
    try{
      switch(data.type){
        case "ready": if(this.state.phase!=="lobby") return; player.ready=Boolean(data.ready); await this.save(); await this.broadcast(); break;
        case "setSettings": this.requireHost(player.id); if(this.state.phase!=="lobby") throw new Error("Nur Lobby"); this.state.settings=validateSettings(data.settings); await this.save(); await this.broadcast(); break;
        case "startGame": this.requireHost(player.id); if(this.state.phase!=="lobby") throw new Error("Läuft"); if(this.state.players.length<2) throw new Error("Min 2 Spieler"); if(!this.state.players.every(p=>p.ready)) throw new Error("Alle bereit?"); this.state.settings=validateSettings(data.settings); this.state.roundsTotal=this.state.settings.rounds; this.state.roundIndex=1; this.state.history=[]; this.state.usedPersonIds=[]; for(const p of this.state.players){p.score=0;p.submitted=false} await this.startRound(); break;
        case "submit": if(this.state.phase!=="playing") throw new Error("Keine Antworten"); if(player.submitted) throw new Error("Schon"); const answers={}; const allowed=new Set(this.state.missingKeys); if(!data.answers||typeof data.answers!=="object") throw new Error("Ungültig"); for(const k of allowed){ const v=data.answers[k]; if(typeof v!=="string"||!v.trim()||v.length>150) throw new Error("Alle ausfüllen"); answers[k]=v.trim(); } this.state.answersByPlayer[player.id]=answers; player.submitted=true; await this.save(); if(this.state.players.every(p=>p.submitted)) this.finishRound(); await this.save(); await this.broadcast(); break;
        case "nextRound": this.requireHost(player.id); if(this.state.phase!=="reveal") throw new Error("Noch nicht"); if(this.state.roundIndex>=this.state.roundsTotal) throw new Error("Letzte"); this.state.roundIndex++; await this.startRound(); break;
        case "finishGame": this.requireHost(player.id); this.state.phase="results"; await this.save(); await this.broadcast(); break;
        case "returnLobby": this.requireHost(player.id); this.state.phase="lobby"; this.state.profile=null; this.state.missingKeys=[]; this.state.answersByPlayer={}; this.state.roundResult=null; this.state.history=[]; this.state.usedPersonIds=[]; this.state.roundIndex=1; for(const p of this.state.players){p.score=0;p.ready=false;p.submitted=false} await this.save(); await this.broadcast(); break;
        default: throw new Error("Unbekannt");
      }
    }catch(e){ this.sendError(ws,e.message); }
  }
  requireHost(id){ if(this.state.hostId!==id) throw new Error("Nur Host"); }
  sendError(ws,m){ try{ ws.send(JSON.stringify({type:"error",message:m})); }catch{} }
  async broadcast(){ for(const ws of this.ctx.getWebSockets()){ if(ws.readyState!==1) continue; try{ const a=ws.deserializeAttachment(); ws.send(JSON.stringify({type:"state",state:this.publicState(a?.clientId)})); }catch{} } }
  publicState(clientId){ const result=JSON.parse(JSON.stringify(this.state)); delete result.usedPersonIds; delete result.answersByPlayer; if(result.phase==="playing"&&result.profile){ result.profile.fields=result.profile.fields.map(f=>{ if(result.missingKeys.includes(f.key)) return {...f,value:null}; return f; }); result.myAnswers=this.state.answersByPlayer?.[clientId]||null; result.roundResult=null; } return result; }
  async startRound(){ this.state.phase="lobby"; this.state.profile=null; this.state.missingKeys=[]; this.state.answersByPlayer={}; this.state.roundResult=null; await this.save(); await this.broadcast(); try{ const profile=await fetchRandomProfile(this.state.usedPersonIds,this.state.settings.visibleCount,this.state.settings.missingCount); this.state.profile=profile; this.state.usedPersonIds.push(profile.id); this.state.missingKeys=shuffle(profile.fields.map(f=>f.key)).slice(0,this.state.settings.missingCount); for(const p of this.state.players) p.submitted=false; this.state.phase="playing"; await this.save(); await this.broadcast(); }catch(e){ this.state.phase="lobby"; await this.save(); await this.broadcast(); } }
  finishRound(){ const profile=this.state.profile; const results=this.state.players.map(player=>{ const answers=this.state.answersByPlayer[player.id]||{}; let points=0; for(const key of this.state.missingKeys){ const field=profile.fields.find(f=>f.key===key); if(!field) continue; points+=calculatePoints(answers[key],field.value); } player.score+=points; return {id:player.id,username:player.username,answers,points}; }); this.state.roundResult={answers:results}; this.state.history.push({round:this.state.roundIndex,category:profile.name,personId:profile.id,answers:results}); this.state.phase="reveal"; }
  async webSocketClose(ws){ await this.removeSocketPlayer(ws); }
  async webSocketError(ws){ await this.removeSocketPlayer(ws); }
  async removeSocketPlayer(ws){ await this.load(); if(!this.state) return; const a=ws.deserializeAttachment(); const clientId=a?.clientId; if(!clientId) return; const still=this.ctx.getWebSockets().some(o=>{ if(o===ws||o.readyState!==1) return false; return o.deserializeAttachment()?.clientId===clientId; }); if(still) return; this.state.players=this.state.players.filter(p=>p.id!==clientId); delete this.state.answersByPlayer[clientId]; if(this.state.players.length===0){ this.state=null; await this.save(); return; } if(this.state.hostId===clientId) this.state.hostId=this.state.players[0].id; await this.save(); await this.broadcast(); }
}
function validateSettings(s={}){ const r=Number(s.rounds), m=Number(s.missingCount), v=Number(s.visibleCount); if(!Number.isInteger(r)||r<1||r>100) throw new Error("Runden 1-100"); if(!Number.isInteger(v)||v<2||v>30) throw new Error("Infos 2-30"); if(!Number.isInteger(m)||m<1||m>=v) throw new Error("Fehlende ungültig"); return {rounds:r,missingCount:m,visibleCount:v}; }
async function fetchRandomProfile(usedIds,visibleCount,missingCount){
  const excluded=usedIds.map(id=>String(id).split("/").pop()).filter(id=>/^Q\d+$/.test(id));
  const exFilter=excluded.length?`FILTER(?person NOT IN (${excluded.map(id=>"wd:"+id).join(", ")}))`:"";
  const query=`SELECT ?person ?personLabel (SAMPLE(?image) AS ?imageUrl) (SAMPLE(?birthDate) AS ?birthDateValue) (SAMPLE(?birthPlaceLabel) AS ?birthPlaceName) (SAMPLE(?occupationLabel) AS ?occupationName) (SAMPLE(?citizenshipLabel) AS ?citizenshipName) (SAMPLE(?deathDate) AS ?deathDateValue) WHERE { ?person wdt:P31 wd:Q5; wdt:P569 ?birthDate; wdt:P18 ?image. FILTER(YEAR(?birthDate) >= 1700) ${exFilter} OPTIONAL{?person wdt:P19 ?birthPlace} OPTIONAL{?person wdt:P106 ?occupation} OPTIONAL{?person wdt:P27 ?citizenship} OPTIONAL{?person wdt:P570 ?deathDate} SERVICE wikibase:label{bd:serviceParam wikibase:language "de,en". ?person rdfs:label ?personLabel. ?birthPlace rdfs:label ?birthPlaceLabel. ?occupation rdfs:label ?occupationLabel. ?citizenship rdfs:label ?citizenshipLabel.} } GROUP BY ?person ?personLabel ORDER BY RAND() LIMIT 40`;
  const endpoint=new URL("https://query.wikidata.org/sparql"); endpoint.searchParams.set("query",query); endpoint.searchParams.set("format","json");
  const res=await fetch(endpoint,{headers:{Accept:"application/sparql-results+json","User-Agent":"ProfileClash/1.0"},signal:AbortSignal.timeout(15000)});
  if(!res.ok) throw new Error("Wikidata"); const j=await res.json(); const bindings=j.results?.bindings||[]; const cand=shuffle(bindings);
  for(const item of cand){
    const id=item.person?.value; if(!id) continue; const birthYear=readYear(item.birthDateValue?.value); if(!birthYear) continue;
    const fields=[]; const add=(k,l,v)=>{ if(!v) return; fields.push({key:k,label:l,value:v}) };
    add("birthYear","Geburtsjahr",birthYear); add("birthPlace","Geburtsort",item.birthPlaceName?.value); add("occupation","Beruf",item.occupationName?.value); add("citizenship","Staatsangehörigkeit",item.citizenshipName?.value); const dy=readYear(item.deathDateValue?.value); if(dy) add("deathYear","Todesjahr",dy);
    if(fields.length<=missingCount) continue; const sel=shuffle(fields).slice(0,Math.min(visibleCount,fields.length)); if(sel.length<=missingCount) continue;
    return {id,name:item.personLabel?.value||"Person",description:[item.occupationName?.value,item.citizenshipName?.value].filter(Boolean).join(" · ")||"Persönlichkeit",image:item.imageUrl?.value||"",updatedAt:"Wikidata "+new Date().toLocaleDateString("de-DE"),fields:sel};
  }
  throw new Error("Keine Person");
}
function readYear(v){ if(!v) return null; const m=String(v).match(/^(-?\d{4,})/); if(!m) return null; const y=Number(m[1]); return Number.isSafeInteger(y)?y:null; }
function normalizeAnswer(v){ return String(v??"").toLowerCase().replace(/\s+/g,""); }
function calculatePoints(a,c){ const s=normalizeAnswer(a), sol=normalizeAnswer(c); if(!s||!sol) return 0; if(s===sol) return 100; const sn=Number(String(a).trim().replace(",",".")), cn=Number(c); if(Number.isFinite(sn)&&Number.isFinite(cn)){ const d=Math.abs(sn-cn); return Math.max(0,Math.round(100/(1+d))); } const dist=levenshtein(s,sol), len=Math.max(s.length,sol.length,1); return Math.max(0,Math.round(100*(1-dist/len))); }
function levenshtein(a,b){ const prev=Array.from({length:b.length+1},(_,i)=>i); for(let i=1;i<=a.length;i++){let diag=prev[0]; prev[0]=i; for(let j=1;j<=b.length;j++){const old=prev[j]; prev[j]=Math.min(prev[j]+1,prev[j-1]+1,diag+(a[i-1]===b[j-1]?0:1)); diag=old}} return prev[b.length]; }
function shuffle(arr){ const r=[...arr]; for(let i=r.length-1;i>0;i--){ const x=new Uint32Array(1); crypto.getRandomValues(x); const j=x[0]%(i+1); [r[i],r[j]]=[r[j],r[i]] } return r; }
