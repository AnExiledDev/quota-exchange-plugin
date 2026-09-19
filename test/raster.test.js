import { describe, expect, test } from "bun:test";

import { DEFAULT, bar, base64, packCells, sparkline, usageColor } from "../hooks/raster.js";

const decode = (cells) => {
    const bytes = Buffer.from(cells, "base64");
    const words = [];

    for (let i = 0; i < bytes.length; i += 4) {
        words.push(bytes.readUInt32LE(i));
    }

    return words;
};

describe("base64", () => {
    test("matches the platform's for every padding length", () => {
        for (const text of ["", "a", "ab", "abc", "abcd", "hello raster"]) {
            expect(base64(new TextEncoder().encode(text))).toBe(Buffer.from(text).toString("base64"));
        }
    });
});

describe("packCells", () => {
    test("one orange full block is the documented triplet, little-endian", () => {
        const packed = packCells([[{ cp: 0x2588, fg: 0xff8800 }]]);

        expect(packed).toMatchObject({ columns: 1, rows: 1 });
        expect(decode(packed.cells)).toEqual([0x2588, 0xff8800, DEFAULT]);
    });
});

describe("sparkline", () => {
    test("scales the series over the eight block heights, low to high", () => {
        const spark = sparkline([0, 50, 100]);
        const words = decode(spark.cells);

        expect(spark.columns).toBe(3);
        expect(spark.rows).toBe(1);
        expect([words[0], words[3], words[6]]).toEqual([0x2581, 0x2585, 0x2588]);
    });

    test("a flat series draws mid-height, an empty one nothing, a long one its tail", () => {
        expect(decode(sparkline([5, 5]).cells)[0]).toBe(0x2585);
        expect(sparkline([])).toBeNull();
        expect(sparkline([1, 2, 3, 4], { maxColumns: 2 }).columns).toBe(2);
    });
});

describe("bar", () => {
    test("fills the fraction and blanks the rest", () => {
        const words = decode(bar(0.5, 4, 0x4caf50).cells);
        const glyphs = [words[0], words[3], words[6], words[9]];

        expect(glyphs).toEqual([0x2588, 0x2588, 0x20, 0x20]);
        expect(words[1]).toBe(0x4caf50);
    });

    test("colours green, amber, red by fill", () => {
        expect(usageColor(0.2)).toBe(0x4caf50);
        expect(usageColor(0.7)).toBe(0xffb300);
        expect(usageColor(0.95)).toBe(0xf44336);
    });
});
