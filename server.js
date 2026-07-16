// server.js
// MINDExpert — läuft auf Render.
//
// Aktueller Stand: reine "Datenbank"-Website. trains.json und stations.json
// (aus den Roblox-ModuleScripts nach JSON konvertiert) liegen lokal unter
// /data und werden beim Start einmal eingelesen. Es gibt aktuell KEINE
// Verbindung zu Roblox — nur die Soll-Zeiten aus dem Fahrplan. Die
// Echtzeit-Anbindung (Ist-Zeiten aus dem laufenden Spiel) kommt später als
// eigener Schritt dazu.

import express from "express";
import cors from "cors";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use("/expert", express.static(join(__dirname, "public/expert")));

const trains = JSON.parse(readFileSync(join(__dirname, "/trains.json"), "utf-8"));
const stations = JSON.parse(readFileSync(join(__dirname, "/stations.json"), "utf-8"));

console.log(`MINDExpert-Datenbank geladen: ${Object.keys(trains).length} Züge, ${Object.keys(stations).length} Stationen`);

// Einzelnen Zug abrufen (Soll-Fahrplan)
app.get("/api/roblox-expert/trains/:trainnumber", (req, res) => {
  const trainnumber = String(req.params.trainnumber);
  const train = trains[trainnumber];
  if (!train) return res.status(404).json({ error: "Zug nicht gefunden" });

  res.json({
    train: { ...train, trainnumber },
    stations,
    updatedAt: Date.now(),
  });
});

// Liste aller bekannten Zugnummern (fürs Debuggen / Discord-Bot)
app.get("/api/roblox-expert/trains", (req, res) => {
  res.json(Object.keys(trains));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MINDExpert läuft auf Port ${PORT}`));
