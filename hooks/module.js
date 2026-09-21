/**
 * quota-exchange: what one percent of each subscription meter buys, drawn.
 *
 * The estimator in `estimator/exchange.py` fits credits-per-percent on the
 * proxy's rate-limit headers and writes `exchange-rate.json` and
 * `exchange-history.jsonl` into the usage directory. This module reads those
 * two files and draws them: `/quota` opens a pane with five tabs (overview,
 * rates, burn, history, diagnostics), and `/quota refresh` runs the estimator
 * first when `QUOTA_EXCHANGE_ESTIMATOR` names it.
 *
 * Nothing here computes a rate. A hooks module has a compute budget per
 * dispatch and no numpy; the fit is the cron's job and the pane shows what
 * the last run found and how long ago that was.
 *
 * Every `$` call that can fail is wrapped: the worst case of installing this
 * is a pane that says why it is empty.
 */

import { METERS, TABS, WINDOWS, parseHistory, parseSnapshot, sessionMeters } from "./data.js";
import { paneTree } from "./pane.js";

const PANE_ID = "quota-exchange";
const PANE_TITLE = "Quota exchange";
const COMMAND = "quota";

/** The two files the estimator writes, under the usage directory. */
const SNAPSHOT_FILE = "exchange-rate.json";
const HISTORY_FILE = "exchange-history.jsonl";

/** How long the refresh child may run. The fit takes ~10 s on a month of data. */
const REFRESH_TIMEOUT_MS = 120_000;

/** How often an open pane re-reads the files (the cron writes hourly). */
const RELOAD_MS = 5 * 60_000;

/**
 * This session's view: which tab, window and meter, and what was last read.
 * Per session by construction: the module is loaded once per session.
 */
let view = freshView();

/**
 * The manifest's `userConfig`, as `register` was handed it. The two settings
 * were environment variables first and both spellings still work, the
 * manifest's winning: a config-menu row is the discoverable half, and the
 * variable is what a cron line already exports around the session.
 */
let options = {};

/** A `userConfig` string, then its environment variable, then nothing. */
const setting = async ($, key, variable) => {
    const declared = options[key];

    if (typeof declared === "string" && declared.trim() !== "") {
        return declared.trim();
    }

    const fromEnv = await safely($, () => $.env.get(variable));

    return typeof fromEnv === "string" && fromEnv.trim() !== "" ? fromEnv.trim() : "";
};

function freshView() {
    return {
        tab: "overview",
        window: "7d",
        meter: "7d",
        snapshot: null,
        history: [],
        session: {},
        error: undefined,
        refreshing: false,
        refreshNote: undefined,
        nowMs: Date.now(),
        opened: false,
    };
}

/** @type {import('claude-code').Register} */
export const register = (on, pluginOptions) => {
    options = pluginOptions ?? {};

    on("session.start", async ($, e, next) => {
        view = freshView();

        await safely($, () =>
            $.command.register({
                name: COMMAND,
                description: "Subscription exchange rates: what 1% of the 5h / 7d / 7d-Fable meters buys, burn, history",
                argumentHint: "[overview|rates|burn|history|diagnostics|refresh]",
            }),
        );

        $.clock.every(RELOAD_MS, async () => {
            if (view.opened) {
                await safely($, () => reload($));
                await safely($, () => $.ui.invalidate("ui.render"));
            }
        });

        return next(e);
    });

    on("command.run", { command: COMMAND }, async ($, e) => {
        const args = String(e.args ?? "").trim().toLowerCase();
        const tab = TABS.find((t) => t.id === args || t.label.toLowerCase() === args);

        if (tab) {
            view.tab = tab.id;
        }

        if (args === "refresh") {
            const note = await refresh($);

            if (note) {
                view.refreshNote = note;
            }
        }

        await reload($);

        try {
            await $.ui.open({ id: PANE_ID, title: PANE_TITLE, focus: true, closeOnEscape: true });
            view.opened = true;
        } catch (error) {
            return { text: `quota-exchange: the pane would not open (${String(error).slice(0, 120)}).\n\n${summaryText()}` };
        }

        await safely($, () => $.ui.invalidate("ui.render"));

        return { text: summaryText() };
    });

    on("ui.render", { surface: "terminal", component: "Pane" }, async ($, e, next) => {
        if (e.requestId !== PANE_ID) {
            return next(e);
        }

        const elements = $.ui.resolve(e);
        const columns = typeof e.props?.bodyColumns === "number" ? e.props.bodyColumns : e.viewport?.columns;
        view.nowMs = Date.now();

        return paneTree(elements, view, actionsFor($), columns);
    });

    on("ui.close", async ($, e, next) => {
        if (e.id === PANE_ID) {
            view.opened = false;
        }

        return next(e);
    });
};

/** The handlers the pane's buttons run. Each redraws after changing the view. */
const actionsFor = ($) => ({
    setTab: (tab) => {
        view.tab = tab;
        void safely($, () => $.ui.invalidate("ui.render"));
    },
    setWindow: (window) => {
        view.window = WINDOWS.includes(window) ? window : view.window;
        void safely($, () => $.ui.invalidate("ui.render"));
    },
    setMeter: (meter) => {
        view.meter = METERS.includes(meter) ? meter : view.meter;
        void safely($, () => $.ui.invalidate("ui.render"));
    },
    refresh: () => {
        void (async () => {
            const note = await refresh($);
            view.refreshNote = note;
            await safely($, () => reload($));
            await safely($, () => $.ui.invalidate("ui.render"));
        })();
    },
    close: () => {
        view.opened = false;
        void safely($, () => $.ui.close({ id: PANE_ID }));
    },
});

/** Reads the two files and the session's own meters into the view. */
const reload = async ($) => {
    const dir = await usageDir($);
    const snapshotText = await readOrNull($, `${dir}/${SNAPSHOT_FILE}`);
    const parsed = parseSnapshot(snapshotText);

    view.snapshot = parsed.snapshot;
    view.error = parsed.error === undefined ? undefined : `${parsed.error} (${dir}/${SNAPSHOT_FILE})`;
    view.history = parseHistory(await readOrNull($, `${dir}/${HISTORY_FILE}`));
    view.session = sessionMeters(await safely($, () => $.session.usage()));
    view.nowMs = Date.now();
};

/**
 * Runs the estimator when `QUOTA_EXCHANGE_ESTIMATOR` names it, and says what
 * happened in one line for the status row.
 */
const refresh = async ($) => {
    const script = await setting($, "estimator", "QUOTA_EXCHANGE_ESTIMATOR");

    if (script === "") {
        return "refresh needs the `estimator` setting (or QUOTA_EXCHANGE_ESTIMATOR) to name exchange.py; the cron refreshes hourly anyway";
    }

    view.refreshing = true;
    await safely($, () => $.ui.invalidate("ui.render"));

    try {
        const started = Date.now();
        const result = await $.process.run(["python3", script], { timeoutMs: REFRESH_TIMEOUT_MS });
        const seconds = ((Date.now() - started) / 1000).toFixed(1);

        if (result.exitCode !== 0) {
            return `refresh failed (exit ${result.exitCode}): ${String(result.stderr ?? "").trim().split("\n").pop()?.slice(0, 160) ?? ""}`;
        }

        return `refreshed in ${seconds}s`;
    } catch (error) {
        return `refresh failed: ${String(error).slice(0, 160)}`;
    } finally {
        view.refreshing = false;
    }
};

/** The `usageDir` setting, `QUOTA_EXCHANGE_USAGE_DIR`, or `~/.claude/usage`. */
const usageDir = async ($) => {
    const override = await setting($, "usageDir", "QUOTA_EXCHANGE_USAGE_DIR");

    if (override !== "") {
        return override.replace(/\/+$/, "");
    }

    const home = (await safely($, () => $.env.get("HOME"))) ?? "";

    return `${home}/.claude/usage`;
};

const readOrNull = async ($, path) => {
    try {
        if (!(await $.fs.exists(path))) {
            return null;
        }

        return await $.fs.read(path);
    } catch {
        return null;
    }
};

/** The transcript line the command answers with: one line per meter. */
const summaryText = () => {
    if (!view.snapshot) {
        return `quota-exchange: ${view.error ?? "no snapshot"}. The pane says how to set the estimator up.`;
    }

    const lines = [];

    for (const meter of METERS) {
        const report = view.snapshot.meters?.[meter];
        const window = report?.windows?.["7d"];
        const current = view.snapshot.current?.[meter];

        if (!report) {
            continue;
        }

        const models = Object.entries(window?.models ?? {})
            .filter(([, m]) => m.counted && typeof m.credits_per_percent === "number")
            .sort((a, b) => (b[1].share_of_percent ?? 0) - (a[1].share_of_percent ?? 0))
            .slice(0, 3)
            .map(([model, m]) => `${model.replace(/^claude-/, "")} ${Math.round(m.credits_per_percent / 1000)}k${typeof m.usd_per_percent === "number" ? ` ($${m.usd_per_percent.toFixed(2)})` : ""}`)
            .join(", ");
        const drift = Object.entries(report.drift ?? {})
            .filter(([, d]) => d.verdict !== "stable")
            .map(([model, d]) => `${model.replace(/^claude-/, "")} ${d.verdict} ${(d.relative * 100).toFixed(0)}%`)
            .join(", ");
        const level = typeof current?.used_percentage === "number" ? `${current.used_percentage}% used` : "no reading";

        lines.push(`${meter}: ${level}; per 1% (7d fit): ${models || "no fit"}${drift ? `; DRIFT ${drift}` : ""}`);
    }

    return `Quota exchange pane is open (esc closes).\n${lines.join("\n")}`;
};

/**
 * A `$` call whose failure must not take the dispatch down: the result, or
 * null with a line in the transcript's debug log.
 */
const safely = async ($, run) => {
    try {
        return await run();
    } catch (error) {
        try {
            await $.ui.log(`quota-exchange: ${String(error).slice(0, 200)}`);
        } catch {
            // Nothing left to tell.
        }

        return null;
    }
};
