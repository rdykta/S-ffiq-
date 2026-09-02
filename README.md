# SüffIQ – das Trinkspiel für alle Handys

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

- Roundmaster wählt Kategorien und Antwortzeit (15–60 s oder ohne Limit) und startet
- Solo-Start ist möglich (zum Testen) – der Button heißt dann "Solo starten"
- Kategorien wechseln gewichtet ab (Wahrheit/Pflicht selten, nie zweimal dieselbe hintereinander); Gewichte in `server.js` bei `WEIGHTS`
- Timer-Balken läuft von grün über gelb nach rot; wer nicht rechtzeitig antwortet, trinkt 1
- Jede Runde: eine zufällige Frage, alle antworten auf ihrem Handy
- Ich hab noch nie: wer's getan hat, trinkt 1
- Wer würde eher: meistgewählte Person trinkt 2
- Schätzfrage: am weitesten daneben trinkt 3, zweitweiteste 1
- Wahrheit oder Pflicht: zufällige Person; kneifen kostet 3
- Entweder oder: Minderheit trinkt 1 (Gleichstand: alle)
- Trivia: 4 Antworten, wer falsch liegt trinkt 1
- Wer bin ich?: 4 Tipps im 7-Sekunden-Takt (allgemein → eindeutig), Freitext.
  Falsche Tipps landen im Chat für alle, richtige werden als "[Name] hat es erraten!" gemeldet.
  Nach dem letzten Tipp bleiben 7 Sekunden. Richtig erraten = 0 Schlücke, nicht erraten = 3.
  Nachname reicht, kleine Tippfehler werden toleriert. Wer nah dran ist (Teilwort, Vorname, ähnliche
  Schreibweise), bekommt privat ein "Nah dran!" – in beiden Freitext-Kategorien.
- Wer bin ich? (Bild): Artikelbild der Person aus der deutschen Wikipedia (Wikimedia Commons, mit Bildnachweis
  in der Auflösung), startet stark verschwommen und wird in 5 Stufen alle 7 Sekunden schärfer. Raten, Chat,
  "Nah dran" und Schlücke wie bei "Wer bin ich". Nutzt dieselbe Personenliste (`werbinich`).
- Song-Quiz: 30-Sekunden-Vorschau aus dem iTunes-Katalog (öffentliche Apple-Such-API, kein Key nötig),
  Titel als Freitext mit Chat wie bei "Wer bin ich". Nicht erkannt = 2 Schlücke, erkannt = 0.
  Jedes Handy hat einen Abspielen-Button; am besten spielt der Roundmaster laut vor. Findet der Server keine Vorschau, springt die Runde auf eine andere Kategorie.
  Songliste in `questions.js` unter `song` (`{ t: "Titel", a: "Künstler" }`).
- Montagsmaler: ein zufälliger Spieler (nie zweimal hintereinander derselbe) bekommt ein Wort und zeichnet es
  auf seinem Handy (Farben, Strichstärken, Radierer, alles löschen). Die anderen sehen die Zeichnung live und raten
  per Freitext mit Chat und "Nah dran" wie bei "Wer bin ich"; angezeigt wird nur die Buchstabenzahl. 90 Sekunden
  Zeichenzeit (`DRAW_SEC` in `server.js`), die Runde endet früher, sobald alle es erraten haben. Nicht erraten =
  2 Schlücke, errät es niemand, trinkt der Zeichner 3. Wortliste in `questions.js` unter `malen`
  (`{ name: "Fahrrad", alt: ["Rad"] }`).
- Roundmaster kann auswerten, überspringen, Roundmaster übergeben oder
  Spieler rauswerfen. Verlässt der Roundmaster das Spiel, rückt der nächste nach.
- Handy kurz zu? Seite neu laden, man landet wieder in der Runde.

## Eigene Fragen

Alle Fragen stehen in `questions.js` – Zeilen ergänzen, Server neu starten.
Schätzfragen: `{ q: "...", a: Zahl, unit: "km" }`.
Trivia: `{ q: "...", o: ["A", "B", "C", "D"], c: 1 }`
Wer bin ich: `{ name: "Angela Merkel", alt: ["Merkel"], hints: ["Tipp 1", "Tipp 2", "Tipp 3", "Tipp 4"] }` – `alt` sind zusätzlich akzeptierte Schreibweisen; Tipp-Takt in `server.js` bei `HINT_MS` – `c` ist die Position der richtigen Antwort, gezählt ab 0.
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
