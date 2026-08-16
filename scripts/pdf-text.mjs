#!/usr/bin/env node
/* Text out of a PDF, for the Elecbits process documents.

   These are Type0/CID PDFs: the glyph codes in the content streams mean
   nothing on their own, so the code→unicode table has to be read from each
   font's ToUnicode CMap first. Some of those font dictionaries live inside
   compressed object streams, which is why the CMaps are found by their own
   syntax rather than by following a /ToUnicode reference.

     node scripts/pdf-text.mjs <in.pdf> <out.txt>
*/
import { readFileSync, writeFileSync } from "node:fs";
import zlib from "node:zlib";

const buf = readFileSync(process.argv[2]);
const raw = buf.toString("latin1");

/* every object's byte range */
const objs = new Map();
for (const m of raw.matchAll(/(\d+)\s+0\s+obj/g)) {
  const start = m.index + m[0].length;
  const end = raw.indexOf("endobj", start);
  objs.set(Number(m[1]), { start, end, head: raw.slice(start, Math.min(start + 400, end)) });
}
const streamOf = (o) => {
  const s = raw.indexOf("stream", o.start);
  if (s < 0 || s > o.end) return null;
  let a = s + 6;
  if (buf[a] === 13) a++;
  if (buf[a] === 10) a++;
  const e = raw.indexOf("endstream", a);
  try { return zlib.inflateSync(buf.subarray(a, e)); } catch { return null; }
};

/* ToUnicode CMaps → one map per font object */
const cmaps = new Map();
// Font dictionaries can live inside compressed object streams, so a raw
// /ToUnicode reference is not always visible. Inflate everything and let the
// CMap identify itself by its own syntax.
for (const [n, o] of objs) {
  const data = streamOf(o);
  if (!data) continue;
  const t = data.toString("latin1");
  if (!/beginbfchar|beginbfrange/.test(t)) continue;
  const map = new Map();
  const hexToStr = (h) => {
    let s = "";
    for (let i = 0; i + 3 < h.length + 1; i += 4) s += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
    return s;
  };
  for (const b of t.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const p of b[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.set(parseInt(p[1], 16), hexToStr(p[2]));
    }
  }
  for (const b of t.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const p of b[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const lo = parseInt(p[1], 16), hi = parseInt(p[2], 16), dst = parseInt(p[3], 16);
      for (let c = lo; c <= hi && c - lo < 65535; c++) map.set(c, String.fromCharCode(dst + (c - lo)));
    }
  }
  if (map.size) cmaps.set(n, map);
}
// One merged map: these documents use a single embedded family, so a per-font
// table would be the same table several times over.
const merged = new Map();
for (const m of cmaps.values()) for (const [k, v] of m) if (!merged.has(k)) merged.set(k, v);

const decodeHex = (h) => {
  let s = "";
  for (let i = 0; i + 1 < h.length; i += 4) {
    const code = parseInt(h.slice(i, i + 4), 16);
    s += merged.get(code) ?? "";
  }
  return s;
};

/* content streams → text */
const out = [];
for (const [, o] of objs) {
  const data = streamOf(o);
  if (!data) continue;
  const t = data.toString("latin1");
  if (!/\bTJ\b|\bTj\b/.test(t)) continue;
  let page = "";
  for (const m of t.matchAll(/\[((?:[^\]\\]|\\.)*)\]\s*TJ|<([0-9A-Fa-f\s]+)>\s*Tj|\(((?:[^()\\]|\\.)*)\)\s*Tj|(T\*|ET|BT)/g)) {
    if (m[4]) { page += "\n"; continue; }
    if (m[2] !== undefined) { page += decodeHex(m[2].replace(/\s/g, "")); continue; }
    if (m[3] !== undefined) { page += m[3].replace(/\\([()\\])/g, "$1"); continue; }
    for (const p of (m[1] || "").matchAll(/<([0-9A-Fa-f\s]+)>|\(((?:[^()\\]|\\.)*)\)|(-?\d+(?:\.\d+)?)/g)) {
      if (p[1] !== undefined) page += decodeHex(p[1].replace(/\s/g, ""));
      else if (p[2] !== undefined) page += p[2].replace(/\\([()\\])/g, "$1");
      else if (Number(p[3]) < -180) page += " ";   // a wide kern is a space
    }
  }
  out.push(page.replace(/\n{3,}/g, "\n\n").trim());
}
// Each glyph is positioned separately, so a naive newline-per-move puts one
// character on every line. Stitch runs of single characters back together.
const stitch = (t) => t.split("\n").reduce((acc, line) => {
  const l = line.replace(/\s+$/, "");
  if (l.length <= 1 && acc.length && acc[acc.length - 1].tiny) acc[acc.length - 1].s += l;
  else acc.push({ s: l, tiny: l.length <= 1 });
  return acc;
}, []).map((x) => x.s).filter((x) => x.trim()).join("\n");
const text = out.map(stitch).filter(Boolean).join("\n\n──────\n\n");
writeFileSync(process.argv[3], text);
console.log(`${merged.size} glyphs mapped · ${text.length} chars`);
