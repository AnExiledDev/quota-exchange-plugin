/**
 * A small snapshot and history in the estimator's shape, enough for every tab
 * to draw something and for the figures to be checked by eye.
 */

const model = (rate, band, usd, share, extra = {}) => ({
    credits_per_percent: rate,
    band,
    weight_vs_reference: rate === null ? null : 2_177_255 / rate,
    share_of_percent: share,
    credits_in_fit: rate === null ? 5_000_000 : rate * 80 * share,
    usd_per_percent: usd,
    counted: rate !== null,
    identifiable: rate !== null && band !== null,
    ...extra,
});

const window = (models, extra = {}) => ({
    since: 1789182539,
    since_iso: "2026-09-12T03:08:59Z",
    intervals: 83,
    intervals_used: 80,
    censored: { empty: 0, outlier: 3 },
    percent_fitted: 81,
    reference: "claude-opus-5",
    explained: 0.874,
    mean_abs_residual: 0.25,
    residual_mad: 0.302,
    models,
    split: {
        "claude-fable-5-1": {
            model: "claude-fable-5-1",
            counters: {
                input: { tokens_per_percent: 735_958, band: [475_593, 1_358_165] },
                cache_write: { tokens_per_percent: 746_565, band: [630_132, 905_253] },
                output: { tokens_per_percent: 129_295, band: [113_179, 150_092] },
            },
            output_per_cache_write: 5.77,
            output_per_cache_write_band: [4.34, 7.85],
            formula_expects: 8.33,
        },
    },
    ...extra,
});

const NOW = 1_789_787_339;

export const SNAPSHOT = {
    generated_at: NOW,
    generated_at_iso: "2026-09-19T03:08:59Z",
    method: "tick-interval NNLS on proxy headers; credits = input + cache_write + 5*output, cache reads free",
    output_weight: 5,
    windows: ["3d", "7d", "14d", "30d"],
    drift_rule: { now: "3d", baseline: "14d", z: 3, relative: 0.1 },
    sources: {
        usage_dir: "/home/me/.claude/usage",
        header_rows: 59_024,
        usage_rows: 169_923,
        first_at: 1_786_050_181,
        first_at_iso: "2026-08-06T21:03:01Z",
        last_at: NOW - 1,
        last_at_iso: "2026-09-19T03:08:58Z",
        pricing: "/home/me/ops/usage-monitor/pricing.json",
    },
    current: {
        "5h": {
            used_percentage: 18,
            resets_at: NOW + 4261,
            resets_at_iso: "2026-09-19T04:20:00Z",
            observed_at: NOW - 1,
            age_seconds: 1,
            percent_per_hour: { "1h": 4.54, "6h": 1.1, "24h": null },
            hours_to_exhaustion: 18.07,
            exhausts_before_reset: false,
        },
        "7d": {
            used_percentage: 23,
            resets_at: NOW + 445_861,
            resets_at_iso: "2026-09-24T07:00:00Z",
            observed_at: NOW - 1,
            age_seconds: 1,
            percent_per_hour: { "1h": 0.76, "6h": 0.63, "24h": 0.39 },
            hours_to_exhaustion: 122.98,
            exhausts_before_reset: true,
        },
        "7d_oi": {
            used_percentage: 21,
            resets_at: NOW + 445_861,
            resets_at_iso: "2026-09-24T07:00:00Z",
            observed_at: NOW - 1,
            age_seconds: 1,
            percent_per_hour: { "1h": 0.5, "6h": 0.4, "24h": 0.3 },
            hours_to_exhaustion: 197.5,
            exhausts_before_reset: false,
        },
    },
    meters: {
        "5h": {
            label: "5-hour",
            claim: "five_hour",
            header_rows: 58_990,
            intervals: 1159,
            ticks_percent: 1180,
            censored: { first_level: 159, after_drop: 0, drops: 0, reordered: 106 },
            windows: {
                "3d": window({
                    "claude-opus-5": model(557_000, [537_000, 579_000], 8.34, 0.5),
                    "claude-fable-5-1": model(196_000, [191_000, 201_000], 3.38, 0.4),
                }),
                "7d": window({
                    "claude-opus-5": model(502_390, [489_611, 513_146], 7.53, 0.45),
                    "claude-fable-5-1": model(181_582, [176_537, 186_217], 3.13, 0.4),
                    "claude-sonnet-5": model(570_916, [529_569, 612_100], 4.07, 0.1),
                    "claude-haiku-4-5": model(1_418_874, [1_257_238, 1_660_680], 1.74, 0.05),
                }),
                "14d": window({
                    "claude-opus-5": model(480_000, [474_000, 487_000], 7.2, 0.45),
                    "claude-fable-5-1": model(179_000, [175_000, 183_000], 3.09, 0.4),
                }),
                "30d": window({
                    "claude-opus-5": model(476_000, [471_000, 480_000], 7.13, 0.45),
                    "claude-fable-5-1": model(168_000, [165_000, 171_000], 2.89, 0.4),
                }),
            },
            drift: {
                "claude-opus-5": { now: 557_000, baseline: 480_000, relative: 0.16, z: 3.5, verdict: "grew" },
                "claude-fable-5-1": { now: 196_000, baseline: 179_000, relative: 0.095, z: 2.1, verdict: "stable" },
            },
        },
        "7d": {
            label: "7-day",
            claim: "seven_day",
            header_rows: 58_990,
            intervals: 254,
            ticks_percent: 260,
            censored: { first_level: 5, after_drop: 6, drops: 3, reordered: 23 },
            windows: {
                "3d": window({
                    "claude-opus-5": model(2_280_000, [2_061_000, 2_455_000], 34.17, 0.5),
                    "claude-fable-5-1": model(807_000, [773_000, 836_000], 13.92, 0.4),
                }),
                "7d": window({
                    "claude-opus-5": model(2_177_255, [2_090_684, 2_287_183], 32.64, 0.393),
                    "claude-fable-5-1": model(692_000, [663_000, 728_000], 11.94, 0.4),
                    "claude-sonnet-5": model(3_097_000, [2_586_000, 3_510_000], 22.05, 0.15),
                }),
                "14d": window({
                    "claude-opus-5": model(2_259_000, [2_201_000, 2_309_000], 33.86, 0.4),
                    "claude-fable-5-1": model(705_000, [684_000, 731_000], 12.17, 0.4),
                }),
                "30d": window({
                    "claude-opus-5": model(2_339_000, [2_289_000, 2_382_000], 35.07, 0.4),
                    "claude-fable-5-1": model(721_000, [706_000, 737_000], 12.44, 0.4),
                }),
            },
            drift: {
                "claude-opus-5": { now: 2_280_000, baseline: 2_259_000, relative: 0.009, z: 0.1, verdict: "stable" },
                "claude-fable-5-1": { now: 807_000, baseline: 705_000, relative: 0.144, z: 2.58, verdict: "stable" },
            },
        },
        "7d_oi": {
            label: "7-day Fable",
            claim: "seven_day_overage_included",
            header_rows: 6848,
            intervals: 195,
            ticks_percent: 200,
            censored: { first_level: 6, after_drop: 4, drops: 2, reordered: 2 },
            windows: {
                "3d": null,
                "7d": window(
                    {
                        "claude-fable-5-1": model(371_000, [362_000, 382_000], 6.4, 0.95),
                        "claude-opus-5": model(null, null, null, 0.01),
                    },
                    { reference: "claude-fable-5-1" },
                ),
                "14d": window(
                    {
                        "claude-fable-5-1": model(364_000, [358_000, 371_000], 6.28, 0.97),
                        "claude-opus-5": model(null, null, null, 0.0),
                    },
                    { reference: "claude-fable-5-1" },
                ),
                "30d": { since: 0, since_iso: "-", intervals: 3, models: null, reason: "too few usable intervals" },
            },
            drift: { "claude-fable-5-1": { now: 445_000, baseline: 364_000, relative: 0.22, z: 3.2, verdict: "grew" } },
        },
    },
    usd_per_credit: { "claude-opus-5": 0.000015, "claude-fable-5-1": 0.0000173 },
    burn: {
        by_day: [
            { date: "2026-09-17", by_model: { "claude-opus-5": { requests: 900, credits: 9_000_000, usd: 135, usd_known: true, input: 1000, cache_write: 4_000_000, cache_read: 90_000_000, output: 1_000_000 } } },
            { date: "2026-09-18", by_model: { "claude-fable-5-1": { requests: 300, credits: 3_000_000, usd: 50, usd_known: true, input: 500, cache_write: 1_500_000, cache_read: 30_000_000, output: 300_000 }, "claude-opus-5": { requests: 400, credits: 4_000_000, usd: 60, usd_known: true, input: 100, cache_write: 2_000_000, cache_read: 40_000_000, output: 400_000 } } },
            { date: "2026-09-19", by_model: { "claude-fable-5-1": { requests: 249, credits: 2_584_975, usd: 43.34, usd_known: true, input: 20_744, cache_write: 1_144_981, cache_read: 24_179_527, output: 283_850 } } },
        ],
        last_24h: {
            "claude-fable-5-1": { requests: 339, credits: 3_540_369, usd: 58.78, usd_known: true, input: 59_985, cache_write: 1_496_939, cache_read: 33_632_850, output: 396_689 },
            "claude-opus-5": { requests: 500, credits: 5_000_000, usd: 75, usd_known: true, input: 200, cache_write: 2_500_000, cache_read: 50_000_000, output: 500_000 },
            "claude-haiku-4-5": { requests: 340, credits: 1_257_977, usd: 2.66, usd_known: true, input: 263_211, cache_write: 798_811, cache_read: 6_057_290, output: 39_191 },
        },
        rate_limited: { "24h": 0, "7d": 0, total: 2462, by_model_7d: {} },
        cache_hit_ratio_7d: 0.9615,
    },
};

const historyRow = (at, opusRate, fableRate, verdict = "stable") => ({
    generated_at: at,
    generated_at_iso: new Date(at * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    meters: {
        "5h": { models: { "claude-opus-5": { rate: opusRate / 4.5, band: [opusRate / 4.6, opusRate / 4.4], n: 300 } }, drift: { "claude-opus-5": verdict } },
        "7d": {
            models: {
                "claude-opus-5": { rate: opusRate, band: [opusRate * 0.96, opusRate * 1.04], n: 80 },
                "claude-fable-5-1": { rate: fableRate, band: [fableRate * 0.96, fableRate * 1.04], n: 80 },
            },
            drift: { "claude-opus-5": verdict, "claude-fable-5-1": "stable" },
        },
        "7d_oi": { models: { "claude-fable-5-1": { rate: 368_000, band: [364_000, 374_000], n: 63 } }, drift: {} },
    },
});

export const HISTORY_ROWS = [
    historyRow(NOW - 3 * 3600, 2_150_000, 690_000),
    historyRow(NOW - 2 * 3600, 2_160_000, 695_000),
    historyRow(NOW - 3600, 2_200_000, 700_000, "grew"),
    historyRow(NOW, 2_177_255, 692_000),
];

export const HISTORY_TEXT = `${HISTORY_ROWS.map((row) => JSON.stringify(row)).join("\n")}\nnot json\n`;

export const NOW_MS = (NOW + 600) * 1000;

/**
 * Element factories that record what they were asked for: each returns a
 * plain node `{ type, props }`, so a test can walk the tree.
 */
export const recordingElements = () => {
    const make = (type) => (props) => ({ type, props: props ?? {} });

    return { Box: make("Box"), Text: make("Text"), Button: make("Button"), Raster: make("Raster"), Markdown: make("Markdown") };
};

/** Every node of a tree, depth first. */
export const walk = (node, out = []) => {
    if (node === null || node === undefined || typeof node !== "object") {
        return out;
    }

    if (Array.isArray(node)) {
        for (const child of node) {
            walk(child, out);
        }

        return out;
    }

    out.push(node);
    walk(node.props?.children, out);

    return out;
};

/** All the text a tree shows, one line per Text/Markdown/Button. */
export const linesOf = (tree) =>
    walk(tree)
        .map((node) => (node.type === "Text" ? String(node.props.children ?? "") : node.type === "Markdown" ? node.props.text : node.type === "Button" ? `[${node.props.label}]` : null))
        .filter((line) => line !== null);

export const noActions = () => ({ setTab() {}, setWindow() {}, setMeter() {}, refresh() {}, close() {} });
