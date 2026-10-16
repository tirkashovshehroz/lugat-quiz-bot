// Eski Office formatlari: .doc (Word 97–2003) va .xls (Excel 97–2003). Tashqi kutubxonasiz.

const CP1252 = { 0x80: "€", 0x82: "‚", 0x83: "ƒ", 0x84: "„", 0x85: "…", 0x86: "†", 0x87: "‡", 0x88: "ˆ", 0x89: "‰",
  0x8a: "Š", 0x8b: "‹", 0x8c: "Œ", 0x8e: "Ž", 0x91: "‘", 0x92: "’", 0x93: "“", 0x94: "”", 0x95: "•", 0x96: "–",
  0x97: "—", 0x98: "˜", 0x99: "™", 0x9a: "š", 0x9b: "›", 0x9c: "œ", 0x9e: "ž", 0x9f: "Ÿ" };
const cp = (b) => CP1252[b] ?? String.fromCharCode(b);
const ENDS = 0xfffffffa;

// ---------- OLE (Compound File) o'qish ----------
function openCfb(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 0xe011cfd0 || dv.getUint32(4, true) !== 0xe11ab1a1) throw new Error("OLE emas");
  const ss = 1 << dv.getUint16(0x1e, true);
  const mss = 1 << dv.getUint16(0x20, true);
  const cutoff = dv.getUint32(0x38, true);
  const sector = (id) => buf.subarray((id + 1) * ss, (id + 2) * ss);
  const u32s = (bytes) => {
    const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out = [];
    for (let i = 0; i + 4 <= bytes.length; i += 4) out.push(d.getUint32(i, true));
    return out;
  };
  // FAT sektorlari ro'yxati (DIFAT)
  const fatIds = [];
  for (let i = 0; i < 109; i++) {
    const id = dv.getUint32(0x4c + i * 4, true);
    if (id < ENDS) fatIds.push(id);
  }
  let difat = dv.getUint32(0x44, true);
  for (let guard = 0; difat < ENDS && guard < 10000; guard++) {
    const ids = u32s(sector(difat));
    const next = ids.pop();
    for (const id of ids) if (id < ENDS) fatIds.push(id);
    difat = next;
  }
  const fat = [];
  for (const id of fatIds) fat.push(...u32s(sector(id)));
  const chain = (start, table) => {
    const out = [];
    const seen = new Set();
    for (let id = start; id < ENDS && !seen.has(id) && id < table.length; id = table[id]) { seen.add(id); out.push(id); }
    return out;
  };
  const readBig = (start, size) => {
    const ids = chain(start, fat);
    const out = new Uint8Array(ids.length * ss);
    ids.forEach((id, k) => out.set(sector(id), k * ss));
    return size == null ? out : out.subarray(0, size);
  };
  // Katalog
  const dirBytes = readBig(dv.getUint32(0x30, true));
  const ddv = new DataView(dirBytes.buffer, dirBytes.byteOffset, dirBytes.byteLength);
  const entries = [];
  for (let o = 0; o + 128 <= dirBytes.length; o += 128) {
    const nlen = ddv.getUint16(o + 0x40, true);
    let name = "";
    for (let i = 0; i + 2 < nlen; i += 2) name += String.fromCharCode(ddv.getUint16(o + i, true));
    entries.push({ name, type: dirBytes[o + 0x42], start: ddv.getUint32(o + 0x74, true), size: ddv.getUint32(o + 0x78, true) });
  }
  const root = entries.find((e) => e.type === 5);
  const miniStream = root ? readBig(root.start, root.size) : new Uint8Array(0);
  const miniFat = u32s(readBig(dv.getUint32(0x3c, true)));
  return (name) => {
    const e = entries.find((x) => x.type === 2 && x.name.toLowerCase() === name.toLowerCase());
    if (!e) return null;
    if (e.size >= cutoff) return readBig(e.start, e.size);
    const ids = chain(e.start, miniFat);
    const out = new Uint8Array(ids.length * mss);
    ids.forEach((id, k) => out.set(miniStream.subarray(id * mss, (id + 1) * mss), k * mss));
    return out.subarray(0, e.size);
  };
}

const isNumCell = (s) => /^\s*\d+\s*[.)]?\s*$/.test(s);
const isLetter = (s) => /^[A-Ja-jА-Га-г]$/.test(s);
const same = (a, b) => a.toLowerCase().replace(/\s+/g, "") === b.toLowerCase().replace(/\s+/g, "");

// Jadval qatori test savoli bo'lsa: Savol | A | B | C | D | Javob [| Izoh] → test qatorlari
export function rowLines(cells) {
  let c = cells.map((x) => (x == null ? "" : String(x).replace(/\s+/g, " ").trim())).filter(Boolean);
  let num = 0;
  if (c.length && isNumCell(c[0])) num = parseInt(c.shift(), 10);
  // Sarlavha qatori ("№ | Savol | A | B | C | D | Javob" yoki "So'z | Tarjima") — o'tkazib yuboramiz
  if (c.some((x, i) => x.toUpperCase() === "A" && (c[i + 1] || "").toUpperCase() === "B")) return [];
  const HEAD = /^(№|#|n|no|savol|savollar|javob|to['‘’`ʻ]?g['‘’`ʻ]?ri javob|izoh|so['‘’`ʻ]z|so['‘’`ʻ]zlar|tarjima|tarjimasi|ma['‘’`ʻ]nosi|word|words|translation|question|answer|explanation|слово|перевод|вопрос|ответ|kelime|çeviri|soru|cevap|açıklama|turkcha|o['‘’`ʻ]zbekcha|inglizcha|ruscha|nemischa|arabcha|koreyscha|xitoycha|yaponcha|fransuzcha|talaffuz|talaffuzi|transkripsiya|pronunciation|transcription|произношение|транскрипция|русский|узбекский|английский|турецкий|okunuş|telaffuz|türkçe|özbekçe|rusça|english|russian|uzbek|turkish)$/i;
  if (c.length >= 2 && c.every((x) => HEAD.test(x.trim()))) return [];
  const asMcq = (q, opts, ans, exp) => [`${num || 1}. ${q}`, ...opts.map((o, i) => `${"ABCDEFGHIJ"[i]}) ${o}`), `Javob: ${ans}`,
    ...(exp ? [`Izoh: ${exp}`] : [])];
  if (c.length >= 4) {
    const last = c[c.length - 1];
    const opts = c.slice(1, -1);
    if (opts.length >= 2 && opts.length <= 10 && (isLetter(last) || opts.some((o) => same(o, last))))
      return asMcq(c[0], opts, last);
  }
  // Oxirgi ustun — izoh, undan oldingisi — javob
  if (c.length >= 5) {
    const ans = c[c.length - 2];
    const opts = c.slice(1, -2);
    if (opts.length >= 2 && opts.length <= 10 && (isLetter(ans) || opts.some((o) => same(o, ans))))
      return asMcq(c[0], opts, ans, c[c.length - 1]);
  }
  return [rowLine(cells)];
}

// Jadval qatori → "so'z<TAB>tarjima" (raqam ustunlari tashlab yuboriladi)
export function rowLine(cells) {
  const c = cells.map((x) => (x == null ? "" : String(x).replace(/\s+/g, " ").trim())).filter((x) => x && !isNumCell(x));
  return c.slice(0, 2).join("\t");
}

// ---------- .doc ----------
export function docLines(buf) {
  const get = openCfb(buf);
  const wd = get("WordDocument");
  if (!wd) throw new Error("WordDocument yo'q");
  const dv = new DataView(wd.buffer, wd.byteOffset, wd.byteLength);
  if (dv.getUint16(0, true) !== 0xa5ec) throw new Error("Word 97+ emas");
  const flags = dv.getUint16(0x0a, true);
  if (flags & 0x0100) throw new Error("Shifrlangan");
  const table = get(flags & 0x0200 ? "1Table" : "0Table");
  if (!table) throw new Error("Table yo'q");
  // FIB ichidan joylashuvlarni hisoblash
  let o = 32;
  const csw = dv.getUint16(o, true); o += 2 + csw * 2;
  const cslw = dv.getUint16(o, true); const lw = o + 2; o += 2 + cslw * 4;
  const ccpText = dv.getUint32(lw + 12, true);
  const fcLcb = o + 2;
  const fcClx = dv.getUint32(fcLcb + 33 * 8, true);
  const lcbClx = dv.getUint32(fcLcb + 33 * 8 + 4, true);
  const tdv = new DataView(table.buffer, table.byteOffset, table.byteLength);
  let p = fcClx;
  const end = fcClx + lcbClx;
  while (p < end && table[p] === 0x01) p += 3 + tdv.getInt16(p + 1, true);
  if (table[p] !== 0x02) throw new Error("Clx topilmadi");
  const lcb = tdv.getUint32(p + 1, true);
  const plc = p + 5;
  const n = (lcb - 4) / 12;
  let text = "";
  for (let i = 0; i < n && text.length < ccpText; i++) {
    const cp0 = tdv.getUint32(plc + i * 4, true);
    const cp1 = tdv.getUint32(plc + (i + 1) * 4, true);
    let fc = tdv.getUint32(plc + (n + 1) * 4 + i * 8 + 2, true);
    const len = cp1 - cp0;
    if (fc & 0x40000000) {
      fc = (fc & ~0x40000000) / 2;
      for (let k = 0; k < len; k++) text += cp(wd[fc + k]);
    } else {
      for (let k = 0; k < len; k++) text += String.fromCharCode(dv.getUint16(fc + k * 2, true));
    }
  }
  text = text.slice(0, ccpText);
  // maydon kodlarini olib tashlash: \x13 kod \x14 natija \x15
  text = text.replace(/\x13[^\x13\x14\x15]*\x14/g, "").replace(/\x13[^\x13\x14\x15]*\x15/g, "").replace(/[\x14\x15\x01\x08]/g, "");
  // Jadval: har katak \x07 bilan tugaydi, qator oxirida yana bitta \x07 bo'ladi
  const out = [];
  let cell = "", row = [], afterCell = false;
  for (const ch of text) {
    if (ch === "\x07") {
      if (afterCell && cell === "") { out.push(...rowLines(row)); row = []; afterCell = false; }
      else { row.push(cell); cell = ""; afterCell = true; }
    } else if (ch === "\r" || ch === "\x0c") {
      if (row.length) cell += " ";
      else { out.push(cell); cell = ""; }
      afterCell = false;
    } else {
      cell += ch === "\x0b" || ch === "\t" && row.length ? " " : ch;
      afterCell = false;
    }
  }
  if (row.length) out.push(...rowLines(row));
  if (cell) out.push(cell);
  return out;
}

// ---------- .xls (BIFF8) ----------
class Cursor {
  constructor(chunks) { this.c = chunks; this.i = 0; this.p = 0; }
  fix() { while (this.i < this.c.length && this.p >= this.c[this.i].length) { this.i++; this.p = 0; } }
  u8() { this.fix(); return this.i < this.c.length ? this.c[this.i][this.p++] : 0; }
  u16() { return this.u8() | (this.u8() << 8); }
  u32() { return (this.u16() | (this.u16() << 16)) >>> 0; }
  skip(n) { while (n-- > 0) this.u8(); }
  chars(cch, high) {
    let s = "";
    while (cch > 0) {
      if (this.i < this.c.length && this.p >= this.c[this.i].length) {
        this.i++; this.p = 0;
        if (this.i >= this.c.length) break;
        high = this.c[this.i][this.p++] & 1; // CONTINUE boshida yangi bayroq
      }
      if (this.i >= this.c.length) break;
      if (high) s += String.fromCharCode(this.u16());
      else s += cp(this.u8());
      cch--;
    }
    return s;
  }
}

function xlString(cur) {
  const cch = cur.u16();
  const fl = cur.u8();
  const rich = fl & 8 ? cur.u16() : 0;
  const ext = fl & 4 ? cur.u32() : 0;
  const s = cur.chars(cch, fl & 1);
  cur.skip(rich * 4 + ext);
  return s;
}

export function xlsLines(buf) {
  const get = openCfb(buf);
  const wb = get("Workbook") || get("Book");
  if (!wb) throw new Error("Workbook yo'q");
  const dv = new DataView(wb.buffer, wb.byteOffset, wb.byteLength);
  const recs = [];
  for (let p = 0; p + 4 <= wb.length; ) {
    const type = dv.getUint16(p, true), len = dv.getUint16(p + 2, true);
    recs.push({ type, data: wb.subarray(p + 4, p + 4 + len) });
    p += 4 + len;
  }
  let sst = [];
  const sheets = [];
  let cur = null;
  for (let i = 0; i < recs.length; i++) {
    const { type, data } = recs[i];
    const d = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (type === 0x0809) { cur = new Map(); sheets.push(cur); continue; }
    if (type === 0x00fc) {
      const chunks = [data];
      while (recs[i + 1]?.type === 0x003c) chunks.push(recs[++i].data);
      const c = new Cursor(chunks);
      c.u32();
      const n = c.u32();
      sst = [];
      for (let k = 0; k < n; k++) sst.push(xlString(c));
      continue;
    }
    if (!cur || data.length < 6) continue;
    const r = d.getUint16(0, true), col = d.getUint16(2, true);
    const set = (v) => { if (!cur.has(r)) cur.set(r, []); cur.get(r)[col] = v; };
    if (type === 0x00fd) set(sst[d.getUint32(6, true)] ?? "");
    else if (type === 0x0204 || type === 0x00d6) set(xlString(new Cursor([data.subarray(6)])));
    else if (type === 0x0203) set(String(d.getFloat64(6, true)));
  }
  const lines = [];
  for (const sh of sheets) {
    for (const r of [...sh.keys()].sort((a, b) => a - b)) {
      lines.push(...rowLines(sh.get(r)).filter(Boolean));
    }
  }
  return lines;
}
