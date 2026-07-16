# Roblox → MINDExpert-Webseite

Die Website liegt nach dem Start unter `/expert/`. Sie erhält ihre Daten **nicht** direkt aus Roblox: Der Server-Script-Bridge überträgt einen Snapshot an den Node-Server, der ihn an alle Browser verteilt.

1. Setze beim Deployment eine lange, zufällige Umgebungsvariable `ROBLOX_EXPERT_TOKEN`.
2. Kopiere [`roblox/MINDExpertBridge.server.lua`](roblox/MINDExpertBridge.server.lua) nach `ServerScriptService`.
3. Trage `ENDPOINT`, `TOKEN` und gegebenenfalls die beiden Module unter `ReplicatedStorage.Modules` ein. Die tatsächlichen Namen/Pfade deiner Module sind maßgeblich.
4. Aktiviere in Roblox Studio unter **Game Settings → Security** die HTTP-Anfragen.
5. Öffne `https://deine-domain/expert/?train=18024`.

Die Bridge sendet aktuell alle zwei Sekunden einen vollständigen Snapshot. Sie ist absichtlich token-geschützt; ohne die Server-Umgebungsvariable nimmt der Endpunkt keine Daten an.
