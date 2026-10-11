// Lug'at fayllarini o'qish: .txt .csv .tsv .docx .xlsx va oddiy matn (tashqi kutubxonasiz)

const SEPS = ["\t", " — ", " – ", " - ", " = ", " : ", "—", "–", "=", ";", "|", ":", " -", "- ", "-", ","];
const NUM = /^\s*\d+\s*[.)]\s*/;

export function splitLine(line) {
  line = line.trim().replace(NUM, "");
  if (!line || line.startsWith("#")) return null;
  for (const sep of SEPS) {
    const i = line.indexOf(sep);
    if (i >= 0) {
      const a = line.slice(0, i).trim();
      const b = line.slice(i + sep.length).trim();
      if (a && b) return [a, b];
    }
  }
  return null;
}

function dedupe(pairs) {
  const seen = new Set();
  const out = [];
  for (const [a, b] of pairs) {
    const k = a.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push([a, b]);
    }
  }
  return out;
}

function fromRows(rows) {
  const pairs = [];
  for (const row of rows) {
    const cells = row.map((c) => (c == null ? "" : String(c).trim())).filter(Boolean);
    if (cells.length >= 2) pairs.push([cells[0].replace(NUM, ""), cells[1]]);
    else if (cells.length === 1) {
      const p = splitLine(cells[0]);
      if (p) pairs.push(p);
    }
  }
  return pairs;
}

export function parseText(text) {
  return dedupe(text.split(/\r?\n/).map(splitLine).filter(Boolean));
}

function decode(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
  } catch {}
  try {
    return new TextDecoder("windows-1251").decode(bytes);
  } catch {}
  return new TextDecoder("utf-8").decode(bytes);
}

// ---------- ZIP (docx/xlsx ichini ochish) ----------
async function inflate(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function unzip(buf, want) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("ZIP emas");
  const n = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files = {};
  const dec = new TextDecoder();
  for (let k = 0; k < n; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true);
    const elen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const off = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + elen + clen;
    if (!want(name)) continue;
    const start = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true);
    const raw = buf.subarray(start, start + csize);
    const data = method === 0 ? raw : method === 8 ? await inflate(raw) : null;
    if (data) files[name] = dec.decode(data);
  }
  return files;
}

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function unxml(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : +e.slice(1));
    return ENT[e] ?? m;
  });
}

function docxText(xml) {
  xml = xml.replace(/<w:tab\/>/g, "<w:t>\t</w:t>");
  return unxml([...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(""));
}

function parseDocx(xml) {
  const pairs = [];
  const tables = [];
  xml = xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, (t) => { tables.push(t); return ""; });
  for (const m of xml.matchAll(/<w:p[\s>][\s\S]*?<\/w:p>/g)) {
    const p = splitLine(docxText(m[0]));
    if (p) pairs.push(p);
  }
  for (const t of tables) {
    const rows = [...t.matchAll(/<w:tr[\s>][\s\S]*?<\/w:tr>/g)].map((r) =>
      [...r[0].matchAll(/<w:tc[\s>][\s\S]*?<\/w:tc>/g)].map((c) => docxText(c[0])));
    pairs.push(...fromRows(rows));
  }
  return pairs;
}

function colIndex(ref) {
  const letters = (ref.match(/^[A-Z]+/) || ["A"])[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseXlsx(files) {
  const shared = [];
  const ss = files["xl/sharedStrings.xml"];
  if (ss) {
    for (const si of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      shared.push(unxml([...si[1].matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((m) => m[1]).join("")));
    }
  }
  const pairs = [];
  const sheets = Object.keys(files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort();
  for (const name of sheets) {
    const rows = [];
    for (const r of files[name].matchAll(/<row[\s>][\s\S]*?<\/row>/g)) {
      const row = [];
      for (const c of r[0].matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1];
        const inner = c[2] || "";
        const ref = (attrs.match(/\br="([A-Z]+)\d*"/) || [, "A"])[1];
        const t = (attrs.match(/\bt="(\w+)"/) || [])[1];
        let v = "";
        if (t === "inlineStr") v = unxml([...inner.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((m) => m[1]).join(""));
        else {
          const vm = inner.match(/<v>([^<]*)<\/v>/);
          if (vm) v = t === "s" ? shared[+vm[1]] ?? "" : unxml(vm[1]);
        }
        row[colIndex(ref)] = v;
      }
      rows.push(row);
    }
    pairs.push(...fromRows(rows));
  }
  return pairs;
}

export async function parseFile(filename, bytes) {
  const name = filename.toLowerCase();
  if (name.endsWith(".docx")) {
    const f = await unzip(bytes, (n) => n === "word/document.xml");
    return dedupe(parseDocx(f["word/document.xml"] || ""));
  }
  if (name.endsWith(".xlsx") || name.endsWith(".xlsm")) {
    const f = await unzip(bytes, (n) => n === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
    return dedupe(parseXlsx(f));
  }
  return parseText(decode(bytes));
}
