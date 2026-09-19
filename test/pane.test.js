import { describe, expect, test } from "bun:test";

import { parseHistory } from "../hooks/data.js";
import { col, fit, paneTree } from "../hooks/pane.js";
import { HISTORY_TEXT, NOW_MS, SNAPSHOT, linesOf, noActions, recordingElements, walk } from "./fixtures.js";

const view = (overrides = {}) => ({
    tab: "overview",
    window: "7d",
    meter: "7d",
    snapshot: SNAPSHOT,
    history: parseHistory(HISTORY_TEXT),
    session: { "5h": { percentUsed: 18, resetsAt: null }, "7d": { percentUsed: 25, resetsAt: null } },
    nowMs: NOW_MS,
    ...overrides,
});

const draw = (overrides, columns = 120) => paneTree(recordingElements(), view(overrides), noActions(), columns);

describe("every tree", () => {
    test("uses only the elements the terminal has, and puts children in props", () => {
        for (const tab of ["overview", "rates", "burn", "history", "diagnostics"]) {
            const nodes = walk(draw({ tab }));

            for (const node of nodes) {
                expect(["Box", "Text", "Button", "Raster", "Markdown"]).toContain(node.type);
            }

            const boxes = nodes.filter((node) => node.type === "Box");
            expect(boxes.length).toBeGreaterThan(0);

            for (const box of boxes) {
                expect(Array.isArray(box.props.children)).toBe(true);
            }
        }
    });

    test("no line is wider than the body", () => {
        for (const columns of [60, 100, 160]) {
            for (const tab of ["overview", "rates", "burn", "history", "diagnostics"]) {
                for (const line of linesOf(draw({ tab }, columns))) {
                    if (!line.startsWith("[")) {
                        expect(line.length).toBeLessThanOrEqual(columns - 6);
                    }
                }
            }
        }
    });

    test("the current tab is a heading, the others hotkeyed buttons", () => {
        const nodes = walk(draw({ tab: "burn" }));
        const tabs = nodes.filter((node) => String(node.props.key ?? "").startsWith("tab:"));

        expect(tabs.map((node) => node.type)).toEqual(["Button", "Button", "Text", "Button", "Button"]);
        expect(tabs[0].props.hotkey).toBe("1");
        expect(tabs[2].props.children).toBe("3: Burn");
    });
});

describe("overview", () => {
    test("says what a percent buys, what the meter is worth, and where it drifted", () => {
        const lines = linesOf(draw({ tab: "overview" }));
        const text = lines.join("\n");

        expect(text).toContain("opus-5: 2.18M credits per 1% [2.09M–2.29M]  =  $32.64 of API per 1%  →  the whole meter ≈ $3,264");
        expect(text).toContain("DRIFT opus-5: grew +16% vs 14d (z=3.5)");
        expect(text).toContain("7d_oi  7-day Fable");
        expect(text).toContain("opus-5 not counted");
        expect(text).toContain("23% used  ·  resets in 5d 3h  ·  session says 25%");
        expect(text).toContain("18% used  ·  resets in 1h 1m  ·  session agrees");
        expect(text).toContain("BEFORE the reset");
    });

    test("draws one gauge Raster per meter with a reading", () => {
        const rasters = walk(draw({ tab: "overview" })).filter((node) => node.type === "Raster");

        expect(rasters.map((node) => node.props.key)).toEqual(["gauge:5h", "gauge:7d", "gauge:7d_oi"]);
        expect(rasters[0].props.rows).toBe(1);
        expect(typeof rasters[0].props.cells).toBe("string");
    });
});

describe("rates", () => {
    test("tables the chosen window for every meter, with the split fit", () => {
        const text = linesOf(draw({ tab: "rates", window: "7d" })).join("\n");

        expect(text).toContain("7d  7-day  ·  7d window");
        expect(text).toContain("80/83 intervals used · 81% of meter fitted · explained 87% · mean |residual| 0.25%");
        expect(text).toMatch(/opus-5\s+2\.18M\s+2\.09M–2\.29M\s+\$32\.64\s+39%\s+1\.00/);
        expect(text).toContain("not counted here");
        expect(text).toContain("output weighs 5.8× [4.3–7.8] a cache write (formula: 8.3×)");
    });

    test("a window with no fit says why", () => {
        const text = linesOf(draw({ tab: "rates", window: "30d" })).join("\n");

        expect(text).toContain("too few usable intervals");
    });
});

describe("burn", () => {
    test("totals the last day and prices it in meter percent", () => {
        const text = linesOf(draw({ tab: "burn" })).join("\n");

        expect(text).toContain("Last 24 hours  ·  9.80M credits  ·  $136.44 at API list price");
        // 5M Opus credits at 502,390/1% on 5h and 2,177,255/1% on 7d.
        expect(text).toMatch(/opus-5\s+500\s+5\.00M\s+\$75\.00.*\s10\.0%\s+2\.3%/);
        expect(text).toContain("cache hit ratio (7d) 96.2%  ·  429s: 0 in 24h, 0 in 7d, 2462 in the log");
        expect(text).toContain("2026-09-18  700       7.00M      $110.00   6.2%");
    });

    test("draws the by-day sparkline", () => {
        const rasters = walk(draw({ tab: "burn" })).filter((node) => node.type === "Raster");

        expect(rasters.map((node) => node.props.key)).toEqual(["spark:usd"]);
        expect(rasters[0].props.columns).toBe(3);
    });
});

describe("history", () => {
    test("one sparkline per model on the chosen meter, with the range", () => {
        const tree = draw({ tab: "history", meter: "7d" });
        const text = linesOf(tree).join("\n");
        const rasters = walk(tree).filter((node) => node.type === "Raster");

        expect(text).toContain("4 runs from");
        expect(text).toContain("opus-5  ·  latest 2.18M [2.09M–2.26M]  ·  min 2.15M  max 2.20M  swing 2%");
        expect(text).toContain("drift verdicts: 4 runs, 1 not stable, latest stable");
        expect(rasters.map((node) => node.props.key)).toEqual(["spark:7d:claude-opus-5", "spark:7d:claude-fable-5-1"]);
        expect(rasters[0].props.columns).toBe(4);
    });

    test("with no rows it says so", () => {
        expect(linesOf(draw({ tab: "history", history: [] })).join("\n")).toContain("No history rows yet");
    });
});

describe("diagnostics", () => {
    test("shows the censoring tallies and the fit quality per window", () => {
        const text = linesOf(draw({ tab: "diagnostics" })).join("\n");

        expect(text).toContain("censored: first level 159, after drop 0, drops 0, reordered 106");
        expect(text).toContain("7d   n=80/83  empty 0  outliers 3  explained 87%  mean|res| 0.25%  MAD 0.30%  ref opus-5");
        expect(text).toContain("30d: too few usable intervals");
        expect(text).toContain("session sees: 5h 18%, 7d 25%");
    });
});

describe("no snapshot", () => {
    test("explains how to set the estimator up, and offers no tab body", () => {
        const tree = draw({ snapshot: null, error: "no snapshot yet (/x/exchange-rate.json)" });
        const text = linesOf(tree).join("\n");

        expect(text).toContain("**No exchange-rate snapshot.** no snapshot yet (/x/exchange-rate.json)");
        expect(text).toContain("9 * * * *");
        expect(walk(tree).filter((node) => node.type === "Raster")).toEqual([]);
    });
});

describe("text helpers", () => {
    test("fit cuts with an ellipsis and flattens newlines", () => {
        expect(fit("abcdef", 4)).toBe("abc…");
        expect(fit("a\nb", 10)).toBe("a b");
    });

    test("col pads and cuts every column but the last", () => {
        expect(col(["ab", 4], ["toolong", 4], ["end", 2])).toBe("ab   too… end");
    });
});
