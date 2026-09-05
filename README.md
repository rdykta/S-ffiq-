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

- Roundmaster wählt Kategorien, Antwortzeit (15–60 s oder ohne Limit) und ob 18+-Fragen dabei sind, und startet
- 18+ Fragen: standardmäßig an. Dann werden in allen Text-Kategorien (Ich hab noch nie, Wer würde eher, Entweder oder,
  Wahrheit oder Pflicht, Trivia, Schätzfrage, Montagsmaler) zusätzlich versaute Fragen gemischt. "Jugendfrei" schaltet
  sie ab. Pflicht-Aufgaben mit Körperkontakt gelten nur mit Einverständnis der anderen Person; kneifen kostet wie immer 3.
- Solo-Start ist möglich (zum Testen) – der Button heißt dann "Solo starten"
- Kategorien kommen gleichmäßig, aber in zufälliger Reihenfolge dran: jede gewählte Kategorie genau einmal pro
  Durchlauf, dann wird neu gemischt (nie zweimal dieselbe hintereinander)
- Timer-Balken läuft von grün über gelb nach rot; wer nicht rechtzeitig antwortet, trinkt 1
- Jede Runde: eine zufällige Frage, alle antworten auf ihrem Handy
- Ich hab noch nie: wer's getan hat, trinkt 1
- Wer würde eher: meistgewählte Person trinkt 1
- Schätzfrage: am weitesten daneben trinkt 1
- Wahrheit oder Pflicht: zufällige Person; kneifen kostet 1
- Entweder oder: Minderheit trinkt 1 (Gleichstand: alle)
- Trivia: 4 Antworten, wer falsch liegt trinkt 1
- Wer bin ich?: 4 Tipps im 7-Sekunden-Takt (allgemein → eindeutig), Freitext.
  Falsche Tipps landen im Chat für alle, richtige werden als "[Name] hat es erraten!" gemeldet.
  Nach dem letzten Tipp bleiben 7 Sekunden. Richtig erraten = 0 Schlücke, nicht erraten = 1.
  In der Liste stehen reale Personen und Fantasiefiguren (Gandalf, Harry Potter, Pippi Langstrumpf, James Bond …).
  Nachname reicht, kleine Tippfehler werden toleriert. Wer nah dran ist (Teilwort, Vorname, ähnliche
  Schreibweise), bekommt privat ein "Nah dran!" – in beiden Freitext-Kategorien.
- Wer bin ich? (Bild): Artikelbild der Person aus der deutschen Wikipedia (Wikimedia Commons, mit Bildnachweis
  in der Auflösung), startet stark verschwommen und wird in 5 Stufen alle 7 Sekunden schärfer. Raten, Chat,
  "Nah dran" und Schlücke wie bei "Wer bin ich" (nicht erraten = 1 Schluck). Eigene Liste in `questions.js` unter `bild`: sehr bekannte,
  überwiegend aktuelle Personen (`{ name: "Taylor Swift", alt: ["Swift"] }`), ein paar Weltberühmtheiten der Geschichte
  und bekannte Zeichentrick-, Animations- und Comicfiguren (`{ name: "Homer Simpson", alt: ["Homer"], en: "Homer Simpson" }`).
  Figuren haben in der deutschen Wikipedia meist kein Bild, deshalb kommt ihr Bild über `en` aus der englischen
  Wikipedia (dort auch nicht-freie Figurenbilder, Nachweis in der Auflösung). Bei Figuren ist das Artikelbild oft
  ein Buchcover, Filmplakat oder Serienlogo statt der Figur – solche Dateien erkennt der Server am Dateinamen und
  nimmt stattdessen ein anderes Bild aus dem Artikel. Findet sich keins, wird die Figur übersprungen und eine
  andere gezogen, es erscheint also nie ein Cover. Bilder selbst prüfen: `npm run bildcheck` erzeugt
  `bildcheck.html` mit allen Figurenbildern zum Durchsehen (`node tools/bildcheck.js alle` nimmt Personen dazu). Der Nachname bzw. die Figur
  allein reicht beim Raten ("Simpson", "Homer").
- Logo-Quiz: eine Bildmarke ohne Schriftzug (Apfel, Swoosh, Stern, Sirene …) wird sofort scharf gezeigt, es gilt die
  eingestellte Antwortzeit (Standard 30 s). Raten per Freitext mit Chat und "Nah dran". Nicht erkannt = 1 Schluck, erkannt = 0. Alle Logos sind reine Bildmarken ohne Schriftzug (sonst könnte man den Namen in der letzten
  Stufe einfach ablesen) und stecken als Vektorsymbol direkt im Spiel – kein Netzabruf, nichts kann fehlen. Liste in
  `questions.js` unter `logo` (`{ name: "Nike", alt: ["Swoosh"], hex: "111111", path: "…" }`; `path` ist ein SVG-Pfad
  in einer 24x24-Fläche, `hex` die Farbe). Symbole aus dem Simple-Icons-Satz (CC0).
- Song-Quiz: 30-Sekunden-Vorschau aus dem iTunes-Katalog (öffentliche Apple-Such-API, kein Key nötig),
  Titel als Freitext mit Chat wie bei "Wer bin ich". Nicht erkannt = 1 Schluck, erkannt = 0.
  Jedes Handy hat einen Abspielen-Button; am besten spielt der Roundmaster laut vor. Findet der Server keine Vorschau, springt die Runde auf eine andere Kategorie.
  Songliste in `questions.js` unter `song` (`{ t: "Titel", a: "Künstler" }`) – Partyhits von den 80ern bis heute,
  nach Jahrzehnten gegliedert, dazu Malle-, Karnevals- und Après-Ski-Klassiker. Geraten wird der Titel.
- Regeln & Events: kein Raten, nur ein Screen. Eine neue Regel erscheint ("Nur noch mit links trinken", "Vor dem Trinken
  auf den Tisch klopfen", "[Name] sucht sich einen Trink-Buddy" …) und gilt ab sofort. Irgendwann in den nächsten 10 bis
  30 Runden kommt ein eigener Screen "Regel aufgehoben". Nie mehr als zwei Regeln gleichzeitig; ist das Limit erreicht,
  kommt stattdessen die nächste Kategorie dran. Aktive Regeln stehen in jeder Runde oben auf dem Bildschirm. Der Roundmaster
  klickt "Weiter". Regeln in `questions.js` unter `regel` (`{ t: "Text mit {X} und {Y}", g: "gruppe" }`; `{X}`/`{Y}` werden
  zu Mitspielernamen, Regeln derselben Gruppe `g` sind nie gleichzeitig aktiv). Grenzen in `server.js` bei `RULE_MIN`, `RULE_MAX`, `RULE_MAX_ACTIVE`.
- Montagsmaler: ein zufälliger Spieler (nie zweimal hintereinander derselbe) bekommt ein Wort und zeichnet es
  auf seinem Handy (Farben, Strichstärken, Radierer, alles löschen). Die anderen sehen die Zeichnung live und raten
  per Freitext mit Chat und "Nah dran" wie bei "Wer bin ich"; angezeigt wird nur die Buchstabenzahl. Fester Timer von
  60 Sekunden unabhängig von der Antwortzeit (`DRAW_SEC` in `server.js`), die Runde endet früher, sobald alle es erraten haben. Nicht erraten =
  1 Schluck, errät es niemand, trinkt der Zeichner 1. Wortliste in `questions.js` unter `malen`
  (`{ name: "Fahrrad", alt: ["Rad"] }`).
- Roundmaster kann auswerten, überspringen, Roundmaster übergeben oder
  Spieler rauswerfen. Verlässt der Roundmaster das Spiel, rückt der nächste nach.
- Tastatur offen? In allen Rate-Kategorien (Wer bin ich, Bild, Logo, Song, Montagsmaler, Schätzfrage) schaltet die
  Seite auf ein kompaktes Layout: Tipps, Bild oder Zeichnung bleiben oben sichtbar, das Eingabefeld sitzt direkt über
  der Tastatur, Kopfzeile und Spielerliste werden ausgeblendet. So kann man tippen und korrigieren, ohne zu scrollen.
- Jeder Knopfdruck während einer Runde (Antworten, Raten, Zeichenwerkzeuge, Auswerten, Nächste Runde) gibt ein kurzes,
  helles Plopp als Bestätigung. Kommt aus dem Browser selbst (Web Audio), keine Audiodatei nötig; Handy auf lautlos = kein Ton.
- Handy kurz zu oder Standby? Die App verbindet sich von selbst neu und holt den aktuellen Stand, sobald sie wieder
  offen ist (Ping alle 20 s, bei ausbleibender Antwort wird die Verbindung ersetzt). Zur Not: Seite neu laden, man landet wieder in der Runde.

## Eigene Fragen

Alle Fragen stehen in `questions.js` – Zeilen ergänzen, Server neu starten.
Schätzfragen: `{ q: "...", a: Zahl, unit: "km" }`.
Trivia: `{ q: "...", o: ["A", "B", "C", "D"], c: 1 }`
Wer bin ich: `{ name: "Angela Merkel", alt: ["Merkel"], hints: ["Tipp 1", "Tipp 2", "Tipp 3", "Tipp 4"] }` – `alt` sind zusätzlich akzeptierte Schreibweisen; Tipp-Takt in `server.js` bei `HINT_MS` – `c` ist die Position der richtigen Antwort, gezählt ab 0.
Wer bin ich (Bild): `{ name: "Taylor Swift", alt: ["Swift"] }` unter `bild` – das Bild kommt automatisch aus der Wikipedia.
18+-Fragen stehen gesammelt unter `nsfw`, mit denselben Unterlisten und Formaten wie die normalen Kategorien
(`nsfw.nie`, `nsfw.wer`, `nsfw.oder`, `nsfw.wahrheit`, `nsfw.pflicht`, `nsfw.trivia`, `nsfw.schaetz`, `nsfw.malen`).
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
