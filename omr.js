// LingoUP — javob varaqasi (OMR, EvalBee uslubida)
// Varaq tuzilishi millimetrlarda (A4: 210×297). Shu funksiya ilovadagi skanerga ham aynan yuboriladi.
export function omrLayout(n, k) {
  const L = {
    w: 210, h: 297, marker: 8, r: 2.6,
    markers: [[14, 14], [196, 14], [14, 283], [196, 283]],
    rows: 25, n: Math.min(n, 100), k: Math.min(Math.max(k, 2), 5), id: [], q: [],
  };
  // O'quvchi raqami: 3 qator (yuzlik, o'nlik, birlik) × 0–9
  for (let d = 0; d < 3; d++) {
    const row = [];
    for (let v = 0; v < 10; v++) row.push([104 + v * 8.5, 44 + d * 7]);
    L.id.push(row);
  }
  // Savollar: 4 ustun × 25 qator
  for (let i = 0; i < L.n; i++) {
    const c = Math.floor(i / L.rows), r = i % L.rows;
    const x0 = 20 + c * 45, y = 78 + r * 7.8;
    const opts = [];
    for (let j = 0; j < L.k; j++) opts.push([x0 + 10 + j * 7, y]);
    L.q.push(opts);
  }
  return L;
}

export const LETTERS = ["A", "B", "C", "D", "E"];

// Standart PDF shriftida yo'q harflarni yaqiniga almashtiramiz (faqat varaq sarlavhasi uchun)
const plain = (s) => String(s || "")
  .replace(/[şŞ]/g, (c) => (c === "ş" ? "s" : "S")).replace(/[ğĞ]/g, (c) => (c === "ğ" ? "g" : "G"))
  .replace(/ı/g, "i").replace(/İ/g, "I").replace(/[ʻʼ‘’`´]/g, "'").replace(/[“”«»]/g, '"').replace(/[—–]/g, "-")
  .replace(/[^\x20-\x7E -ÿ]/g, "");

export async function answerSheetPdf({ title, n, k, author }) {
  const { PDFDocument, StandardFonts, rgb } = await import("./pdf-lib.js");
  const L = omrLayout(n, k);
  const MM = 72 / 25.4;
  const doc = await PDFDocument.create();
  const page = doc.addPage([L.w * MM, L.h * MM]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const X = (x) => x * MM, Y = (y) => (L.h - y) * MM;
  const black = rgb(0, 0, 0), grey = rgb(0.45, 0.45, 0.45), light = rgb(0.6, 0.6, 0.6);
  const text = (s, x, y, size, f = font, color = black) => page.drawText(plain(s), { x: X(x), y: Y(y), size, font: f, color });
  const center = (s, x, y, size, f = font, color = black) => {
    const t = plain(s);
    page.drawText(t, { x: X(x) - f.widthOfTextAtSize(t, size) / 2, y: Y(y) - size * 0.35, size, font: f, color });
  };
  // Burchak belgilari
  for (const [x, y] of L.markers)
    page.drawRectangle({ x: X(x - L.marker / 2), y: Y(y + L.marker / 2), width: L.marker * MM, height: L.marker * MM, color: black });
  // Sarlavha
  let t = plain(title);
  while (bold.widthOfTextAtSize(t, 14) > 150 * MM && t.length > 3) t = t.slice(0, -2);
  text(t === plain(title) ? t : t + "...", 24, 26, 14, bold);
  text("JAVOB VARAQASI", 24, 32.5, 8, font, grey);
  text("Ism-familiya:", 24, 42, 10);
  page.drawLine({ start: { x: X(24), y: Y(52) }, end: { x: X(92), y: Y(52) }, thickness: 0.6, color: grey });
  text("Guruh / sana:", 24, 60, 10);
  page.drawLine({ start: { x: X(24), y: Y(66) }, end: { x: X(92), y: Y(66) }, thickness: 0.6, color: grey });
  // O'quvchi raqami bloki
  text("O'quvchi raqami", 104 - L.r, 37.5, 8, bold);
  ["100", "10", "1"].forEach((lbl, d) => text(lbl, 96, L.id[d][0][1] + 1.1, 6.5, font, grey));
  for (const row of L.id) row.forEach(([x, y], v) => {
    page.drawCircle({ x: X(x), y: Y(y), size: L.r * MM, borderColor: black, borderWidth: 0.7 });
    center(String(v), x, y, 6.5, font, light);
  });
  // Ko'rsatma
  text("Doirachani to'liq bo'yang:", 24, 71, 7, font, grey);
  page.drawCircle({ x: X(60), y: Y(70.3), size: 1.6 * MM, color: black });
  text("To'g'ri", 62.5, 71, 7, font, grey);
  text("Belgi qo'ymang, chizmang. Varaqni bukmang.", 80, 71, 7, font, grey);
  // Savollar
  L.q.forEach((opts, i) => {
    const [x0, y] = opts[0];
    const num = String(i + 1);
    page.drawText(num, { x: X(x0 - 4.5) - bold.widthOfTextAtSize(num, 8), y: Y(y) - 2.8, size: 8, font: bold });
    opts.forEach(([x, yy], j) => {
      page.drawCircle({ x: X(x), y: Y(yy), size: L.r * MM, borderColor: black, borderWidth: 0.7 });
      center(LETTERS[j], x, yy, 6.5, font, light);
    });
  });
  text(`LingoUP bot${author ? "  ·  " + author : ""}  ·  ${L.n} ta savol`, 24, 290, 7, font, grey);
  return doc.save();
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// Savollar varag'i — Word ochadigan .doc (HTML) fayl: barcha harflar (ş, ğ, ı, oʻ) to'g'ri chiqadi
export function questionsDoc({ title, description, questions, k, author }) {
  const qs = questions.slice(0, 100).map((q, i) =>
    `<p class=q><b>${i + 1}.</b> ${esc(q.q)}</p><p class=o>` +
    q.opts.slice(0, k).map((o, j) => `<span>${LETTERS[j]}) ${esc(o)}</span>`).join("&nbsp;&nbsp;&nbsp;&nbsp; ") + "</p>").join("");
  const key = questions.slice(0, 100).map((q, i) => `${i + 1}-${LETTERS[q.correct] || "?"}`).join(", ");
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8">
<title>${esc(title)}</title><style>body{font-family:Calibri,Arial,sans-serif;font-size:12pt}h1{font-size:16pt;margin:0}
.q{margin:10pt 0 2pt}.o{margin:0 0 0 14pt}.key{page-break-before:always}.muted{color:#666;font-size:10pt}</style></head><body>
<h1>${esc(title)}</h1>${description ? `<p class=muted>${esc(description)}</p>` : ""}
<p class=muted>Ism-familiya: ______________________ &nbsp;&nbsp; Javoblarni javob varaqasidagi doirachalarni bo'yab belgilang.</p>
${qs}
<div class=key><h1>Javoblar kaliti (o'qituvchi uchun)</h1><p>${key}</p><p class=muted>${esc(author || "")} · LingoUP bot</p></div>
</body></html>`;
}

// ---------- Skaner (brauzerda ishlaydi; funksiyalar o'zi yetarli — tashqi o'zgaruvchisiz) ----------
// 4 nuqtadan 4 nuqtaga perspektiv o'tkazish matritsasi
export function omrHomography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    if (Math.abs(A[c][c]) < 1e-12) return null;
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const h = b.map((v, i) => v / A[i][i]);
  return (x, y) => {
    const d = h[6] * x + h[7] * y + 1;
    return [(h[0] * x + h[1] * y + h[2]) / d, (h[3] * x + h[4] * y + h[5]) / d];
  };
}

// px — kulrang piksellar (0–255), w×h; L — omrLayout natijasi; H — omrHomography
export function omrScan(px, w, h, L, H) {
  // Otsu bo'yicha qora/oq chegarasi
  const hist = new Array(256).fill(0);
  for (let i = 0; i < px.length; i += 3) hist[px[i]]++;
  let total = 0, sum = 0;
  for (let i = 0; i < 256; i++) { total += hist[i]; sum += i * hist[i]; }
  let sB = 0, wB = 0, best = 0, thr = 110;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sB += i * hist[i];
    const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) { best = v; thr = i; }
  }
  thr = Math.min(thr, 140);
  // Qora dog'lar (bog'langan sohalar)
  const lab = new Int32Array(w * h), stack = new Int32Array(w * h);
  const comps = [];
  for (let s = 0; s < w * h; s++) {
    if (lab[s] || px[s] >= thr) continue;
    const id = comps.length + 1;
    let sp = 0, area = 0, sx = 0, sy = 0, x0 = w, x1 = 0, y0 = h, y1 = 0;
    stack[sp++] = s; lab[s] = id;
    while (sp) {
      const p = stack[--sp], x = p % w, y = (p - x) / w;
      area++; sx += x; sy += y;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && !lab[p - 1] && px[p - 1] < thr) { lab[p - 1] = id; stack[sp++] = p - 1; }
      if (x < w - 1 && !lab[p + 1] && px[p + 1] < thr) { lab[p + 1] = id; stack[sp++] = p + 1; }
      if (y > 0 && !lab[p - w] && px[p - w] < thr) { lab[p - w] = id; stack[sp++] = p - w; }
      if (y < h - 1 && !lab[p + w] && px[p + w] < thr) { lab[p + w] = id; stack[sp++] = p + w; }
    }
    comps.push({ area, cx: sx / area, cy: sy / area, bw: x1 - x0 + 1, bh: y1 - y0 + 1 });
  }
  const S = Math.max(w, h);
  const cand = comps.filter((c) => c.bw > S * 0.012 && c.bh > S * 0.012 && c.bw < S * 0.09 && c.bh < S * 0.09 &&
    c.bw / c.bh > 0.6 && c.bw / c.bh < 1.6 && c.area / (c.bw * c.bh) > 0.82);
  const corners = [[0, 0], [w, 0], [0, h], [w, h]];
  const pick = [];
  for (const [qx, qy] of corners) {
    let bestC = null, bd = Infinity;
    for (const c of cand) {
      if ((qx ? c.cx < w / 2 : c.cx > w / 2) || (qy ? c.cy < h / 2 : c.cy > h / 2)) continue;
      const d = Math.hypot(c.cx - qx, c.cy - qy);
      if (d < bd) { bd = d; bestC = c; }
    }
    if (!bestC) return { error: "markers", found: pick.length };
    pick.push(bestC);
  }
  const sizes = pick.map((c) => Math.sqrt(c.area));
  if (Math.max(...sizes) > 2.2 * Math.min(...sizes)) return { error: "markers", found: 3 };
  const map = H(L.markers, pick.map((c) => [c.cx, c.cy]));
  if (!map) return { error: "markers", found: 4 };
  const at = (x, y) => {
    const [u, v] = map(x, y), ix = Math.round(u), iy = Math.round(v);
    return ix < 0 || iy < 0 || ix >= w || iy >= h ? 255 : px[iy * w + ix];
  };
  // Qog'oz va bo'yoq darajasi
  const black = pick.reduce((a, c) => a + at(...L.markers[pick.indexOf(c)]), 0) / 4;
  const paper = [];
  for (let x = 30; x < 190; x += 8) for (let y = 74; y < 275; y += 15.6) paper.push(at(x + 3.5, y + 3.9));
  paper.sort((a, b) => a - b);
  const white = paper[Math.floor(paper.length * 0.7)] || 230;
  const ring = [];
  for (let a = 0; a < 6.28; a += 0.5) for (const rr of [0.3, 0.75, 1.25]) ring.push([Math.cos(a) * rr * L.r * 0.5, Math.sin(a) * rr * L.r * 0.5]);
  const dark = ([x, y]) => {
    let s = 0;
    for (const [dx, dy] of ring) s += at(x + dx, y + dy);
    const g = s / ring.length;
    return Math.max(0, Math.min(1, (white - g) / Math.max(30, white - black)));
  };
  const choose = (ds) => {
    const order = ds.map((d, i) => [d, i]).sort((a, b) => b[0] - a[0]);
    const [top, i] = order[0], second = order[1][0];
    const med = order[Math.floor(order.length / 2)][0];
    if (top < 0.35 || top - med < 0.22) return -1; // bo'sh
    if (second > 0.35 && top - second < 0.18) return -2; // bir nechta belgilangan
    return i;
  };
  const scores = L.q.map((opts) => opts.map(dark));
  const answers = scores.map(choose);
  const digits = L.id.map((row) => choose(row.map(dark)));
  const id = digits.every((d) => d >= 0) ? String(digits[0] * 100 + digits[1] * 10 + digits[2]).padStart(3, "0") : "";
  return { answers, id, map, markers: pick.map((c) => [c.cx, c.cy]), scores };
}
