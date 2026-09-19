#!/usr/bin/env python3
"""How many Opus-equivalent credits buy 1% of each subscription meter, measured any time.

The question this answers is "did Anthropic quietly change what my subscription
gives me", and it answers it without waiting for a reset and without spending a
token. Every API response carries the account's three meters as whole percents:

    anthropic-ratelimit-unified-5h-utilization      the five-hour window
    anthropic-ratelimit-unified-7d-utilization      the seven-day window
    anthropic-ratelimit-unified-7d_oi-utilization   the seven-day Fable window (7df)

A meter that reads 12% and then 13% ticked exactly once between two responses,
and the proxy logged every request in between with its model and token counts.
So one tick is one equation:

    1 percent = b_opus * credits_opus + b_fable * credits_fable + ...

where credits_m is the model's tokens in that interval weighted as the meters
weigh them (input + cache writes + 5 x output, cache reads free; see FINDINGS
2026-09-04 in ~/ops/usage-monitor). Hundreds of ticks a day make hundreds of
equations, and a non-negative least-squares fit gives each model's b_m, whose
reciprocal is the credits that buy one percent. Bootstrap resampling of the
intervals gives a 16-84% band. A change in the allowance is a change in that
number, visible within a day, on any meter, from any point in the window.

What is censored, and why (each of these produced a wrong number before it was):

- the first level seen in each window: its start is unknown, so its interval is
  open on the left;
- the interval after a level went DOWN inside a window (a re-read, a fallback,
  or a tick the proxy saw out of order): its start is unknowable;
- an interval with no requests through the proxy at all: something else on
  the account spent the tick, so it is "unseen traffic", not a rate;
- an interval whose jump the fit cannot explain (outlier by robust residual):
  the same unseen traffic, or a proxy gap, dressed as a legitimate tick.

Two fits per meter and window. The "credits" fit is the headline: one column
per model using the fixed credit formula, so the numbers compare across runs
and across meters. The "split" fit lets the largest model's input, cache-write
and output counters float separately; it is the check on the formula itself.
If output stops fitting at about 5x input, the weights changed, not the price.

Inputs (all passive, all already written by the prompt proxy):

    ~/.claude/usage/proxy-headers.jsonl[.1]   every response's rate headers
    ~/.claude/usage/proxy-usage.jsonl[.1]     every response's model and tokens
    ~/ops/usage-monitor/pricing.json          API list prices (optional)

Outputs:

    ~/.claude/usage/exchange-rate.json        overwritten each run: the answer
    ~/.claude/usage/exchange-history.jsonl    one row per run: the control chart

    python3 exchange.py                       write both, print a short report
    python3 exchange.py --print               report only, write nothing
    python3 exchange.py --since 2026-09-04    restrict the data (also --until)
"""

import argparse
import bisect
import datetime as dt
import glob
import json
import os
import re
import sys
import time

import numpy as np
from scipy.optimize import nnls

HOME = os.path.expanduser("~")
USAGE_DIR = os.environ.get("QUOTA_EXCHANGE_USAGE_DIR", os.path.join(HOME, ".claude", "usage"))
PRICING_PATH = os.environ.get("QUOTA_EXCHANGE_PRICING", os.path.join(HOME, "ops", "usage-monitor", "pricing.json"))
OUT_PATH = os.path.join(USAGE_DIR, "exchange-rate.json")
HISTORY_PATH = os.path.join(USAGE_DIR, "exchange-history.jsonl")

METERS = {
    "5h": {"label": "5-hour", "claim": "five_hour"},
    "7d": {"label": "7-day", "claim": "seven_day"},
    "7d_oi": {"label": "7-day Fable", "claim": "seven_day_overage_included"},
}

# Rolling windows the fit is run over. The 3-day one is the drift detector's
# "now"; the 14-day one is its baseline.
WINDOWS = (("3d", 3), ("7d", 7), ("14d", 14), ("30d", 30))
DRIFT_NOW, DRIFT_BASE = "3d", "14d"

# Output tokens weigh about five input tokens on every meter measured so far;
# cache reads weigh nothing. The split fit re-measures this every run.
OUTPUT_WEIGHT = 5.0

# A model gets its own column only when it spent enough to be identifiable;
# below this share of the window's credits it is folded into "other".
MIN_CREDIT_SHARE = 0.01

# "Weight vs reference" is relative to this model, or to the biggest spender
# when it is absent from the window.
REFERENCE = "claude-opus-5"

BOOTSTRAP_ROUNDS = 300
BAND = (16, 84)

# An interval whose first-pass residual is beyond this many scaled MADs (and at
# least three quarters of a percent) is censored as unseen traffic.
OUTLIER_MADS = 4.0
OUTLIER_FLOOR = 0.75

# The drift flag: the 3-day estimate sits this many combined standard errors
# from the 14-day one, and at least this far off in relative terms.
DRIFT_Z = 3.0
DRIFT_RELATIVE = 0.10

# A lower reading this soon after a higher one is an out-of-order response
# (90 of the 106 apparent 5h drops on 2026-09-19 were within five seconds).
REORDER_SECONDS = 60

# A drift verdict is only given for a model that explains at least this share
# of the meter's movement in both windows; below it the band is too optimistic.
DRIFT_MIN_SHARE = 0.10

# How many models get the per-counter split fit, biggest spenders first.
SPLIT_MODELS = 2

# A model whose credits explain less than this share of the meter's movement,
# despite being spent in bulk, does not count against that meter (Opus on the
# Fable meter): its rate is reported as "not counted", not as a huge number.
COUNTED_MIN_SHARE = 0.02

DATED_MODEL = re.compile(r"-\d{8}$")
OTHER = "other"


def iso(epoch):
    return None if epoch is None else time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch))


def normalize_model(model):
    return DATED_MODEL.sub("", str(model or "")).strip().lower()


def credits_of(counters):
    return counters["input"] + counters["cache_write"] + OUTPUT_WEIGHT * counters["output"]


def counters_of(record):
    return {
        "input": record.get("input_tokens", 0),
        "cache_write": record.get("cache_creation_input_tokens", 0),
        "output": record.get("output_tokens", 0),
        "cache_read": record.get("cache_read_input_tokens", 0),
    }


# ---------------------------------------------------------------- loading


def rotated(pattern):
    """Every parsable record of a rotated log (`x.jsonl.2`, `x.jsonl.1`, `x.jsonl`), oldest file first."""
    def rotation(path):
        suffix = path.rsplit(".", 1)[-1]

        return -int(suffix) if suffix.isdigit() else 0

    for path in sorted(glob.glob(pattern), key=rotation):
        with open(path, "rb") as fh:
            for line in fh:
                try:
                    yield json.loads(line)
                except ValueError:
                    continue


def load(since, until):
    """Header levels per meter, the request log and the response statuses, clipped to [since, until)."""
    levels = {meter: [] for meter in METERS}
    statuses = []
    requests = []

    for record in rotated(os.path.join(USAGE_DIR, "proxy-headers.jsonl*")):
        at = record.get("captured_at")
        headers = record.get("headers")

        if not isinstance(at, (int, float)) or not isinstance(headers, dict) or not since <= at < until:
            continue

        statuses.append((at, record.get("status"), normalize_model(record.get("model"))))

        for meter in METERS:
            used = headers.get(f"anthropic-ratelimit-unified-{meter}-utilization")
            reset = headers.get(f"anthropic-ratelimit-unified-{meter}-reset")

            if used is None:
                continue

            try:
                levels[meter].append((at, str(reset), int(round(float(used) * 100))))
            except (TypeError, ValueError):
                continue

    for record in rotated(os.path.join(USAGE_DIR, "proxy-usage.jsonl*")):
        at = record.get("captured_at")

        if not isinstance(at, (int, float)) or not since <= at < until:
            continue

        requests.append({
            "at": at,
            "model": normalize_model(record.get("model")),
            "counters": counters_of(record),
            "cache_write_5m": record.get("cache_creation_5m_tokens", 0),
            "cache_write_1h": record.get("cache_creation_1h_tokens", 0),
        })

    for meter in METERS:
        levels[meter].sort(key=lambda row: row[0])

    requests.sort(key=lambda row: row["at"])
    statuses.sort()

    return levels, requests, statuses


# ---------------------------------------------------------------- intervals


def intervals_of(levels, requests):
    """One row per tick interval whose start is known, plus the tally of what was not.

    A row is {start, end, reset, jump, models}: the meter moved `jump` whole percents
    at `end`, and `models` holds each model's token counters between `start` and
    `end`, the request that carried the new level included.
    """
    times = [r["at"] for r in requests]
    rows = []
    censored = {"first_level": 0, "after_drop": 0}
    drops = 0
    reordered = 0
    last = None        # (reset, level, time) last accepted
    open_start = None  # time of the last boundary, None while the start is unknown

    for at, reset, used in levels:
        if last is None or reset != last[0]:
            last = (reset, used, at)
            open_start = None
            censored["first_level"] += 1

            continue

        if used < last[1]:
            # Concurrent responses land out of order within a few seconds; a lower
            # reading that close to the last one is the older response, not a drop.
            if at - last[2] <= REORDER_SECONDS:
                reordered += 1

                continue

            drops += 1
            last = (reset, used, at)
            open_start = None

            continue

        if used == last[1]:
            continue

        jump = used - last[1]
        last = (reset, used, at)

        if open_start is None:
            censored["after_drop" if drops else "first_level"] += 1
            open_start = at

            continue

        rows.append({
            "start": open_start,
            "end": at,
            "reset": reset,
            "jump": jump,
            "models": sum_counters(requests[bisect.bisect_right(times, open_start):bisect.bisect_right(times, at)]),
        })
        open_start = at

    return rows, dict(censored, drops=drops, reordered=reordered)


def sum_counters(records):
    totals = {}

    for record in records:
        into = totals.setdefault(record["model"], {"input": 0, "cache_write": 0, "output": 0, "cache_read": 0, "requests": 0})

        for key, value in record["counters"].items():
            into[key] += value

        into["requests"] += 1

    return totals


# ---------------------------------------------------------------- fitting


def columns_of(rows):
    """The models that spent enough in these rows to get a column of their own, biggest first."""
    totals = {}

    for row in rows:
        for model, counters in row["models"].items():
            totals[model] = totals.get(model, 0.0) + credits_of(counters)

    grand = sum(totals.values()) or 1.0
    named = sorted((m for m, t in totals.items() if t / grand >= MIN_CREDIT_SHARE), key=lambda m: -totals[m])

    if len(named) < len(totals):
        named.append(OTHER)

    return named


def design(rows, columns, split_model=None):
    """The design matrix: one credits column per model, or three raw counters for `split_model`."""
    names = []

    for model in columns:
        if model == split_model:
            names += [f"{model}:input", f"{model}:cache_write", f"{model}:output"]
        else:
            names.append(model)

    X = np.zeros((len(rows), len(names)))

    for i, row in enumerate(rows):
        for model, counters in row["models"].items():
            column = model if model in columns else OTHER

            if column not in columns:
                continue

            if column == split_model:
                base = names.index(f"{column}:input")
                X[i, base] += counters["input"]
                X[i, base + 1] += counters["cache_write"]
                X[i, base + 2] += counters["output"]
            else:
                X[i, names.index(column)] += credits_of(counters)

    return names, X


def fit_rows(rows, columns):
    """Two-pass NNLS with robust outlier censoring, then a bootstrap slope per column."""
    names, X = design(rows, columns)
    y = np.array([r["jump"] for r in rows], dtype=float)
    empty = X.sum(axis=1) == 0
    keep = ~empty

    if keep.sum() < len(names) + 2:
        return None

    first, _ = nnls(X[keep], y[keep])
    residual = y - X @ first
    scale = 1.4826 * np.median(np.abs(residual[keep] - np.median(residual[keep])))
    outlier = keep & (np.abs(residual) > max(OUTLIER_MADS * scale, OUTLIER_FLOOR))
    keep &= ~outlier

    if keep.sum() < len(names) + 2:
        return None

    slopes, _ = nnls(X[keep], y[keep])
    fitted = X[keep] @ slopes
    boots = bootstrap(X, y, keep)

    return {
        "names": names,
        "X": X,
        "y": y,
        "slopes": slopes,
        "boots": boots,
        "keep": keep,
        "empty": int(empty.sum()),
        "outlier": int(outlier.sum()),
        "explained": float(fitted.sum() / y[keep].sum()) if y[keep].sum() else None,
        "mean_abs_residual": float(np.abs(y[keep] - fitted).mean()),
        "residual_mad": float(scale),
        "percent_fitted": float(y[keep].sum()),
    }


def bootstrap(X, y, keep):
    """Slopes refitted on resamples of the kept intervals, one row per round."""
    rng = np.random.default_rng(int(y.sum()) + len(y))
    kept = np.flatnonzero(keep)
    samples = (rng.choice(kept, size=len(kept), replace=True) for _ in range(BOOTSTRAP_ROUNDS))

    return np.array([nnls(X[s], y[s])[0] for s in samples])


def band_of(slopes):
    """The 16-84% band of credits per percent implied by bootstrap slopes; None where they touch zero."""
    positive = slopes[slopes > 0]

    if positive.size < len(slopes) * 0.9:
        return None

    lo, hi = np.percentile(1.0 / positive, BAND)

    return [float(lo), float(hi)]


def split_fit(rows, columns, keep, model):
    """One model's raw counters fitted separately: the check on the credit formula.

    Reports tokens of each kind per percent with bands, and output against cache
    writes rather than against input: a model whose prompts are nearly all cache
    reads (Opus here) has no identifiable input slope, and a ratio to it is noise.
    The formula says output should weigh about 5 / 0.6 of a cache-write token.
    """
    names, X = design(rows, columns, split_model=model)
    y = np.array([r["jump"] for r in rows], dtype=float)

    if keep.sum() <= len(names) + 2:
        return None

    slopes, _ = nnls(X[keep], y[keep])
    boots = bootstrap(X, y, keep)
    base = names.index(f"{model}:input")
    counters = {}

    for offset, counter in enumerate(("input", "cache_write", "output")):
        slope = float(slopes[base + offset])
        counters[counter] = {
            "tokens_per_percent": None if slope <= 0 else 1.0 / slope,
            "band": band_of(boots[:, base + offset]),
        }

    b_cw, b_out = float(slopes[base + 1]), float(slopes[base + 2])
    ratios = boots[:, base + 2] / np.where(boots[:, base + 1] > 0, boots[:, base + 1], np.nan)

    return {
        "model": model,
        "counters": counters,
        "output_per_cache_write": None if b_cw <= 0 else b_out / b_cw,
        "output_per_cache_write_band": None if np.isnan(ratios).mean() > 0.1 else [float(v) for v in np.nanpercentile(ratios, BAND)],
        "formula_expects": OUTPUT_WEIGHT / 0.6,
    }


def window_report(rows, since, usd_per_credit):
    """Everything the fit says about one meter over the intervals that closed since `since`."""
    rows = [r for r in rows if r["end"] >= since]

    if not rows:
        return None

    columns = columns_of(rows)
    fit = fit_rows(rows, columns)

    if fit is None:
        return {"since": since, "since_iso": iso(since), "intervals": len(rows), "models": None,
                "reason": "too few usable intervals"}

    reference = REFERENCE if REFERENCE in columns else columns[0]
    reference_slope = fit["slopes"][fit["names"].index(reference)]
    models = {}

    for i, name in enumerate(fit["names"]):
        slope = float(fit["slopes"][i])
        credits = float(fit["X"][fit["keep"], i].sum())
        band = band_of(fit["boots"][:, i])
        usd = usd_per_credit.get(name)
        share = slope * credits / fit["percent_fitted"] if fit["percent_fitted"] else None
        credit_share = credits / float(fit["X"][fit["keep"]].sum())
        counted = share is not None and (share >= COUNTED_MIN_SHARE or credit_share < COUNTED_MIN_SHARE * 5)

        if not counted:
            slope = 0.0

        models[name] = {
            "credits_per_percent": None if slope <= 0 else 1.0 / slope,
            "band": band if counted else None,
            "weight_vs_reference": None if reference_slope <= 0 or slope <= 0 else slope / reference_slope,
            "share_of_percent": share,
            "credits_in_fit": credits,
            "usd_per_percent": None if slope <= 0 or usd is None else usd / slope,
            "counted": counted,
            "identifiable": counted and band is not None and (band[1] - band[0]) < (1.0 / slope),
        }

    return {
        "since": since,
        "since_iso": iso(since),
        "intervals": len(rows),
        "intervals_used": int(fit["keep"].sum()),
        "censored": {"empty": fit["empty"], "outlier": fit["outlier"]},
        "percent_fitted": fit["percent_fitted"],
        "reference": reference,
        "explained": fit["explained"],
        "mean_abs_residual": fit["mean_abs_residual"],
        "residual_mad": fit["residual_mad"],
        "models": models,
        "split": {m: split_fit(rows, columns, fit["keep"], m) for m in columns[:SPLIT_MODELS] if m != OTHER},
    }


def drift_of(now_window, base_window):
    """Per model: is the short-window rate outside what the long-window rate says it should be?"""
    if not now_window or not base_window or not now_window.get("models") or not base_window.get("models"):
        return None

    out = {}

    for model, now in now_window["models"].items():
        base = base_window["models"].get(model)

        if not base or not now["credits_per_percent"] or not base["credits_per_percent"]:
            continue

        if now["band"] is None or base["band"] is None:
            continue

        if min(now["share_of_percent"] or 0, base["share_of_percent"] or 0) < DRIFT_MIN_SHARE:
            continue

        se_now = (now["band"][1] - now["band"][0]) / 2
        se_base = (base["band"][1] - base["band"][0]) / 2
        delta = now["credits_per_percent"] - base["credits_per_percent"]
        relative = delta / base["credits_per_percent"]
        z = delta / ((se_now ** 2 + se_base ** 2) ** 0.5 or 1.0)
        is_drift = abs(z) >= DRIFT_Z and abs(relative) >= DRIFT_RELATIVE

        out[model] = {
            "now": now["credits_per_percent"],
            "baseline": base["credits_per_percent"],
            "relative": relative,
            "z": z,
            # Fewer credits per percent means the allowance SHRANK.
            "verdict": "stable" if not is_drift else ("shrank" if relative < 0 else "grew"),
        }

    return out


# ---------------------------------------------------------------- pricing


def load_pricing():
    try:
        with open(PRICING_PATH) as fh:
            table = json.load(fh)
    except (OSError, ValueError):
        return None

    return table if isinstance(table.get("tiers"), dict) and isinstance(table.get("models"), dict) else None


def rates_for(pricing, model, at):
    if not pricing:
        return None

    schedule = pricing["models"].get(model)

    if isinstance(schedule, list):
        schedule = next((p["tier"] for p in schedule if "until" not in p or at < p["until"]), None)

    return pricing["tiers"].get(schedule) if isinstance(schedule, str) else None


def usd_of(request, rates):
    """API list price of one request. A cache write with no recorded TTL gets the 5-minute rate."""
    c = request["counters"]
    untyped = max(0, c["cache_write"] - request["cache_write_5m"] - request["cache_write_1h"])

    return (c["input"] * rates["input"]
            + c["output"] * rates["output"]
            + c["cache_read"] * rates["cacheRead"]
            + (request["cache_write_5m"] + untyped) * rates["cacheWrite5m"]
            + request["cache_write_1h"] * rates["cacheWrite1h"]) / 1_000_000


def usd_per_credit_by_model(requests, pricing):
    """USD per credit per model over the loaded log: the bridge from credits/1% to $/1%."""
    usd = {}
    credits = {}

    for request in requests:
        rates = rates_for(pricing, request["model"], request["at"])

        if not rates:
            continue

        usd[request["model"]] = usd.get(request["model"], 0.0) + usd_of(request, rates)
        credits[request["model"]] = credits.get(request["model"], 0.0) + credits_of(request["counters"])

    return {m: usd[m] / credits[m] for m in usd if credits.get(m)}


# ---------------------------------------------------------------- the rest of the picture


def current_levels(levels, now):
    """Where each meter stands, how fast it has been climbing, and whether it runs out before it resets."""
    out = {}

    for meter, rows in levels.items():
        if not rows:
            out[meter] = None

            continue

        at, reset, used = rows[-1]
        same_window = [(t, u) for t, r, u in rows if r == reset]
        per_hour = {}

        for label, seconds in (("1h", 3600), ("6h", 6 * 3600), ("24h", 24 * 3600)):
            earlier = [(t, u) for t, u in same_window if t <= at - seconds]
            per_hour[label] = None

            if earlier:
                t0, u0 = earlier[-1]
                per_hour[label] = (used - u0) / ((at - t0) / 3600)

        rate = per_hour["6h"] or per_hour["24h"] or per_hour["1h"]
        reset_epoch = int(float(reset)) if reset.replace(".", "", 1).isdigit() else None
        hours_left = None if not rate or rate <= 0 else (100 - used) / rate

        out[meter] = {
            "used_percentage": used,
            "resets_at": reset_epoch,
            "resets_at_iso": iso(reset_epoch),
            "observed_at": at,
            "observed_at_iso": iso(at),
            "age_seconds": int(now - at),
            "percent_per_hour": per_hour,
            "hours_to_exhaustion": hours_left,
            "exhausts_before_reset": None if hours_left is None or reset_epoch is None else at + hours_left * 3600 < reset_epoch,
        }

    return out


def burn(requests, statuses, pricing, now):
    """Spend by day and by model, the last 24 hours, rate-limited responses and the cache hit rate."""
    by_day = {}
    last_24h = {}

    for request in requests:
        rates = rates_for(pricing, request["model"], request["at"])
        usd = usd_of(request, rates) if rates else None
        day = time.strftime("%Y-%m-%d", time.gmtime(request["at"]))
        buckets = [by_day.setdefault(day, {})]

        if request["at"] >= now - 86400:
            buckets.append(last_24h)

        for bucket in buckets:
            add_burn(bucket, request, usd)

    limited = {"24h": 0, "7d": 0, "total": 0, "by_model_7d": {}}

    for at, status, model in statuses:
        if status != 429:
            continue

        limited["total"] += 1
        limited["24h"] += at >= now - 86400

        if at >= now - 7 * 86400:
            limited["7d"] += 1
            limited["by_model_7d"][model] = limited["by_model_7d"].get(model, 0) + 1

    week = [r["counters"] for r in requests if r["at"] >= now - 7 * 86400]
    read = sum(c["cache_read"] for c in week)
    fresh = sum(c["input"] + c["cache_write"] for c in week)

    return {
        "by_day": [{"date": day, "by_model": models} for day, models in sorted(by_day.items())][-30:],
        "last_24h": last_24h,
        "rate_limited": limited,
        "cache_hit_ratio_7d": None if read + fresh == 0 else read / (read + fresh),
    }


def add_burn(bucket, request, usd):
    into = bucket.setdefault(request["model"], {"requests": 0, "credits": 0.0, "usd": 0.0, "usd_known": True,
                                                "input": 0, "cache_write": 0, "cache_read": 0, "output": 0})
    into["requests"] += 1
    into["credits"] += credits_of(request["counters"])

    for key, value in request["counters"].items():
        into[key] += value

    if usd is None:
        into["usd_known"] = False
    else:
        into["usd"] += usd


# ---------------------------------------------------------------- assembly


def build(now, since, until):
    levels, requests, statuses = load(since, until)
    pricing = load_pricing()
    usd_per_credit = usd_per_credit_by_model(requests, pricing)
    meters = {}

    for meter, info in METERS.items():
        rows, censored = intervals_of(levels[meter], requests)
        windows = {label: window_report(rows, now - days * 86400, usd_per_credit) for label, days in WINDOWS}

        meters[meter] = {
            "label": info["label"],
            "claim": info["claim"],
            "header_rows": len(levels[meter]),
            "intervals": len(rows),
            "ticks_percent": sum(r["jump"] for r in rows),
            "censored": censored,
            "windows": windows,
            "drift": drift_of(windows.get(DRIFT_NOW), windows.get(DRIFT_BASE)),
        }

    first = requests[0]["at"] if requests else None
    last = requests[-1]["at"] if requests else None

    return {
        "generated_at": now,
        "generated_at_iso": iso(now),
        "method": "tick-interval NNLS on proxy headers; credits = input + cache_write + 5*output, cache reads free",
        "output_weight": OUTPUT_WEIGHT,
        "windows": [label for label, _ in WINDOWS],
        "drift_rule": {"now": DRIFT_NOW, "baseline": DRIFT_BASE, "z": DRIFT_Z, "relative": DRIFT_RELATIVE},
        "sources": {
            "usage_dir": USAGE_DIR,
            "header_rows": len(statuses),
            "usage_rows": len(requests),
            "first_at": first, "first_at_iso": iso(first),
            "last_at": last, "last_at_iso": iso(last),
            "pricing": PRICING_PATH if pricing else None,
        },
        "current": current_levels(levels, now),
        "meters": meters,
        "usd_per_credit": usd_per_credit,
        "burn": burn(requests, statuses, pricing, now),
    }


def history_row(snapshot):
    """The control-chart row: the 7-day window's rate and band per meter per model, and the verdicts."""
    row = {"generated_at": snapshot["generated_at"], "generated_at_iso": snapshot["generated_at_iso"], "meters": {}}

    for meter, report in snapshot["meters"].items():
        window = report["windows"].get("7d") or {}
        models = {
            model: {"rate": m["credits_per_percent"], "band": m["band"], "n": window.get("intervals_used")}
            for model, m in (window.get("models") or {}).items()
        }
        row["meters"][meter] = {"models": models, "drift": {m: d["verdict"] for m, d in (report["drift"] or {}).items()}}

    return row


# ---------------------------------------------------------------- printing


def fmt_k(value):
    return "n/a" if value is None else f"{value / 1000:,.0f}k"


def print_report(snapshot):
    print(f"exchange rates at {snapshot['generated_at_iso']}  "
          f"({snapshot['sources']['usage_rows']:,} requests, {snapshot['sources']['header_rows']:,} header rows)")

    for meter, report in snapshot["meters"].items():
        current = snapshot["current"].get(meter)
        level = f"{current['used_percentage']}% used" if current else "no reading"

        print(f"\n{meter} ({report['label']}): {level}, {report['intervals']} intervals, censored {report['censored']}")

        for label in snapshot["windows"]:
            window = report["windows"].get(label)

            if not window or not window.get("models"):
                print(f"  {label:>4}: no fit")

                continue

            parts = []

            for model, m in window["models"].items():
                if not m["counted"]:
                    parts.append(f"{model.replace('claude-', '')} not counted")

                    continue

                if m["credits_per_percent"] is None:
                    continue

                band = "" if m["band"] is None else f" [{fmt_k(m['band'][0])}-{fmt_k(m['band'][1])}]"
                usd = "" if m["usd_per_percent"] is None else f" ${m['usd_per_percent']:.2f}"
                parts.append(f"{model.replace('claude-', '')} {fmt_k(m['credits_per_percent'])}{band}{usd}")

            print(f"  {label:>4}: n={window['intervals_used']}/{window['intervals']} "
                  f"explained={window['explained']:.2f} resid={window['mean_abs_residual']:.2f}  " + "  |  ".join(parts))

        for model, split in ((report["windows"].get("7d") or {}).get("split") or {}).items():
            if split and split["output_per_cache_write"] is not None:
                band = split["output_per_cache_write_band"]
                band = "" if band is None else f" [{band[0]:.1f}-{band[1]:.1f}]"
                print(f"  split ({model}, 7d): output weighs {split['output_per_cache_write']:.1f}x{band} a cache-write token; "
                      f"formula expects {split['formula_expects']:.1f}x")

        for model, d in (report["drift"] or {}).items():
            if d["verdict"] != "stable":
                print(f"  DRIFT {model}: {d['verdict']} {d['relative'] * 100:+.0f}% (z={d['z']:.1f})")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--since", help="ISO date/time; default: 60 days ago")
    parser.add_argument("--until", help="ISO date/time; default: now")
    parser.add_argument("--print", action="store_true", help="report only; write nothing")
    parser.add_argument("--out", default=OUT_PATH)
    parser.add_argument("--history", default=HISTORY_PATH)
    parser.add_argument("--json", action="store_true", help="print the snapshot as JSON instead of the report")
    args = parser.parse_args(argv)
    now = int(time.time())
    until = dt.datetime.fromisoformat(args.until).timestamp() if args.until else now + 1
    since = dt.datetime.fromisoformat(args.since).timestamp() if args.since else now - 60 * 86400
    snapshot = build(now, since, until)

    if not args.print:
        write_outputs(snapshot, args.out, args.history)

    if args.json:
        json.dump(snapshot, sys.stdout, indent=1, sort_keys=True)
        print()
    else:
        print_report(snapshot)


def write_outputs(snapshot, out_path, history_path):
    tmp = out_path + ".tmp"

    with open(tmp, "w") as fh:
        json.dump(snapshot, fh, indent=1, sort_keys=True)
        fh.write("\n")

    os.replace(tmp, out_path)

    with open(history_path, "a") as fh:
        fh.write(json.dumps(history_row(snapshot), sort_keys=True) + "\n")


if __name__ == "__main__":
    main()
