# Problem Statement

**Statement selected:** 01 — *Will I Make It* · Build type: Measurement and data
**Track:** General

---

## Describe the problem you are trying to solve

An electric vehicle in India claims a range. A Tata Nexon EV 45 claims 465 km on
the MIDC cycle. That figure is measured on a dynamometer, on a cycle built for
repeatability: no air conditioning, one occupant, no gradient, no traffic. Then
somebody drives Delhi to Jaipur in May with four people and the AC running, and
discovers the number was never a promise. That trip is 270 km and costs about
207 Wh/km against the 90 Wh/km the claim implies — a 2.3× gap, with nothing on
the dashboard to warn them.

The obvious fix is a better number: a "real-world range" estimate. That is still
the wrong *shape* of answer. Whether a driver makes it depends on a forecast
that may be wrong, traffic they cannot see yet, their own right foot, the
gradient ahead, and whether the charger at Behror is working today — and public
charger maps do not publish the one field that matters, the share of sessions
that actually deliver charge. Those are distributions, not constants. No single
number can carry them, however carefully it is tuned.

So the problem is not "estimate range more accurately". It is: **give an Indian
driver a trustworthy answer to the question they actually ask — will I make it —
and attach a confidence level to it that is honest.**

"Honest" is the hard part, and it is testable. A probability is only worth
something if it is *calibrated*: if the trips called 80% actually succeed about
80% of the time. Most range estimators never make a claim that could be checked.
We set out to make one that can be, and to ship the harness that checks it.

## What we built

**Pahunch** — an arrival-confidence engine that refuses to print a range figure.
For any trip it returns P(arrive above the driver's own reserve), a credible
interval on that probability, the arrival-charge band, the dominant source of
doubt, the actions that would change the answer, and a fallback charging plan
scored on whether the charger actually works.

It is built in four layers: India-specific physics (HVAC load, gradient, air
density, stop-go, a clock that advances along the route), calibration of that
physics against logged trips, Monte Carlo over the remaining uncertainty, and a
Neo4j graph of the road network and charger reliability.

## How we know it works

On 118 trips the calibration layer never saw:

| | Brier score (lower is better) |
|---|---|
| **Pahunch** | **0.112** |
| Uncalibrated physics point estimate | 0.195 |
| Always guessing the base rate | 0.234 |
| The nameplate range figure | 0.542 |

Expected calibration error **0.067**; Brier skill score **0.520**. `npm run
validate` reproduces all of it, prints the full reliability diagram bin by bin,
asserts five success criteria and exits non-zero if any fails. It is a test, not
a report.
