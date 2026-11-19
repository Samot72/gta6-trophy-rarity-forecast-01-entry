# GTA VI Trophy Rarity Forecast — make.fun entry

[![Competition](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01) [![Rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/Samot72/gta6-trophy-rarity-forecast-01-entry/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01) [![Reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/Samot72/gta6-trophy-rarity-forecast-01-entry/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01)

My entry for the make.fun bounty **gta6-trophy-rarity-forecast-01** ("Forecast how many GTA VI
players earn each trophy in week one", $250). The program reads one case — the house's recording
of Exophase's Grand Theft Auto VI PS5 trophy page up to a checkpoint — and writes, for each of
the game's 55 trophies, five quantiles (5%, 25%, 50%, 75%, 95%) of its earn rate at the case's
target: the percent of Exophase-tracked players who will hold the trophy then. Scored by pinball
loss on the logit scale.

## The model

A rate is earners ÷ tracked players, and the two parts move differently, so the program models
them separately and divides at the end:

- **Earners never shrink** — nobody un-earns a trophy — and their growth is concave: the keenest
  players earn early, and the pool of active players who have not earned a trophy yet drains as
  they do. The program therefore works with log(earners) against **sqrt(days since the first
  read)**, the simplest concave growth law.
- **Anchored, recent, damped.** The forecast starts from the last read's actual earner count —
  never from a fitted level — and grows it by a slope measured by weighted least squares over the
  **recent half** of the record only. The slope is shrunk toward zero (persistence) when a trophy
  has few reads, capped, and damped over the extrapolation distance: a slope measured over the
  observed span is trusted less the further past that span it is carried.
- **Tracked players** get the same treatment (anchored at the last read, recent slope, damped).
  Their growth is what dilutes the rates of trophies the early crowd already holds — an
  early-game trophy can have rising earners and a falling rate at the same time, and the model
  says so when the data does.
- **Spread.** Quantiles sit on the logit scale around the median, with σ growing like
  sqrt(horizon), widened when the trophy's own history fits its curve badly (its fit residual)
  and widened again while its earner count is small, where a handful of players is a visible
  step. No network, no model calls, standard library only; the same case always writes the same
  bytes.

## Why sqrt(time) — calibration from real trophy sets

The two closest Rockstar trophy sets, at lifetime maturity on Exophase (read 2026-11-19/20),
bend exactly this way — fast early rise, long flat tail:

- **GTA V (PS4)** — 784,495 players tracked: first trophy 97.09%; story rates decay along the
  campaign (a mid-story trophy at 59.09%, the final mission under a third); 100% completion
  3.19%; platinum 2.17%. https://www.exophase.com/game/grand-theft-auto-v-ps4/trophies/
- **Red Dead Redemption 2 (PS4)**: Chapter 1 at 84.3% of tracked players; 100% completion 5.5%;
  platinum ("Legend of the West") 2.71%. https://www.exophase.com/game/red-dead-redemption-2-psn/trophies/

A straight line in time would overshoot a one-week target; flat persistence undershoots every
trophy players are still reaching for. The case's own history is the primary signal — these
lifetime curves only justify the shape of the law and the ordering (early story trophies head
toward saturation among tracked players; completion and platinum stay in low single digits for
a long time).

## Format

- Input: every `/input/<id>.in` is one JSON case
  `{"schema":"makefun/gta6-trophies-case/v1","id","at","horizon_minutes","target","levels","game","trophies","history","notes"}`;
  `history` is every house read before `at`, oldest first, each
  `{slot, at, players_tracked, trophies_earned, rates}` with `rates` in the order of `trophies`
  (null where a read lacked the trophy).
- Output: `/output/<id>.out` is `{"trophies":[{"id":1,"q":[q05,q25,q50,q75,q95]}, ...]}` — one
  row per trophy, five finite numbers from 0 to 100, non-decreasing.
- `main.ts` in the repository root (Node 22, standard library only), at most a few hundred
  milliseconds per case. Outside the grader's container, `MAKEFUN_INPUT_DIR` and
  `MAKEFUN_OUTPUT_DIR` stand in for `/input` and `/output`.

## Run it

```sh
mkdir -p /tmp/in /tmp/out
cp samples/p00.in /tmp/in/
MAKEFUN_INPUT_DIR=/tmp/in MAKEFUN_OUTPUT_DIR=/tmp/out node main.ts
cat /tmp/out/p00.out
```

`samples/` holds the kit's two practice cases (cut from the house's launch-night recording)
and the outputs this program writes for them.

## License

MIT (see `LICENSE`).
