// Fayllarni o'qish: .pdf .doc .docx .xls .xlsx .txt .csv va oddiy matn (tashqi kutubxonasiz)
// Natija: lug'at juftliklari (pairs), bo'limlar, test savollari (mcq) va Word ichidagi rasmlar (images).
import { pdfToLines } from "./pdf.js";
import { docLines, xlsLines, rowLines } from "./ole.js";
import { parseMcq } from "./mcq.js";

const SEPS = ["\t", " — ", " – ", " - ", " = ", " : ", "—", "–", "=", ";", "|", ":", " -", "- ", "-", ","];
const NUM = /^\s*\d+\s*[.)]\s*/;
const IMG = /⟦IMG\d+⟧/g;

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
  for (const p of pairs) {
    const k = p[0].toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(p);
    }
  }
  return out;
}

export function parseText(text) {
  return analyze(text.split(/\r?\n/));
}

// ---------- Tuzilmali matn: sarlavha (A1 1-DARS), bo'limlar (OTLAR / FE'LLAR), raqamli ro'yxat ----------
const TITLE = /^([ABC][12])\s*[-–.]?\s*(\d+)\s*[-–.]?\s*DARS\b/i;
const PURE_NUM = /^\d{1,4}$/;
const NUMBERED = /^\s*\d+\s*[.)]?\s+\S/;

function isHeader(line) {
  if (!/\p{L}/u.test(line) || /\d/.test(line) || line.length > 60) return false;
  // "USA - AQSH" kabi katta harfli so'z juftligi sarlavha emas (sarlavhada uzun tire "—" bo'ladi)
  if (splitLine(line) && !/\s[—–]\s/.test(line)) return false;
  return line === line.toLocaleUpperCase("tr") && line !== line.toLocaleLowerCase("tr");
}

function sectionName(h) {
  const parts = h.split(/\s+[—–-]\s+/);
  const s = (parts[1] || parts[0]).trim().replace(/İ/g, "i").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function tidy(s) {
  return s.replace(/\s+([,.;:)])/g, "$1").replace(/\(\s+/g, "(").replace(/(\p{L}) -(\p{L})/gu, "$1-$2").replace(/\s+/g, " ").trim();
}

export function parseLines(rawLines) {
  const lines = rawLines.map((l) => l.replace(IMG, "").replace(/[^\S\t]+/g, " ").replace(/ *\t */g, "\t").trim()).filter(Boolean);
  const sepLines = lines.filter((l) => splitLine(l));
  const numbered = sepLines.length > 0 && sepLines.filter((l) => NUMBERED.test(l)).length >= sepLines.length * 0.6;
  let title = null;
  const sections = [];
  let sec = -1;
  const pairs = [];
  let last = null;
  for (let i = 0; i < lines.length; i++) {
    const line = numbered ? lines[i].replace(/^\d+\s*[.)]?\s+/, "") : lines[i];
    const isNum = NUMBERED.test(lines[i]) || lines[i].includes("\t"); // jadval qatori ham alohida yozuv
    if (PURE_NUM.test(lines[i])) {
      // so'z raqami (ikki qatorli yozuvda) — davom etadi; sahifa raqami — zanjirni uzadi
      if (last?.wait) last.wait = false;
      else last = null;
      continue;
    }
    const tm = line.match(TITLE);
    if (tm) { title ??= `${tm[1].toUpperCase()} ${tm[2]}-dars`; last = null; continue; }
    if (isHeader(line)) {
      sections.push(sectionName(line));
      sec = sections.length - 1;
      last = null;
      continue;
    }
    if (/@|https?:|t\.me\//i.test(line)) { last = null; continue; }
    const p = splitLine(line);
    if (!numbered) {
      if (p) pairs.push([tidy(p[0]), tidy(p[1]), sec]);
      continue;
    }
    const startsEntry = isNum || (p && PURE_NUM.test(lines[i + 1] || ""));
    if (p && startsEntry) {
      const e = [tidy(p[0]), tidy(p[1]), sec];
      pairs.push(e);
      last = { e, wait: !isNum };
    } else if (last) last.e[1] = tidy(last.e[1] + " " + line);
    else last = null;
  }
  return { pairs: dedupe(pairs), title, sections };
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

// Kerakli fayllarni xom baytlar ko'rinishida qaytaradi
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
    if (data) files[name] = data;
  }
  return files;
}
const txt = (u8) => (u8 ? new TextDecoder().decode(u8) : "");

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function unxml(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : +e.slice(1));
    return ENT[e] ?? m;
  });
}

// Word paragrafi matni; ichidagi rasmlar ⟦IMGn⟧ belgisi bilan qo'shiladi
function docxText(xml, img) {
  xml = xml.replace(/<w:tab\/>/g, "<w:t>\t</w:t>");
  let t = unxml([...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(""));
  if (img) for (const m of xml.matchAll(/(?:r:embed|r:id)="(rId\d+)"/g)) {
    const n = img(m[1]);
    if (n != null) t += ` ⟦IMG${n}⟧`;
  }
  return t;
}

// Hujjat tartibida: paragraflar → qatorlar, jadval qatorlari → "so'z<TAB>tarjima" yoki test savoli
function docxLines(xml, img) {
  const out = [];
  for (const m of xml.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>|<w:p[\s>][\s\S]*?<\/w:p>/g)) {
    if (m[0].startsWith("<w:tbl>")) {
      for (const r of m[0].matchAll(/<w:tr[\s>][\s\S]*?<\/w:tr>/g))
        out.push(...rowLines([...r[0].matchAll(/<w:tc[\s>][\s\S]*?<\/w:tc>/g)].map((c) => docxText(c[0], img))));
    } else out.push(docxText(m[0], img));
  }
  return out;
}

function colIndex(ref) {
  const letters = (ref.match(/^[A-Z]+/) || ["A"])[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function xlsxLines(files) {
  const shared = [];
  const ss = txt(files["xl/sharedStrings.xml"]);
  if (ss) {
    for (const si of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      shared.push(unxml([...si[1].matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((m) => m[1]).join("")));
    }
  }
  const lines = [];
  const sheets = Object.keys(files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort();
  for (const name of sheets) {
    const rows = [];
    for (const r of txt(files[name]).matchAll(/<row[\s>][\s\S]*?<\/row>/g)) {
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
    for (const row of rows) lines.push(...rowLines(row).filter(Boolean));
  }
  return lines;
}

// Sahifa sarlavhasi/pastki yozuvlari: muallif, kanal, profil, havolalar (har sahifada takrorlanadi)
const HEADER_KEY = /^\s*(?:muallif|tuzuvchi|tayyorlovchi|tayyorladi|o['‘’`ʻ]qituvchi|author|автор|составитель|yazar|hazırlayan|telegram|instagram|youtube|tiktok|facebook|kanal(?:imiz|im)?|канал|guruh(?:imiz)?|группа|tel(?:efon)?|aloqa|контакт|manzil|sayt|website|web)\b[^\n]*[:：]/i;
const LINK_IN = /(https?:\/\/|www\.|\b(?:t|telegram)\.(?:me|dog)\/|(?<![\w.])@[A-Za-z][A-Za-z0-9_]{3,})/;
const CONTENT_START = /^\s*(?:\d{1,4}\s*[.)]|[A-Ja-jА-Ка-к]\s*[).]|[*+]\s*[A-Ja-j]\)|javob|to['‘’`ʻ]?g['‘’`ʻ]?ri javob|answer|ответ|cevap|izoh|explanation|⟦IMG)/i;
function stripHeaders(lines) {
  const counts = new Map();
  for (const l of lines) { const k = l.trim(); if (k) counts.set(k, (counts.get(k) || 0) + 1); }
  return lines.filter((l) => {
    const t = l.trim();
    if (!t) return true;
    if (CONTENT_START.test(t)) return true; // savol, variant va javob qatorlari doim qoladi
    if (HEADER_KEY.test(t)) return false;
    if (LINK_IN.test(t)) return false;
    return true;
  });
}

// Lug'at va test savollarini birga tahlil qilish
function analyze(lines, images = []) {
  lines = stripHeaders(lines);
  const res = parseLines(lines);
  res.mcq = parseMcq(lines);
  res.images = images;
  return res;
}

const IMG_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" };

export async function parseFile(filename, bytes) {
  const name = filename.toLowerCase();
  if (name.endsWith(".docx")) {
    const f = await unzip(bytes, (n) => n === "word/document.xml" || n === "word/_rels/document.xml.rels" || n.startsWith("word/media/"));
    // Rasmlar: rId → word/media/... → tartib raqami
    const rels = {};
    for (const m of txt(f["word/_rels/document.xml.rels"]).matchAll(/<Relationship\b[^>]*>/g)) {
      const id = m[0].match(/Id="([^"]+)"/)?.[1], target = m[0].match(/Target="([^"]+)"/)?.[1];
      if (id && target && /\/image"/.test(m[0])) rels[id] = "word/" + target.replace(/^\.?\//, "").replace(/^word\//, "");
    }
    const images = [];
    const byPath = {};
    const img = (rid) => {
      const path = rels[rid];
      if (!path || !f[path]) return null;
      const ext = path.split(".").pop().toLowerCase();
      if (!IMG_TYPES[ext]) return null; // .emf/.wmf kabi formatlarni Telegram qabul qilmaydi
      if (byPath[path] == null) { byPath[path] = images.length; images.push({ name: path.split("/").pop(), type: IMG_TYPES[ext], bytes: f[path] }); }
      return byPath[path];
    };
    return analyze(docxLines(txt(f["word/document.xml"]), img), images);
  }
  if (name.endsWith(".xlsx") || name.endsWith(".xlsm")) {
    const f = await unzip(bytes, (n) => n === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
    return analyze(xlsxLines(f));
  }
  if (name.endsWith(".pdf")) return analyze(await pdfToLines(bytes));
  if (name.endsWith(".doc")) return analyze(docLines(bytes));
  if (name.endsWith(".xls")) return analyze(xlsLines(bytes));
  return analyze(decode(bytes).split(/\r?\n/));
}
