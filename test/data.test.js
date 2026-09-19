import { describe, expect, test } from "bun:test";

import {
    burnDays,
    fmtDuration,
    fmtK,
    fmtUsd,
    freshness,
    historyModels,
    historySeries,
    meterHeadline,
    modelRows,
    parseHistory,
    parseSnapshot,
    percentOfMeter,
    sessionMeters,
} from "../hooks/data.js";
import { HISTORY_TEXT, NOW_MS, SNAPSHOT } from "./fixtures.js";

describe("parseSnapshot", () => {
    test("reads a snapshot and refuses what is not one", () => {
        expect(parseSnapshot(JSON.stringify(SNAPSHOT)).snapshot.meters["7d"].label).toBe("7-day");
        expect(parseSnapshot(null).error).toBe("no snapshot yet");
        expect(parseSnapshot("{not json").error).toMatch(/does not parse/);
        expect(parseSnapshot('{"a":1}').error).toBe("the snapshot has no meters");
    });
});

describe("parseHistory", () => {
    test("keeps the rows that parse, oldest first, and drops the rest", () => {
        const rows = parseHistory(HISTORY_TEXT);

        expect(rows.length).toBe(4);
        expect(rows[0].generated_at).toBeLessThan(rows[3].generated_at);
        expect(parseHistory(null)).toEqual([]);
    });
});

describe("formatting", () => {
    test("figures read as a person writes them", () => {
        expect(fmtK(2_177_255)).toBe("2.18M");
        expect(fmtK(181_582)).toBe("182k");
        expect(fmtK(950)).toBe("950");
        expect(fmtK(null)).toBe("-");
        expect(fmtUsd(32.636)).toBe("$32.64");
        expect(fmtUsd(3263.5)).toBe("$3,264");
        expect(fmtDuration(5400)).toBe("1h 30m");
        expect(fmtDuration(200_000)).toBe("2d 7h");
        expect(fmtDuration(90)).toBe("1m");
    });
});

describe("freshness", () => {
    test("a snapshot ten minutes old is fresh, four hours old is stale", () => {
        expect(freshness(SNAPSHOT, NOW_MS)).toMatchObject({ stale: false, label: "10m ago" });
        expect(freshness(SNAPSHOT, NOW_MS + 4 * 3600 * 1000).stale).toBe(true);
        expect(freshness({}, NOW_MS).stale).toBe(true);
    });
});

describe("meterHeadline", () => {
    test("leads with the reference model's 7d rate and prices the whole meter", () => {
        const head = meterHeadline(SNAPSHOT, "7d");

        expect(head.lead.model).toBe("claude-opus-5");
        expect(head.lead.credits_per_percent).toBe(2_177_255);
        expect(head.meterUsd).toBeCloseTo(3264, 1);
        expect(head.windowLabel).toBe("7d");
        expect(head.drift).toEqual([]);
    });

    test("names the drift that is not stable", () => {
        const head = meterHeadline(SNAPSHOT, "5h");

        expect(head.drift).toEqual([{ model: "claude-opus-5", verdict: "grew", relative: 0.16, z: 3.5 }]);
    });

    test("on the Fable meter the lead is Fable, and Opus is not counted", () => {
        const head = meterHeadline(SNAPSHOT, "7d_oi");

        expect(head.lead.model).toBe("claude-fable-5-1");
        expect(modelRows(SNAPSHOT.meters["7d_oi"].windows["7d"]).map((r) => [r.model, r.counted])).toEqual([
            ["claude-fable-5-1", true],
            ["claude-opus-5", false],
        ]);
    });
});

describe("history", () => {
    test("the series is the 7d-window rate per run, and the models are ranked by rows", () => {
        const rows = parseHistory(HISTORY_TEXT);

        expect(historySeries(rows, "7d", "claude-opus-5").map((p) => p.rate)).toEqual([2_150_000, 2_160_000, 2_200_000, 2_177_255]);
        expect(historyModels(rows, "7d")).toEqual(["claude-opus-5", "claude-fable-5-1"]);
        expect(historySeries(rows, "7d_oi", "claude-opus-5")).toEqual([]);
    });
});

describe("sessionMeters", () => {
    test("maps the status line's kinds onto the meters", () => {
        const usage = { rateLimits: [{ kind: "five_hour", percentUsed: 18 }, { kind: "seven_day_overage_included", percentUsed: 21, resetsAt: "x" }] };

        expect(sessionMeters(usage)).toEqual({ "5h": { percentUsed: 18, resetsAt: null }, "7d_oi": { percentUsed: 21, resetsAt: "x" } });
        expect(sessionMeters(null)).toEqual({});
    });
});

describe("burn", () => {
    test("a day's total and its cost in meter percent", () => {
        const days = burnDays(SNAPSHOT);

        expect(days.length).toBe(3);
        expect(days[1]).toMatchObject({ date: "2026-09-18", requests: 700, credits: 7_000_000, usd: 110, usdKnown: true });
        // 3M Fable credits at 692k/1% plus 4M Opus at 2,177,255/1%.
        expect(percentOfMeter(SNAPSHOT, days[1], "7d")).toBeCloseTo(3_000_000 / 692_000 + 4_000_000 / 2_177_255, 6);
        // On the Fable meter Opus is not counted, so only the Fable credits cost anything.
        expect(percentOfMeter(SNAPSHOT, days[1], "7d_oi")).toBeCloseTo(3_000_000 / 371_000, 6);
    });
});
