# MINDExpert — aktueller Stand

Die Website unter `https://mindexpert.onrender.com/expert/` ist aktuell eine
reine **Soll-Fahrplan-Anzeige**. Es gibt keine Verbindung zu Roblox mehr —
`data/trains.json` und `data/stations.json` sind die komplette "Datenbank",
1:1 aus den Roblox-ModuleScripts `trains` und `stations` nach JSON
konvertiert. Der Server liest diese beim Start einmal ein.

Die Echtzeit-Anbindung (Ist-Zeiten aus dem laufenden Spiel, "Angekommen" /
"Abgefahren") kommt später als eigener Schritt dazu.

## Struktur

```
mindexpert/
├── server.js              Liest data/*.json, liefert /api/roblox-expert/trains/:nummer
├── package.json
├── data/
│   ├── trains.json         Soll-Fahrplan pro Zugnummer (aus trains-ModuleScript)
│   └── stations.json       Stationsnamen/Gleise (aus stations-ModuleScript)
└── public/expert/
    └── index.html          Frontend
```

## Deployment (Render)

1. Als **Language: Node** anlegen (kein Docker).
2. Build Command: `npm install`
3. Start Command: `npm start`
4. Nach dem Deploy erreichbar unter `/expert/?train=18024`.

## Fahrplan aktualisieren

Wenn sich der Fahrplan in Roblox ändert, exportierst du `trains.lua` /
`stations.lua` neu und konvertierst sie erneut nach JSON (z.B. mit dem
gleichen Lua→JSON-Parser), dann `data/trains.json` / `data/stations.json`
im Repo ersetzen und neu deployen. Sobald die Echtzeit-Anbindung
dazukommt, übernimmt ein neuer Server-Endpunkt das automatisch aus dem
laufenden Spiel.
