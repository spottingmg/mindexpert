# Roblox → MINDExpert-Webseite

Die Website unter `https://mindexpert.onrender.com/expert/` bekommt ihre Daten
aus zwei getrennten Quellen, die der Server zusammenführt:

| Quelle | Was | Wie oft |
|---|---|---|
| `MINDExpertBridge.server.lua` | Soll-Fahrplan (`trains` + `stations`) | alle 60s (ändert sich nur bei Fahrplan-Edits) |
| `MINDExpertLiveEvents.server.lua` | Ist-Daten: ein Event pro "Angekommen"/"Abgefahren" | genau dann, wenn es im Spiel passiert |

Die Website liest nur `GET /api/roblox-expert/trains/:nummer` — die Merge-Logik
läuft komplett im Node-Server.

## Deployment (Render)

1. `server.js`, `package.json` und `public/expert/index.html` in dein Repo legen.
2. In Render eine lange, zufällige Umgebungsvariable `ROBLOX_EXPERT_TOKEN` setzen.
3. Start-Command: `npm install && npm start`.
4. Website danach unter `/expert/?train=18024` erreichbar.

## Roblox

1. In **Game Settings → Security** "Allow HTTP Requests" aktivieren.
2. `MINDExpertBridge.server.lua` nach `ServerScriptService` kopieren, `TOKEN`
   auf denselben Wert wie `ROBLOX_EXPERT_TOKEN` setzen, Pfad zu eurem
   RIS-Handler-Modul prüfen (aktuell `ReplicatedStorage["os.library"].PlayerOnTrainMovement["RIS-Handler"]`).
3. `MINDExpertLiveEvents.server.lua` ebenfalls nach `ServerScriptService`
   kopieren, TOKEN setzen und **die drei markierten Stellen an eure Objekte
   anpassen**:
   - Pfad zum `Trains`-Ordner mit den Zugsets (aktuell `workspace.Trains`)
   - die Namen der FIS-Values (`Zugnummer`, `StationIndex`, `stationReached`)
   - falls ihr ein eigenes "Abgefahren"-Signal habt (statt des
     StationIndex-Fallbacks), den Hook dafür austauschen
   - die Quelle der In-Game-Uhrzeit in `gameClockMinutes()` (aktuell
     `Lighting:GetMinutesAfterMidnight()`)

Beide Scripts sind absichtlich token-geschützt; ohne den korrekten Header
nimmt der Server keine Daten an.
