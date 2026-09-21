> **AI-written from operator direction.** The intent is the operator's; the wording and scope are an agent's.
> `session: 5ecf3d1b-8afa-4906-a0c5-ffd8fb08bbf2 | 2026-09-19 | source: op:2026-09-19-0250-1113`

# quota-exchange

A Claude Code plugin that answers one question at any moment, without waiting
for a reset: **how much API-priced work does 1% of my subscription buy right
now, on each meter, and has that changed?**

Anthropic's subscription meters (`5h`, `7d`, and `7d_oi`, the 7-day Fable
meter) report whole-percent utilization in the response headers of every
request. They can change independently and without notice. This repository
holds two halves:

- `estimator/exchange.py` turns the captured headers and per-request token
  counts into an exchange rate per meter and per model, **credits per 1%**,
  with confidence bands, a per-window history, and a drift verdict. It runs
  from cron and writes a JSON snapshot.
- `hooks/` is the plugin: a `/quota` command that opens a pane with five tabs
  over that snapshot.

## Provenance

The operator directed the work in two utterances, quoted verbatim:

> Yes, enhance our existing setup to make this standard and stable. THen build a plugin which displays this information with a command in a nice GUI showing as rich statistics and data as you possibly can. ultrathink

(`op:2026-09-19-0250-1113`, recorded as `dec-2026-09-19-452d`)

A second utterance, `op:2026-09-19-0253-73fd`, placed the repository. Verbatim: "I forgot to mention, I want the plugin built alongside the other plugins as its own remote repository in claude-investigations project."

Earlier in the same thread the operator settled that the proxy's captured
headers stay the meter source and the plugin is display only, and that the
paid usage API endpoint is not wanted.

## Install

```bash
claude plugin marketplace add AnExiledDev/quota-exchange-plugin
claude plugin install quota-exchange@quota-exchange
```

This repository is its own marketplace: `.claude-plugin/marketplace.json`
lists one plugin whose `source` is the repository root. `claude plugin
install` writes user scope unless you pass `--scope project` or `--scope
local`. The plugin needs `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in the
environment, like every function-hooks plugin.

The plugin has no runtime dependencies. `bun test` runs its tests;
`claude plugin validate .` checks the manifest and the hooks module.

## The estimator

The plugin reads what the estimator writes. Nothing in the plugin computes a
rate; if the snapshot is missing the pane says so and shows the cron line.

### Inputs

Two JSONL files under `~/.claude/usage/`, written by a local proxy that sees
every request's response headers:

- `proxy-headers.jsonl` (and a rotated `.1`): one row per response with the
  `anthropic-ratelimit-unified-{5h,7d,7d_oi}-utilization` and `-reset`
  headers.
- `proxy-usage.jsonl` (and `.1`): one row per request with the model and the
  `usage` block (input, cache write, cache read, output tokens).

### Method

1. **Credits.** Every request is priced in Opus-equivalent credits,
   `input + cache_write + 5 × output`; cache reads are free. This is the
   formula the meters are observed to follow (the split fit below checks
   it).
2. **Ticks.** A meter's whole-percent reading only changes at a tick. The
   traffic between two consecutive ticks of the same reset window is one
   interval; its cost is exactly 1% (or however many percent the reading
   moved).
3. **Censoring.** The first reading of a window, the interval after a drop
   (a reset, or a rollback), and empty intervals are excluded. A lower
   reading within 60 s of the last accepted one is an out-of-order response
   (`REORDER_SECONDS`) and counted as `reordered`, not as a drop.
4. **Fit.** Non-negative least squares over the intervals: percent moved
   against credits per model. The slope for a model is credits per 1%. A
   robust residual pass drops outliers; a bootstrap (300 rounds) gives the
   16–84% band.
5. **Windows.** The fit is repeated over the last 3, 7, 14 and 30 days.
6. **Counted.** A model whose fitted share of the meter is under 2% while its
   credit share is 10% or more is `counted: false`: that meter does not
   charge for it (Opus and Sonnet on the Fable meter). Its rate is reported
   as null, never as a number.
7. **Split fit.** For the two biggest models the fit is repeated with input,
   cache write and output as separate columns, reporting tokens per 1% per
   counter and the ratio of output to cache-write weight. The credit formula
   predicts 5 / 0.6 ≈ 8.3.
8. **Drift.** The 3-day rate against the 14-day rate, per meter and model, as
   a z-test on the bootstrap bands. `grew` or `shrank` needs |z| ≥ 3 and a
   relative change of 10% or more; a model under 10% share in either window
   gets no verdict.

### Running it

```bash
python3 estimator/exchange.py            # writes the snapshot and appends history
python3 estimator/exchange.py --print    # prints the report, writes nothing
python3 estimator/exchange.py --json     # prints the snapshot JSON
```

Outputs default to `~/.claude/usage/exchange-rate.json` (the snapshot) and
`~/.claude/usage/exchange-history.jsonl` (one row per run, the 7d-window
rates and drift verdicts). `--out`, `--history`, `--since` and `--until`
override them. It needs `numpy` and `scipy`.

Hourly cron, as installed on the box that built it:

```
9 * * * * /usr/bin/python3 /home/deploy/ops/usage-monitor/exchange.py >/dev/null 2>>/home/deploy/.local/state/usage-exchange.log
```

Tests: `cd estimator && python3 -m unittest test_exchange`. They simulate
traffic at known rates and check the estimator recovers them within 5%, and
that each censoring rule fires on the case it is for.

### Configuration

Two settings, each an absolute path (the plugin runtime has no plugin-root
value, so nothing can be relative to the install). Set either one in
`/plugin`, under this plugin's configuration:

| Setting | Default | Meaning |
| --- | --- | --- |
| `usageDir` | `$HOME/.claude/usage` | where `exchange-rate.json` and `exchange-history.jsonl` live |
| `estimator` | empty | path to `exchange.py`; when set, the pane's refresh button runs it |

Both were environment variables first and both spellings still work:
`QUOTA_EXCHANGE_USAGE_DIR` and `QUOTA_EXCHANGE_ESTIMATOR` are read when the
matching setting is left empty. The setting wins when both are present. The
variable is the one to use from a cron line that already exports its
environment around the session.

## The pane

`/quota` opens the pane and prints a one-line summary per meter. `/quota
rates`, `/quota burn`, `/quota history` and `/quota diagnostics` open on that
tab; `/quota refresh` runs the estimator first. Tabs switch on `1`–`5`, `r`
refreshes, `q` or Esc closes. The snapshot is re-read every five minutes
while the pane is open.

- **Overview.** One card per meter: a gauge of percent used, the reset
  countdown, whether the status line's own reading agrees, the lead model's
  credits per 1% with its band, the API dollars that percent is worth, the
  whole meter's worth in dollars, the other models' rates, and any drift
  verdict that is not `stable`.
- **Rates.** The full table for a chosen window (`3d`/`7d`/`14d`/`30d`):
  per model, credits per 1%, band, dollars per 1%, share of the meter, and
  rate relative to the lead. The fit's quality line and the split fit's
  per-counter tokens with the output-to-cache-write ratio.
- **Burn.** The last 24 hours by model (requests, credits, dollars, and what
  that cost on each meter in percent), then by day with a sparkline; cache
  hit ratio and 429 counts.
- **History.** One sparkline per model on a chosen meter over every run in
  the history file, with latest, min, max and swing, and how many runs
  reported drift.
- **Diagnostics.** Censoring tallies, per-window fit statistics, the
  snapshot's inputs and their freshness, and what the session reports.

## Caveats

- The estimator sees whole percents, so a single interval is worth 1% ± the
  traffic that landed between the tick and the next request. Bands, not
  point values, are the number to read.
- Opus input tokens are not separately identifiable from cache writes at
  current traffic; the split fit's bands say so. The combined credit rate
  is identifiable.
- A model with too little traffic in a window is `identifiable: false`
  (band wider than the rate). The pane shows it, greyed.
- A drift verdict compares 3 days to 14 days. A change in your own model
  mix does not move it (rates are per model), but a change in Anthropic's
  pricing of a counter would show first as a drift on the models that use
  that counter most.
- Freshness: a snapshot older than three hours is flagged stale in the
  status line.

## Layout

```
.claude-plugin/plugin.json      manifest
.claude-plugin/marketplace.json this repo as a marketplace
hooks/hooks.json                names the module
hooks/module.js                 command, pane lifecycle, refresh
hooks/pane.js                   the tree per tab
hooks/data.js                   snapshot and history parsing, formatting
hooks/raster.js                 Raster packing: gauges and sparklines
estimator/exchange.py           the estimator
estimator/test_exchange.py      its tests
test/*.test.js                  the plugin's tests (bun test)
```

## License

MIT, see `LICENSE`.
