# Prost – das Trinkspiel für alle Handys

Lokaler Ersatz für TipsyIQ: eine Person erstellt eine Runde, die anderen
tippen den 4-stelligen Code ein. Kein Account, keine Werbung, keine Cloud.

## Starten

1. Node.js installieren (https://nodejs.org, LTS-Version reicht)
2. Ordner entpacken, Terminal darin öffnen
3. Einmalig: `npm install`
4. Starten: `npm start`

Im Terminal steht dann so etwas:

    Du selbst:        http://localhost:3000
    Freunde im WLAN:  http://192.168.178.42:3000

Die zweite Adresse geben deine Freunde am Handy in den Browser ein
(alle müssen im selben WLAN sein). Beenden mit Strg+C.

Falls Handys nicht verbinden: Windows-Firewall fragt beim ersten Start,
ob Node.js ins Netzwerk darf – "Zulassen" klicken. Bei manchen Routern
(z. B. Gäste-WLAN) ist Gerätekommunikation blockiert.

## Spielablauf

- Roundmaster wählt Kategorien und startet
- Jede Runde: eine zufällige Frage, alle antworten auf ihrem Handy
- Ich hab noch nie: wer's getan hat, trinkt 1
- Wer würde eher: meistgewählte Person trinkt 2
- Schätzfrage: am weitesten daneben trinkt 3, zweitweiteste 1
- Wahrheit oder Pflicht: zufällige Person; kneifen kostet 3
- Entweder oder: Minderheit trinkt 1 (Gleichstand: alle)
- Trivia: 4 Antworten, wer falsch liegt trinkt 1
- Roundmaster kann auswerten, überspringen, Roundmaster übergeben oder
  Spieler rauswerfen. Verlässt der Roundmaster das Spiel, rückt der nächste nach.
- Handy kurz zu? Seite neu laden, man landet wieder in der Runde.

## Eigene Fragen

Alle Fragen stehen in `questions.js` – Zeilen ergänzen, Server neu starten.
Schätzfragen: `{ q: "...", a: Zahl, unit: "km" }`.
Trivia: `{ q: "...", o: ["A", "B", "C", "D"], c: 1 }` – `c` ist die Position der richtigen Antwort, gezählt ab 0.
Neue Kategorie: Array in `questions.js` anlegen und in `server.js` bei
`CATS`, `nextRound` und `resolve` je einen Block ergänzen.

## Vom Handy hosten + per Link einladen

Ein Handy kann den Server nicht selbst ausführen, also läuft er kostenlos
im Internet. Einmal einrichten, danach reicht ein Link. Beispiel mit Render
(kostenlos, WebSockets werden unterstützt):

1. Kostenloses Konto auf https://github.com anlegen, neues Repository
   erstellen (z. B. `prost-trinkspiel`), die Dateien aus diesem Ordner
   hochladen ("Add file → Upload files"). `node_modules` nicht hochladen.
2. Konto auf https://render.com anlegen (mit GitHub anmelden).
3. "New → Web Service", das Repository wählen. Render liest `render.yaml`,
   du musst nur "Free" bestätigen und auf Deploy klicken.
4. Nach 2–3 Minuten gibt es eine Adresse wie
   `https://prost-trinkspiel.onrender.com`. Die als Lesezeichen aufs Handy.

Ab dann: Seite auf dem Handy öffnen → "Neue Runde erstellen" →
"Einladungslink teilen" (öffnet WhatsApp, Signal usw.). Wer den Link tippt,
landet direkt in deiner Runde, nur noch Name eingeben.

Hinweis zum Free-Plan: Wird die Seite 15 Minuten nicht benutzt, schläft der
Server ein und der erste Aufruf danach dauert ca. 30–60 Sekunden. Beim
Vorglühen einfach kurz vorher einmal öffnen. Alternative Hosts mit gleichem
Ablauf: Railway, Fly.io, Koyeb.

Eigene Fragen änderst du weiterhin in `questions.js` – Datei auf GitHub
bearbeiten, Render deployt automatisch neu.
