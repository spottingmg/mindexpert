// server.js
// MINDExpert backend — läuft auf Render.
//
// Zwei Datenquellen aus Roblox:
//  1) "Snapshot"  -> der komplette Fahrplan (trains + stations), so wie er aus
//     deinen ModuleScripts kommt. Ändert sich selten (nur wenn du den Fahrplan
//     bearbeitest), wird daher nur alle ~60s gepusht, nicht alle 2s.
//  2) "Live-Event" -> ein einzelnes Ereignis ("Angekommen" / "Abgefahren") für
//     einen konkreten Zug an einer konkreten Station, inkl. Ist-Zeit und
//     Verspätung. Wird genau dann gepusht, wenn es im Spiel passiert.
//
// Der Server merged beides: Soll-Zeiten kommen aus dem Snapshot, Ist-Zeiten
// aus den Live-Events. Die Website liest nur den gemergten Zustand.
// Nach const app = express(); und app.use(express.json());

let staticTrains = {};    // Speichert den statischen Fahrplan
let staticStations = {};  // Speichert die Haltestellennamen
let liveTrainStates = {}; // Speichert die aktuellen Verspätungen/Echtzeit-Events

import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

// 1. Pfade sicher auflösen (Linux- & Render-kompatibel)
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 2. Express App initialisieren
const app = express();

// 3. Middlewares einrichten
app.use(cors());
app.use(express.json({ limit: "8mb" }));

// 4. Statische Dateien ausliefern (zeigt auf "public/expert")
app.use("/expert", express.static(path.join(__dirname, "public", "expert")));

// 5. Weiterleitung von / nach /expert/ (Verhindert "Cannot GET /" beim Aufruf der Hauptdomain)
app.get("/", (req, res) => {
  res.redirect("/expert/");
});

const TOKEN = process.env.ROBLOX_EXPERT_TOKEN;

/** @type {{trains: Record<string, any>, stations: Record<string, any>}} */
let schedule = { trains: {}, stations: {} };

/**
 * Live-Overlay pro Zugnummer:
 * live[trainnumber] = {
 *    route: { [stationId]: { actualArr, arrDelay, actualDep, depDelay, arrived, departed } },
 *    updatedAt: number,
 *    active: boolean   // true sobald der erste Event für diese Fahrt kam
 * }
 */
let live = {};

const sseClients = new Set();

function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) res.write(payload);
}

function requireToken(req, res, next) {
  if (!TOKEN) {
    return res.status(500).json({ error: "ROBLOX_EXPERT_TOKEN ist auf dem Server nicht gesetzt" });
  }
  if (req.headers["x-roblox-expert-token"] !== TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

// ---------------------------------------------------------------------------
// 1) Fahrplan-Snapshot (Soll-Daten) — gepusht von MINDExpertBridge.server.lua
// ---------------------------------------------------------------------------
app.post("/api/roblox-expert/snapshot", requireToken, (req, res) => {
  const { trains, stations } = req.body || {};
  if (trains && typeof trains === "object") schedule.trains = trains;
  if (stations && typeof stations === "object") schedule.stations = stations;
  res.json({ ok: true, trains: Object.keys(schedule.trains).length, stations: Object.keys(schedule.stations).length });
});

// ---------------------------------------------------------------------------
// 2) Live-Event (Ist-Daten) — gepusht von MINDExpertLiveEvents.server.lua
//    Body: { trainnumber, stationId, type: "arrival" | "departure", time: "HH:MM", delay: number }
// ---------------------------------------------------------------------------
app.post("/api/roblox-expert/live-event", requireToken, (req, res) => {
  const { trainnumber, stationId, type, time, delay } = req.body || {};
  if (!trainnumber || !stationId || !type) {
    return res.status(400).json({ error: "trainnumber, stationId und type sind erforderlich" });
  }
  if (!schedule.trains[trainnumber]) {
    return res.status(404).json({ error: `Zug ${trainnumber} ist nicht im aktuellen Fahrplan-Snapshot` });
  }

  const entry = (live[trainnumber] ??= { route: {}, updatedAt: null, active: true });
  const stop = (entry.route[stationId] ??= {});

  if (type === "arrival") {
    stop.actualArr = time ?? null;
    stop.arrDelay = typeof delay === "number" ? delay : stop.arrDelay ?? null;
    stop.arrived = true;
  } else if (type === "departure") {
    stop.actualDep = time ?? null;
    stop.depDelay = typeof delay === "number" ? delay : stop.depDelay ?? null;
    stop.departed = true;
  } else {
    return res.status(400).json({ error: "type muss 'arrival' oder 'departure' sein" });
  }

  entry.active = true;
  entry.updatedAt = Date.now();

  broadcast({ trainnumber, stationId, type });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// 3) Fahrt zurücksetzen — z.B. wenn ein Zugset neu an eine Zugnummer
//    angemeldet wird und die alte Fahrt vom Vortag noch im Speicher steht.
// ---------------------------------------------------------------------------
app.post("/api/roblox-expert/reset", requireToken, (req, res) => {
  const { trainnumber } = req.body || {};
  if (trainnumber) delete live[trainnumber];
  broadcast({ trainnumber, type: "reset" });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// 4) Öffentlicher Lese-Endpunkt für die Website
// ---------------------------------------------------------------------------
app.get("/api/roblox-expert/trains/:trainnumber", (req, res) => {
  const trainnumber = String(req.params.trainnumber);
  const base = schedule.trains[trainnumber];
  if (!base) return res.status(404).json({ error: "Zug nicht gefunden" });

  const overlay = live[trainnumber];
  const route = (base.route || []).map((stop) => {
    const o = overlay?.route?.[String(stop.id)] || {};
    return {
      ...stop,
      actualArr: o.actualArr ?? null,
      actualDep: o.actualDep ?? null,
      arrDelay: o.arrDelay ?? stop.arrDelay ?? null,
      depDelay: o.depDelay ?? stop.depDelay ?? null,
      arrived: !!o.arrived,
      departed: !!o.departed,
    };
  });

  res.json({
    train: { ...base, route, trainnumber, active: !!overlay?.active },
    stations: schedule.stations,
    updatedAt: overlay?.updatedAt || Date.now(),
  });
});

// Liste aller aktuell im Fahrplan bekannten Zugnummern (fürs Debuggen / Discord-Bot)
app.get("/api/roblox-expert/trains", (req, res) => {
  res.json(
    Object.keys(schedule.trains).map((trainnumber) => ({
      trainnumber,
      active: !!live[trainnumber]?.active,
    }))
  );
});

// ---------------------------------------------------------------------------
// 5) SSE-Stream — die Website hört hierauf und lädt bei Änderungen neu
// ---------------------------------------------------------------------------
app.get("/api/roblox-expert/stream", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  res.write(`event: ping\ndata: "connected"\n\n`);
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

// Keep-alive-Ping alle 25s, damit Render/Proxys die SSE-Verbindung nicht killen
setInterval(() => {
  for (const res of sseClients) res.write(`event: ping\ndata: "keepalive"\n\n`);
}, 25000);
// Hilfsfunktion zur Umrechnung der In-Game-Minuten in HH:MM
function minutesToHHMM(totalMinutes) {
    const hours = Math.floor(totalMinutes / 60) % 24;
    const minutes = totalMinutes % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

// ENDPUNKT 1: Nimmt einmalig den Fahrplan aus Roblox entgegen
app.post('/api/roblox-expert/snapshot', (req, res) => {
    const { trains, stations } = req.body;
    if (trains) staticTrains = trains;
    if (stations) staticStations = stations;
    console.log("Neuer Fahrplan-Snapshot erfolgreich geladen!");
    res.sendStatus(200);
});

// ENDPUNKT 2: Nimmt Live-Updates von aktiven Zügen entgegen
app.post('/api/roblox-expert/live-event', (req, res) => {
    const { trainnumber, stationId, type, time, delay } = req.body;
    
    if (!liveTrainStates[trainnumber]) {
        liveTrainStates[trainnumber] = {};
    }
    
    liveTrainStates[trainnumber][stationId] = {
        delay: delay,
        actualTime: time,
        type: type // "arrival" (Ankunft) oder "departure" (Abfahrt)
    };
    
    res.sendStatus(200);
});

// ENDPUNKT 3: Setzt die Live-Daten zurück (z.B. bei Schichtende/Umlaufende)
app.post('/api/roblox-expert/reset', (req, res) => {
    const { trainnumber } = req.body;
    if (liveTrainStates[trainnumber]) {
        delete liveTrainStates[trainnumber];
    }
    res.sendStatus(200);
});

// ENDPUNKT 4: Abfahrten für dein Netlify-Frontend abrufen (Soll + Ist gemischt)
app.get('/api/stations/:stationId/departures', (req, res) => {
    const { stationId } = req.params;
    const departures = [];

    for (const [trainnumber, train] of Object.entries(staticTrains)) {
        const stopIndex = train.route.findIndex(s => s.id === stationId);
        if (stopIndex === -1) continue;

        const stop = train.route[stopIndex];
        if (stop.dep === undefined || stop.dep === null) continue; // Endstation ignorieren

        const plannedMinutes = train.start + stop.dep;
        const plannedTimeStr = minutesToHHMM(plannedMinutes);

        const liveData = liveTrainStates[trainnumber]?.[stationId];
        let delay = 0;
        let isLive = false;
        let actualTimeStr = plannedTimeStr;

        if (liveData) {
            delay = liveData.delay;
            isLive = true;
            actualTimeStr = minutesToHHMM(plannedMinutes + delay);
        }

        const lastStop = train.route[train.route.length - 1];
        const destinationName = staticStations[lastStop.id]?.name || "Unbekanntes Ziel";

        departures.push({
            trainnumber: trainnumber,
            line: train.line,
            type: train.type,
            track: stop.bst || stop.plan || "1",
            plannedTime: plannedTimeStr,
            actualTime: actualTimeStr,
            delay: delay,
            isLive: isLive,
            destination: destinationName,
            plannedMinutes: plannedMinutes
        });
    }

    departures.sort((a, b) => a.plannedMinutes - b.plannedMinutes);
    res.json(departures);
});

// ENDPUNKT: Einzelnen Zuglauf für die Detailansicht abrufen
app.get('/api/roblox-expert/trains/:trainnumber', (req, res) => {
    const { trainnumber } = req.params;

    // Sicherheits-Check: Falls der Server nach einem Neustart noch keinen Snapshot hat
    if (Object.keys(staticTrains).length === 0) {
        return res.status(404).json({ error: "Fahrplan auf dem Server noch nicht geladen. Bitte starte das Roblox-Spiel einmal." });
    }

    // Zug im statischen Fahrplan suchen (als String oder Zahl)
    const train = staticTrains[trainnumber] || staticTrains[Number(trainnumber)];

    if (!train) {
        return res.status(404).json({ error: "Zug nicht gefunden" });
    }

    // Wir bauen den kompletten Zuglauf (alle Haltestellen) inklusive Live-Daten zusammen
    const fullRoute = train.route.map(stop => {
        const plannedMinutes = train.start + (stop.dep || stop.arr || 0);
        const plannedTimeStr = minutesToHHMM(plannedMinutes);

        // Prüfen, ob wir Live-Daten für diesen Halt dieses Zuges haben
        const liveData = liveTrainStates[trainnumber]?.[stop.id] || liveTrainStates[Number(trainnumber)]?.[stop.id];
        
        let delay = 0;
        let isLive = false;
        let actualTimeStr = plannedTimeStr;

        if (liveData) {
            delay = liveData.delay;
            isLive = true;
            actualTimeStr = minutesToHHMM(plannedMinutes + delay);
        }

        return {
            stationId: stop.id,
            stationName: staticStations[stop.id]?.name || "Unbekannte Station",
            plannedArrival: stop.arr !== undefined ? minutesToHHMM(train.start + stop.arr) : null,
            plannedDeparture: stop.dep !== undefined ? minutesToHHMM(train.start + stop.dep) : null,
            actualArrival: stop.arr !== undefined ? minutesToHHMM(train.start + stop.arr + delay) : null,
            actualDeparture: stop.dep !== undefined ? minutesToHHMM(train.start + stop.dep + delay) : null,
            delay: delay,
            isLive: isLive,
            track: stop.bst || stop.plan || "1"
        };
    });

    // Rückgabe des formatierten Zuges für deine bahn.expert-Detailansicht
    res.json({
        trainnumber: trainnumber,
        line: train.line,
        type: train.type,
        route: fullRoute
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MINDExpert läuft auf Port ${PORT}`));
