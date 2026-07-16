// server.js - Consolidated Backend running on Render
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

// 1. Pfade sicher auflösen
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 2. Express App initialisieren
const app = express();

// 3. Middlewares
app.use(cors());
app.use(express.json({ limit: "8mb" }));

// 4. Statische Dateien ausliefern
app.use("/expert", express.static(path.join(__dirname, "public", "expert")));

app.get("/", (req, res) => {
  res.redirect("/expert/");
});

const TOKEN = process.env.ROBLOX_EXPERT_TOKEN;

// --- GEMEINSAME DATENSTRUKTUR (Soll- & Ist-Daten synchronisiert) ---
let schedule = { trains: {}, stations: {} };

/**
 * Live-Speicher pro Zugnummer:
 * live[trainnumber] = {
 *    route: { 
 *       [stationId]: { 
 *          actualArr: string, // "HH:MM:SS" aus Roblox
 *          arrDelay: number, 
 *          actualDep: string, // "HH:MM:SS" aus Roblox
 *          depDelay: number, 
 *          arrived: boolean, 
 *          departed: boolean,
 *          actualTrack: string // Optional für Gleisänderungen
 *       } 
 *    },
 *    updatedAt: number,
 *    active: boolean
 * }
 */
let live = {};
const sseClients = new Set();

// --- HILFSFUNKTIONEN ---
function minutesToHHMM(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60) % 24;
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

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
// 1) Fahrplan-Snapshot (Soll-Daten) — von MINDExpertBridge.server.lua
// ---------------------------------------------------------------------------
app.post("/api/roblox-expert/snapshot", requireToken, (req, res) => {
  const { trains, stations } = req.body || {};
  if (trains && typeof trains === "object") schedule.trains = trains;
  if (stations && typeof stations === "object") schedule.stations = stations;
  
  console.log(`Fahrplan-Snapshot geladen! ${Object.keys(schedule.trains).length} Züge, ${Object.keys(schedule.stations).length} Stationen.`);
  res.json({ ok: true, trains: Object.keys(schedule.trains).length, stations: Object.keys(schedule.stations).length });
});

// ---------------------------------------------------------------------------
// 2) Live-Event (Ist-Daten) — von MINDExpertLiveEvents.server.lua
// ---------------------------------------------------------------------------
app.post("/api/roblox-expert/live-event", requireToken, (req, res) => {
  const { trainnumber, stationId, type, time, delay, actualTrack } = req.body || {};
  
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

  if (actualTrack) {
    stop.actualTrack = String(actualTrack);
  }

  entry.active = true;
  entry.updatedAt = Date.now();

  broadcast({ trainnumber, stationId, type });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// 3) Fahrt zurücksetzen
// ---------------------------------------------------------------------------
app.post("/api/roblox-expert/reset", requireToken, (req, res) => {
  const { trainnumber } = req.body || {};
  if (trainnumber) delete live[trainnumber];
  broadcast({ trainnumber, type: "reset" });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// 4) Detailansicht für einen Zuglauf (Soll, Ist & Prognose kombiniert!)
// ---------------------------------------------------------------------------
app.get("/api/roblox-expert/trains/:trainnumber", (req, res) => {
  const trainnumber = String(req.params.trainnumber);
  const base = schedule.trains[trainnumber];
  
  if (!base) return res.status(404).json({ error: "Zug nicht gefunden" });

  const overlay = live[trainnumber];
  const isActive = !!overlay?.active;

  // Letzte bekannte Verspätung ermitteln, um sie für die Zukunft (Prognose) hochzurechnen
  let lastKnownDelay = 0;
  if (isActive && overlay.route) {
    for (const stop of (base.route || [])) {
      const liveStop = overlay.route[String(stop.id)];
      if (liveStop) {
        if (liveStop.departed && liveStop.depDelay !== null) {
          lastKnownDelay = liveStop.depDelay;
        } else if (liveStop.arrived && liveStop.arrDelay !== null) {
          lastKnownDelay = liveStop.arrDelay;
        }
      }
    }
  }

  const route = (base.route || []).map((stop, index) => {
    const isStart = index === 0;
    const isEnd = index === base.route.length - 1;
    const o = overlay?.route?.[String(stop.id)] || {};

    const plannedArrMin = stop.arr !== undefined && stop.arr !== null ? (base.start + stop.arr) : null;
    const plannedDepMin = stop.dep !== undefined && stop.dep !== null ? (base.start + stop.dep) : null;

    const plannedArrStr = plannedArrMin !== null ? minutesToHHMM(plannedArrMin) : null;
    const plannedDepStr = plannedDepMin !== null ? minutesToHHMM(plannedDepMin) : null;

    let arrivalData = null;
    let departureData = null;

    // ARRIVAL-ZEILE GENERIEREN
    if (plannedArrStr !== null && !isStart) {
      arrivalData = {
        planned: plannedArrStr,
        actual: null,
        isLive: false,
        isPrognosis: false,
        delay: 0,
        color: "green"
      };

      if (isActive) {
        arrivalData.isLive = true;
        if (o.arrived) {
          arrivalData.actual = o.actualArr; // "00:09:26" (fett, mit Sekunden)
          arrivalData.isPrognosis = false;
          arrivalData.delay = o.arrDelay || 0;
          arrivalData.color = (o.arrDelay || 0) > 0 ? "red" : "green";
        } else {
          // Prognose (Zukunft)
          const projectedMin = plannedArrMin + lastKnownDelay;
          arrivalData.actual = minutesToHHMM(projectedMin); // "01:05" (dünn, ohne Sekunden)
          arrivalData.isPrognosis = true;
          arrivalData.delay = lastKnownDelay;
          arrivalData.color = lastKnownDelay > 0 ? "red" : "green";
        }
      }
    }

    // DEPARTURE-ZEILE GENERIEREN
    if (plannedDepStr !== null && !isEnd) {
      departureData = {
        planned: plannedDepStr,
        actual: null,
        isLive: false,
        isPrognosis: false,
        delay: 0,
        color: "green"
      };

      if (isActive) {
        departureData.isLive = true;
        if (o.departed) {
          departureData.actual = o.actualDep; // "01:00:31" (fett, mit Sekunden)
          departureData.isPrognosis = false;
          departureData.delay = o.depDelay || 0;
          departureData.color = (o.depDelay || 0) > 0 ? "red" : "green";
        } else {
          // Prognose (Zukunft)
          const projectedMin = plannedDepMin + lastKnownDelay;
          departureData.actual = minutesToHHMM(projectedMin); // "01:01" (dünn, ohne Sekunden)
          departureData.isPrognosis = true;
          departureData.delay = lastKnownDelay;
          departureData.color = lastKnownDelay > 0 ? "red" : "green";
        }
      }
    }

    return {
      stationId: String(stop.id),
      stationName: schedule.stations[stop.id]?.name || "Unbekannte Station",
      plannedTrack: stop.bst || stop.plan || "1",
      actualTrack: o.actualTrack || null,
      arrival: arrivalData,
      departure: departureData
    };
  });

  res.json({
    trainnumber,
    line: base.line,
    type: base.type,
    destination: schedule.stations[base.route[base.route.length - 1].id]?.name || "Unbekannt",
    isActive: isActive,
    updatedAt: overlay?.updatedAt || Date.now(),
    route: route
  });
});

// ---------------------------------------------------------------------------
// 5) Abfahrtstafeln für Stationen (für Netlify / Monitor-Seiten)
// ---------------------------------------------------------------------------
app.get("/api/stations/:stationId/departures", (req, res) => {
  const { stationId } = req.params;
  const departures = [];

  for (const [trainnumber, train] of Object.entries(schedule.trains)) {
    const stopIndex = train.route.findIndex(s => String(s.id) === String(stationId));
    if (stopIndex === -1) continue;

    const stop = train.route[stopIndex];
    if (stop.dep === undefined || stop.dep === null) continue; 

    const plannedMinutes = train.start + stop.dep;
    const plannedTimeStr = minutesToHHMM(plannedMinutes);

    const overlay = live[trainnumber];
    const isLive = !!overlay?.active;
    const o = overlay?.route?.[String(stationId)] || {};

    let delay = 0;
    let actualTimeStr = plannedTimeStr;

    if (isLive) {
      let accumDelay = 0;
      for (let i = 0; i <= stopIndex; i++) {
        const st = train.route[i];
        const ol = overlay.route[String(st.id)] || {};
        if (ol.departed) accumDelay = ol.depDelay || 0;
        else if (ol.arrived) accumDelay = ol.arrDelay || 0;
      }
      delay = o.departed ? (o.depDelay || 0) : (o.arrived ? (o.arrDelay || 0) : accumDelay);
      actualTimeStr = minutesToHHMM(plannedMinutes + delay);
    }

    const lastStop = train.route[train.route.length - 1];
    const destinationName = schedule.stations[lastStop.id]?.name || "Unbekanntes Ziel";

    departures.push({
      trainnumber,
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

// Debug-API: Alle Zugnummern auflisten
app.get("/api/roblox-expert/trains", (req, res) => {
  res.json(
    Object.keys(schedule.trains).map((trainnumber) => ({
      trainnumber,
      active: !!live[trainnumber]?.active,
    }))
  );
});

// SSE-Stream initialisieren
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

// Keep-alive-Ping alle 25s
setInterval(() => {
  for (const res of sseClients) res.write(`event: ping\ndata: "keepalive"\n\n`);
}, 25000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MINDExpert läuft auf Port ${PORT}`));
