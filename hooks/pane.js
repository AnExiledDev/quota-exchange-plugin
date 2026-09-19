/**
 * The pane's tree, built from plain data.
 *
 * `$` never reaches here: the hook resolves the element table
 * (`$.ui.resolve(e)`) and hands it in with the view and the handlers, so the
 * whole drawing is testable with factories that record what they were asked
 * for.
 *
 * Three rules the terminal surface enforces:
 *
 * - **Children go in `props.children`.** `Box({}, child)` draws an empty frame.
 * - **Only `Box`, `Text`, `Button`, `Raster` and `Markdown` are used.** `div`,
 *   `span` and `b` are not elements.
 * - **No `Code`, and no line wider than the body.** `Code` overdraws when it
 *   wraps; every line here is cut to the width first.
 */

import {
    METERS,
    TABS,
    WINDOWS,
    burnDays,
    fmtDuration,
    fmtK,
    fmtPct,
    fmtUsd,
    freshness,
    historyModels,
    historySeries,
    meterHeadline,
    modelRows,
    percentOfMeter,
    shortModel,
} from "./data.js";
import { DEFAULT, bar, modelColor, sparkline, usageColor, verdictColor } from "./raster.js";

/** Where a line is broken when the pane's width is unknown. */
export const DEFAULT_COLUMNS = 100;

/** How far inside the body width a line is broken, for the frame and padding. */
const GUTTER = 6;

/**
 * The view the pane draws: which tab and window, the parsed files, what the
 * session itself reports, and whether a refresh is running.
 *
 * @typedef {{
 *   tab: string,
 *   window: string,
 *   meter: string,
 *   snapshot: any,
 *   history: any[],
 *   session: Record<string, { percentUsed: number, resetsAt: string | null }>,
 *   error?: string,
 *   refreshing?: boolean,
 *   refreshNote?: string,
 *   nowMs: number,
 * }} View
 */

/**
 * @typedef {{
 *   setTab: (tab: string) => void,
 *   setWindow: (window: string) => void,
 *   setMeter: (meter: string) => void,
 *   refresh: () => void,
 *   close: () => void,
 * }} Actions
 */

/**
 * The whole pane.
 *
 * @param {{ Box: Function, Text: Function, Button: Function, Raster: Function, Markdown: Function }} elements
 * @param {View} view
 * @param {Actions} actions
 * @param {number} columns
 */
export const paneTree = (elements, view, actions, columns = DEFAULT_COLUMNS) => {
    const { Box, Text } = elements;
    const width = Math.max(40, columns - GUTTER);
    const body = view.snapshot === null || view.snapshot === undefined ? [emptyBody(elements, view, width)] : tabBody(elements, view, actions, width);

    return Box({
        flexDirection: "column",
        paddingX: 1,
        children: [
            tabBar(elements, view, actions),
            Text({ key: "status", dimColor: true, children: fit(statusLine(view), width) }),
            ...body,
            footer(elements, view, actions, width),
        ],
    });
};

/** The tab row: the current tab underlined, the rest as hotkeyed plain buttons. */
const tabBar = (elements, view, actions) => {
    const { Box, Text, Button } = elements;

    return Box({
        key: "tabs",
        flexDirection: "row",
        gap: 2,
        children: TABS.map((tab) =>
            tab.id === view.tab
                ? Text({ key: `tab:${tab.id}`, bold: true, underline: true, children: `${tab.hotkey}: ${tab.label}` })
                : Button({ key: `tab:${tab.id}`, label: tab.label, hotkey: tab.hotkey, plain: true, onPress: () => actions.setTab(tab.id) }),
        ),
    });
};

const statusLine = (view) => {
    if (!view.snapshot) {
        return view.error ?? "no snapshot";
    }

    const fresh = freshness(view.snapshot, view.nowMs);
    const sources = view.snapshot.sources ?? {};
    const parts = [
        `snapshot ${fresh.label}${fresh.stale ? " (STALE: is the hourly cron running?)" : ""}`,
        `${Number(sources.header_rows ?? 0).toLocaleString("en-US")} header rows`,
        `${Number(sources.usage_rows ?? 0).toLocaleString("en-US")} requests`,
        sources.first_at_iso ? `since ${String(sources.first_at_iso).slice(0, 10)}` : "",
    ];

    if (view.refreshing) {
        parts.push("refreshing...");
    } else if (view.refreshNote) {
        parts.push(view.refreshNote);
    }

    return parts.filter(Boolean).join("  ·  ");
};

const footer = (elements, view, actions, width) => {
    const { Box, Button, Text } = elements;

    return Box({
        key: "footer",
        flexDirection: "row",
        gap: 2,
        marginTop: 1,
        children: [
            Button({ key: "refresh", label: view.refreshing ? "refreshing" : "refresh", hotkey: "r", onPress: () => actions.refresh() }),
            Button({ key: "close", label: "close", hotkey: "q", onPress: () => actions.close() }),
            Text({ key: "hint", dimColor: true, children: fit("1-5 tabs · w window · m meter · esc closes", Math.max(10, width - 30)) }),
        ],
    });
};

const emptyBody = (elements, view, width) => {
    const { Markdown } = elements;
    const text = [
        `**No exchange-rate snapshot.** ${view.error ?? ""}`,
        "",
        "The pane reads `~/.claude/usage/exchange-rate.json`, written by the estimator",
        "that ships with this plugin (`estimator/exchange.py`). It needs the proxy's",
        "`proxy-headers.jsonl` and `proxy-usage.jsonl` in the same directory, and runs",
        "hourly from cron:",
        "",
        "    9 * * * * /usr/bin/python3 /path/to/quota-exchange/estimator/exchange.py",
        "",
        "Set `QUOTA_EXCHANGE_USAGE_DIR` to read another directory, and",
        "`QUOTA_EXCHANGE_ESTIMATOR` to the script's path for the refresh button.",
    ].join("\n");

    return Markdown({ key: "empty", text: cutLines(text, width) });
};

const tabBody = (elements, view, actions, width) => {
    switch (view.tab) {
        case "rates":
            return ratesTab(elements, view, actions, width);
        case "burn":
            return burnTab(elements, view, width);
        case "history":
            return historyTab(elements, view, actions, width);
        case "diagnostics":
            return diagnosticsTab(elements, view, width);
        default:
            return overviewTab(elements, view, width);
    }
};

// ---------------------------------------------------------------- overview

const overviewTab = (elements, view, width) => {
    const { Box, Text } = elements;
    const children = [];

    for (const meter of METERS) {
        const head = meterHeadline(view.snapshot, meter);

        if (!view.snapshot.meters?.[meter]) {
            continue;
        }

        children.push(meterCard(elements, view, meter, head, width));
    }

    children.push(
        Box({
            key: "legend",
            flexDirection: "column",
            marginTop: 1,
            children: [
                Text({ key: "l1", dimColor: true, children: fit("credits = input + cache_write + 5 × output (cache reads free); rate = credits one percent of the meter buys; $ = the same tokens at API list price.", width) }),
                Text({ key: "l2", dimColor: true, children: fit("Drift compares the 3-day rate with the 14-day one: 'shrank' means one percent now buys fewer credits, i.e. the allowance got smaller.", width) }),
            ],
        }),
    );

    return children;
};

const meterCard = (elements, view, meter, head, width) => {
    const { Box, Text, Raster } = elements;
    const current = head.current;
    const used = typeof current?.used_percentage === "number" ? current.used_percentage : null;
    const fraction = used === null ? 0 : used / 100;
    const barWidth = Math.max(10, Math.min(40, width - 60));
    const session = view.session?.[meter];
    const lines = [];

    const title = `${meter}  ${head.label}${head.claim ? `  (${head.claim})` : ""}`;
    lines.push(Text({ key: "title", bold: true, children: fit(title, width) }));

    const gauge = [];

    if (used !== null) {
        gauge.push(Raster({ key: `gauge:${meter}`, ...bar(fraction, barWidth, usageColor(fraction)) }));
    }

    const level = used === null ? "no reading" : `${used}% used`;
    const reset = current?.resets_at ? `resets in ${fmtDuration(current.resets_at - view.nowMs / 1000)}` : "";
    const agree = session && used !== null ? (session.percentUsed === used ? "session agrees" : `session says ${session.percentUsed}%`) : "";
    gauge.push(Text({ key: "level", children: fit(` ${[level, reset, agree].filter(Boolean).join("  ·  ")}`, Math.max(10, width - barWidth - 2)) }));
    lines.push(Box({ key: "gauge-row", flexDirection: "row", children: gauge }));

    if (current?.percent_per_hour) {
        const p = current.percent_per_hour;
        const pace = ["1h", "6h", "24h"].map((k) => `${k} ${typeof p[k] === "number" ? `${p[k].toFixed(2)}%/h` : "-"}`).join("  ");
        const eta = typeof current.hours_to_exhaustion === "number" ? `  ·  at the 6h pace, 100% in ${fmtDuration(current.hours_to_exhaustion * 3600)}` : "";
        const warn = current.exhausts_before_reset ? "  ·  BEFORE the reset" : "";
        lines.push(Text({ key: "pace", dimColor: !current.exhausts_before_reset, children: fit(`  pace ${pace}${eta}${warn}`, width) }));
    }

    if (head.lead) {
        const band = head.lead.band ? ` [${fmtK(head.lead.band[0])}–${fmtK(head.lead.band[1])}]` : "";
        const usd = head.lead.usd_per_percent == null ? "" : `  =  ${fmtUsd(head.lead.usd_per_percent)} of API per 1%  →  the whole meter ≈ ${fmtUsd(head.meterUsd)}`;
        lines.push(Text({ key: "lead", children: fit(`  ${shortModel(head.lead.model)}: ${fmtK(head.lead.credits_per_percent)} credits per 1%${band}${usd}`, width) }));
    } else {
        lines.push(Text({ key: "lead", dimColor: true, children: "  no rate yet (too few ticks)" }));
    }

    const others = modelRows(view.snapshot.meters[meter]?.windows?.[head.windowLabel ?? "7d"])
        .filter((row) => row.model !== head.lead?.model && row.model !== "other")
        .map((row) =>
            row.counted && typeof row.credits_per_percent === "number"
                ? `${shortModel(row.model)} ${fmtK(row.credits_per_percent)}${row.usd_per_percent == null ? "" : ` (${fmtUsd(row.usd_per_percent)})`}${row.identifiable ? "" : "?"}`
                : `${shortModel(row.model)} not counted`,
        );

    if (others.length > 0) {
        lines.push(Text({ key: "others", dimColor: true, children: fit(`  also: ${others.join("  ·  ")}`, width) }));
    }

    if (head.drift.length > 0) {
        for (const d of head.drift) {
            const sign = d.relative >= 0 ? "+" : "";
            lines.push(
                Text({
                    key: `drift:${d.model}`,
                    color: d.verdict === "shrank" ? "red" : "blue",
                    bold: true,
                    children: fit(`  DRIFT ${shortModel(d.model)}: ${d.verdict} ${sign}${(d.relative * 100).toFixed(0)}% vs 14d (z=${d.z.toFixed(1)})`, width),
                }),
            );
        }
    } else if (head.lead) {
        lines.push(Text({ key: "drift", dimColor: true, children: "  drift: stable (3d rate inside the 14d band)" }));
    }

    return Box({ key: `meter:${meter}`, flexDirection: "column", marginTop: 1, children: lines });
};

// ---------------------------------------------------------------- rates

const ratesTab = (elements, view, actions, width) => {
    const { Box, Text, Button } = elements;
    const children = [
        Box({
            key: "windows",
            flexDirection: "row",
            gap: 2,
            marginTop: 1,
            children: [
                Text({ key: "wlabel", dimColor: true, children: "window:" }),
                ...WINDOWS.map((w) =>
                    w === view.window
                        ? Text({ key: `win:${w}`, bold: true, underline: true, children: w })
                        : Button({ key: `win:${w}`, label: w, plain: true, onPress: () => actions.setWindow(w) }),
                ),
                Button({ key: "win:next", label: "next window", hotkey: "w", plain: true, onPress: () => actions.setWindow(WINDOWS[(WINDOWS.indexOf(view.window) + 1) % WINDOWS.length]) }),
            ],
        }),
    ];

    for (const meter of METERS) {
        const report = view.snapshot.meters?.[meter];

        if (!report) {
            continue;
        }

        const window = report.windows?.[view.window];
        const rows = modelRows(window);
        const lines = [Text({ key: "title", bold: true, children: fit(`${meter}  ${report.label}  ·  ${view.window} window`, width) })];

        if (!window || rows.length === 0) {
            lines.push(Text({ key: "none", dimColor: true, children: `  ${window?.reason ?? "no fit in this window"}` }));
        } else {
            lines.push(Text({ key: "fit", dimColor: true, children: fit(`  ${window.intervals_used}/${window.intervals} intervals used · ${window.percent_fitted ?? 0}% of meter fitted · explained ${fmtPct(window.explained)} · mean |residual| ${Number(window.mean_abs_residual ?? 0).toFixed(2)}%`, width) }));
            lines.push(Text({ key: "head", dimColor: true, children: fit(col(["model", 14], ["credits/1%", 12], ["16–84% band", 20], ["$/1%", 10], ["share", 7], ["×ref", 6], ["credits in fit", 15], ["note", 20]), width) }));

            for (const row of rows) {
                const note = !row.counted ? "not counted here" : row.identifiable ? "" : "wide band";
                const text = row.counted
                    ? col(
                          [shortModel(row.model), 14],
                          [fmtK(row.credits_per_percent), 12],
                          [row.band ? `${fmtK(row.band[0])}–${fmtK(row.band[1])}` : "-", 20],
                          [fmtUsd(row.usd_per_percent), 10],
                          [fmtPct(row.share_of_percent), 7],
                          [typeof row.weight_vs_reference === "number" ? row.weight_vs_reference.toFixed(2) : "-", 6],
                          [fmtK(row.credits_in_fit), 15],
                          [note, 20],
                      )
                    : col([shortModel(row.model), 14], ["-", 12], ["-", 20], ["-", 10], [fmtPct(row.share_of_percent), 7], ["-", 6], [fmtK(row.credits_in_fit), 15], [note, 20]);

                lines.push(Text({ key: `row:${row.model}`, dimColor: !row.counted, children: fit(text, width) }));
            }

            for (const [model, split] of Object.entries(window.split ?? {})) {
                if (!split) {
                    continue;
                }

                const c = split.counters ?? {};
                const ratio = typeof split.output_per_cache_write === "number" ? split.output_per_cache_write.toFixed(1) : "-";
                const band = Array.isArray(split.output_per_cache_write_band) ? ` [${split.output_per_cache_write_band[0].toFixed(1)}–${split.output_per_cache_write_band[1].toFixed(1)}]` : "";
                lines.push(
                    Text({
                        key: `split:${model}`,
                        dimColor: true,
                        children: fit(`  split ${shortModel(model)}: tokens per 1% → input ${fmtK(c.input?.tokens_per_percent)} · cache-write ${fmtK(c.cache_write?.tokens_per_percent)} · output ${fmtK(c.output?.tokens_per_percent)}`, width),
                    }),
                    Text({
                        key: `split-ratio:${model}`,
                        dimColor: true,
                        children: fit(`    output weighs ${ratio}×${band} a cache write (formula: ${Number(split.formula_expects ?? 0).toFixed(1)}×)`, width),
                    }),
                );
            }
        }

        children.push(Box({ key: `rates:${meter}`, flexDirection: "column", marginTop: 1, children: lines }));
    }

    return children;
};

// ---------------------------------------------------------------- burn

const burnTab = (elements, view, width) => {
    const { Box, Text, Raster } = elements;
    const burn = view.snapshot.burn ?? {};
    const days = burnDays(view.snapshot, 30);
    const children = [];

    const last = burn.last_24h ?? {};
    const lastRows = Object.entries(last)
        .map(([model, m]) => ({ model, ...m }))
        .sort((a, b) => (b.credits ?? 0) - (a.credits ?? 0));
    const lastTotal = lastRows.reduce((s, m) => s + (m.usd ?? 0), 0);
    const lastCredits = lastRows.reduce((s, m) => s + (m.credits ?? 0), 0);

    children.push(
        Box({
            key: "last24",
            flexDirection: "column",
            marginTop: 1,
            children: [
                Text({ key: "title", bold: true, children: fit(`Last 24 hours  ·  ${fmtK(lastCredits)} credits  ·  ${fmtUsd(lastTotal)} at API list price`, width) }),
                Text({ key: "head", dimColor: true, children: fit(col(["model", 14], ["requests", 9], ["credits", 10], ["API $", 9], ["input", 9], ["cache write", 12], ["cache read", 12], ["output", 9], ["% of 5h", 8], ["% of 7d", 8]), width) }),
                ...lastRows.map((m) =>
                    Text({
                        key: `l:${m.model}`,
                        children: fit(
                            col(
                                [shortModel(m.model), 14],
                                [String(m.requests ?? 0), 9],
                                [fmtK(m.credits), 10],
                                [m.usd_known === false ? "?" : fmtUsd(m.usd), 9],
                                [fmtK(m.input), 9],
                                [fmtK(m.cache_write), 12],
                                [fmtK(m.cache_read), 12],
                                [fmtK(m.output), 9],
                                [percentOf(view.snapshot, m, "5h"), 8],
                                [percentOf(view.snapshot, m, "7d"), 8],
                            ),
                            width,
                        ),
                    }),
                ),
            ],
        }),
    );

    const rl = burn.rate_limited ?? {};
    const cache = typeof burn.cache_hit_ratio_7d === "number" ? fmtPct(burn.cache_hit_ratio_7d, 1) : "-";
    children.push(
        Text({
            key: "meta",
            dimColor: true,
            marginTop: 1,
            children: fit(`cache hit ratio (7d) ${cache}  ·  429s: ${rl["24h"] ?? 0} in 24h, ${rl["7d"] ?? 0} in 7d, ${rl.total ?? 0} in the log`, width),
        }),
    );

    if (days.length > 0) {
        const usd = days.map((d) => d.usd);
        const spark = sparkline(usd, { maxColumns: Math.min(60, days.length), color: () => 0x00_ff_b3_00 });
        const lines = [
            Text({ key: "title", bold: true, marginTop: 1, children: fit(`By day  ·  ${days.length} days  ·  API $/day, oldest → newest (max ${fmtUsd(Math.max(...usd))})`, width) }),
        ];

        if (spark) {
            lines.push(Raster({ key: "spark:usd", ...spark }));
        }

        lines.push(Text({ key: "head", dimColor: true, children: fit(col(["day", 11], ["requests", 9], ["credits", 10], ["API $", 9], ["% of 7d", 8], ["top models", 40]), width) }));

        for (const day of days.slice(-14)) {
            const pct = percentOfMeter(view.snapshot, day, "7d");
            const top = day.models.slice(0, 3).map((m) => `${shortModel(m.model)} ${fmtUsd(m.usd)}`).join(", ");
            lines.push(
                Text({
                    key: `d:${day.date}`,
                    children: fit(col([day.date, 11], [String(day.requests), 9], [fmtK(day.credits), 10], [day.usdKnown ? fmtUsd(day.usd) : `${fmtUsd(day.usd)}?`, 9], [pct === null ? "-" : `${pct.toFixed(1)}%`, 8], [top, 40]), width),
                }),
            );
        }

        children.push(Box({ key: "bydays", flexDirection: "column", children: lines }));
    }

    return children;
};

const percentOf = (snapshot, m, meter) => {
    const rate = snapshot?.meters?.[meter]?.windows?.["7d"]?.models?.[m.model]?.credits_per_percent;

    return typeof rate === "number" && rate > 0 && typeof m.credits === "number" ? `${(m.credits / rate).toFixed(1)}%` : "-";
};

// ---------------------------------------------------------------- history

const historyTab = (elements, view, actions, width) => {
    const { Box, Text, Button, Raster } = elements;
    const meter = METERS.includes(view.meter) ? view.meter : "7d";
    const children = [
        Box({
            key: "meters",
            flexDirection: "row",
            gap: 2,
            marginTop: 1,
            children: [
                Text({ key: "mlabel", dimColor: true, children: "meter:" }),
                ...METERS.map((m) =>
                    m === meter
                        ? Text({ key: `meter:${m}`, bold: true, underline: true, children: m })
                        : Button({ key: `meter:${m}`, label: m, plain: true, onPress: () => actions.setMeter(m) }),
                ),
                Button({ key: "meter:next", label: "next meter", hotkey: "m", plain: true, onPress: () => actions.setMeter(METERS[(METERS.indexOf(meter) + 1) % METERS.length]) }),
            ],
        }),
    ];

    if (view.history.length === 0) {
        children.push(Text({ key: "none", dimColor: true, marginTop: 1, children: "No history rows yet: each estimator run appends one to exchange-history.jsonl." }));

        return children;
    }

    const first = view.history[0]?.generated_at_iso ?? "";
    const lastAt = view.history[view.history.length - 1]?.generated_at_iso ?? "";
    children.push(Text({ key: "span", dimColor: true, children: fit(`${view.history.length} runs from ${String(first).slice(0, 16)} to ${String(lastAt).slice(0, 16)}  ·  each point is the 7d-window rate at that run`, width) }));

    for (const model of historyModels(view.history, meter).slice(0, 4)) {
        const series = historySeries(view.history, meter, model);

        if (series.length === 0) {
            continue;
        }

        const rates = series.map((p) => p.rate);
        const latest = series[series.length - 1];
        const min = Math.min(...rates);
        const max = Math.max(...rates);
        const swing = min > 0 ? (max - min) / min : 0;
        const spark = sparkline(rates, { maxColumns: Math.min(width - 4, 120), color: () => modelColor(model) });
        const lines = [
            Text({ key: "title", bold: true, children: fit(`${shortModel(model)}  ·  latest ${fmtK(latest.rate)}${latest.band ? ` [${fmtK(latest.band[0])}–${fmtK(latest.band[1])}]` : ""}  ·  min ${fmtK(min)}  max ${fmtK(max)}  swing ${fmtPct(swing)}`, width) }),
        ];

        if (spark) {
            lines.push(Raster({ key: `spark:${meter}:${model}`, ...spark }));
        }

        const verdicts = view.history.map((row) => row?.meters?.[meter]?.drift?.[model]).filter(Boolean);
        const notStable = verdicts.filter((v) => v !== "stable").length;
        lines.push(Text({ key: "verdicts", dimColor: true, children: fit(`  drift verdicts: ${verdicts.length} runs, ${notStable} not stable${verdicts.length ? `, latest ${verdicts[verdicts.length - 1]}` : ""}`, width) }));
        children.push(Box({ key: `hist:${model}`, flexDirection: "column", marginTop: 1, children: lines }));
    }

    return children;
};

// ---------------------------------------------------------------- diagnostics

const diagnosticsTab = (elements, view, width) => {
    const { Box, Text } = elements;
    const s = view.snapshot;
    const children = [
        Box({
            key: "method",
            flexDirection: "column",
            marginTop: 1,
            children: [
                Text({ key: "t", bold: true, children: "Method" }),
                Text({ key: "m", dimColor: true, children: fit(`  ${s.method ?? "-"}`, width) }),
                Text({ key: "d", dimColor: true, children: fit(`  drift rule: ${s.drift_rule ? `${s.drift_rule.now} vs ${s.drift_rule.baseline}, |z| ≥ ${s.drift_rule.z} and |Δ| ≥ ${fmtPct(s.drift_rule.relative)}` : "-"}  ·  output weight ${s.output_weight ?? "-"}  ·  windows ${(s.windows ?? []).join(", ")}`, width) }),
            ],
        }),
    ];

    for (const meter of METERS) {
        const report = s.meters?.[meter];

        if (!report) {
            continue;
        }

        const c = report.censored ?? {};
        const lines = [
            Text({ key: "t", bold: true, children: fit(`${meter}  ${report.label}`, width) }),
            Text({ key: "rows", dimColor: true, children: fit(`  ${Number(report.header_rows ?? 0).toLocaleString("en-US")} header rows → ${report.intervals} intervals covering ${report.ticks_percent ?? 0}% of ticks`, width) }),
            Text({ key: "censored", dimColor: true, children: fit(`  censored: first level ${c.first_level ?? 0}, after drop ${c.after_drop ?? 0}, drops ${c.drops ?? 0}, reordered ${c.reordered ?? 0}`, width) }),
        ];

        for (const w of WINDOWS) {
            const window = report.windows?.[w];

            if (!window || !window.models) {
                lines.push(Text({ key: `w:${w}`, dimColor: true, children: `  ${w}: ${window?.reason ?? "no fit"}` }));

                continue;
            }

            const wc = window.censored ?? {};
            lines.push(Text({ key: `w:${w}`, children: fit(`  ${w.padEnd(4)} n=${window.intervals_used}/${window.intervals}  empty ${wc.empty ?? 0}  outliers ${wc.outlier ?? 0}  explained ${fmtPct(window.explained)}  mean|res| ${Number(window.mean_abs_residual ?? 0).toFixed(2)}%  MAD ${Number(window.residual_mad ?? 0).toFixed(2)}%  ref ${shortModel(window.reference)}`, width) }));
        }

        children.push(Box({ key: `diag:${meter}`, flexDirection: "column", marginTop: 1, children: lines }));
    }

    const src = s.sources ?? {};
    children.push(
        Box({
            key: "sources",
            flexDirection: "column",
            marginTop: 1,
            children: [
                Text({ key: "t", bold: true, children: "Sources" }),
                Text({ key: "u", dimColor: true, children: fit(`  usage dir ${src.usage_dir ?? "-"}`, width) }),
                Text({ key: "p", dimColor: true, children: fit(`  pricing ${src.pricing ?? "-"}`, width) }),
                Text({ key: "r", dimColor: true, children: fit(`  requests ${src.first_at_iso ?? "-"} → ${src.last_at_iso ?? "-"}  ·  generated ${s.generated_at_iso ?? "-"}`, width) }),
                Text({ key: "s", dimColor: true, children: fit(`  session sees: ${Object.entries(view.session ?? {}).map(([m, v]) => `${m} ${v.percentUsed}%`).join(", ") || "no rate limits reported"}`, width) }),
            ],
        }),
    );

    return children;
};

// ---------------------------------------------------------------- text helpers

/**
 * Fixed-width columns: each `[text, width]` padded or cut to its width, one
 * space between. The last column is not padded.
 */
export const col = (...cells) =>
    cells
        .map(([text, width], index) => {
            const s = String(text ?? "");

            if (index === cells.length - 1) {
                return s;
            }

            return s.length > width ? `${s.slice(0, Math.max(0, width - 1))}…` : s.padEnd(width);
        })
        .join(" ");

/**
 * One line, cut to the body width.
 *
 * Cutting rather than wrapping: a wrapped line is the `Code` overdraw bug in
 * another element. The whole text is in the JSON for anyone who wants it.
 */
export const fit = (text, width) => {
    const line = String(text ?? "").replace(/[\r\n\t]+/g, " ");

    return line.length > width ? `${line.slice(0, Math.max(0, width - 1))}…` : line;
};

/** Every line of a block cut to the width (for Markdown, which wraps on its own but is kept tidy). */
export const cutLines = (text, width) =>
    String(text ?? "")
        .split("\n")
        .map((line) => (line.length > width ? `${line.slice(0, Math.max(0, width - 1))}…` : line))
        .join("\n");

export { DEFAULT, verdictColor };
