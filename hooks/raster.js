/**
 * Cells for a `Raster`: sparklines and bars, packed as the terminal wants
 * them.
 *
 * A Raster's `cells` is standard base64 of `columns * rows` little-endian u32
 * triplets `[codePoint, foreground, background]`. The base64 is written here
 * rather than taken from the host: a hooks module has no Buffer, and
 * `Uint8Array.prototype.toBase64` is newer than some of the runtimes the tests
 * run under.
 */

/** The terminal's own colour, for either channel. */
export const DEFAULT = 0x01000000;

/** Eight block heights, lowest first, and a blank. */
const BLOCKS = [0x2581, 0x2582, 0x2583, 0x2584, 0x2585, 0x2586, 0x2587, 0x2588];
const SPACE = 0x20;
const FULL = 0x2588;

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Standard padded base64 of bytes. */
export const base64 = (bytes) => {
    let out = "";

    for (let i = 0; i < bytes.length; i += 3) {
        const a = bytes[i];
        const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
        const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
        const n = (a << 16) | (b << 8) | c;

        out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
        out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=";
        out += i + 2 < bytes.length ? B64[n & 63] : "=";
    }

    return out;
};

/**
 * Packs a grid of `{ cp, fg, bg }` cells, row-major, into a Raster's `cells`.
 *
 * @param {Array<Array<{ cp: number, fg?: number, bg?: number }>>} grid
 */
export const packCells = (grid) => {
    const rows = grid.length;
    const columns = rows === 0 ? 0 : grid[0].length;
    const words = new Uint32Array(rows * columns * 3);
    let i = 0;

    for (const row of grid) {
        for (const cell of row) {
            words[i++] = cell.cp;
            words[i++] = cell.fg ?? DEFAULT;
            words[i++] = cell.bg ?? DEFAULT;
        }
    }

    // Little-endian by hand: a DataView is the portable spelling.
    const bytes = new Uint8Array(words.length * 4);
    const view = new DataView(bytes.buffer);

    for (let k = 0; k < words.length; k++) {
        view.setUint32(k * 4, words[k], true);
    }

    return { columns, rows, cells: base64(bytes) };
};

/**
 * A one-row sparkline: each value one block, scaled between `min` and `max`
 * (the series' own by default), coloured by `color(value, index)`.
 *
 * Returns Raster props (`columns`, `rows`, `cells`) for `values.length`
 * columns, or null for an empty series. A series wider than `maxColumns` is
 * thinned to its last `maxColumns` points.
 *
 * @param {number[]} values
 * @param {{ maxColumns?: number, min?: number, max?: number, color?: (value: number, index: number) => number }} options
 */
export const sparkline = (values, options = {}) => {
    const maxColumns = Math.max(1, Math.min(512, options.maxColumns ?? 60));
    const series = values.filter((v) => typeof v === "number" && Number.isFinite(v)).slice(-maxColumns);

    if (series.length === 0) {
        return null;
    }

    const min = options.min ?? Math.min(...series);
    const max = options.max ?? Math.max(...series);
    const span = max - min;
    const color = options.color ?? (() => DEFAULT);
    const row = series.map((value, index) => {
        const level = span <= 0 ? 4 : Math.round(((value - min) / span) * 7);

        return { cp: BLOCKS[Math.max(0, Math.min(7, level))], fg: color(value, index), bg: DEFAULT };
    });

    return packCells([row]);
};

/**
 * A horizontal bar: `fraction` of `columns` filled, coloured by `fg`, the rest
 * blank on `bg`. Raster props for one row.
 *
 * @param {number} fraction 0..1
 * @param {number} columns
 * @param {number} fg
 */
export const bar = (fraction, columns, fg, bg = DEFAULT) => {
    const width = Math.max(1, Math.min(512, Math.floor(columns)));
    const filled = Math.round(Math.max(0, Math.min(1, fraction)) * width);
    const row = [];

    for (let i = 0; i < width; i++) {
        row.push(i < filled ? { cp: FULL, fg, bg } : { cp: SPACE, fg: DEFAULT, bg });
    }

    return packCells([row]);
};

/** Green under 60%, amber to 85%, red above. */
export const usageColor = (fraction) => (fraction < 0.6 ? 0x00_4c_af_50 : fraction < 0.85 ? 0x00_ff_b3_00 : 0x00_f4_43_36);

/** A drift verdict's colour: green stable, red shrank, blue grew. */
export const verdictColor = (verdict) => (verdict === "shrank" ? 0x00_f4_43_36 : verdict === "grew" ? 0x00_42_a5_f5 : 0x00_4c_af_50);

/** A model's colour, stable per family. */
export const modelColor = (model) => {
    const name = String(model ?? "");

    if (name.includes("fable")) return 0x00_ab_47_bc;
    if (name.includes("opus")) return 0x00_ff_b3_00;
    if (name.includes("sonnet")) return 0x00_42_a5_f5;
    if (name.includes("haiku")) return 0x00_26_a6_9a;

    return 0x00_9e_9e_9e;
};
