// LingoUP — 🧰 Fayl vositalari: iLovePDF'ga o'xshash bepul PDF vositalari (tashqi xizmatlarsiz, faqat pdf-lib)
import { PDFDocument, StandardFonts, rgb, degrees, PDFName, PDFRawStream, PDFNumber, decodePDFRawStream } from "./pdf-lib.js";
import { fonts, pdfStr } from "./omr.js";
import { decodeJpeg, encodeJpeg } from "./jpeg.js";

const MM = 72 / 25.4;
const A4 = [595.28, 841.89];

// PDF'ni ochish (parolli yoki biroz buzilgan fayllarga ham urinib ko'radi)
export async function loadPdf(bytes) {
  try {
    return await PDFDocument.load(bytes, { ignoreEncryption: false, throwOnInvalidObject: false, updateMetadata: false });
  } catch (e) {
    if (/encrypt/i.test(String(e?.message))) throw new Error("PDF parol bilan himoyalangan. Avval parolni olib tashlang.");
    throw new Error("PDF faylni ochib bo'lmadi (buzilgan yoki PDF emas).");
  }
}
const save = (doc) => doc.save({ useObjectStreams: true });

// «1-3, 5, 8-10» → [0,1,2,4,7,8,9] (0 dan); «oxirgi» yoki «-» bilan ochiq oraliq: «5-» = 5 dan oxirigacha
export function parseRanges(text, total) {
  const groups = [];
  const t = String(text || "").toLowerCase().replace(/oxirgi|last|son/g, String(total)).replace(/[–—]/g, "-").replace(/\s+/g, "");
  if (!t) throw new Error("Sahifalarni yozing, masalan: 1-3, 5, 8-10");
  for (const part of t.split(/[,;]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)?(?:-(\d+)?)?$/);
    if (!m || (!m[1] && !m[2])) throw new Error(`Noto'g'ri yozuv: «${part}». Masalan: 1-3, 5, 8-10`);
    const a = m[1] ? +m[1] : 1;
    const b = part.includes("-") ? (m[2] ? +m[2] : total) : a;
    if (a < 1 || b < 1 || a > total || b > total) throw new Error(`${part}: faylda ${total} ta sahifa bor`);
    const g = [];
    if (a <= b) for (let i = a; i <= b; i++) g.push(i - 1); else for (let i = a; i >= b; i--) g.push(i - 1);
    groups.push(g);
  }
  return groups;
}

async function pick(src, indices) {
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, indices);
  pages.forEach((p) => out.addPage(p));
  return save(out);
}

// ---------- Tartibga solish ----------
export async function mergePdfs(list) {
  const out = await PDFDocument.create();
  let pages = 0, skipped = 0;
  for (const bytes of list) {
    let src;
    try { src = await loadPdf(bytes); } catch { skipped++; continue; }
    const copied = await out.copyPages(src, src.getPageIndices());
    copied.forEach((p) => out.addPage(p));
    pages += copied.length;
  }
  if (!pages) throw new Error("PDF fayllarni o'qib bo'lmadi");
  return { bytes: await save(out), pages, skipped };
}
// mode: "ranges" (har oraliq alohida fayl) | "each" (har sahifa alohida) | "every:N" (har N sahifa)
export async function splitPdf(bytes, mode, ranges) {
  const src = await loadPdf(bytes);
  const n = src.getPageCount();
  let groups;
  if (mode === "each") groups = src.getPageIndices().map((i) => [i]);
  else if (String(mode).startsWith("every:")) {
    const k = Math.max(1, +mode.split(":")[1] || 1);
    groups = [];
    for (let i = 0; i < n; i += k) groups.push(src.getPageIndices().slice(i, i + k));
  } else groups = parseRanges(ranges, n);
  if (groups.length > 100) throw new Error("Ko'pi bilan 100 ta faylga bo'lish mumkin");
  const files = [];
  for (const g of groups) files.push({ bytes: await pick(src, g), label: g.length === 1 ? `${g[0] + 1}` : `${g[0] + 1}-${g.at(-1) + 1}` });
  return { files, total: n };
}
export async function extractPages(bytes, ranges) {
  const src = await loadPdf(bytes);
  const idx = parseRanges(ranges, src.getPageCount()).flat();
  return { bytes: await pick(src, idx), pages: idx.length };
}
export async function removePages(bytes, ranges) {
  const src = await loadPdf(bytes);
  const n = src.getPageCount();
  const del = new Set(parseRanges(ranges, n).flat());
  const keep = src.getPageIndices().filter((i) => !del.has(i));
  if (!keep.length) throw new Error("Hamma sahifani o'chirib bo'lmaydi");
  return { bytes: await pick(src, keep), pages: keep.length, removed: n - keep.length };
}
// Yangi tartib: «3,1,2,4-10»; yozilmagan sahifalar oxiriga o'z tartibida qo'shiladi
export async function organizePdf(bytes, order) {
  const src = await loadPdf(bytes);
  const n = src.getPageCount();
  const seq = parseRanges(order, n).flat();
  const seen = new Set(seq);
  const rest = src.getPageIndices().filter((i) => !seen.has(i));
  return { bytes: await pick(src, [...seq, ...rest]), pages: seq.length + rest.length };
}
export async function reversePdf(bytes) {
  const src = await loadPdf(bytes);
  return { bytes: await pick(src, src.getPageIndices().reverse()), pages: src.getPageCount() };
}

// ---------- Tahrirlash ----------
export async function rotatePdf(bytes, angle, ranges) {
  const doc = await loadPdf(bytes);
  const pages = doc.getPages();
  const idx = ranges ? parseRanges(ranges, pages.length).flat() : pages.map((_, i) => i);
  for (const i of new Set(idx)) {
    const p = pages[i];
    p.setRotation(degrees((((p.getRotation().angle + angle) % 360) + 360) % 360));
  }
  return { bytes: await save(doc), pages: new Set(idx).size };
}
// pos: "bc" pastki markaz, "br" pastki o'ng, "bl" pastki chap, "tc", "tr", "tl"; fmt: "n" | "n/N" | "page"
export async function addPageNumbers(bytes, { pos = "bc", fmt = "n", start = 1, skipFirst = false, size = 11 } = {}) {
  const doc = await loadPdf(bytes);
  const { font, fix } = await fonts(doc, StandardFonts, PDFName);
  const pages = doc.getPages(), total = pages.length;
  pages.forEach((p, i) => {
    if (skipFirst && i === 0) return;
    const num = start + i - (skipFirst ? 1 : 0);
    const last = start + total - 1 - (skipFirst ? 1 : 0);
    const label = fmt === "n/N" ? `${num} / ${last}` : fmt === "page" ? `${num}-sahifa` : String(num);
    const { x: bx, y: by, width: W, height: H } = p.getCropBox();
    const w = font.widthOfTextAtSize(label, size), m = 28;
    const x = pos.endsWith("l") ? bx + m : pos.endsWith("r") ? bx + W - m - w : bx + (W - w) / 2;
    const y = pos.startsWith("t") ? by + H - m : by + m - size / 2;
    const rot = p.getRotation().angle;
    if (rot) { // aylantirilgan sahifada ham to'g'ri o'qilishi uchun
      const c = [bx + W / 2, by + H / 2];
      const r = (rot * Math.PI) / 180, dx = x - c[0], dy = y - c[1];
      const [rx, ry] = [c[0] + dx * Math.cos(r) - dy * Math.sin(r), c[1] + dx * Math.sin(r) + dy * Math.cos(r)];
      p.drawText(label, { x: rx, y: ry, size, font, color: rgb(0.2, 0.2, 0.2), rotate: degrees(rot) });
    } else p.drawText(label, { x, y, size, font, color: rgb(0.2, 0.2, 0.2) });
  });
  await fix();
  return { bytes: await save(doc), pages: total };
}
// Matnli suv belgisi: sahifa markazida, qiyalatib, yarim shaffof
export async function addWatermark(bytes, text, { opacity = 0.18, diagonal = true, color = "grey" } = {}) {
  const doc = await loadPdf(bytes);
  const { bold, fix } = await fonts(doc, StandardFonts, PDFName);
  const t = pdfStr(text).slice(0, 80);
  if (!t.trim()) throw new Error("Suv belgisi matni bo'sh");
  const col = { grey: rgb(0.4, 0.4, 0.4), red: rgb(0.85, 0.1, 0.1), blue: rgb(0.1, 0.3, 0.8) }[color] || rgb(0.4, 0.4, 0.4);
  for (const p of doc.getPages()) {
    const { x: bx, y: by, width: W, height: H } = p.getCropBox();
    const ang = diagonal ? Math.atan2(H, W) : 0;
    let size = 60;
    const diag = diagonal ? Math.hypot(W, H) * 0.75 : W * 0.8;
    size = Math.max(14, Math.min(110, size * (diag / Math.max(1, bold.widthOfTextAtSize(t, size)))));
    const w = bold.widthOfTextAtSize(t, size);
    const cx = bx + W / 2, cy = by + H / 2;
    const x = cx - (Math.cos(ang) * w) / 2 + (Math.sin(ang) * size * 0.35);
    const y = cy - (Math.sin(ang) * w) / 2 - (Math.cos(ang) * size * 0.35);
    p.drawText(t, { x, y, size, font: bold, color: col, opacity, rotate: degrees((ang * 180) / Math.PI) });
  }
  await fix();
  return { bytes: await save(doc), pages: doc.getPageCount() };
}
// Chetlarni kesish (mm): hamma tomondan bir xil
export async function cropPdf(bytes, mm) {
  const doc = await loadPdf(bytes);
  const d = Math.max(0, +mm || 0) * MM;
  for (const p of doc.getPages()) {
    const { x, y, width: W, height: H } = p.getCropBox();
    if (W - 2 * d < 72 || H - 2 * d < 72) throw new Error("Kesish juda katta — sahifa juda kichrayib qoladi");
    p.setCropBox(x + d, y + d, W - 2 * d, H - 2 * d);
    p.setMediaBox(x + d, y + d, W - 2 * d, H - 2 * d);
  }
  return { bytes: await save(doc), pages: doc.getPageCount() };
}

// ---------- Rasm ↔ PDF ----------
// opts: { orient: "auto"|"portrait"|"landscape", margin: 0|20|40 (pt), size: "a4"|"fit" }
export async function imagesToPdf(list, { orient = "auto", margin = 20, size = "a4" } = {}) {
  const out = await PDFDocument.create();
  let pages = 0, skipped = 0;
  for (const bytes of list) {
    const isPng = bytes[0] === 0x89 && bytes[1] === 0x50, isJpg = bytes[0] === 0xff && bytes[1] === 0xd8;
    if (!isPng && !isJpg) { skipped++; continue; }
    let img;
    try { img = isPng ? await out.embedPng(bytes) : await out.embedJpg(bytes); } catch { skipped++; continue; }
    if (size === "fit") {
      const k = Math.min(1, 1600 / Math.max(img.width, img.height)) * 0.75;
      const w = img.width * k, h = img.height * k;
      out.addPage([w + 2 * margin, h + 2 * margin]).drawImage(img, { x: margin, y: margin, width: w, height: h });
    } else {
      const land = orient === "landscape" || (orient === "auto" && img.width > img.height);
      const [W, H] = land ? [A4[1], A4[0]] : A4;
      const k = Math.min((W - 2 * margin) / img.width, (H - 2 * margin) / img.height);
      const w = img.width * k, h = img.height * k;
      out.addPage([W, H]).drawImage(img, { x: (W - w) / 2, y: (H - h) / 2, width: w, height: h });
    }
    pages++;
  }
  if (!pages) throw new Error("Rasmlarni o'qib bo'lmadi (faqat JPG yoki PNG)");
  return { bytes: await save(out), pages, skipped };
}
// PDF ichidagi JPG rasmlarni chiqarib olish
export async function extractImages(bytes, max = 60) {
  const doc = await loadPdf(bytes);
  const out = [];
  const seen = new Set();
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const d = obj.dict;
    if (d.get(PDFName.of("Subtype")) !== PDFName.of("Image")) continue;
    const f = d.get(PDFName.of("Filter"));
    const isDct = f === PDFName.of("DCTDecode") || (f?.asArray && f.asArray().length === 1 && f.asArray()[0] === PDFName.of("DCTDecode"));
    if (!isDct) continue;
    const w = d.get(PDFName.of("Width"))?.asNumber?.() || 0, h = d.get(PDFName.of("Height"))?.asNumber?.() || 0;
    if (w < 40 || h < 40) continue;
    const c = obj.contents;
    const key = c.length + ":" + c[100] + c[c.length - 3];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ bytes: c, w, h, ref: ref.objectNumber });
    if (out.length >= max) break;
  }
  return out;
}

// ---------- Optimallashtirish ----------
// Siqish: ichidagi JPG rasmlarni kichraytirib, sifatini pasaytirib qayta kodlaydi; level: "low" | "mid" | "high"
export async function compressPdf(bytes, level = "mid", budgetMs = 20000) {
  const cfg = { low: { px: 2000, q: 75 }, mid: { px: 1400, q: 55 }, high: { px: 1000, q: 38 } }[level] || { px: 1400, q: 55 };
  const t0 = Date.now();
  const doc = await loadPdf(bytes);
  let done = 0, skipped = 0, before = 0, after = 0;
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const d = obj.dict;
    if (d.get(PDFName.of("Subtype")) !== PDFName.of("Image")) continue;
    if (d.get(PDFName.of("Filter")) !== PDFName.of("DCTDecode")) continue;
    if (d.get(PDFName.of("SMask")) || d.get(PDFName.of("Mask")) || d.get(PDFName.of("Decode"))) { skipped++; continue; }
    const cs = d.get(PDFName.of("ColorSpace"));
    if (cs !== PDFName.of("DeviceRGB") && cs !== PDFName.of("DeviceGray")) { skipped++; continue; }
    if (obj.contents.length < 30000) continue;
    if (Date.now() - t0 > budgetMs) { skipped++; continue; }
    let img;
    try { img = decodeJpeg(obj.contents); } catch { skipped++; continue; }
    // Kichraytirish
    const k = Math.min(1, cfg.px / Math.max(img.width, img.height));
    const W = Math.max(1, Math.round(img.width * k)), H = Math.max(1, Math.round(img.height * k));
    let data = img.data;
    if (k < 1) {
      data = new Uint8Array(W * H * 4);
      for (let y = 0; y < H; y++) {
        const sy = Math.min(img.height - 1, Math.floor(y / k));
        for (let x = 0; x < W; x++) {
          const si = (sy * img.width + Math.min(img.width - 1, Math.floor(x / k))) * 4, di = (y * W + x) * 4;
          data[di] = img.data[si]; data[di + 1] = img.data[si + 1]; data[di + 2] = img.data[si + 2]; data[di + 3] = 255;
        }
      }
    }
    const jpg = encodeJpeg(data, W, H, cfg.q);
    if (jpg.length >= obj.contents.length * 0.92) continue;
    before += obj.contents.length; after += jpg.length;
    const nd = doc.context.obj({ Type: "XObject", Subtype: "Image", Width: W, Height: H, ColorSpace: "DeviceRGB", BitsPerComponent: 8, Filter: "DCTDecode", Length: jpg.length });
    doc.context.assign(ref, PDFRawStream.of(nd, jpg));
    done++;
  }
  const out = await save(doc);
  return { bytes: out, images: done, skipped, saved: before - after };
}
// Tiklash: buzilgan joylarini tashlab, faylni qayta yozib chiqadi
export async function repairPdf(bytes) {
  let doc;
  try { doc = await PDFDocument.load(bytes, { ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false }); }
  catch { throw new Error("Faylni tiklab bo'lmadi — u juda shikastlangan yoki PDF emas"); }
  const out = await PDFDocument.create();
  let ok = 0, bad = 0;
  for (const i of doc.getPageIndices()) {
    try { const [p] = await out.copyPages(doc, [i]); out.addPage(p); ok++; } catch { bad++; }
  }
  if (!ok) throw new Error("Birorta ham sahifani tiklab bo'lmadi");
  return { bytes: await save(out), pages: ok, lost: bad };
}

// ---------- ZIP (ko'p faylni bitta qilib yuborish uchun, siqmasdan) ----------
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
export function makeZip(files) {
  const enc = new TextEncoder(), parts = [], central = [];
  let off = 0;
  for (const f of files) {
    const name = enc.encode(f.name), data = f.bytes, crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true);
    parts.push(new Uint8Array(h.buffer), name, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true); c.setUint32(42, off, true);
    central.push(new Uint8Array(c.buffer), name);
    off += 30 + name.length + data.length;
  }
  const csize = central.reduce((a, b) => a + b.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, csize, true); e.setUint32(16, off, true);
  const all = [...parts, ...central, new Uint8Array(e.buffer)];
  const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
  let p = 0; for (const a of all) { out.set(a, p); p += a.length; }
  return out;
}
export const pageCount = async (bytes) => (await loadPdf(bytes)).getPageCount();
