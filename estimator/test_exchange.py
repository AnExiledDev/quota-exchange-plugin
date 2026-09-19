"""Synthetic checks on the tick-interval estimator.

A fake meter that charges known credits per percent, driven by fake traffic,
must give those rates back; a percent that ticks while no request was logged
must be censored, not fitted; and a lower reading a few seconds after a higher
one must be treated as a reordered response, not as a level drop.

Run:  python3 -m unittest estimator/test_exchange.py
"""

import math
import unittest

import numpy as np

import exchange

OPUS = "claude-opus-5"
FABLE = "claude-fable-5-1"
RATES = {OPUS: 450_000.0, FABLE: 170_000.0}   # credits per percent, the truth
RESET = "2026-09-20T00:00:00Z"


def request(at, model, output, cache_write=0, cache_read=0, inp=0):
    counters = {"input": inp, "cache_write": cache_write, "output": output, "cache_read": cache_read}

    return {"at": at, "model": model, "counters": counters, "cache_write_5m": cache_write, "cache_write_1h": 0}


def simulate(seed=1, requests_n=1200, gap=120):
    """Traffic at a fixed cadence; the meter's whole-percent reading after every request."""
    rng = np.random.default_rng(seed)
    requests, levels = [], []
    spent, at = 0.0, 1_000_000

    for _ in range(requests_n):
        at += gap
        model = OPUS if rng.random() < 0.6 else FABLE
        output = int(rng.integers(200, 4000))
        cache_write = int(rng.integers(0, 30_000))
        cache_read = int(rng.integers(0, 150_000))
        req = request(at, model, output, cache_write, cache_read)
        requests.append(req)
        spent += exchange.credits_of(req["counters"]) / RATES[model]
        levels.append((at, RESET, int(spent)))

    return requests, levels


class Recovery(unittest.TestCase):
    def fit(self, requests, levels):
        rows, censored = exchange.intervals_of(levels, requests)
        report = exchange.window_report(rows, 0, {})

        return rows, censored, report

    def test_known_rates_come_back(self):
        requests, levels = simulate()
        rows, censored, report = self.fit(requests, levels)

        for model, truth in RATES.items():
            got = report["models"][model]
            self.assertTrue(got["counted"], model)
            self.assertLess(abs(got["credits_per_percent"] - truth) / truth, 0.05, (model, got["credits_per_percent"]))
            self.assertLessEqual(got["band"][0], truth * 1.05)
            self.assertGreaterEqual(got["band"][1], truth * 0.95)

        self.assertEqual(censored["drops"], 0)
        # The first reading, and the first tick (whose start is unknown).
        self.assertEqual(censored["first_level"], 2)
        self.assertGreater(report["explained"], 0.95)

    def test_unseen_traffic_is_censored(self):
        requests, levels = simulate()
        # Something outside the proxy spent 3% right after a tick, with no request logged since it.
        i = next(k for k in range(600, len(levels)) if levels[k][2] > levels[k - 1][2])
        at = levels[i][0] + 30
        levels.insert(i + 1, (at, RESET, levels[i][2] + 3))
        levels[i + 2:] = [(t, r, u + 3) for t, r, u in levels[i + 2:]]

        rows, _, report = self.fit(requests, levels)
        interval = next(r for r in rows if r["end"] == at)

        self.assertEqual(interval["jump"], 3)
        self.assertEqual(interval["models"], {})
        self.assertGreaterEqual(report["censored"]["empty"], 1)

        for model, truth in RATES.items():
            self.assertLess(abs(report["models"][model]["credits_per_percent"] - truth) / truth, 0.05)

    def test_reordered_reading_is_not_a_drop(self):
        requests, levels = simulate()
        # A response from just before a tick arrives 5 s after the one that showed the tick.
        i = next(k for k in range(1, len(levels)) if levels[k][2] > levels[k - 1][2])
        levels.insert(i + 1, (levels[i][0] + 5, RESET, levels[i - 1][2]))

        rows, censored, report = self.fit(requests, levels)

        self.assertEqual(censored["reordered"], 1)
        self.assertEqual(censored["drops"], 0)
        self.assertEqual(censored["after_drop"], 0)

        for model, truth in RATES.items():
            self.assertLess(abs(report["models"][model]["credits_per_percent"] - truth) / truth, 0.05)

    def test_real_drop_censors_the_next_interval(self):
        requests, levels = simulate()
        i = 500
        # The level falls by 2 % and stays there: the interval closing on the next tick is censored.
        levels[i:] = [(t, r, max(0, u - 2)) for t, r, u in levels[i:]]

        _, censored, _ = self.fit(requests, levels)

        self.assertEqual(censored["drops"], 1)
        self.assertEqual(censored["after_drop"], 1)

    def test_uncounted_model_is_flagged(self):
        # Fable is the only model this meter charges; Opus spends a lot and moves nothing.
        rng = np.random.default_rng(3)
        requests, levels = [], []
        spent, at = 0.0, 1_000_000

        for _ in range(1200):
            at += 120
            model = OPUS if rng.random() < 0.6 else FABLE
            req = request(at, model, int(rng.integers(200, 4000)), int(rng.integers(0, 30_000)))
            requests.append(req)

            if model == FABLE:
                spent += exchange.credits_of(req["counters"]) / RATES[FABLE]

            levels.append((at, RESET, int(spent)))

        _, _, report = self.fit(requests, levels)

        self.assertFalse(report["models"][OPUS]["counted"])
        self.assertIsNone(report["models"][OPUS]["credits_per_percent"])
        self.assertTrue(report["models"][FABLE]["counted"])
        self.assertLess(abs(report["models"][FABLE]["credits_per_percent"] - RATES[FABLE]) / RATES[FABLE], 0.05)


class Drift(unittest.TestCase):
    def window(self, rate, band_width, share=0.5):
        return {"models": {OPUS: {"credits_per_percent": rate, "band": [rate - band_width, rate + band_width],
                                  "share_of_percent": share}}}

    def test_stable_within_bands(self):
        drift = exchange.drift_of(self.window(460e3, 15e3), self.window(450e3, 5e3))
        self.assertEqual(drift[OPUS]["verdict"], "stable")

    def test_shrank_when_far_outside(self):
        drift = exchange.drift_of(self.window(300e3, 10e3), self.window(450e3, 5e3))
        self.assertEqual(drift[OPUS]["verdict"], "shrank")
        self.assertTrue(math.isclose(drift[OPUS]["relative"], -1 / 3, rel_tol=1e-6))

    def test_small_share_gets_no_verdict(self):
        drift = exchange.drift_of(self.window(300e3, 10e3, share=0.01), self.window(450e3, 5e3))
        self.assertNotIn(OPUS, drift)


if __name__ == "__main__":
    unittest.main()
