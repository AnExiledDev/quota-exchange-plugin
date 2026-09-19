/**
 * Everything the pane knows, computed from plain data.
 *
 * Two files feed it, both written by `estimator/exchange.py` on an hourly
 * cron: `exchange-rate.json`, the latest snapshot, and `exchange-history.jsonl`,
 * one control-chart row per run. `$` never reaches here; the hook reads the
 * files and hands the text in, so every figure the pane shows is testable from
 * a string.
 */

/** The meters, in the order the pane shows them. */
export const METERS = ["5h", "7d", "7d_oi"];

/** The rolling windows the estimator fits, shortest first. */
export const WINDOWS = ["3d", "7d", "14d", "30d"];

/** The tabs, in hotkey order. */
export const TABS = [
    { id: "overview", label: "Overview", hotkey: "1" },
    { id: "rates", label: "Rates", hotkey: "2" },
    { id: "burn", label: "Burn", hotkey: "3" },
    { id: "history", label: "History", hotkey: "4" },
    { id: "diagnostics", label: "Diagnostics", hotkey: "5" },
];

/** How a meter reads in prose. */
export const METER_LABELS = { "5h": "5-hour", "7d": "7-day", "7d_oi": "7-day Fable" };

/**
 * The snapshot, parsed, or a reason it could not be.
 *
 * @param {string | null} text
 * @returns {{ snapshot: any, error?: string }}
 */
export const parseSnapshot = (text) => {
    if (typeof text !== "string" || text.trim() === "") {
        return { snapshot: null, error: "no snapshot yet" };
    }

    try {
        const snapshot = JSON.parse(text);

        if (typeof snapshot !== "object" || snapshot === null || typeof snapshot.meters !== "object") {
            return { snapshot: null, error: "the snapshot has no meters" };
        }

        return { snapshot };
    } catch (error) {
        return { snapshot: null, error: `the snapshot does not parse: ${String(error).slice(0, 120)}` };
    }
};

/**
 * The history rows, oldest first, skipping lines that do not parse.
 *
 * @param {string | null} text
 * @returns {any[]}
 */
export const parseHistory = (text) => {
    if (typeof text !== "string") {
        return [];
    }

    const rows = [];

    for (const line of text.split("\n")) {
        if (line.trim() === "") {
            continue;
        }

        try {
            const row = JSON.parse(line);

            if (typeof row?.generated_at === "number" && typeof row?.meters === "object") {
                rows.push(row);
            }
        } catch {
            // One bad line is not a reason to lose the chart.
        }
    }

    rows.sort((a, b) => a.generated_at - b.generated_at);

    return rows;
};

/** `claude-opus-5` reads as `opus-5`. */
export const shortModel = (model) => String(model ?? "").replace(/^claude-/, "");

/** 2,177,255 reads as `2.18M`; 181,582 as `182k`; 950 as `950`. */
export const fmtK = (value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return "-";
    }

    if (Math.abs(value) >= 1e9) {
        return `${(value / 1e9).toFixed(2)}B`;
    }

    if (Math.abs(value) >= 1e6) {
        return `${(value / 1e6).toFixed(2)}M`;
    }

    if (Math.abs(value) >= 1e3) {
        return `${Math.round(value / 1e3)}k`;
    }

    return `${Math.round(value)}`;
};

/** 32.635 reads as `$32.64`; 3263.5 as `$3,264`. */
export const fmtUsd = (value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return "-";
    }

    if (Math.abs(value) >= 1000) {
        return `$${Math.round(value).toLocaleString("en-US")}`;
    }

    return `$${value.toFixed(2)}`;
};

/** 5400 seconds reads as `1h 30m`; 90 as `1m`; 200000 as `2d 7h`. */
export const fmtDuration = (seconds) => {
    if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
        return "-";
    }

    const s = Math.max(0, Math.round(seconds));
    const days = Math.floor(s / 86400);
    const hours = Math.floor((s % 86400) / 3600);
    const minutes = Math.floor((s % 3600) / 60);

    if (days > 0) {
        return `${days}d ${hours}h`;
    }

    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }

    return `${minutes}m`;
};

/** 0.3930 reads as `39%`. */
export const fmtPct = (fraction, digits = 0) =>
    typeof fraction === "number" && Number.isFinite(fraction) ? `${(fraction * 100).toFixed(digits)}%` : "-";

/**
 * How long ago the snapshot was written, and whether the cron looks dead.
 *
 * @param {any} snapshot
 * @param {number} nowMs
 */
export const freshness = (snapshot, nowMs) => {
    const at = typeof snapshot?.generated_at === "number" ? snapshot.generated_at : null;

    if (at === null) {
        return { ageSeconds: null, stale: true, label: "unknown age" };
    }

    const ageSeconds = Math.max(0, nowMs / 1000 - at);

    return { ageSeconds, stale: ageSeconds > 3 * 3600, label: `${fmtDuration(ageSeconds)} ago` };
};

/**
 * The models of one meter's window, rate-bearing first, biggest share first.
 *
 * @param {any} window
 * @returns {Array<{ model: string } & Record<string, any>>}
 */
export const modelRows = (window) => {
    const models = window?.models;

    if (typeof models !== "object" || models === null) {
        return [];
    }

    return Object.entries(models)
        .map(([model, m]) => ({ model, ...m }))
        .sort((a, b) => Number(b.counted === true) - Number(a.counted === true) || (b.share_of_percent ?? 0) - (a.share_of_percent ?? 0));
};

/**
 * The headline per meter: the reference model's rate in the 7d window, what
 * one percent and the whole meter are worth in API dollars, and the drift
 * verdicts that are not `stable`.
 *
 * @param {any} snapshot
 * @param {string} meter
 */
export const meterHeadline = (snapshot, meter) => {
    const report = snapshot?.meters?.[meter];
    const window = report?.windows?.["7d"] ?? report?.windows?.["14d"] ?? null;
    const reference = window?.reference;
    const rows = modelRows(window);
    const lead = rows.find((row) => row.model === reference && row.counted) ?? rows.find((row) => row.counted) ?? null;
    const drift = Object.entries(report?.drift ?? {})
        .filter(([, d]) => d?.verdict && d.verdict !== "stable")
        .map(([model, d]) => ({ model, verdict: d.verdict, relative: d.relative, z: d.z }));

    return {
        label: report?.label ?? METER_LABELS[meter] ?? meter,
        claim: report?.claim ?? null,
        lead,
        meterUsd: lead?.usd_per_percent == null ? null : lead.usd_per_percent * 100,
        windowLabel: window === report?.windows?.["7d"] ? "7d" : window ? "14d" : null,
        drift,
        current: snapshot?.current?.[meter] ?? null,
    };
};

/**
 * The reference model's 7d-window rate across the history, one point per run,
 * for the sparkline; plus its band.
 *
 * @param {any[]} history
 * @param {string} meter
 * @param {string} model
 */
export const historySeries = (history, meter, model) => {
    const points = [];

    for (const row of history) {
        const m = row?.meters?.[meter]?.models?.[model];

        if (typeof m?.rate === "number" && Number.isFinite(m.rate)) {
            points.push({ at: row.generated_at, rate: m.rate, band: Array.isArray(m.band) ? m.band : null, n: m.n ?? null });
        }
    }

    return points;
};

/** Which models the history carries on a meter, most rows first. */
export const historyModels = (history, meter) => {
    const counts = new Map();

    for (const row of history) {
        for (const [model, m] of Object.entries(row?.meters?.[meter]?.models ?? {})) {
            if (typeof m?.rate === "number") {
                counts.set(model, (counts.get(model) ?? 0) + 1);
            }
        }
    }

    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([model]) => model);
};

/**
 * What the session's own meters say, matched to the snapshot's, so the pane
 * can show that the two agree (they are the same headers, read from two ends).
 *
 * `rateLimits[].kind` is `five_hour`, `seven_day` or `seven_day_overage_included`
 * as the status line names them.
 *
 * @param {any} usage what `$.session.usage()` answered
 */
export const sessionMeters = (usage) => {
    const kinds = { five_hour: "5h", seven_day: "7d", seven_day_overage_included: "7d_oi" };
    const out = {};

    for (const limit of Array.isArray(usage?.rateLimits) ? usage.rateLimits : []) {
        const meter = kinds[limit?.kind];

        if (meter && typeof limit.percentUsed === "number") {
            out[meter] = { percentUsed: limit.percentUsed, resetsAt: limit.resetsAt ?? null };
        }
    }

    return out;
};

/**
 * The day rows of the burn table, most recent last, with a per-day total.
 *
 * @param {any} snapshot
 * @param {number} days
 */
export const burnDays = (snapshot, days = 14) => {
    const rows = Array.isArray(snapshot?.burn?.by_day) ? snapshot.burn.by_day.slice(-days) : [];

    return rows.map((day) => {
        const models = Object.entries(day?.by_model ?? {}).map(([model, m]) => ({ model, ...m }));
        const total = (key) => models.reduce((sum, m) => sum + (typeof m[key] === "number" ? m[key] : 0), 0);

        return {
            date: day?.date ?? "-",
            models: models.sort((a, b) => (b.credits ?? 0) - (a.credits ?? 0)),
            requests: total("requests"),
            credits: total("credits"),
            usd: total("usd"),
            usdKnown: models.every((m) => m.usd_known !== false),
        };
    });
};

/**
 * What a day's spend cost the meter: credits spent that day divided by the
 * 7d-window rate per model, summed, on the meter given. A model the meter does
 * not count contributes nothing.
 *
 * @param {any} snapshot
 * @param {ReturnType<typeof burnDays>[number]} day
 * @param {string} meter
 */
export const percentOfMeter = (snapshot, day, meter) => {
    const models = snapshot?.meters?.[meter]?.windows?.["7d"]?.models ?? snapshot?.meters?.[meter]?.windows?.["14d"]?.models ?? {};
    let percent = 0;
    let known = false;

    for (const m of day.models) {
        const rate = models?.[m.model]?.credits_per_percent;

        if (typeof rate === "number" && rate > 0 && typeof m.credits === "number") {
            percent += m.credits / rate;
            known = true;
        }
    }

    return known ? percent : null;
};
