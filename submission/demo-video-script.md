# Demo video — shot list and script

**Target: 90 seconds.** The form caps the upload at 25 MB, so record at 1080p
and keep it under two minutes; a 90-second 1080p screen capture lands around
10–15 MB in H.264.

## Before you hit record

```bash
docker compose up -d && npm run seed    # so the badge reads "Neo4j", not "bundled"
npm run dev
```

Open the app, set the browser to full screen, and **hard-refresh once** so the
page loads on the Delhi → Jaipur scenario. Close the devtools. If you want the
Sarvam segment, put a key in `.env` first and restart.

---

## Shot 1 — The gap (0:00–0:20)

**On screen:** the loaded Delhi → Jaipur verdict. Let the dial sit.

> "A Tata Nexon EV 45 claims four hundred and sixty-five kilometres. This is
> Delhi to Jaipur — two hundred and seventy kilometres, forty-two degrees, four
> people, air conditioning on."

**Point at the two figures side by side:** 207 Wh/km, and 90 Wh/km implied by
the MIDC claim.

> "The brochure implies ninety watt-hours per kilometre. The trip costs two
> hundred and seven. So the answer isn't a range figure — it's this."

**Point at the dial.**

---

## Shot 2 — The answer has a shape (0:20–0:40)

**On screen:** scroll slightly so the dial and the arrival band are both visible.

> "Under one percent chance of arriving above the driver's own reserve. The
> faint band behind the arc is the confidence interval on the probability
> itself — the number is uncertain, and the instrument says so."

**Point at the arrival band, specifically the part left of zero.**

> "Arrival charge, tenth to ninetieth percentile. The axis runs below zero on
> purpose. 'You run out thirty kilometres short' is information."

---

## Shot 3 — Act on it (0:40–1:00)

**Scroll to "What would change my mind" and "Where the doubt comes from".**

> "Every lever is a full re-simulation, not a rule of thumb. Driving without the
> AC is worth thirteen points. And if you'd rather not gamble —"

**Scroll to the charging plan card.**

> "— stop at Behror. Twenty minutes. And that site actually delivers charge
> ninety percent of the time, which is the field no public charger map
> publishes. The nearest charger is often not the one it picks."

---

## Shot 4 — The graph (1:00–1:15)

**Click the Chandigarh → Shimla preset. Let it recompute, then scroll to "The road".**

> "Nineteen hundred metres of climb. Watch the charger rings go red."

**Point at the header figure: longest stretch with no 70%+ charger = 117 km.**

> "Neo4j gives us this: the longest stretch of the corridor with no dependable
> charger. A hundred and seventeen kilometres — the entire ghat climb has
> nothing above seventy percent uptime."

---

## Shot 5 — The claim is checkable (1:15–1:30)

**Cut to a terminal. Run it live — it takes a few seconds.**

```bash
npm run validate
```

**Let the reliability diagram and the Brier table scroll past, then hold on the
five PASS lines.**

> "Anyone can print a percentage. On a hundred and eighteen trips the model
> never saw: Brier score zero-point-one-one-two, against zero-point-five-four
> for the nameplate figure. Calibration error zero-point-zero-six-seven. Five
> criteria, and it exits non-zero if any of them fail."

**Final frame: the "All checks passed." line.**

> "It's a test, not a report."

---

## If you have 15 more seconds

Add the Sarvam beat after Shot 3 — pick Hindi, press **Translate & speak**, and
let the audio play for a few seconds:

> "And the driver who most needs an honest answer isn't reading watt-hours per
> kilometre in English."

## Recording notes

- **Windows:** Xbox Game Bar (`Win+G`) records the active window to MP4, or use
  OBS for a cleaner crop.
- Record the browser window only, not the whole desktop — the form's 25 MB cap
  rewards a tight frame.
- Do one silent pass first to get the scrolling smooth, then record with audio
  over it. Scroll slowly; fast scrolling reads as jitter after compression.
- Do not record the `.env` file or the terminal scrollback above `npm run
  validate` — nothing secret is in there, but a clean frame looks deliberate.
