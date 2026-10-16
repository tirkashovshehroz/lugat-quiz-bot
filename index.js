// LingoUP bot — Cloudflare Workers versiyasi (bepul tarifda ishlaydi)
// QuizBot kabi ishlaydi, lekin savollar fayldan avtomatik tuziladi.
import { DurableObject } from "cloudflare:workers";
import { parseFile, parseText, xlsxSheets } from "./parse.js";
import { pdfToLines } from "./pdf.js";
import { tr, trMarkup, fromButton, LANGS, detectLang, trCommands } from "./i18n.js";

const MAX_FILE = 20 * 1024 * 1024;
const MAX_QUESTIONS = 5000;
const MIN_READY = 2; // guruhda test boshlanishi uchun kerakli "Tayyorman" soni
const DIRS = { fwd: "So'z → tarjima", rev: "Tarjima → so'z", mix: "Aralash" };
const TIMERS = [10, 15, 30, 45, 60, 120, 180, 240, 300, 600];
const SHUFFLE = { all: "Hammasi aralashtiriladi", none: "Aralashtirilmaydi", q: "Faqat savollar", a: "Faqat javoblar" };

// Pastda doim ko'rinib turadigan tugmalar (shaxsiy chatda)
const BTN_NEW = "➕ Yangi test";
const BTN_MY = "📚 Testlarim";
const BTN_AUTHOR = "👨‍🏫 Muallif";
const BTN_GUIDE = "📖 Yo'riqnoma";
const BTN_AD = "📣 Reklama berish";
const BTN_CAT = "🗂 Muallif testlari";
const BTN_SET = "⚙️ Sozlamalar";
const BTN_REVIEW = "🧠 Takrorlash";
const BTN_DONATE = "💝 Qo'llab-quvvatlash";
const BTN_TOOLS = "🧰 Fayl vositalari";
const TOOL_MAX_FILES = 30, TOOL_MAX_BYTES = 45 * 1024 * 1024;
const DAY = 86400e3;
const REVIEW_STEPS = [1, 3, 7]; // xatodan keyin 1 kun, so'ng 3 va 7 kun; 3 marta to'g'ri — o'zlashtirildi
const REVIEW_MAX = 50;
const SRC_TTL = 3600e3; // yuborilgan faylning so'zlari 1 soat saqlanadi // bitta takrorlash testida eng ko'pi
const NEWQUIZ_TEXT = "📄 <b>1-usul — fayldan (tez):</b> PDF, Word, Excel yoki .txt faylni yuboring yoki matnni xabar qilib yozing.\n" +
  "Savol ostiga <code>Izoh: ...</code> yozsangiz — javobdan keyin tushuntirish chiqadi. Word ichidagi rasmlar savolga o'zi biriktiriladi.\n\n" +
  "✍️ <b>2-usul — QuizBot kabi, bittalab:</b> 📎 → <b>So'rovnoma</b> → <b>Viktorina</b> rejimini yoqing, to'g'ri javobni belgilang (izoh ham yozish mumkin) va shu yerga yuboring.\n" +
  "🖼 Rasmli savol uchun avval rasmni yuboring, keyin viktorinani.\n\n" +
  "🗂 Fayl qanday bo'lishi kerakligini ko'rish uchun: /namuna";
const TG_DELETE_URL = "https://my.telegram.org/auth?to=delete";
const MAIN_KB = { keyboard: [[{ text: BTN_NEW }, { text: BTN_MY }], [{ text: BTN_CAT }, { text: BTN_REVIEW }], [{ text: BTN_GUIDE }, { text: BTN_AUTHOR }],
  [{ text: BTN_AD }, { text: BTN_SET }], [{ text: BTN_TOOLS }, { text: BTN_DONATE }]], resize_keyboard: true, is_persistent: false, one_time_keyboard: true };
const authorOf = (env) => env.AUTHOR || "@Shehroz_hoca";

// Buyruqlar menyusi: hamma uchun va faqat muallif uchun
const USER_COMMANDS = [
  { command: "start", description: "🏠 Bosh menyu — botni ishga tushirish" },
  { command: "newquiz", description: "➕ Yangi test — fayldan yoki bittalab" },
  { command: "mytests", description: "📚 Testlarim — ochish, tahrirlash, o'chirish" },
  { command: "tests", description: "🗂 Muallif testlari — tayyor testlar" },
  { command: "takrorlash", description: "🧠 Takrorlash — xato so'zlaringizdan test" },
  { command: "hisobot", description: "📈 Hisobot — guruh testlari va o'quvchilar" },
  { command: "guide", description: "📖 Yo'riqnoma — botdan foydalanish" },
  { command: "namuna", description: "📄 Namunalar — test fayli qanday bo'ladi" },
  { command: "vositalar", description: "🧰 Fayl vositalari — PDF, CSV, TXT" },
  { command: "yozish", description: "💬 Muallifga yozish — bot orqali xabar" },
  { command: "author", description: "👨‍🏫 Muallif — savol va takliflar" },
  { command: "donat", description: "💝 Qo'llab-quvvatlash — bot rivojiga hissa" },
  { command: "reklama", description: "📣 Reklama — botga reklama berish" },
  { command: "settings", description: "⚙️ Sozlamalar — til, ma'lumotlarni o'chirish" },
  { command: "lang", description: "🌐 Til — interfeys tilini tanlash" },
  { command: "stop", description: "⏹ To'xtatish — davom etayotgan testni" },
  { command: "cancel", description: "❌ Bekor qilish — joriy amalni" },
];
const ADMIN_COMMANDS = [
  { command: "start", description: "🏠 Bosh menyu — botni ishga tushirish" },
  { command: "newquiz", description: "➕ Yangi test — fayldan yoki bittalab" },
  { command: "mytests", description: "📚 Testlarim — ochish, tahrirlash, o'chirish" },
  { command: "tests", description: "🗂 Muallif testlari — katalog" },
  { command: "takrorlash", description: "🧠 Takrorlash — xato so'zlaringizdan test" },
  { command: "reklama", description: "📣 Reklama — joylash va boshqarish" },
  { command: "adcheck", description: "🔎 Reklama tekshiruvi — kimga yetgani" },
  { command: "hisobot", description: "📈 Hisobot — guruh testlari va o'quvchilar" },
  { command: "stat", description: "📊 Statistika — foydalanuvchilar va testlar" },
  { command: "materials", description: "📚 Materiallar — yo'riqnoma va namunalar" },
  { command: "donatsozla", description: "💳 Donat sozlash — karta raqamini kiritish" },
  { command: "bans", description: "🚫 Bloklanganlar — ro'yxat va blokdan chiqarish" },
  { command: "guide", description: "📖 Yo'riqnoma — botdan foydalanish" },
  { command: "stop", description: "⏹ To'xtatish — davom etayotgan testni" },
  { command: "cancel", description: "❌ Bekor qilish — joriy amalni" },
];

const HELP =
  "📚 <b>LingoUP bot</b>\n\n" +
  "Fayl yuboring — bot undan tayyor test tuzib beradi.\n\n" +
  "1️⃣ Faylni yuboring (PDF, Word, Excel, .txt)\n" +
  "2️⃣ Bo'lim va savollar sonini tanlang\n" +
  "3️⃣ Test nomi, tavsifi, vaqti va aralashtirishni belgilang\n" +
  "4️⃣ Tayyor! O'zingiz yeching, guruhda o'tkazing yoki ulashing 👥\n\n" +
  "/newquiz — yangi test\n/mytests — mening testlarim\n/tests — muallif testlari\n/guide — yo'riqnoma va namunalar\n/namuna — namuna fayllar\n/lang — til\n/reklama — botga reklama berish\n/stop — testni to'xtatish\n/cancel — bekor qilish";

// ---------------- Yordamchilar ----------------
async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({ ok: false, description: "bad json" }));
  if (!j.ok) console.log("TG xato", method, j.description);
  return j;
}

// Word fayldagi rasmlarni Telegram'ga yuklab, file_id olish (10 tadan albom qilib, so'ng o'chiriladi)
async function uploadImages(env, chatId, images) {
  const ids = [];
  const toDelete = [];
  for (let i = 0; i < images.length; i += 10) {
    const part = images.slice(i, i + 10);
    const fd = new FormData();
    fd.append("chat_id", String(chatId));
    fd.append("disable_notification", "true");
    if (part.length === 1) {
      fd.append("photo", new Blob([part[0].bytes], { type: part[0].type }), part[0].name);
      const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendPhoto`, { method: "POST", body: fd });
      const j = await r.json().catch(() => ({ ok: false }));
      if (j.ok) { toDelete.push(j.result.message_id); ids.push(j.result.photo.at(-1).file_id); } else ids.push(null);
      continue;
    }
    fd.append("media", JSON.stringify(part.map((_, k) => ({ type: "photo", media: `attach://f${k}` }))));
    part.forEach((im, k) => fd.append(`f${k}`, new Blob([im.bytes], { type: im.type }), im.name));
    const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMediaGroup`, { method: "POST", body: fd });
    const j = await r.json().catch(() => ({ ok: false }));
    if (!j.ok) { console.log("Rasm yuklash xatosi", j.description); part.forEach(() => ids.push(null)); continue; }
    for (const m of j.result) { toDelete.push(m.message_id); ids.push(m.photo?.at(-1)?.file_id || null); }
  }
  for (let i = 0; i < toDelete.length; i += 100)
    await tg(env, "deleteMessages", { chat_id: chatId, message_ids: toDelete.slice(i, i + 100) });
  return ids;
}
const photoId = (m) => m.photo?.at(-1)?.file_id || null;
const EXP_MAX = 200; // Telegram viktorina izohi chegarasi

let BOT_USERNAME = null;
async function botName(env) {
  if (!BOT_USERNAME) BOT_USERNAME = (await tg(env, "getMe", {})).result?.username || "bot";
  return BOT_USERNAME;
}

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const btn = (text, data) => ({ text, callback_data: data });
const kb = (rows) => ({ inline_keyboard: rows.filter((r) => r.length) });
const shuffle = (a) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const sample = (a, n) => shuffle([...a]).slice(0, n);
// n tani har biri `size` tadan qismlarga bo'lish; oxirgi qism 5 tadan kam bo'lsa, oldingisiga qo'shiladi
const MAX_PARTS = 100;
function splitSizes(n, size) {
  size = Math.max(1, Math.min(size, n));
  const out = [];
  for (let left = n; left > 0; left -= size) out.push(Math.min(size, left));
  if (out.length > 1 && out[out.length - 1] < 5) out[out.length - 2] += out.pop();
  return out;
}
const timerLabel = (t) => (!t ? "cheklanmagan" : t < 60 ? `${t} soniya` : `${t / 60} daqiqa`);
const timerShort = (t) => (t < 60 ? `${t} son` : `${t / 60} daq`);
function fmtTime(sec) {
  sec = Math.round(sec);
  if (sec < 60) return `${sec} son`;
  return `${Math.floor(sec / 60)} daq ${sec % 60} son`;
}
const channelUrl = (ch) => (ch.startsWith("@") ? `https://t.me/${ch.slice(1)}` : ch);
// Majburiy kanallar: asosiy kanal + testlar kanali
function channelsOf(env) {
  const out = [];
  if (env.CHANNEL) out.push({ id: env.CHANNEL, link: env.CHANNEL_LINK || channelUrl(env.CHANNEL), name: env.CHANNEL_NAME || env.CHANNEL });
  if (env.TESTS_CHANNEL) out.push({ id: env.TESTS_CHANNEL, link: env.TESTS_CHANNEL_LINK || channelUrl(env.TESTS_CHANNEL),
    name: env.TESTS_CHANNEL_NAME || (env.TESTS_CHANNEL.startsWith("@") ? env.TESTS_CHANNEL : "Testlar kanali") });
  return out;
}
const joinRows = (env) => channelsOf(env).map((c, i) => [{ text: `📢 ${i + 1}-kanalga o'tish`, url: c.link }]);

function newId() {
  const abc = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const b = crypto.getRandomValues(new Uint8Array(8));
  return [...b].map((x) => abc[x % abc.length]).join("");
}

async function webhookSecret(env) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("wh:" + env.BOT_TOKEN));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40);
}

// ---------------- Moderatsiya ----------------
// Taqiqlangan mavzular: erotika, giyohvandlik, qurol, terror, qimor va h.k. (o'zbek, rus, ingliz, turk tillarida).
// Topilsa test darhol bloklanmaydi — muallif ko'rib chiqishi uchun ushlab turiladi.
const BAD_WORDS = [
  // Faqat aniq nojo'ya mazmun. "terror", "narkotik" kabi oddiy lug'at so'zlari bu yerda yo'q —
  // ular darsliklarda uchraydi va testni bekorga ushlab qolardi.
  "porno", "porn", "xxx", "erotik", "erotic", "эрот", "порн", "hentai", "nude", "naked", "onlyfans",
  "yalang'och", "yalangoch", "fohisha", "sikish", "jalab", "qanjiq", "сиськ", "трах",
  "zakladka", "закладк", "bomba yasash", "qurol sotish", "оружие купить",
  "1xbet", "stavka qil", "ставки на спорт",
]
// Havolalar va kanal/username reklamasi: https://..., t.me/..., @kanal, sayt.uz va h.k.
const LINK_RE = /(https?:\/\/\S+|www\.\S+|\b(?:t|telegram)\.(?:me|dog)\/\S*|tg:\/\/\S+|(?<![\w.])@[a-z][a-z0-9_]{3,}|\b[a-z0-9-]{2,}\.(?:com|uz|ru|org|net|me|io|info|xyz|site|online|tj|kz|kg|tr)\b)/i;
export function findLink(texts) {
  for (const t of texts) {
    const m = typeof t === "string" && t.match(LINK_RE);
    if (m) return m[0].slice(0, 60);
  }
  return null;
}
const LINK_MSG = "🚫 Testda havola yoki kanal/username topildi: <code>{x}</code>\n" +
  "Testlar orqali kanal, guruh yoki sayt reklama qilish mumkin emas. Havolalarni olib tashlab, qaytadan yuboring.\n" +
  "Botda reklama berish uchun: /reklama";

export function badWord(texts) {
  const t = " " + texts.filter(Boolean).join(" ").toLowerCase().replace(/[‘’`ʻ]/g, "'") + " ";
  return BAD_WORDS.find((w) => t.includes(w)) || null;
}
function quizTexts(q) {
  const out = [q.title, q.description];
  for (const x of q.questions || []) out.push(x.q, x.exp, ...(x.opts || []));
  return out;
}

// Bir xil so'zni bir marta qoldirish (bir nechta darsni birlashtirganda)
function uniqWords(pairs) {
  const seen = new Set();
  return pairs.filter((p) => { const k = p[0].toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
    .map((p) => [p[0], p[1]]);
}

// Lug'atdan savollar tuzish (test yaratilganda bir marta)
export function buildQuestions(pairs, count, direction, allPairs = pairs, keepOrder = false) {
  const chosen = keepOrder ? pairs.slice(0, Math.min(count, MAX_QUESTIONS)) : sample(pairs, Math.min(count, pairs.length, MAX_QUESTIONS));
  const out = [];
  for (const [word, tr] of chosen) {
    const d = direction === "mix" ? (Math.random() < 0.5 ? "fwd" : "rev") : direction;
    const [q, ans, pool] = d === "fwd" ? [word, tr, allPairs.map((p) => p[1])] : [tr, word, allPairs.map((p) => p[0])];
    const a = ans.slice(0, 100);
    const others = [...new Set(pool.map((p) => p.slice(0, 100)))].filter((p) => p.toLowerCase() !== a.toLowerCase());
    if (!others.length) continue;
    const opts = shuffle([...sample(others, 3), a]);
    out.push({ q: q.slice(0, 280), opts, correct: opts.indexOf(a), pair: [word, tr], exp: `${word} — ${tr}`.slice(0, EXP_MAX) });
  }
  return out;
}

// Har bir o'tkazishda aralashtirish sozlamasiga ko'ra tayyorlash
function prepare(questions, mode = "all") {
  let qs = questions.map((q) => ({ ...q, opts: [...q.opts] }));
  if (mode === "all" || mode === "q") shuffle(qs);
  if (mode === "all" || mode === "a") {
    for (const q of qs) {
      const right = q.opts[q.correct];
      shuffle(q.opts);
      q.correct = q.opts.indexOf(right);
    }
  }
  return qs;
}

function quizQuestions(quiz) {
  return quiz.questions?.length ? quiz.questions : buildQuestions(quiz.pairs, quiz.count, quiz.direction || "fwd");
}

// ---------------- Umumiy ombor ----------------
export class Store extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS quizzes(id TEXT PRIMARY KEY, owner INTEGER, title TEXT,
      pairs TEXT, count INTEGER, direction TEXT, timer INTEGER, created INTEGER)`);
    for (const col of ["description TEXT", "shuffle TEXT", "questions TEXT", "chanMsg INTEGER", "public INTEGER DEFAULT 0", "status TEXT DEFAULT 'ok'", "chanReq TEXT"]) {
      try { this.sql.exec(`ALTER TABLE quizzes ADD COLUMN ${col}`); } catch {}
    }
    this.sql.exec(`CREATE TABLE IF NOT EXISTS polls(id TEXT PRIMARY KEY, chat TEXT, created INTEGER)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS users(uid INTEGER PRIMARY KEY, created INTEGER, blocked INTEGER DEFAULT 0)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS ads(id INTEGER PRIMARY KEY AUTOINCREMENT, fromChat INTEGER, msgIds TEXT, pin INTEGER,
      title TEXT, created INTEGER, expires INTEGER, active INTEGER DEFAULT 1, sent INTEGER DEFAULT 0, fail INTEGER DEFAULT 0)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS deliveries(ad INTEGER, uid INTEGER, msgs TEXT, PRIMARY KEY(ad, uid))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS review(uid INTEGER, qid TEXT, k TEXT, title TEXT, q TEXT, stage INTEGER, due INTEGER,
      PRIMARY KEY(uid, qid, k))`);
    // O'qituvchi hisoboti: guruhda o'tkazilgan testlar
    this.sql.exec(`CREATE TABLE IF NOT EXISTS games(id INTEGER PRIMARY KEY AUTOINCREMENT, chat INTEGER, chatTitle TEXT, qid TEXT, title TEXT,
      starter INTEGER, created INTEGER, asked INTEGER)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS game_scores(game INTEGER, uid INTEGER, name TEXT, ok INTEGER, bad INTEGER, secs REAL, PRIMARY KEY(game, uid))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS game_words(game INTEGER, q TEXT, ans TEXT, wrong INTEGER, total INTEGER)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS review_done(uid INTEGER PRIMARY KEY, n INTEGER)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS bans(uid INTEGER PRIMARY KEY, name TEXT, reason TEXT, created INTEGER)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS results(qid TEXT, uid INTEGER, name TEXT, ok INTEGER, total INTEGER,
      secs REAL, created INTEGER, PRIMARY KEY(qid, uid))`);
    // Avvaldan bor foydalanuvchilarni (test yaratgan va yechganlar) ro'yxatga qo'shamiz
    if (!this.sql.exec("SELECT v FROM settings WHERE k='usersBackfill'").toArray().length) {
      this.sql.exec("INSERT OR IGNORE INTO users(uid,created) SELECT DISTINCT owner, created FROM quizzes WHERE owner > 0");
      this.sql.exec("INSERT OR IGNORE INTO users(uid,created) SELECT DISTINCT uid, created FROM results WHERE uid > 0");
      this.sql.exec("INSERT OR REPLACE INTO settings VALUES('usersBackfill','1')");
    }
  }
  saveQuiz(q) {
    const id = newId();
    this.sql.exec(
      `INSERT INTO quizzes(id,owner,title,pairs,count,direction,timer,created,description,shuffle,questions)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      id, q.owner, q.title, JSON.stringify(q.pairs), q.questions.length, q.direction, q.timer, Date.now(),
      q.description || "", q.shuffle || "all", JSON.stringify(q.questions));
    return id;
  }
  getQuiz(id) {
    const r = this.sql.exec("SELECT * FROM quizzes WHERE id=?", id).toArray()[0];
    if (!r) return null;
    return { ...r, pairs: JSON.parse(r.pairs || "[]"), questions: r.questions ? JSON.parse(r.questions) : null };
  }
  updateQuiz(id, owner, field, value) {
    if (!["title", "description", "timer", "shuffle"].includes(field)) return false;
    this.sql.exec(`UPDATE quizzes SET ${field}=? WHERE id=? AND owner=?`, value, id, owner);
    return true;
  }
  listQuizzes(owner, offset = 0, n = 30) {
    return this.sql.exec("SELECT id,title,count,public,chanMsg,chanReq,status FROM quizzes WHERE owner=? ORDER BY created DESC LIMIT ? OFFSET ?", owner, n, offset).toArray();
  }
  countQuizzes(owner) {
    return this.sql.exec("SELECT COUNT(*) AS n FROM quizzes WHERE owner=?", owner).toArray()[0]?.n || 0;
  }
  // Foydalanuvchining barcha testlarini o'chirish (natijalari bilan); kanal postlari qaytariladi
  ownerQuizzes(owner) {
    return this.sql.exec("SELECT id,title,count,public,chanMsg,chanReq,status FROM quizzes WHERE owner=? ORDER BY created ASC", owner).toArray();
  }
  deleteAllQuizzes(owner) {
    const own = this.sql.exec("SELECT id, chanMsg FROM quizzes WHERE owner=?", owner).toArray();
    for (const q of own) this.sql.exec("DELETE FROM results WHERE qid=?", q.id);
    this.sql.exec("DELETE FROM quizzes WHERE owner=?", owner);
    return { n: own.length, posts: own.map((q) => q.chanMsg).filter(Boolean) };
  }
  catalog(owner, offset, n) {
    return this.sql.exec("SELECT id,title,count FROM quizzes WHERE owner=? AND public=1 AND status='ok' ORDER BY created DESC LIMIT ? OFFSET ?", owner, n, offset).toArray();
  }
  countByOwner(owner) {
    return this.sql.exec("SELECT COUNT(*) AS n FROM quizzes WHERE owner=? AND public=1", owner).toArray()[0].n;
  }
  // Foydalanuvchining barcha ma'lumotlarini o'chirish; kanaldagi postlar ro'yxatini qaytaradi
  deleteUserData(uid) {
    const own = this.sql.exec("SELECT id, chanMsg FROM quizzes WHERE owner=?", uid).toArray();
    for (const q of own) this.sql.exec("DELETE FROM results WHERE qid=?", q.id);
    this.sql.exec("DELETE FROM quizzes WHERE owner=?", uid);
    this.sql.exec("DELETE FROM results WHERE uid=?", uid);
    this.sql.exec("DELETE FROM deliveries WHERE uid=?", uid);
    this.sql.exec("DELETE FROM review WHERE uid=?", uid);
    this.sql.exec("DELETE FROM users WHERE uid=?", uid);
    return { quizzes: own.length, posts: own.map((q) => q.chanMsg).filter(Boolean) };
  }
  setStatus(id, s) {
    this.sql.exec("UPDATE quizzes SET status=? WHERE id=?", s, id);
  }
  adminDeleteQuiz(id) {
    const q = this.sql.exec("SELECT chanMsg FROM quizzes WHERE id=?", id).toArray()[0];
    this.sql.exec("DELETE FROM quizzes WHERE id=?", id);
    this.sql.exec("DELETE FROM results WHERE qid=?", id);
    return q?.chanMsg || null;
  }
  ban(uid, name, reason) {
    this.sql.exec("INSERT OR REPLACE INTO bans VALUES(?,?,?,?)", uid, name || "", reason || "", Date.now());
  }
  unban(uid) {
    const n = this.sql.exec("SELECT uid FROM bans WHERE uid=?", uid).toArray().length;
    this.sql.exec("DELETE FROM bans WHERE uid=?", uid);
    return n > 0;
  }
  bans() {
    return this.sql.exec("SELECT * FROM bans ORDER BY created DESC LIMIT 50").toArray();
  }
  // Bitta savolga rasm yoki izoh qo'shish/olib tashlash
  updateQuestion(id, owner, idx, patch) {
    const r = this.sql.exec("SELECT questions FROM quizzes WHERE id=? AND owner=?", id, owner).toArray()[0];
    if (!r?.questions) return false;
    const qs = JSON.parse(r.questions);
    if (!qs[idx]) return false;
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === "") delete qs[idx][k];
      else qs[idx][k] = v;
    }
    this.sql.exec("UPDATE quizzes SET questions=? WHERE id=?", JSON.stringify(qs), id);
    return true;
  }
  setPublic(id, v) {
    this.sql.exec("UPDATE quizzes SET public=? WHERE id=?", v ? 1 : 0, id);
  }
  setChanReq(id, who) {
    this.sql.exec("UPDATE quizzes SET chanReq=? WHERE id=?", who, id);
  }
  setChanMsg(id, msg) {
    this.sql.exec("UPDATE quizzes SET chanMsg=? WHERE id=?", msg, id);
  }
  searchQuizzes(owner, q) {
    return this.sql.exec(
      "SELECT id,title,count,timer,description FROM quizzes WHERE owner=? AND title LIKE ? ORDER BY created DESC LIMIT 20",
      owner, `%${q}%`).toArray();
  }
  deleteQuiz(id, owner) {
    const n = this.sql.exec("SELECT id FROM quizzes WHERE id=? AND owner=?", id, owner).toArray().length;
    this.sql.exec("DELETE FROM quizzes WHERE id=? AND owner=?", id, owner);
    if (n) this.sql.exec("DELETE FROM results WHERE qid=?", id);
    return n > 0;
  }
  // Har bir foydalanuvchining eng yaxshi natijasi saqlanadi (ko'proq to'g'ri, teng bo'lsa — tezroq)
  addResult(qid, uid, name, ok, total, secs) {
    const before = this.sql.exec("SELECT ok, secs FROM results WHERE qid=? AND uid=?", qid, uid).toArray()[0];
    this.sql.exec(`INSERT INTO results VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(qid, uid) DO UPDATE SET ok=excluded.ok, total=excluded.total, secs=excluded.secs, name=excluded.name, created=excluded.created
      WHERE excluded.ok > results.ok OR (excluded.ok = results.ok AND excluded.secs < results.secs)`,
      qid, uid, name, ok, total, secs, Date.now());
    const pl = this.placeOf(qid, uid);
    return pl && { ...pl, improved: !!before && (ok > before.ok || (ok === before.ok && secs < before.secs)), first: !before };
  }
  placeOf(qid, uid) {
    const me = this.sql.exec("SELECT ok,secs FROM results WHERE qid=? AND uid=?", qid, uid).toArray()[0];
    if (!me) return null;
    const better = this.sql.exec("SELECT COUNT(*) AS n FROM results WHERE qid=? AND (ok>? OR (ok=? AND secs<?))",
      qid, me.ok, me.ok, me.secs).toArray()[0].n;
    return { place: better + 1, total: this.takers(qid) };
  }
  takers(qid) {
    return this.sql.exec("SELECT COUNT(*) AS n FROM results WHERE qid=?", qid).toArray()[0].n;
  }
  top(qid, n = 5) {
    return this.sql.exec("SELECT name,ok,total,secs FROM results WHERE qid=? ORDER BY ok DESC, secs ASC LIMIT ?", qid, n).toArray();
  }
  // Foydalanuvchilar (reklama tarqatish uchun)
  addUser(uid) {
    const had = this.sql.exec("SELECT blocked FROM users WHERE uid=?", uid).toArray()[0];
    if (had) {
      if (had.blocked) this.sql.exec("UPDATE users SET blocked=0 WHERE uid=?", uid);
      return false;
    }
    this.sql.exec("INSERT INTO users(uid,created) VALUES(?,?)", uid, Date.now());
    return true;
  }
  listUsers(after, n) {
    return this.sql.exec("SELECT uid FROM users WHERE uid>? AND blocked=0 ORDER BY uid LIMIT ?", after, n).toArray().map((r) => r.uid);
  }
  markBlocked(uid) {
    this.sql.exec("UPDATE users SET blocked=1 WHERE uid=?", uid);
  }
  // ---- Takrorlash: har bir o'quvchining o'z xatolaridan yig'ilgan bitta umumiy ro'yxati ----
  // wrong: xato qilingan savollar, right: to'g'ri topilgan juftliklar; isReview — takrorlash sessiyasimi
  reviewUpdate(uid, wrong, right, isReview, srcTitle = "") {
    const now = Date.now();
    const key = (p) => (p[0] + "|" + p[1]).slice(0, 300);
    let added = 0, mastered = 0, advanced = 0;
    const wrongKeys = new Set();
    for (const q of wrong) {
      const k = key(q.pair);
      if (wrongKeys.has(k)) continue;
      wrongKeys.add(k);
      const had = this.sql.exec("SELECT 1 FROM review WHERE uid=? AND k=?", uid, k).toArray().length;
      if (!had) added++;
      this.sql.exec("DELETE FROM review WHERE uid=? AND k=?", uid, k);
      this.sql.exec("INSERT INTO review VALUES(?,?,?,?,?,?,?)", uid, "*", k, srcTitle, JSON.stringify(q), 0, now + REVIEW_STEPS[0] * DAY);
    }
    if (isReview) {
      for (const p of right) {
        const k = key(p);
        if (wrongKeys.has(k)) continue;
        const r = this.sql.exec("SELECT MAX(stage) AS stage FROM review WHERE uid=? AND k=?", uid, k).toArray()[0];
        if (r?.stage == null) continue;
        const st = r.stage + 1;
        if (st >= REVIEW_STEPS.length) {
          this.sql.exec("DELETE FROM review WHERE uid=? AND k=?", uid, k); mastered++;
          this.sql.exec("INSERT INTO review_done VALUES(?,1) ON CONFLICT(uid) DO UPDATE SET n=n+1", uid);
        }
        else { this.sql.exec("UPDATE review SET stage=?, due=? WHERE uid=? AND k=?", st, now + REVIEW_STEPS[st] * DAY, uid, k); advanced++; }
        wrongKeys.add(k);
      }
    }
    const left = this.sql.exec("SELECT COUNT(DISTINCT k) AS n FROM review WHERE uid=?", uid).toArray()[0].n;
    return { added, mastered, advanced, left };
  }
  // ---- O'qituvchi hisoboti ----
  saveGame(g) {
    this.sql.exec("INSERT INTO games(chat,chatTitle,qid,title,starter,created,asked) VALUES(?,?,?,?,?,?,?)",
      g.chat, g.chatTitle || "", g.qid, g.title, g.starter, Date.now(), g.asked);
    const id = this.sql.exec("SELECT last_insert_rowid() AS id").toArray()[0].id;
    for (const u of g.scores) this.sql.exec("INSERT OR REPLACE INTO game_scores VALUES(?,?,?,?,?,?)", id, u.uid, u.name, u.ok, u.bad, u.t);
    for (const w of g.words) this.sql.exec("INSERT INTO game_words VALUES(?,?,?,?,?)", id, w.q, w.ans, w.wrong, w.total);
    return id;
  }
  groupsOf(uid) {
    return this.sql.exec(`SELECT chat, MAX(chatTitle) AS title, COUNT(*) AS n, MAX(created) AS last FROM games
      WHERE chat IN (SELECT DISTINCT chat FROM games WHERE starter=? UNION SELECT DISTINCT g.chat FROM games g JOIN game_scores s ON s.game=g.id WHERE s.uid=?)
      GROUP BY chat ORDER BY last DESC LIMIT 15`, uid, uid).toArray();
  }
  groupGames(chat, offset = 0, n = 10) {
    const total = this.sql.exec("SELECT COUNT(*) AS n FROM games WHERE chat=?", chat).toArray()[0].n;
    const rows = this.sql.exec(`SELECT g.id, g.title, g.created, g.asked, (SELECT COUNT(*) FROM game_scores s WHERE s.game=g.id) AS players
      FROM games g WHERE chat=? ORDER BY id DESC LIMIT ? OFFSET ?`, chat, n, offset).toArray();
    return { total, rows, title: this.sql.exec("SELECT chatTitle FROM games WHERE chat=? ORDER BY id DESC LIMIT 1", chat).toArray()[0]?.chatTitle || "" };
  }
  gameReport(id) {
    const g = this.sql.exec("SELECT * FROM games WHERE id=?", id).toArray()[0];
    if (!g) return null;
    const scores = this.sql.exec("SELECT uid, name, ok, bad, secs FROM game_scores WHERE game=? ORDER BY ok DESC, secs ASC", id).toArray();
    const words = this.sql.exec("SELECT q, ans, wrong, total FROM game_words WHERE game=? AND wrong>0 ORDER BY wrong*1.0/total DESC, wrong DESC LIMIT 15", id).toArray();
    return { g, scores, words };
  }
  groupStudents(chat) {
    const rows = this.sql.exec(`SELECT s.uid, MAX(s.name) AS name, COUNT(*) AS games, SUM(s.ok) AS ok, SUM(g.asked) AS asked
      FROM game_scores s JOIN games g ON g.id=s.game WHERE g.chat=? GROUP BY s.uid ORDER BY SUM(s.ok)*1.0/MAX(SUM(g.asked),1) DESC LIMIT 60`, chat).toArray();
    const now = Date.now();
    for (const r of rows) {
      const solo = this.sql.exec("SELECT COUNT(*) AS n, AVG(ok*1.0/MAX(total,1)) AS avg FROM results WHERE uid=?", r.uid).toArray()[0];
      const rv = this.sql.exec("SELECT COUNT(DISTINCT k) AS n, COUNT(DISTINCT CASE WHEN due<=? THEN k END) AS due FROM review WHERE uid=?", now, r.uid).toArray()[0];
      r.solo = solo.n || 0; r.soloAvg = solo.avg == null ? null : Math.round(solo.avg * 100);
      r.review = rv.n || 0; r.due = rv.due || 0;
      r.mastered = this.sql.exec("SELECT n FROM review_done WHERE uid=?", r.uid).toArray()[0]?.n || 0;
    }
    return rows;
  }
  reviewSummary(uid) {
    const r = this.sql.exec(`SELECT COUNT(DISTINCT k) AS total, COUNT(DISTINCT CASE WHEN due<=? THEN k END) AS due, MIN(CASE WHEN due>? THEN due END) AS next
      FROM review WHERE uid=?`, Date.now(), Date.now(), uid).toArray()[0];
    return { total: r?.total || 0, due: r?.due || 0, next: r?.next || null };
  }
  reviewItems(uid, onlyDue, limit = REVIEW_MAX) {
    const rows = this.sql.exec(`SELECT k, q FROM review WHERE uid=?${onlyDue ? " AND due<=?" : ""} ORDER BY due`,
      ...(onlyDue ? [uid, Date.now()] : [uid])).toArray();
    const seen = new Set(), out = [];
    for (const r of rows) { if (seen.has(r.k)) continue; seen.add(r.k); out.push(JSON.parse(r.q)); if (out.length >= limit) break; }
    return out;
  }
  userInfo(uid) {
    const u = this.sql.exec("SELECT created, blocked FROM users WHERE uid=?", uid).toArray()[0] || null;
    const ads = this.sql.exec("SELECT id, title, active, (SELECT msgs FROM deliveries d WHERE d.ad=ads.id AND d.uid=?) AS got FROM ads WHERE active=1 ORDER BY id", uid).toArray();
    return { u, ads };
  }
  adDeliveryCounts() {
    return this.sql.exec("SELECT id, title, sent, fail, (SELECT COUNT(*) FROM deliveries d WHERE d.ad=ads.id) AS have FROM ads WHERE active=1 ORDER BY id").toArray();
  }
  userStats() {
    const q = (s) => this.sql.exec(s).toArray()[0].n;
    return { users: q("SELECT COUNT(*) AS n FROM users WHERE blocked=0"), blocked: q("SELECT COUNT(*) AS n FROM users WHERE blocked=1"),
      quizzes: q("SELECT COUNT(*) AS n FROM quizzes"), results: q("SELECT COUNT(*) AS n FROM results") };
  }
  // ---- Reklamalar ----
  addAd(a) {
    this.sql.exec("INSERT INTO ads(fromChat,msgIds,pin,title,created,expires) VALUES(?,?,?,?,?,?)",
      a.fromChat, JSON.stringify(a.msgIds), a.pin ? 1 : 0, a.title, Date.now(), a.expires || null);
    return this.sql.exec("SELECT last_insert_rowid() AS id").toArray()[0].id;
  }
  getAd(id) {
    const r = this.sql.exec("SELECT * FROM ads WHERE id=?", id).toArray()[0];
    return r ? { ...r, msgIds: JSON.parse(r.msgIds) } : null;
  }
  // Foydalanuvchini ro'yxatda faol qilib qo'yadi (bloklangan deb belgilangan bo'lsa ham)
  // va unga hali yetib bormagan faol reklamalarni qaytaradi
  touchUser(uid) {
    const had = this.sql.exec("SELECT blocked FROM users WHERE uid=?", uid).toArray()[0];
    if (!had) this.sql.exec("INSERT INTO users(uid,created) VALUES(?,?)", uid, Date.now());
    else if (had.blocked) this.sql.exec("UPDATE users SET blocked=0 WHERE uid=?", uid);
    return this.sql.exec("SELECT * FROM ads WHERE active=1 AND id NOT IN (SELECT ad FROM deliveries WHERE uid=?) ORDER BY id", uid)
      .toArray().map((r) => ({ ...r, msgIds: JSON.parse(r.msgIds) }));
  }
  deliveredTo(ad, uids) {
    if (!uids.length) return [];
    return this.sql.exec(`SELECT uid FROM deliveries WHERE ad=? AND uid IN (${uids.map(() => "?").join(",")})`, ad, ...uids).toArray().map((r) => r.uid);
  }
  activeAds() {
    return this.sql.exec("SELECT * FROM ads WHERE active=1 ORDER BY id").toArray().map((r) => ({ ...r, msgIds: JSON.parse(r.msgIds) }));
  }
  deactivateAd(id) {
    this.sql.exec("UPDATE ads SET active=0 WHERE id=?", id);
  }
  expiredAds(now) {
    return this.sql.exec("SELECT id FROM ads WHERE active=1 AND expires IS NOT NULL AND expires<=?", now).toArray().map((r) => r.id);
  }
  nextExpiry() {
    return this.sql.exec("SELECT MIN(expires) AS t FROM ads WHERE active=1 AND expires IS NOT NULL").toArray()[0].t;
  }
  adStats(id, sent, fail) {
    this.sql.exec("UPDATE ads SET sent=?, fail=? WHERE id=?", sent, fail, id);
  }
  addDeliveries(ad, rows) {
    for (const [uid, msgs] of rows) this.sql.exec("INSERT OR REPLACE INTO deliveries VALUES(?,?,?)", ad, uid, JSON.stringify(msgs));
  }
  listDeliveries(ad, after, n) {
    return this.sql.exec("SELECT uid, msgs FROM deliveries WHERE ad=? AND uid>? ORDER BY uid LIMIT ?", ad, after, n).toArray()
      .map((r) => ({ uid: r.uid, msgs: JSON.parse(r.msgs) }));
  }
  clearDeliveries(ad) {
    this.sql.exec("DELETE FROM deliveries WHERE ad=?", ad);
  }
  getSetting(k) {
    return this.sql.exec("SELECT v FROM settings WHERE k=?", k).toArray()[0]?.v ?? null;
  }
  setSetting(k, v) {
    this.sql.exec("INSERT OR REPLACE INTO settings VALUES(?,?)", k, v);
  }
  mapPoll(pid, chat) {
    this.sql.exec("DELETE FROM polls WHERE created < ?", Date.now() - 86400000);
    this.sql.exec("INSERT OR REPLACE INTO polls VALUES(?,?,?)", pid, String(chat), Date.now());
  }
  pollChat(pid) {
    return this.sql.exec("SELECT chat FROM polls WHERE id=?", pid).toArray()[0]?.chat ?? null;
  }
}

// Test kartasi (QuizBot uslubida)
async function cardContent(env, quiz, { owner = false, takers = null, author = false } = {}) {
  const me = await botName(env);
  const n = quiz.questions?.length || quiz.count;
  let text = `🎲 <b>${esc(quiz.title)}</b>\n`;
  if (quiz.description) text += `<i>${esc(quiz.description)}</i>\n`;
  text += `\n🖊 ${n} ta savol\n⏱ Har bir savolga ${timerLabel(quiz.timer)}\n🔀 ${SHUFFLE[quiz.shuffle || "all"]}`;
  const imgs = (quiz.questions || []).filter((q) => q.img).length;
  const exps = (quiz.questions || []).filter((q) => q.exp).length;
  if (imgs) text += `\n🖼 ${imgs} ta rasmli savol`;
  if (exps) text += `\n💬 ${exps === n ? "Har bir savolda izoh bor" : `${exps} ta savolda izoh bor`}`;
  if (takers != null) text += `\n👥 ${takers} kishi yechgan`;
  if (author) text += quiz.public ? "\n🌐 Hammaga ko'rinadi («Muallif testlari» va kanalda)" : "\n🔒 Faqat sizga ko'rinadi";
  else if (owner) text += quiz.chanMsg ? "\n📢 Testlar kanalida joylangan" : quiz.chanReq ? "\n⏳ Kanalga chiqarish uchun muallif tasdig'i kutilmoqda" : "\n🔒 Kanalga joylanmagan";
  text += `\n\n🔗 https://t.me/${me}?start=${quiz.id}`;
  const rows = [
    [btn("▶️ Testni boshlash", `run:${quiz.id}`)],
    [{ text: "👥 Guruhda boshlash", url: `https://t.me/${me}?startgroup=${quiz.id}` }],
    [{ text: "🔗 Testni ulashish", switch_inline_query: quiz.id }],
  ];
  if (owner) rows.push([btn("✏️ Tahrirlash", `edit:${quiz.id}`), btn("📊 Statistika", `stat:${quiz.id}`)]);
  if (author) rows.push([btn(quiz.public ? "🔒 Hammadan yashirish" : "🌐 Hammaga ko'rsatish", `pub:${quiz.id}`)]);
  else if (owner && quiz.status !== "pending") rows.push([btn(quiz.chanMsg ? "🔕 Kanaldan olib tashlash" : quiz.chanReq ? "↩️ So'rovni bekor qilish" : "📢 Kanalga joylash", `chan:${quiz.id}`)]);
  return { text, reply_markup: kb(rows) };
}

// ---------------- Har bir chat uchun alohida obyekt ----------------
export class Chat extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.st = ctx.storage;
  }
  store() {
    return this.env.STORE.get(this.env.STORE.idFromName("db"));
  }
  // Joriy chat tiliga tarjima qilib yuborish (boshqa chatlarga — o'zgarishsiz)
  tgx(method, body) {
    if (this.lang && this.lang !== "uz" && (method === "answerCallbackQuery" || String(body.chat_id) === String(this.chatId))) {
      body = { ...body };
      if (body.text) body.text = tr(this.lang, body.text);
      if (body.caption) body.caption = tr(this.lang, body.caption);
      if (body.reply_markup) body.reply_markup = trMarkup(this.lang, body.reply_markup);
    }
    return tg(this.env, method, body);
  }
  // Muallifdan boshqalar uchun havola tekshiruvi: topilsa — rad etib xabar beradi
  async rejectLinks(texts) {
    if (this.isAuthor(this.from)) return false;
    const x = findLink(texts);
    if (!x) return false;
    await this.send(LINK_MSG.replace("{x}", esc(x)));
    return true;
  }
  T(s) {
    return tr(this.lang, s);
  }
  async loadLang(from) {
    this.lang = (await this.st.get("lang")) || (await this.st.get("langAuto"));
    if (!this.lang && from) {
      // Telegram tilidan avtomatik aniqlaymiz (keyin /lang bilan o'zgartirish mumkin)
      this.lang = detectLang(from.language_code);
      await this.st.put("langAuto", this.lang);
    }
    this.lang ||= "uz";
  }
  langPicker(editId) {
    const text = "🌐 Tilni tanlang / Выберите язык / Choose your language / Dil seçin";
    const reply_markup = kb(Object.entries(LANGS).map(([k, v]) => [btn(v, `lang:${k}`)]));
    return editId ? tg(this.env, "editMessageText", { chat_id: this.chatId, message_id: editId, text, reply_markup })
      : tg(this.env, "sendMessage", { chat_id: this.chatId, text, reply_markup });
  }
  send(text, extra = {}) {
    return this.tgx("sendMessage", { chat_id: this.chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });
  }
  edit(msgId, text, extra = {}) {
    return this.tgx("editMessageText", { chat_id: this.chatId, message_id: msgId, text, parse_mode: "HTML",
      disable_web_page_preview: true, ...extra });
  }

  // ---------- Kanalga a'zolik ----------
  async isMember(uid) {
    const chans = channelsOf(this.env);
    if (!chans.length) return true;
    const until = await this.st.get("m:" + uid);
    if (until && until > Date.now()) return true;
    for (const ch of chans) {
      const r = await this.tgx("getChatMember", { chat_id: ch.id, user_id: uid });
      if (!r.ok) continue; // bot kanalda admin bo'lmasa — bu kanal tekshirilmaydi (loglarda xato ko'rinadi)
      const s = r.result.status;
      const ok = ["creator", "administrator", "member"].includes(s) || (s === "restricted" && r.result.is_member);
      if (!ok) return false;
    }
    await this.st.put("m:" + uid, Date.now() + 3600e3);
    return true;
  }
  joinPrompt() {
    const chans = channelsOf(this.env);
    const list = chans.map((c, i) => `${i + 1}. ${esc(c.name)}`).join("\n");
    return this.send(
      `📢 Botdan foydalanish uchun avval ${chans.length > 1 ? "quyidagi kanallarimizga" : "kanalimizga"} a'zo bo'ling:\n${list}\n\nA'zo bo'lgach, «✅ Tekshirish» tugmasini bosing.\n\n👨‍🏫 Muallif: ${esc(authorOf(this.env))}`,
      { reply_markup: kb([...joinRows(this.env), [btn("✅ Tekshirish", "chk")]]) });
  }

  async onLangPick(cq) {
    const code = cq.data.slice(5);
    if (!LANGS[code]) return tg(this.env, "answerCallbackQuery", { callback_query_id: cq.id });
    await this.st.put("lang", code);
    this.lang = code;
    await this.tgx("answerCallbackQuery", { callback_query_id: cq.id, text: "✅ Til o'zgartirildi." });
    await this.edit(cq.message.message_id, `✅ Til o'zgartirildi. ${LANGS[code]}`);
    if (cq.message.chat.type !== "private") return;
    const pending = await this.st.get("langStart");
    await this.st.delete("langStart");
    if (pending) return this.openQuiz(pending, cq.from, "private");
    return this.sendHelp();
  }

  sendHelp() {
    return this.send(HELP + `\n\n👨‍🏫 Muallif: ${esc(authorOf(this.env))}`, { reply_markup: MAIN_KB });
  }
  isAuthor(from) {
    const a = authorOf(this.env).replace(/^@/, "").toLowerCase();
    return (from?.username || "").toLowerCase() === a || (this.env.ADMIN_ID && String(from?.id) === String(this.env.ADMIN_ID));
  }
  // ---------- Yo'riqnoma va namunalar ----------
  async samples() {
    try { return JSON.parse((await this.store().getSetting("samples")) || "[]"); } catch { return []; }
  }
  async guideMenu(editId) {
    const n = (await this.samples()).length;
    const text = "📖 <b>Yo'riqnoma va namunalar</b>\n\nKerakli bo'limni tanlang:";
    const reply_markup = kb([[btn("📖 Bot yo'riqnomasi", "g:bot")], [btn("📘 Test fayli qanday bo'lishi kerak", "g:fmt")],
      [btn(`🗂 Namuna fayllar (${n})`, "g:smp")]]);
    return editId ? this.edit(editId, text, { reply_markup }) : this.send(text, { reply_markup });
  }
  // Muallif uchun: yo'riqnoma bo'limi (yuklab olish + almashtirish + o'chirish)
  async guideAdmin(kind, editId) {
    const key = kind === "fmt" ? "fguide" : "guide";
    const fid = await this.store().getSetting(key);
    const name = kind === "fmt" ? "📘 <b>Test fayli qanday bo'lishi kerak</b>" : "📖 <b>Bot yo'riqnomasi</b>";
    await this.st.put("awaitMat", key);
    const text = `${name}\n\nHolati: ${fid ? "✅ yuklangan" : "❌ hali yuklanmagan"}\n\n` +
      `📎 <b>Faylni shu yerga yuboring</b> — u foydalanuvchilar uchun ${fid ? "joylanadi, eskisi o'chadi" : "joylanadi"} (test tuzilmaydi).\n\n` +
      "📥 — foydalanuvchilar ko'radigandek yuklab olish\n🗑 — o'chirish";
    const rows = [];
    if (fid) rows.push([btn("📥 Yuklab olish", `g:get${kind}`)]);
    rows.push([btn(fid ? "🔄 Almashtirish" : "➕ Fayl yuklash", `mt:set:${key}`)].concat(fid ? [btn("🗑 O'chirish", `mt:del:${key}`)] : []));
    rows.push([btn("⬅️ Orqaga", "g:menu")]);
    return editId ? this.edit(editId, text, { reply_markup: kb(rows) }) : this.send(text, { reply_markup: kb(rows) });
  }
  async sendGuide(kind = "bot") {
    const key = kind === "fmt" ? "fguide" : "guide";
    const fid = await this.store().getSetting(key);
    if (!fid) return this.send("📖 Bu yo'riqnoma hali yuklanmagan. Savollar bo'lsa, muallifga yozing: /author");
    const head = kind === "fmt" ? "📘 <b>Test fayli qanday bo'lishi kerak</b>" : "📖 <b>LingoUP bot — foydalanish yo'riqnomasi</b>";
    return this.tgx("sendDocument", { chat_id: this.chatId, document: fid,
      caption: head + "\n\nSavollar bo'lsa " + esc(authorOf(this.env)) + " bilan bog'laning.", parse_mode: "HTML" });
  }
  async samplesMenu(editId) {
    const list = await this.samples();
    const adm = this.isAuthor(this.from);
    if (!list.length && !adm) return this.send("🗂 Namuna fayllar hali yuklanmagan.");
    const rows = list.map((s, i) => [btn(`📄 ${s.title}`.slice(0, adm ? 48 : 60), `smp:${i}`)].concat(adm ? [btn("🗑", `mt:rm:${i}`)] : []));
    if (list.length) rows.push([btn("📦 Hammasini yuborish", "smp:all")]);
    if (adm) {
      await this.st.put("awaitMat", "smp");
      rows.push([btn("➕ Namuna qo'shish", "mt:add")]);
      if (list.length) rows.push([btn("🗑 Barcha namunalarni o'chirish", "mt:rmask")]);
    }
    rows.push([btn("⬅️ Orqaga", "g:menu")]);
    let text = "🗂 <b>Namuna fayllar</b>\n\nFaylni tanlang — u sizga yuboriladi. Shu fayllardagidek tuzib yuborsangiz, bot testni o'zi yaratadi.";
    if (adm) text += `\n\n👨‍🏫 <i>Muallif rejimi:</i> 📄 — yuklab olish, 🗑 — o'chirish.\n📎 <b>Yangi namuna qo'shish uchun faylni shu yerga yuboring</b> (test tuzilmaydi). Bir nechtasini ketma-ket yuborsa bo'ladi.` + (list.length ? "" : "\n\nHozircha namuna yo'q.");
    return editId ? this.edit(editId, text, { reply_markup: kb(rows) }) : this.send(text, { reply_markup: kb(rows) });
  }
  sendSample(s) {
    return this.tgx("sendDocument", { chat_id: this.chatId, document: s.file_id, caption: `🗂 ${esc(s.title)}${s.note ? "\n" + esc(s.note) : ""}`, parse_mode: "HTML" });
  }

  // Muallif: materiallarni boshqarish
  async materialsMenu(editId) {
    const store = this.store();
    const g = await store.getSetting("guide"), f = await store.getSetting("fguide");
    const list = await this.samples();
    const text = "📚 <b>Materiallar boshqaruvi</b>\n\n" +
      `📖 Bot yo'riqnomasi: ${g ? "✅ yuklangan" : "❌ yo'q"}\n📘 Test fayli yo'riqnomasi: ${f ? "✅ yuklangan" : "❌ yo'q"}\n🗂 Namuna fayllar: ${list.length} ta\n\n` +
      "🔄 — yangisini yuklash (eskisi o'chadi), 🗑 — o'chirish.";
    const rows = [
      [btn("🔄 Bot yo'riqnomasi", "mt:set:guide"), btn("🗑", "mt:del:guide")],
      [btn("🔄 Test fayli yo'riqnomasi", "mt:set:fguide"), btn("🗑", "mt:del:fguide")],
      [btn("➕ Namuna qo'shish", "mt:add")],
      ...list.map((s, i) => [btn(`🗑 ${s.title}`.slice(0, 60), `mt:rm:${i}`)]),
      list.length ? [btn("🗑 Barcha namunalarni o'chirish", "mt:rmall")] : [],
    ];
    return editId ? this.edit(editId, text, { reply_markup: kb(rows) }) : this.send(text, { reply_markup: kb(rows) });
  }
  async onMaterialFile(doc, caption) {
    const mode = await this.st.get("awaitMat");
    const store = this.store();
    if (mode === "guide" || mode === "fguide") {
      await this.st.delete("awaitMat");
      await store.setSetting(mode, doc.file_id);
      await this.send(mode === "guide" ? "✅ Bot yo'riqnomasi yangilandi. Eskisi o'chirildi." : "✅ Test fayli yo'riqnomasi yangilandi. Eskisi o'chirildi.");
      return this.guideAdmin(mode === "guide" ? "bot" : "fmt");
    }
    const list = await this.samples();
    const title = (caption || doc.file_name || "Namuna").replace(/\.[^.]+$/, "").replace(/_/g, " ").trim().slice(0, 50);
    list.push({ title, file_id: doc.file_id });
    await store.setSetting("samples", JSON.stringify(list));
    return this.send(`✅ Namuna qo'shildi: <b>${esc(title)}</b> (jami ${list.length} ta).\nYana fayl yuboring yoki tugating.`,
      { reply_markup: kb([[btn("✅ Tayyor", "mt:done")]]) });
  }
  // ---------- Donat ----------
  async donateMenu() {
    const info = await this.store().getSetting("donate");
    const admin = this.isAuthor(this.from);
    if (!info) return this.send("💝 Donat hozircha sozlanmagan." + (admin ? "\nSozlash: /donatsozla" : ""));
    // Karta raqamlarini bosib nusxalash mumkin bo'lishi uchun <code> ichiga olamiz
    const body = esc(info).replace(/(?:\d[ -]?){12,19}\d?/g, (x) => `<code>${x.trim()}</code>`);
    const text = "💝 <b>LingoUP botini qo'llab-quvvatlash</b>\n\nBot bepul ishlaydi. Agar u sizga foydali bo'lsa, rivojiga hissa qo'shishingiz mumkin — har qanday miqdor uchun katta rahmat! 🙏\n\n" +
      body + "\n\n<i>Karta raqamini bosing — u nusxalanadi.</i>";
    const rows = admin ? [[btn("✏️ O'zgartirish", "dn:set"), btn("🗑 O'chirish", "dn:del")]] : [];
    return this.send(text, { reply_markup: kb(rows) });
  }
  async donateSetup() {
    await this.st.put("awaitDonate", 1);
    return this.send("💳 <b>Donat sozlash</b>\n\nFoydalanuvchilarga ko'rinadigan matnni bitta xabar qilib yuboring. Masalan:\n\n<code>💳 Karta: 8600 1234 5678 9012\n👤 Egasi: Ism Familiya\n🏦 Humo / Uzcard</code>\n\nBir nechta karta yozish mumkin. Karta raqami botning kodida emas, faqat bot sozlamalarida saqlanadi.\nBekor qilish: /cancel");
  }
  sendAuthor() {
    const a = authorOf(this.env);
    return this.send(`👨‍🏫 Bot muallifi: <b>${esc(a)}</b>\n\nTaklif, savol yoki hamkorlik bo'yicha yozing 👇\n\n💬 <b>Bot orqali yozish</b> — xabaringiz muallifga shu bot orqali boradi, javob ham shu yerga keladi.`,
      { reply_markup: kb([[btn("💬 Bot orqali yozish", "sup:new")], [{ text: "✉️ Telegramda yozish", url: `https://t.me/${a.replace(/^@/, "")}` }]]) });
  }
  // ---------- 🧰 Fayl vositalari (fayllar saqlanmaydi — faqat Telegram file_id lar vaqtincha) ----------
  toolsMenu(editId) {
    const text = "🧰 <b>Fayl vositalari</b>\n\nNimani qilamiz?\n\n🖼 <b>Rasmlardan PDF</b> — bir nechta JPG/PNG bitta PDF bo'ladi\n📎 <b>PDF birlashtirish</b> — bir nechta PDF bitta faylga\n📊 <b>Excel → CSV</b> — .xlsx jadvalni CSV qilish\n📄 <b>PDF → TXT</b> — PDF ichidagi matnni olish\n\n<i>Fayllar botda saqlanmaydi: natija yuborilgach hammasi o'chadi.</i>";
    const reply_markup = kb([[btn("🖼 Rasmlardan PDF", "tl:img"), btn("📎 PDF birlashtirish", "tl:merge")], [btn("📊 Excel → CSV", "tl:csv"), btn("📄 PDF → TXT", "tl:txt")]]);
    return editId ? this.edit(editId, text, { reply_markup }) : this.send(text, { reply_markup });
  }
  async startTool(kind, editId) {
    await this.st.put("tool", { kind, files: [], bytes: 0 });
    const t = {
      img: "🖼 <b>Rasmlardan PDF</b>\n\nRasmlarni yuboring (JPG yoki PNG, bir nechtasini birdaniga ham bo'ladi). PDF'da rasmlar yuborilgan tartibda bo'ladi.\nTugatgach «✅ PDF yaratish» ni bosing.",
      merge: "📎 <b>PDF birlashtirish</b>\n\nPDF fayllarni birlashtirish tartibida yuboring (kamida 2 ta).\nTugatgach «✅ Birlashtirish» ni bosing.",
      csv: "📊 <b>Excel → CSV</b>\n\nExcel faylni (.xlsx) yuboring. Har bir varaq alohida CSV fayl bo'ladi.",
      txt: "📄 <b>PDF → TXT</b>\n\nPDF faylni yuboring — ichidagi matn .txt fayl qilib qaytariladi.",
    }[kind];
    return this.edit(editId, t + `\n\n<i>Har bir fayl 20 MB gacha, jami ${TOOL_MAX_FILES} tagacha.</i>`, { reply_markup: kb([[btn("❌ Bekor qilish", "tl:cancel")]]) });
  }
  async downloadTg(fileId) {
    const f = await this.tgx("getFile", { file_id: fileId });
    if (!f.ok) throw new Error("Faylni olib bo'lmadi (20 MB dan katta bo'lishi mumkin)");
    const r = await fetch(`https://api.telegram.org/file/bot${this.env.BOT_TOKEN}/${f.result.file_path}`);
    return new Uint8Array(await r.arrayBuffer());
  }
  async sendFile(bytes, filename, caption, type = "application/octet-stream") {
    const fd = new FormData();
    fd.append("chat_id", String(this.chatId));
    if (caption) { fd.append("caption", caption); fd.append("parse_mode", "HTML"); }
    fd.append("document", new Blob([bytes], { type }), filename);
    const r = await fetch(`https://api.telegram.org/bot${this.env.BOT_TOKEN}/sendDocument`, { method: "POST", body: fd });
    return r.json().catch(() => ({ ok: false }));
  }
  async onToolInput(m) {
    const tool = await this.st.get("tool");
    const d = m.document;
    const name = d?.file_name || "fayl";
    const size = d?.file_size || m.photo?.at(-1)?.file_size || 0;
    if (size > 20 * 1024 * 1024) return this.send("❗ Fayl 20 MB dan katta — Telegram botlarga bunday faylni yuklab olishga ruxsat bermaydi.");
    const isPdf = d && (/pdf/i.test(d.mime_type || "") || /\.pdf$/i.test(name));
    const isImg = m.photo || (d && (/^image\/(jpeg|png)/i.test(d.mime_type || "") || /\.(jpe?g|png)$/i.test(name)));
    if (tool.kind === "img" || tool.kind === "merge") {
      if (tool.kind === "img" && !isImg) return this.send("❗ Faqat JPG yoki PNG rasm yuboring.");
      if (tool.kind === "merge" && !isPdf) return this.send("❗ Faqat PDF fayl yuboring.");
      if (tool.files.length >= TOOL_MAX_FILES) return this.send(`❗ Eng ko'pi ${TOOL_MAX_FILES} ta fayl.`);
      if (tool.bytes + size > TOOL_MAX_BYTES) return this.send("❗ Fayllar jami hajmi juda katta (45 MB gacha). Shu yergacha birlashtiring.");
      tool.files.push({ id: m.photo ? m.photo.at(-1).file_id : d.file_id, name });
      tool.bytes += size;
      if (tool.status) await this.tgx("deleteMessage", { chat_id: this.chatId, message_id: tool.status });
      const n = tool.files.length;
      const go = tool.kind === "img" ? `✅ PDF yaratish (${n})` : `✅ Birlashtirish (${n})`;
      const r = await this.send(`${tool.kind === "img" ? "🖼" : "📎"} Qabul qilindi: <b>${n}</b> ta. Yana yuboring yoki tugating.`,
        { reply_markup: kb([[btn(go, "tl:go")], [btn("❌ Bekor qilish", "tl:cancel")]]) });
      tool.status = r.result?.message_id;
      await this.st.put("tool", tool);
      return;
    }
    // Bitta faylli vositalar
    await this.st.delete("tool");
    try {
      if (tool.kind === "csv") {
        if (!/\.xlsx$/i.test(name)) return this.send("❗ .xlsx fayl yuboring. Eski .xls bo'lsa, Excel'da «Saqlash → .xlsx» qiling. /vositalar");
        await this.tgx("sendChatAction", { chat_id: this.chatId, action: "upload_document" });
        const sheets = (await xlsxSheets(await this.downloadTg(d.file_id))).filter((sh) => sh.rows.some((r) => r.some((x) => x !== "")));
        if (!sheets.length) return this.send("❗ Faylda ma'lumot topilmadi.");
        const base = name.replace(/\.[^.]+$/, "");
        const q = (v) => /[",\n\r]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
        for (const sh of sheets.slice(0, 10)) {
          const csv = "\ufeff" + sh.rows.map((r) => r.map(q).join(",")).join("\r\n");
          await this.sendFile(new TextEncoder().encode(csv), `${base}${sheets.length > 1 ? "_" + sh.name.replace(/[\\/:*?"<>|]/g, "_") : ""}.csv`,
            `📊 ${esc(sh.name)} — ${sh.rows.length} qator`, "text/csv");
        }
        return this.send("✅ Tayyor. Yana: /vositalar");
      }
      if (tool.kind === "txt") {
        if (!isPdf) return this.send("❗ PDF fayl yuboring. /vositalar");
        await this.tgx("sendChatAction", { chat_id: this.chatId, action: "upload_document" });
        const lines = await pdfToLines(await this.downloadTg(d.file_id));
        const text = lines.join("\n").trim();
        if (!text) return this.send("❗ PDF ichida matn topilmadi — u skanerlangan (rasm) bo'lishi mumkin.");
        await this.sendFile(new TextEncoder().encode("\ufeff" + text), name.replace(/\.[^.]+$/, "") + ".txt", `📄 ${lines.length} qator matn`, "text/plain");
        return this.send("✅ Tayyor. Yana: /vositalar");
      }
    } catch (e) {
      console.log("Vosita xatosi", e);
      return this.send(`❗ Faylni qayta ishlab bo'lmadi: <code>${esc(String(e?.message || e).slice(0, 120))}</code>`);
    }
  }
  async runTool(msgId) {
    const tool = await this.st.get("tool");
    if (!tool?.files?.length) return this.edit(msgId, "❗ Hali fayl yuborilmadi.");
    if (tool.kind === "merge" && tool.files.length < 2) return this.edit(msgId, "❗ Birlashtirish uchun kamida 2 ta PDF kerak.", { reply_markup: kb([[btn("❌ Bekor qilish", "tl:cancel")]]) });
    await this.st.delete("tool");
    await this.edit(msgId, "⏳ Tayyorlanmoqda…");
    await this.tgx("sendChatAction", { chat_id: this.chatId, action: "upload_document" });
    try {
      const { PDFDocument } = await import("./pdf-lib.js");
      const out = await PDFDocument.create();
      let pages = 0, skipped = 0;
      for (const f of tool.files) {
        const bytes = await this.downloadTg(f.id);
        if (tool.kind === "img") {
          const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
          const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8;
          if (!isPng && !isJpg) { skipped++; continue; }
          const img = isPng ? await out.embedPng(bytes) : await out.embedJpg(bytes);
          // A4 sahifa, rasm yo'nalishiga qarab; rasm chetlardan 20pt joy qoldirib markazga joylanadi
          const land = img.width > img.height;
          const [W, H] = land ? [842, 595] : [595, 842];
          const k = Math.min((W - 40) / img.width, (H - 40) / img.height);
          const w = img.width * k, h = img.height * k;
          out.addPage([W, H]).drawImage(img, { x: (W - w) / 2, y: (H - h) / 2, width: w, height: h });
          pages++;
        } else {
          let src;
          try { src = await PDFDocument.load(bytes, { ignoreEncryption: true }); } catch { skipped++; continue; }
          const copied = await out.copyPages(src, src.getPageIndices());
          copied.forEach((p) => out.addPage(p));
          pages += copied.length;
        }
      }
      if (!pages) return this.send("❗ Fayllarni o'qib bo'lmadi.");
      const data = await out.save({ useObjectStreams: true });
      if (data.length > 49 * 1024 * 1024) return this.send("❗ Natija 50 MB dan katta — Telegram yuborishga ruxsat bermaydi. Kamroq fayl bilan urinib ko'ring.");
      const r = await this.sendFile(data, tool.kind === "img" ? "LingoUP_rasmlar.pdf" : "LingoUP_birlashtirilgan.pdf",
        `✅ ${pages} sahifa` + (skipped ? ` · ⚠️ ${skipped} ta fayl o'qilmadi` : ""), "application/pdf");
      if (!r.ok) return this.send("❗ Faylni yuborib bo'lmadi.");
      return this.edit(msgId, "✅ Tayyor. Yana: /vositalar");
    } catch (e) {
      console.log("Vosita xatosi", e);
      return this.send(`❗ Xatolik: <code>${esc(String(e?.message || e).slice(0, 120))}</code>`);
    }
  }

  // ---------- Muallif bilan yozishma ----------
  async askSupport(editId) {
    await this.st.put("awaitSupport", 1);
    const text = "💬 <b>Muallifga xabar</b>\n\nXabaringizni yozing — matn, rasm, ovozli xabar yoki fayl bo'lishi mumkin. U muallifga yuboriladi, javob shu chatga keladi.\n\nBekor qilish: /cancel";
    return editId ? this.edit(editId, text) : this.send(text);
  }
  async forwardToAuthor(m) {
    const admin = await this.adminChat();
    if (!admin) { await this.st.delete("awaitSupport"); return this.send("❗ Hozircha xabar yuborib bo'lmadi. Keyinroq urinib ko'ring yoki /author"); }
    const last = (await this.st.get("supLast")) || 0;
    if (Date.now() - last < 15000) return this.send("⏳ Biroz kuting va qayta yuboring.");
    await this.st.delete("awaitSupport");
    await this.st.put("supLast", Date.now());
    const u = m.from;
    const name = [u.first_name, u.last_name].filter(Boolean).join(" ") || "Foydalanuvchi";
    await tg(this.env, "sendMessage", { chat_id: admin, parse_mode: "HTML",
      text: `📩 <b>Yangi xabar</b>\n👤 <a href="tg://user?id=${u.id}">${esc(name)}</a>${u.username ? ` (@${esc(u.username)})` : ""}\n🆔 <code>${u.id}</code>`,
      reply_markup: kb([[btn("↩️ Javob berish", `sup:r:${u.id}`)]]) });
    const r = await tg(this.env, "copyMessage", { chat_id: admin, from_chat_id: this.chatId, message_id: m.message_id });
    if (!r.ok) return this.send("❗ Xabarni yuborib bo'lmadi. Boshqacha shaklda yuborib ko'ring.");
    return this.send("✅ Xabaringiz muallifga yuborildi. Javob shu chatga keladi.", { reply_markup: kb([[btn("💬 Yana yozish", "sup:new")]]) });
  }
  async sendSupportReply(m, uid) {
    await this.st.delete("awaitReply");
    await tg(this.env, "sendMessage", { chat_id: uid, parse_mode: "HTML", text: "📬 <b>Muallifdan javob:</b>" });
    const r = await tg(this.env, "copyMessage", { chat_id: uid, from_chat_id: this.chatId, message_id: m.message_id,
      reply_markup: kb([[btn("💬 Javob yozish", "sup:new")]]) });
    return this.send(r.ok ? "✅ Javob yuborildi." : `❗ Yuborib bo'lmadi: <code>${esc(r.description || "")}</code>\n(Foydalanuvchi botni bloklagan bo'lishi mumkin.)`);
  }

  // Foydalanuvchini bloklash/blokdan chiqarish (muallif tomonidan chaqiriladi)
  async setBanned(v, chatId) {
    this.chatId = chatId;
    await this.st.put("chatId", chatId);
    await this.loadLang();
    if (v) {
      await this.st.put("banned", true);
      for (const k of ["sess", "create", "edit", "retry"]) await this.st.delete(k);
      return this.send(`🚫 Siz bot qoidalarini buzganingiz (nojo'ya mazmundagi test) uchun bloklandingiz.\nE'tirozingiz bo'lsa: ${esc(authorOf(this.env))}`);
    }
    await this.st.delete("banned");
    return this.send("✅ Siz blokdan chiqarildingiz. Botdan yana foydalanishingiz mumkin — /start");
  }

  async handle(update, chatId) {
    this.chatId = chatId;
    await this.st.put("chatId", chatId);
    const m = update.message;
    const cq = update.callback_query;
    const isPrivate = (m?.chat || cq?.message?.chat)?.type === "private";
    const uid = (m || cq)?.from?.id;
    await this.loadLang((m || cq)?.from);
    this.from = (m || cq)?.from;
    if (cq?.data?.startsWith("lang:")) return this.onLangPick(cq);
    if (isPrivate && (await this.st.get("banned"))) {
      if (cq) await this.tgx("answerCallbackQuery", { callback_query_id: cq.id, text: "🚫 Siz botdan bloklangansiz", show_alert: true });
      else if (((await this.st.get("bannedNote")) || 0) < Date.now()) {
        await this.st.put("bannedNote", Date.now() + 3600e3);
        await this.send(`🚫 Siz botdan bloklangansiz. E'tirozingiz bo'lsa: ${esc(authorOf(this.env))}`);
      }
      return;
    }
    // Yangi foydalanuvchini ro'yxatga olamiz (reklama uchun) va faol reklamani ko'rsatamiz
    // Har 3 soatda bir marta: ro'yxatda faollashtiramiz va o'tkazib yuborilgan faol reklamalarni yetkazamiz
    let missed = [];
    const reg = await this.st.get("reg");
    if (isPrivate && uid && (!reg || reg === 1 || Date.now() - reg > 3 * 3600e3 || /^\/start\b/.test(m?.text || ""))) {
      missed = await this.store().touchUser(uid);
      await this.st.put("reg", Date.now());
    }
    const isNew = missed.length > 0;
    // Muallifga maxsus buyruqlar menyusi (faqat unga ko'rinadi)
    if (isPrivate && this.isAuthor((m || cq).from) && !(await this.st.get("adminCmds8"))) {
      await this.tgx("setMyCommands", { commands: ADMIN_COMMANDS, scope: { type: "chat", chat_id: uid } });
      await this.store().setSetting("authorId", String(uid));
      await this.st.put("adminCmds8", 1);
    }
    if (isPrivate && uid && cq?.data !== "chk" && !(await this.isMember(uid))) {
      const arg = m?.text?.match(/^\/start\s+(\S+)/)?.[1];
      if (arg) await this.st.put("pendingStart", arg);
      if (cq) await this.tgx("answerCallbackQuery", { callback_query_id: cq.id });
      await this.joinPrompt();
      if (isNew) await this.sendActiveAds(uid, missed);
      return;
    }
    if (m) await this.onMessage(m);
    else if (cq) await this.onCallback(cq);
    if (isNew) await this.sendActiveAds(uid, missed);
  }

  // Yangi foydalanuvchiga barcha faol reklamalarni yuborish
  async sendActiveAds(uid, list) {
    const store = this.store();
    for (const ad of list || (await store.activeAds())) {
      const r = await copyAd(this.env, this.chatId, ad);
      if (!r.ok) continue;
      if (ad.pin && r.msgs[0]) await pinAd(this.env, this.chatId, r.msgs);
      await store.addDeliveries(ad.id, [[uid, r.msgs]]);
    }
  }

  async adminChat() {
    return +((await this.store().getSetting("authorId")) || 0);
  }
  // Shubhali test yoki shikoyat haqida muallifga xabar
  async reportToAdmin(quiz, header, extra = "") {
    const admin = await this.adminChat();
    if (!admin) return;
    const sample = (quiz.questions || []).slice(0, 3).map((q, i) => `${i + 1}. ${esc(q.q.slice(0, 120))}`).join("\n");
    const text = `${header}\n\n🎲 <b>${esc(quiz.title)}</b>\n${quiz.description ? `<i>${esc(quiz.description)}</i>\n` : ""}` +
      `👤 Tuzuvchi: <a href="tg://user?id=${quiz.owner}">${quiz.owner}</a>\n${extra}\n<b>Namuna savollar:</b>\n${sample || "—"}`;
    return this.tgx("sendMessage", { chat_id: admin, text, parse_mode: "HTML", reply_markup: kb([
      [btn("✅ Ruxsat berish", `mod:ok:${quiz.id}`), btn("🗑 O'chirish", `mod:del:${quiz.id}`)],
      [btn("🚫 Bloklash va testlarini o'chirish", `mod:ban:${quiz.id}`)],
      [btn("👁 Testni ko'rish", `open:${quiz.id}`)]]) });
  }
  async banUser(uid, name, reason) {
    const store = this.store();
    await store.ban(uid, name, reason);
    const res = await store.deleteUserData(uid);
    if (this.env.TESTS_CHANNEL)
      for (const mid of res.posts) await this.tgx("deleteMessage", { chat_id: this.env.TESTS_CHANNEL, message_id: mid });
    await this.env.CHAT.get(this.env.CHAT.idFromName(String(uid))).setBanned(true, uid);
    return res;
  }

  settingsMenu(editId) {
    const text = "⚙️ <b>Sozlamalar</b>\n\n" + "🌐 <b>Til</b> — bot interfeysi tili.\n\n" +
      "🗑 <b>Ma'lumotlarimni o'chirish</b> — botdagi barcha testlaringiz, natijalaringiz va reytingdagi o'rningiz butunlay o'chiriladi.\n\n" +
      "⚠️ <b>Telegram akkauntni o'chirish</b> — Telegram'ning rasmiy sahifasi ochiladi. U yerda telefon raqamingiz bilan kirib, " +
      "akkauntni o'chirishni o'zingiz tasdiqlaysiz. <b>Diqqat:</b> akkaunt o'chirilsa, barcha chatlar, kontaktlar va kanallar qaytarib bo'lmaydigan tarzda yo'qoladi!";
    const reply_markup = kb([[btn("🌐 Til", "langmenu")], [btn("🗑 Ma'lumotlarimni o'chirish", "deldata")], [{ text: "⚠️ Telegram akkauntni o'chirish", url: TG_DELETE_URL }]]);
    return editId ? this.edit(editId, text, { reply_markup }) : this.send(text, { reply_markup });
  }

  adContact() {
    const a = authorOf(this.env);
    return this.send(`📣 Botga reklama joylamoqchi bo'lsangiz ${esc(a)} ga murojaat qiling.`,
      { reply_markup: kb([[{ text: "✉️ Murojaat qilish", url: `https://t.me/${a.replace(/^@/, "")}` }]]) });
  }

  // ---------- Reklama (faqat muallif) ----------
  async adMenu(editId) {
    const store = this.store();
    const s = await store.userStats();
    const ads = await store.activeAds();
    const caster = this.env.CASTER.get(this.env.CASTER.idFromName("main"));
    await caster.kick(); // navbat qotib qolgan bo'lsa — qayta ishga tushadi
    const status = await caster.status();
    let text = `📣 <b>Reklama boshqaruvi</b>\n\n👥 Faol foydalanuvchilar: <b>${s.users}</b>\n🚫 Botni bloklaganlar: ${s.blocked}\n`;
    if (status.queue) text += `\n⏳ Navbatda: ${status.queue} ta vazifa${status.progress != null ? ` (hozirgisi: ${status.progress} ta yuborildi)` : ""}\n`;
    text += ads.length ? `\n<b>Faol reklamalar (${ads.length}):</b>\n` + ads.map((a, i) =>
      `${i + 1}. ${a.pin ? "📌" : "📤"} ${esc(a.title)} — ${a.sent} kishiga yetgan${a.expires ? `, ⏳ ${fmtDate(a.expires)} gacha` : ", muddatsiz"}`).join("\n") +
      "\n\nYangi foydalanuvchilar barcha faol reklamalarni avtomatik oladi." : "\nHozir faol reklama yo'q.";
    const rows = [[btn("➕ Yangi reklama", "ad:new")], ...ads.map((a, i) => [btn(`🗑 ${i + 1}. ${a.title}`.slice(0, 60), `adrm:${a.id}`)]),
      [btn("🔄 Yangilash", "ad:menu")]];
    return editId ? this.edit(editId, text, { reply_markup: kb(rows) }) : this.send(text, { reply_markup: kb(rows) });
  }

  // ---------- Xabarlar ----------
  async onMessage(m) {
    const isPrivate = m.chat.type === "private";
    const isGroup = m.chat.type === "group" || m.chat.type === "supergroup";
    const text = fromButton(m.text || "");
    // Albomning keyingi rasmlari — mavjud qoralamaga qo'shamiz
    if (isPrivate && m.media_group_id && this.isAuthor(m.from)) {
      const d = await this.st.get("adDraft");
      if (d && d.group === m.media_group_id) {
        if (!d.msgIds.includes(m.message_id)) d.msgIds.push(m.message_id);
        await this.st.put("adDraft", d);
        return;
      }
    }
    // Muallif reklama postini yuboryapti
    // Muallif bilan yozishma: foydalanuvchi xabari muallifga, muallif javobi foydalanuvchiga
    if (isPrivate && !text.startsWith("/") && ![BTN_NEW, BTN_MY, BTN_CAT, BTN_REVIEW, BTN_GUIDE, BTN_AUTHOR, BTN_AD, BTN_SET, BTN_DONATE, BTN_TOOLS].includes(text)) {
      const replyTo = this.isAuthor(m.from) ? await this.st.get("awaitReply") : null;
      if (replyTo) return this.sendSupportReply(m, replyTo);
      if (await this.st.get("awaitSupport")) return this.forwardToAuthor(m);
    }
    if (isPrivate && !text.startsWith("/") && (await this.st.get("awaitDonate")) && this.isAuthor(m.from)) {
      await this.st.delete("awaitDonate");
      await this.store().setSetting("donate", text.trim().slice(0, 1500));
      await this.send("✅ Donat ma'lumoti saqlandi. Foydalanuvchilar quyidagicha ko'radi:");
      return this.donateMenu();
    }
    if (isPrivate && !text.startsWith("/") && (await this.st.get("awaitAd")) && this.isAuthor(m.from)) {
      await this.st.delete("awaitAd");
      const kind = m.photo ? "🖼 Rasm" : m.video ? "🎬 Video" : m.animation ? "🎞 GIF" : m.document ? "📄 Fayl" : m.voice ? "🎤 Ovoz" : "📝 Post";
      const title = ((m.caption || m.text || "").split("\n")[0].trim() || kind).slice(0, 40);
      await this.st.put("adDraft", { fromChat: m.chat.id, msgIds: [m.message_id], group: m.media_group_id || null, title });
      const s = await this.store().userStats();
      return this.send(`👆 Reklama posti tayyor${m.media_group_id ? " (albom — barcha rasm/videolar birga boradi, birinchisi qadaladi)" : ""}. <b>${s.users}</b> ta foydalanuvchiga yuboriladi.\n\nQanday tarqatamiz?`, {
        reply_to_message_id: m.message_id,
        reply_markup: kb([[btn("📤 Post qilib yuborish", "admode:send")], [btn("📌 Yuborish va tepaga qadash", "admode:pin")], [btn("❌ Bekor qilish", "ad:cancel")]]) });
    }
    if (text.startsWith("/")) {
      const [head, ...rest] = text.trim().split(/\s+/);
      const [cmd, target] = head.slice(1).split("@");
      if (target && target.toLowerCase() !== (await botName(this.env)).toLowerCase()) return;
      const arg = rest.join(" ");
      if (isPrivate) { await this.st.delete("awaitMat"); await this.st.delete("awaitSupport"); await this.st.delete("awaitReply"); await this.st.delete("tool"); }
      switch (cmd.toLowerCase()) {
        case "start":
          if (isPrivate && !(await this.st.get("lang"))) {
            if (arg) await this.st.put("langStart", arg);
            return this.langPicker();
          }
          if (arg) return this.openQuiz(arg, m.from, m.chat.type);
          return isPrivate ? this.sendHelp() : target ? this.send(HELP) : null;
        case "lang":
        case "til":
        case "language":
          return this.langPicker();
        case "author":
        case "muallif":
          return this.sendAuthor();
        case "vositalar":
        case "tools":
          return isPrivate ? this.toolsMenu() : null;
        case "yozish":
        case "support":
          return isPrivate ? this.askSupport() : null;
        case "hisobot":
        case "report": {
          if (isPrivate) return this.reportHome(m.from.id);
          if (!isGroup) return;
          if (!(await this.isGroupAdmin(this.chatId, m.from.id))) return this.send("📊 Hisobotni faqat guruh adminlari ko'ra oladi.");
          const r = await this.tgx("sendMessage", { chat_id: m.from.id, text: "📊 Hisobot tayyorlanmoqda…" });
          if (!r.ok) return this.send("📊 Hisobotni shaxsiy xabarda yuboraman — avval botga /start bosing, keyin /hisobot ni qayta yozing.");
          const tmp = this.chatId;
          this.chatId = m.from.id;
          await this.reportGroup(tmp, 0, r.result.message_id);
          this.chatId = tmp;
          return this.send("📊 Hisobot sizga shaxsiy xabarda yuborildi.");
        }
        case "takrorlash":
        case "review":
          return isPrivate ? this.reviewMenu(m.from.id) : null;
        case "myid":
        case "id":
          return this.send(`🆔 Sizning ID raqamingiz: <code>${m.from.id}</code>`);
        case "adcheck": {
          if (!isPrivate || !this.isAuthor(m.from)) return;
          const store = this.store();
          const target = +(rest[0] || 0);
          if (!target) {
            const st = await store.userStats();
            const rows = await store.adDeliveryCounts();
            const cs = this.env.CASTER.get(this.env.CASTER.idFromName("main"));
            const det = await cs.details();
            const jobs = det.jobs.length ? det.jobs.map((j, i) => `${i + 1}. ${j.type === "send" ? "📤 tarqatish" : "🗑 olib tashlash"} #${j.ad}: ✅ ${j.ok} / ❌ ${j.fail} (🚫 ${j.blocked}), ${j.age} daq oldin boshlangan` +
              (j.errors ? `, ⚠️ ${j.errors} marta xato` : "") + (j.lastError ? `\n   Telegram: <code>${esc(j.lastError)}</code>` : "")).join("\n") : "bo'sh";
            const navbat = `\n\n⚙️ <b>Navbat:</b> ${jobs}` + (det.alarm ? `\n⏰ Keyingi ishga tushish: ${fmtDate(det.alarm)}` : "\n⏰ Rejalashtirilmagan") +
              (det.lastCrash ? `\n💥 Oxirgi ichki xato: <code>${esc(det.lastCrash)}</code>` : "");
            const btns = rows.map((a) => [btn(`📤 «${a.title}» — yetmaganlarga yuborish`.slice(0, 60), `adre:${a.id}`)]);
            if (det.jobs.length) btns.push([btn("🧹 Navbatni tozalash", "adq:clear")]);
            return this.send(`📊 <b>Reklama tekshiruvi</b>\n\n👥 Faol foydalanuvchilar: ${st.users}\n🚫 Bloklangan deb belgilangan: ${st.blocked}\n\n` +
              (rows.length ? rows.map((a) => `📣 «${esc(a.title)}»: yetkazilgan ${a.have} ta (hisobot: ${a.sent} ✅ / ${a.fail} ❌)`).join("\n") : "Faol reklama yo'q.") +
              navbat + "\n\nBitta foydalanuvchini tekshirish: <code>/adcheck ID</code>\n(ID ni foydalanuvchi botga /id yozib biladi)",
              { reply_markup: kb(btns) });
          }
          const info = await store.userInfo(target);
          let text = `🔎 <b>Foydalanuvchi ${target}</b>\n\n` + (info.u
            ? `📋 Ro'yxatda bor${info.u.blocked ? " — 🚫 bloklangan deb belgilangan" : " — ✅ faol"}`
            : "❗ Ro'yxatda yo'q (botga hali /start bosmagan yoki ma'lumotlarini o'chirgan)");
          for (const a of info.ads) {
            if (a.got) { text += `\n\n📣 «${esc(a.title)}» — ✅ yetkazilgan (xabar №${JSON.parse(a.got).join(", ")})`; continue; }
            const ad = await store.getAd(a.id);
            const r = await copyAd(this.env, target, ad);
            if (r.ok) { await store.addDeliveries(ad.id, [[target, r.msgs]]); await store.touchUser(target); }
            text += `\n\n📣 «${esc(a.title)}» — yetkazilmagan edi. Hozir yuborildi: ${r.ok ? "✅ muvaffaqiyatli" : `❌ Telegram javobi: <code>${esc(r.description || String(r.error_code))}</code>`}`;
          }
          if (!info.ads.length) text += "\n\nFaol reklama yo'q.";
          return this.send(text);
        }
        case "reklama":
        case "ad":
          if (!isPrivate) return;
          if (!this.isAuthor(m.from)) return this.adContact();
          return this.adMenu();
        case "donat":
        case "donate":
          return this.donateMenu();
        case "donatsozla":
          if (!isPrivate || !this.isAuthor(m.from)) return;
          return this.donateSetup();
        case "stat":
        case "stats": {
          if (!isPrivate || !this.isAuthor(m.from)) return;
          const s = await this.store().userStats();
          return this.send(`📊 <b>Bot statistikasi</b>\n\n👥 Foydalanuvchilar: ${s.users}\n🚫 Bloklaganlar: ${s.blocked}\n🎲 Testlar: ${s.quizzes}\n🏁 Yechilgan testlar: ${s.results}`);
        }
        case "guide":
        case "yoriqnoma":
          return this.guideMenu();
        case "namuna":
        case "samples":
          return this.samplesMenu();
        case "materials":
        case "materiallar":
        case "setguide":
          if (!isPrivate) return;
          if (!this.isAuthor(m.from)) return this.send("Bu buyruq faqat bot muallifi uchun.");
          return this.materialsMenu();
        case "help":
          return isPrivate ? this.sendHelp() : this.send(HELP);
        case "stop":
          return this.stop(m.from.id);
        case "newquiz":
          if (!isPrivate) return;
          await this.st.delete("create");
          await this.st.delete("edit");
          return this.send(NEWQUIZ_TEXT);
        case "ban":
        case "unban":
        case "bans": {
          if (!isPrivate || !this.isAuthor(m.from)) return;
          const store = this.store();
          if (cmd.toLowerCase() === "bans") {
            const list = await store.bans();
            return this.send(list.length ? "🚫 <b>Bloklanganlar:</b>\n" + list.map((b) =>
              `• <code>${b.uid}</code> ${esc(b.reason || "")} — ${fmtDate(b.created)}`).join("\n") + "\n\nChiqarish: /unban ID" : "Bloklangan foydalanuvchi yo'q.");
          }
          const target = parseInt(arg, 10);
          if (!target) return this.send(`Foydalanish: <code>/${cmd} 123456789</code> (foydalanuvchi ID raqami)`);
          if (cmd.toLowerCase() === "ban") {
            const res = await this.banUser(target, "", "qo'lda");
            return this.send(`🚫 <code>${target}</code> bloklandi. 🗑 ${res.quizzes} ta testi o'chirildi.`);
          }
          const was = await store.unban(target);
          await this.env.CHAT.get(this.env.CHAT.idFromName(String(target))).setBanned(false, target);
          return this.send(was ? `✅ <code>${target}</code> blokdan chiqarildi.` : "Bu foydalanuvchi bloklanmagan edi.");
        }
        case "settings":
        case "sozlamalar":
          return isPrivate ? this.settingsMenu() : null;
        case "tests":
        case "catalog":
          return isPrivate ? this.catalog(0) : null;
        case "mytests":
        case "myquizzes":
          return isPrivate ? this.myTests(m.from.id) : null;
        case "cancel":
          await this.st.delete("tool");
          await this.st.delete("awaitSupport");
          await this.st.delete("awaitReply");
          await this.st.delete("manual");
          await this.st.delete("awaitAd");
          await this.st.delete("awaitDonate");
          await this.st.delete("awaitMat");
          await this.st.delete("create");
          await this.st.delete("edit");
          return this.send("❌ Bekor qilindi.");
        case "version":
          return this.send("🛠 Bot versiyasi: <b>2026-10-16 · pullik tarif</b>");
        case "skip":
          if (isPrivate) return this.onSkip();
          return;
      }
      return;
    }
    if (!isPrivate) return;
    if (!m.document && (await this.st.get("awaitMat"))) await this.st.delete("awaitMat");
    if ((m.document || m.photo) && (await this.st.get("tool"))) return this.onToolInput(m);
    if (m.document && (await this.st.get("awaitMat")) && this.isAuthor(m.from)) return this.onMaterialFile(m.document, m.caption);
    if (m.document) return this.onFile(m.document);
    if (m.poll) return this.onQuizPoll(m.poll);
    if (m.photo) return this.onPhoto(m);
    // Pastki tugmalar
    if (text === BTN_NEW) {
      await this.st.delete("create");
      await this.st.delete("edit");
      return this.send(NEWQUIZ_TEXT);
    }
    if (text === BTN_MY) return this.myTests(m.from.id);
    if (text === BTN_CAT) return this.catalog(0);
    if (text === BTN_SET) return this.settingsMenu();
    if (text === BTN_AUTHOR) return this.sendAuthor();
    if (text === BTN_GUIDE) return this.guideMenu();
    if (text === BTN_REVIEW) return this.reviewMenu(m.from.id);
    if (text === BTN_DONATE) return this.donateMenu();
    if (text === BTN_TOOLS) return this.toolsMenu();
    if (text === BTN_AD) return this.isAuthor(m.from) ? this.adMenu() : this.adContact();
    if (!text) return;

    // Tahrirlash uchun matn kutilmoqda
    const ed = await this.st.get("edit");
    if (ed) return this.onEditText(ed, text, m.from.id, m.from);

    const create = await this.st.get("create");
    if (create?.step === "sec" && /^\d{1,4}$/.test(text.trim()) && create.secNames?.length > 14) {
      const n = text.trim();
      const k = create.secNames.findIndex((nm) => nm.startsWith(n + ". "));
      if (k < 0) return this.send(`❗ ${n}-mavzu topilmadi. 1–${create.secNames.length} oralig'ida raqam yozing.`);
      const nm = create.secNames[k];
      return this.askCount(uniqWords(create.all.filter((p) => p[2] === nm)), `${create.title} — ${nm}`);
    }
    if (create?.step === "splitcustom") {
      const k = parseInt(text.trim(), 10);
      if (!/^\d+$/.test(text.trim()) || k < 2) return this.send("Raqam yozing, masalan: 40");
      if (k >= create.pairs.length) return this.send(`Jami ${create.pairs.length} ta — undan kichik son yozing.`);
      if (splitSizes(create.pairs.length, k).length > MAX_PARTS) return this.send(`Juda ko'p qism chiqadi (eng ko'pi ${MAX_PARTS}). Kattaroq son yozing.`);
      create.split = { size: k };
      return this.askSplitOrder(create);
    }
    if (create?.step === "custom") {
      const n = parseInt(text.trim(), 10);
      if (!/^\d+$/.test(text.trim()) || n < 1) return this.send("Raqam yozing, masalan: 25");
      create.count = Math.min(n, create.pairs.length);
      if (create.mcq) return this.askTitle(create);
      create.step = "dir";
      await this.st.put("create", create);
      return this.askDirection();
    }
    if (create?.step === "title") {
      if (await this.rejectLinks([text])) return;
      create.title = text.trim().slice(0, 100);
      return this.askDesc(create);
    }
    if (create?.step === "desc") {
      if (await this.rejectLinks([text])) return;
      create.description = text.trim().slice(0, 300);
      return this.askTimer(create);
    }
    const parsed = parseText(text);
    if (parsed.pairs.length >= 4 || parsed.mcq.questions.length >= 2) {
      const d = new Date(Date.now() + 5 * 3600e3);
      const title = `Test ${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      return this.beginCreate(parsed, title);
    }
    return this.send("📄 Test tuzish uchun faylni yuboring yoki /newquiz buyrug'ini bosing.");
  }

  // ---------- QuizBot usuli: viktorinalarni bittalab yuborish ----------
  manualKb(n) {
    return kb([[btn(`✅ Tayyor — testni yakunlash (${n})`, "man:done")], [btn("↩️ Oxirgisini o'chirish", "man:undo"), btn("❌ Bekor qilish", "man:cancel")]]);
  }
  async onQuizPoll(poll) {
    if (poll.type !== "quiz")
      return this.send("❗ So'rovnomani <b>«Viktorina»</b> (Quiz) rejimida yarating va to'g'ri javobni belgilang.");
    if (poll.correct_option_id == null)
      return this.send("❗ To'g'ri javob ko'rinmadi. Viktorinani boshqa joydan forward qilmang — shu chatning o'zida 📎 → So'rovnoma orqali yarating.");
    if (await this.rejectLinks([poll.question, poll.explanation, ...poll.options.map((o) => o.text)])) return;
    const man = (await this.st.get("manual")) || { questions: [], pendingImg: null };
    const q = { q: poll.question.slice(0, 280), opts: poll.options.map((o) => o.text.slice(0, 100)), correct: poll.correct_option_id };
    if (poll.explanation) q.exp = poll.explanation.slice(0, EXP_MAX);
    if (man.pendingImg) { q.img = man.pendingImg; man.pendingImg = null; }
    man.questions.push(q);
    await this.st.put("manual", man);
    const n = man.questions.length;
    return this.send(`✅ ${n}-savol qo'shildi${q.img ? " 🖼" : ""}${q.exp ? " 💬" : ""}.\n\nYana viktorina yuboring (rasmli savol uchun avval rasmni) yoki testni yakunlang.`,
      { reply_markup: this.manualKb(n) });
  }
  async onPhoto(m) {
    const fid = photoId(m);
    const ed = await this.st.get("edit");
    if (ed?.field === "qimg") {
      await this.st.delete("edit");
      await this.store().updateQuestion(ed.id, m.from.id, ed.idx, { img: fid });
      await this.send("✅ Rasm savolga biriktirildi.");
      return this.questionView(ed.id, ed.idx, m.from.id);
    }
    const man = (await this.st.get("manual")) || { questions: [], pendingImg: null };
    man.pendingImg = fid;
    await this.st.put("manual", man);
    return this.send("🖼 Rasm qabul qilindi — u <b>keyingi yuboradigan viktorinangizga</b> biriktiriladi.\n" +
      "Endi 📎 → So'rovnoma → <b>Viktorina</b> rejimida savolni yarating va yuboring.");
  }

  async onFile(doc) {
    if (doc.file_size > MAX_FILE) return this.send("❗ Fayl 20 MB dan katta. Darslarni alohida fayl qilib yuboring.");
    const name = doc.file_name || "lugat.txt";
    // Yangi fayl kelganda oldingi saqlangan fayl darhol o'chiriladi
    await this.st.delete("src");
    await this.st.delete("book");
    try {
      const f = await this.tgx("getFile", { file_id: doc.file_id });
      const r = await fetch(`https://api.telegram.org/file/bot${this.env.BOT_TOKEN}/${f.result.file_path}`);
      // Fayl faqat xotirada o'qiladi va hech qayerga saqlanmaydi
      const parsed = await parseFile(name, new Uint8Array(await r.arrayBuffer()));
      if (!parsed.pairs.length && !parsed.mcq?.questions.length) {
        if (parsed.mcq?.missing) return this.send(`❗ ${parsed.mcq.missing} ta savol topildi, lekin to'g'ri javoblari ko'rsatilmagan.\nHar bir savol ostiga <code>Javob: B</code> kabi yozing yoki to'g'ri variant oldiga * qo'ying.`);
        return this.send(/\.pdf$/i.test(name)
          ? "❗ PDF ichidan matn topilmadi. Skanerlangan (rasm) PDF bo'lishi mumkin — Word'dan saqlangan PDF yuboring."
          : "❗ Fayldan so'z yoki test savoli topilmadi. Boshqa fayl yuborib ko'ring.");
      }
      await this.st.delete("edit");
      // Word ichidagi rasmlarni Telegram'ga yuklab, savollarga biriktiramiz
      const used = [...new Set(parsed.mcq.questions.map((q) => q.imgIdx).filter((x) => x != null))].slice(0, 100);
      if (used.length) {
        await this.send(`🖼 ${used.length} ta rasm topildi, yuklanmoqda…`);
        const ids = await uploadImages(this.env, this.chatId, used.map((i) => parsed.images[i]));
        const map = new Map(used.map((i, k) => [i, ids[k]]));
        for (const q of parsed.mcq.questions) {
          if (q.imgIdx != null && map.get(q.imgIdx)) q.img = map.get(q.imgIdx);
          delete q.imgIdx;
        }
      }
      const fallback = name.replace(/\.[^.]+$/, "").replace(/_/g, " ");
      // O'qilgan so'zlar 1 soat saqlanadi — shu fayldan yana test tuzish uchun
      const exp = Date.now() + SRC_TTL;
      await this.st.put("src", { exp, name: fallback, parsed: { pairs: parsed.pairs, title: parsed.title, sections: parsed.sections, lessons: parsed.lessons,
        mcq: parsed.mcq ? { title: parsed.mcq.title, questions: parsed.mcq.questions, missing: parsed.mcq.missing } : null } });
      const al = await this.st.getAlarm();
      if (!al || al > exp) await this.st.setAlarm(exp + 1000);
      return this.beginCreate(parsed, fallback);
    } catch (e) {
      console.log("Fayl xatosi", e);
      return this.send("❗ Faylni o'qib bo'lmadi. Formatni tekshiring: /help");
    }
  }

  // Saqlangan fayl (1 soat): muddati o'tgan bo'lsa o'chiriladi
  async getSrc() {
    const src = await this.st.get("src");
    if (src && src.exp <= Date.now()) { await this.st.delete("src"); return null; }
    return src || null;
  }
  async againButton() {
    const src = await this.getSrc();
    if (!src) return;
    return this.send(`📂 <b>${esc(src.name)}</b> fayli ${fmtDate(src.exp).slice(6)} gacha saqlanadi — shu fayldan yana test tuzishingiz mumkin.`,
      { reply_markup: kb([[btn("📂 Shu fayldan yana test tuzish", "src:again")], [btn("🗑 Faylni hozir o'chirish", "src:del")]]) });
  }

  // ---------- Test yaratish bosqichlari ----------
  async beginCreate(parsed, fallbackTitle) {
    // Tayyor test savollari (istalgan fan)
    const mcq = parsed.mcq;
    const content = [parsed.title, mcq?.title, ...(mcq?.questions || []).flatMap((q) => [q.q, q.exp, ...q.opts]),
      ...parsed.pairs.flatMap((p) => [p[0], p[1]])];
    if (await this.rejectLinks(content)) { await this.st.delete("create"); return; }
    if (mcq && mcq.questions.length >= 2 && mcq.questions.length >= parsed.pairs.length / 3) {
      const title = (mcq.title || fallbackTitle).slice(0, 60);
      let head = `📄 <b>${esc(title)}</b>\n✅ ${mcq.questions.length} ta test savoli topildi (variantlari va to'g'ri javoblari bilan).`;
      const ni = mcq.questions.filter((q) => q.img).length, ne = mcq.questions.filter((q) => q.exp).length;
      if (ni) head += `\n🖼 Rasmli savollar: ${ni}`;
      if (ne) head += `\n💬 Izohli savollar: ${ne}`;
      if (mcq.missing) head += `\n⚠️ ${mcq.missing} ta savolda to'g'ri javob ko'rsatilmagan — ular qo'shilmadi.`;
      return this.askCount(mcq.questions, title, undefined, { mcq: true, head });
    }
    const all = parsed.pairs;
    if (all.length < 4) return this.send("❗ Kamida 4 ta so'z juftligi kerak. Format:\n<code>so'z - tarjima</code>\n\n/help");
    const lessons = parsed.lessons || [];
    // Bir nechta darsli kitob: daraja → dars → bo'lim
    if (lessons.length > 1) {
      await this.st.put("book", { all, sections: parsed.sections, lessons, title: fallbackTitle.slice(0, 60) });
      await this.st.delete("create");
      return this.levelMenu();
    }
    const title = (parsed.title || fallbackTitle).slice(0, 60);
    return this.offerSections(all, parsed.sections, title);
  }

  // Darajalar menyusi (A1, A2, B1 ...)
  async levelMenu(editId) {
    const b = await this.st.get("book");
    if (!b) return this.send("Faylni qayta yuboring");
    const levels = [...new Set(b.lessons.map((l) => l.level))];
    const rows = levels.map((lv) => {
      const idx = b.lessons.map((l, i) => (l.level === lv ? i : -1)).filter((i) => i >= 0);
      const n = uniqWords(b.all.filter((p) => idx.includes(p[3]))).length;
      return [btn(`${lv} · ${idx.length} dars · ${n} so'z`, `lv:${lv}`)];
    });
    const total = uniqWords(b.all).length;
    rows.push([btn(`📚 Butun kitob (${total})`, "bk:all")]);
    const text = `📚 <b>${esc(b.title)}</b>\n📖 ${total} ta so'z, ${b.lessons.length} ta dars.\n\nQaysi darajadan test tuzamiz?`;
    return editId ? this.edit(editId, text, { reply_markup: kb(rows) }) : this.send(text, { reply_markup: kb(rows) });
  }

  // Tanlangan darajadagi darslar
  async lessonMenu(lv, editId) {
    const b = await this.st.get("book");
    if (!b) return this.send("Faylni qayta yuboring");
    const items = b.lessons.map((l, i) => ({ l, i, n: b.all.filter((p) => p[3] === i).length })).filter((x) => x.l.level === lv && x.n > 0);
    const rows = [];
    for (let k = 0; k < items.length; k += 2)
      rows.push(items.slice(k, k + 2).map((x) => btn(`${x.l.name.split(" ")[1]} (${x.n})`, `ls:${x.i}`)));
    const total = uniqWords(b.all.filter((p) => items.some((x) => x.i === p[3]))).length;
    rows.push([btn(`📚 Butun ${lv} (${total})`, `bk:${lv}`)], [btn("⬅️ Darajalar", "bk:back")]);
    const text = `📚 <b>${lv} darajasi</b> — ${items.length} ta dars, ${total} ta so'z.\n\nQaysi darsdan test tuzamiz?`;
    return editId ? this.edit(editId, text, { reply_markup: kb(rows) }) : this.send(text, { reply_markup: kb(rows) });
  }

  // Bo'limlarni (Otlar, Fe'llar ...) taklif qilish; bir nechta dars bo'lsa — nomi bo'yicha birlashtiriladi
  async offerSections(pairs, sections, title, editId) {
    const named = pairs.map((p) => [p[0], p[1], sections?.[p[2]] ?? null]);
    const names = [...new Set(named.map((p) => p[2]).filter(Boolean))];
    if (names.length > 1) {
      const create = { all: named, title, secNames: names, step: "sec" };
      await this.st.put("create", create);
      return this.sectionPage(create, 0, editId);
    }
    return this.askCount(uniqWords(named), title, editId);
  }

  // Bo'limlar (mavzular) ro'yxati — ko'p bo'lsa sahifalab ko'rsatiladi
  async sectionPage(create, page, editId) {
    const PER = 12;
    const names = create.secNames;
    const counts = {};
    for (const p of create.all) counts[p[2]] = (counts[p[2]] || 0) + 1;
    const pages = Math.ceil(names.length / PER);
    page = Math.min(Math.max(0, page), pages - 1);
    const rows = names.slice(page * PER, page * PER + PER).map((nm, j) => [btn(`${nm} (${counts[nm] || 0})`.slice(0, 64), `sec:${page * PER + j}`)]);
    const nav = [];
    if (page > 0) nav.push(btn("⬅️ Oldingi", `secp:${page - 1}`));
    if (pages > 1) nav.push(btn(`${page + 1}/${pages}`, `secp:${page}`));
    if (page < pages - 1) nav.push(btn("Keyingi ➡️", `secp:${page + 1}`));
    if (nav.length) rows.push(nav);
    if (pages > 2) rows.push([btn("⏮ 1", "secp:0"), btn(`${Math.ceil(pages / 2)}`, `secp:${Math.ceil(pages / 2) - 1}`), btn(`${pages} ⏭`, `secp:${pages - 1}`)]);
    const total = uniqWords(create.all).length;
    rows.push([btn(`📚 Hammasi (${total})`, "sec:all")]);
    const text = `📄 <b>${esc(create.title)}</b>\n📖 ${total} ta so'z, ${names.length} ta ${names.length > 14 ? "mavzu" : "bo'lim"}.\n\n` +
      `Qaysi ${names.length > 14 ? "mavzudan" : "bo'limdan"} test tuzamiz?` + (pages > 1 ? `\n<i>${page + 1}/${pages}-sahifa · raqamini yozib ham tanlashingiz mumkin (masalan: 25)</i>` : "");
    return editId ? this.edit(editId, text, { reply_markup: kb(rows) }) : this.send(text, { reply_markup: kb(rows) });
  }

  async askCount(pairs, title, editId, extra = {}) {
    if (!extra.mcq && pairs.length < 4) return this.send("❗ Bu bo'limda 4 tadan kam so'z bor. Boshqa bo'limni tanlang.");
    await this.st.put("create", { pairs, title, step: "count", mcq: !!extra.mcq });
    const n = pairs.length;
    const opts = [10, 20, 30, 50, 100, 200, 500].filter((x) => x < n).slice(0, 7);
    const text = (extra.head || `📄 <b>${esc(title)}</b>\n📖 <b>${n}</b> ta so'z.`) + "\n\nNechta savol bo'lsin?";
    const reply_markup = kb([opts.slice(0, 4).map((x) => btn(String(x), `cnt:${x}`)), opts.slice(4).map((x) => btn(String(x), `cnt:${x}`)),
      [btn(`Hammasi (${n})`, `cnt:${n}`), btn("✏️ Boshqa son", "cnt:custom")],
      n >= 8 ? [btn("✂️ Qismlarga bo'lib, bir nechta test tuzish", "cnt:split")] : []]);
    return editId ? this.edit(editId, text, { reply_markup }) : this.send(text, { reply_markup });
  }

  // Lug'at/testni teng qismlarga bo'lish: har qismda nechta savol bo'lishini so'raymiz
  async askSplit(create, editId) {
    const n = create.pairs.length;
    create.step = "split";
    await this.st.put("create", create);
    const parts = (size) => splitSizes(n, size).length;
    const sizes = [10, 20, 25, 30, 40, 50, 100, 200].filter((x) => x < n && parts(x) > 1 && parts(x) <= MAX_PARTS).slice(0, 8);
    const counts = [2, 3, 4, 5, 6, 8, 10].filter((k) => k <= n / 4 && k <= MAX_PARTS);
    const rows = [];
    for (let i = 0; i < sizes.length; i += 2) rows.push(sizes.slice(i, i + 2).map((x) => btn(`${x} tadan → ${parts(x)} qism`, `spl:s:${x}`)));
    for (let i = 0; i < counts.length; i += 3) rows.push(counts.slice(i, i + 3).map((k) => btn(`${k} qismga`, `spl:p:${k}`)));
    rows.push([btn("✏️ Har qismga boshqa son", "spl:custom")], [btn("⬅️ Orqaga", "spl:back")]);
    const text = `✂️ <b>${esc(create.title)}</b> — ${n} ta ${create.mcq ? "savol" : "so'z"}.\n\n` +
      `Qanday bo'lamiz? Har bir qism alohida test bo'ladi va har bir ${create.mcq ? "savol" : "so'z"} faqat bitta qismga tushadi.\n\n` +
      "• <b>«… tadan»</b> — har bir qismda shuncha savol\n• <b>«… qismga»</b> — shuncha teng qismga";
    return editId ? this.edit(editId, text, { reply_markup: kb(rows) }) : this.send(text, { reply_markup: kb(rows) });
  }
  async askSplitOrder(create, editId) {
    create.step = "splitorder";
    await this.st.put("create", create);
    const sz = splitSizes(create.pairs.length, create.split.size);
    const text = `✂️ ${sz.length} ta qism: ${sz.length <= 6 ? sz.join(", ") : `${sz[0]} tadan`} ta savol.\n\nSo'zlar qismlarga qanday taqsimlansin?`;
    const reply_markup = kb([[btn("📖 Fayldagi tartibda (1-qism — boshidagi so'zlar)", "spo:seq")], [btn("🔀 Aralashtirib", "spo:rnd")], [btn("⬅️ Orqaga", "cnt:split")]]);
    return editId ? this.edit(editId, text, { reply_markup }) : this.send(text, { reply_markup });
  }

  askDirection(editId) {
    const markup = kb(Object.entries(DIRS).map(([k, v]) => [btn(v, `dir:${k}`)]));
    const text = "🔀 Savol yo'nalishini tanlang:";
    return editId ? this.edit(editId, text, { reply_markup: markup }) : this.send(text, { reply_markup: markup });
  }

  async askTitle(create, editId) {
    create.step = "title";
    await this.st.put("create", create);
    const text = `✏️ Test nomini yozing.\n\nTavsiya: <b>${esc(create.title)}</b>`;
    const reply_markup = kb([[btn("✅ Shu nom qolsin", "ttl:keep")]]);
    return editId ? this.edit(editId, text, { reply_markup }) : this.send(text, { reply_markup });
  }

  async askDesc(create, editId) {
    create.step = "desc";
    await this.st.put("create", create);
    const text = `📝 <b>${esc(create.title)}</b>\n\nTest tavsifini yozing (masalan: «A1 darajasi, 1-dars so'zlari»).\nKerak bo'lmasa — o'tkazib yuboring (/skip).`;
    const reply_markup = kb([[btn("⏭ O'tkazib yuborish", "dsc:skip")]]);
    return editId ? this.edit(editId, text, { reply_markup }) : this.send(text, { reply_markup });
  }

  async askTimer(create, editId) {
    create.step = "timer";
    await this.st.put("create", create);
    const text = "⏱ Har bir savol uchun vaqtni tanlang:\n<i>Guruhda hamma shu vaqt ichida javob beradi.</i>";
    const reply_markup = timerKb("tm");
    return editId ? this.edit(editId, text, { reply_markup }) : this.send(text, { reply_markup });
  }

  async onSkip() {
    const create = await this.st.get("create");
    if (create?.step === "desc") { create.description = ""; return this.askTimer(create); }
  }

  async finishCreate(create, uid, msgId, from = { id: uid }) {
    if (await this.rejectLinks([create.title, create.description,
      ...(create.pairs || []).flatMap((x) => Array.isArray(x) ? x : [x.q, x.exp, ...(x.opts || [])])])) {
      await this.st.delete("create");
      return this.edit(msgId, "❌ Test yaratilmadi.");
    }
    if (create.split) return this.finishSplit(create, uid, msgId, from);
    let questions, pairs = create.pairs, direction = create.direction || "fwd";
    if (create.mcq) {
      // Tayyor savollar: kerakli sonini tanlab, asl tartibini saqlaymiz
      const idx = sample([...create.pairs.keys()], create.count).sort((a, b) => a - b);
      questions = idx.map((i) => create.pairs[i]).map((q) => ({ q: q.q, opts: q.opts.map((o) => o || "—"), correct: q.correct,
        pair: [q.q.length > 80 ? q.q.slice(0, 77) + "…" : q.q, q.opts[q.correct]],
        ...(q.img ? { img: q.img } : {}), ...(q.exp ? { exp: q.exp.slice(0, EXP_MAX) } : {}) }));
      pairs = [];
      direction = "mcq";
    } else questions = buildQuestions(create.pairs, create.count, direction);
    const store = this.store();
    const id = await store.saveQuiz({ owner: uid, title: create.title, description: create.description || "",
      pairs, direction, timer: create.timer, shuffle: create.shuffle, questions });
    await this.st.delete("create");
    const quiz = await store.getQuiz(id);
    const author = this.isAuthor(from);
    if (author) await store.setSetting("authorId", String(uid));
    const bad = author ? null : badWord(quizTexts(quiz));
    if (bad) {
      await store.setStatus(id, "pending");
      await this.edit(msgId, "⏳ Testingiz tekshiruvga yuborildi. Unda bot qoidalariga to'g'ri kelmaydigan so'zlar bor bo'lishi mumkin.\n" +
        "Muallif ko'rib chiqqach, test ochiladi. Nojo'ya (erotik, noqonuniy) mazmundagi testlar uchun bot bloklanadi.");
      return this.reportToAdmin(quiz, "🚨 <b>Shubhali test (avtomatik filtr)</b>", `🔎 Topilgan so'z: <code>${esc(bad)}</code>\n`);
    }
    const c = await cardContent(this.env, quiz, { owner: true, takers: 0, author });
    await this.edit(msgId, "👍 Test yaratildi! Endi uni yechishingiz, guruhda o'tkazishingiz yoki ulashishingiz mumkin." +
      (author ? "\n🔒 Hozircha faqat sizga ko'rinadi. Obunachilarga ko'rsatish uchun «🌐 Hammaga ko'rsatish» ni bosing."
        : this.env.TESTS_CHANNEL ? "\n📢 Testni kanalimizga joylashni xohlasangiz, «📢 Kanalga joylash» tugmasini bosing — muallif tasdiqlagach kanalda chiqadi." : ""));
    await this.send(c.text, { reply_markup: c.reply_markup });
    return this.againButton();
  }

  // Bir nechta qismli testlarni bir yo'la yaratish
  async finishSplit(create, uid, msgId, from) {
    const store = this.store();
    const author = this.isAuthor(from);
    if (author) await store.setSetting("authorId", String(uid));
    const n = create.pairs.length;
    const order = create.split.order === "rnd" ? shuffle([...create.pairs.keys()]) : [...create.pairs.keys()];
    const sizes = splitSizes(n, create.split.size);
    const direction = create.mcq ? "mcq" : create.direction || "fwd";
    const made = [];
    let pos = 0, pending = 0;
    for (let k = 0; k < sizes.length; k++) {
      const idx = order.slice(pos, pos + sizes[k]);
      pos += sizes[k];
      let questions;
      if (create.mcq) {
        questions = idx.sort((a, b) => a - b).map((i) => create.pairs[i]).map((q) => ({ q: q.q, opts: q.opts.map((o) => o || "—"), correct: q.correct,
          pair: [q.q.length > 80 ? q.q.slice(0, 77) + "…" : q.q, q.opts[q.correct]],
          ...(q.img ? { img: q.img } : {}), ...(q.exp ? { exp: q.exp.slice(0, EXP_MAX) } : {}) }));
      } else {
        const part = idx.map((i) => create.pairs[i]);
        questions = buildQuestions(part, part.length, direction, create.pairs, true);
      }
      const title = `${create.title} (${k + 1}-qism)`.slice(0, 100);
      const id = await store.saveQuiz({ owner: uid, title, description: create.description || "",
        pairs: create.mcq ? [] : idx.map((i) => create.pairs[i]), direction, timer: create.timer, shuffle: create.shuffle, questions });
      const bad = author ? null : badWord(quizTexts({ title, description: create.description, questions }));
      if (bad) { await store.setStatus(id, "pending"); pending++; if (pending === 1) await this.reportToAdmin(await store.getQuiz(id), "🚨 <b>Shubhali test (avtomatik filtr)</b>", `🔎 Topilgan so'z: <code>${esc(bad)}</code>\n`); }
      made.push({ id, title, n: questions.length, bad: !!bad });
    }
    await this.st.delete("create");
    const text = `👍 <b>${made.length} ta test yaratildi!</b>\n<b>${esc(create.title)}</b> — ${n} ta ${create.mcq ? "savol" : "so'z"}, ` +
      `${create.split.order === "rnd" ? "aralashtirib" : "fayldagi tartibda"} bo'lindi.\n\n` +
      made.slice(0, 30).map((m) => `${m.bad ? "⏳" : "🎲"} ${esc(m.title)} — ${m.n} ta savol`).join("\n") +
      (made.length > 30 ? `\n… va yana ${made.length - 30} ta (hammasi 📚 Testlarim'da)` : "") +
      (pending ? `\n\n⏳ ${pending} ta qism tekshiruvga yuborildi (muallif ko'rib chiqadi).` : "") +
      (author ? "\n\n🔒 Hozircha faqat sizga ko'rinadi. Har bir testni ochib «🌐 Hammaga ko'rsatish» ni bosishingiz mumkin."
        : this.env.TESTS_CHANNEL ? "\n\n📢 Kanalga joylash uchun testni ochib «📢 Kanalga joylash» ni bosing — muallif tasdiqlagach kanalda chiqadi." : "") +
      "\n\nTestni ochish uchun bosing 👇";
    const rows = made.filter((m) => !m.bad).map((m) => [btn(`🎲 ${m.title} · ${m.n}`.slice(0, 60), `open:${m.id}`)]);
    await this.edit(msgId, text, { reply_markup: kb(rows) });
    return this.againButton();
  }

  async catalog(page = 0, editId) {
    const store = this.store();
    const aid = +((await store.getSetting("authorId")) || 0);
    const total = aid ? await store.countByOwner(aid) : 0;
    if (!total) return this.send("🗂 Muallif testlari hali joylanmagan. Tez orada qo'shiladi!");
    const per = 10, pages = Math.ceil(total / per);
    page = Math.min(Math.max(0, page), pages - 1);
    const rows = (await store.catalog(aid, page * per, per)).map((r) => [btn(`🎲 ${r.title} · ${r.count} savol`, `open:${r.id}`)]);
    const nav = [];
    if (page > 0) nav.push(btn("⬅️ Oldingi", `cat:${page - 1}`));
    if (page < pages - 1) nav.push(btn("Keyingi ➡️", `cat:${page + 1}`));
    rows.push(nav);
    const text = `🗂 <b>Muallif testlari</b> (${total} ta)${pages > 1 ? ` — ${page + 1}/${pages}-sahifa` : ""}\n\nTestni tanlang:`;
    return editId ? this.edit(editId, text, { reply_markup: kb(rows) }) : this.send(text, { reply_markup: kb(rows) });
  }

  // Yangi testni testlar kanaliga joylash
  async postToChannel(quiz, from) {
    const ch = this.env.TESTS_CHANNEL;
    if (!ch) return;
    const me = await botName(this.env);
    const n = quiz.questions?.length || quiz.count;
    const byAuthor = this.isAuthor(from);
    const who = byAuthor ? "⭐ Muallif testi" : `👤 Tuzuvchi: ${esc([from.first_name, from.last_name].filter(Boolean).join(" ") || "obunachi")}`;
    let text = `🎲 <b>${esc(quiz.title)}</b>\n`;
    if (quiz.description) text += `<i>${esc(quiz.description)}</i>\n`;
    text += `\n🖊 ${n} ta savol\n⏱ Har bir savolga ${timerLabel(quiz.timer)}\n${who}`;
    const r = await this.tgx("sendMessage", { chat_id: ch, text, parse_mode: "HTML",
      reply_markup: kb([[{ text: "▶️ Testni boshlash", url: `https://t.me/${me}?start=${quiz.id}` }],
        [{ text: "👥 Guruhda boshlash", url: `https://t.me/${me}?startgroup=${quiz.id}` }]]) });
    if (r.ok) await this.store().setChanMsg(quiz.id, r.result.message_id);
    return r;
  }

  async myTests(owner, page = 0, editId) {
    const PER = 10;
    const store = this.store();
    const total = await store.countQuizzes(owner);
    if (!total) {
      const t = "Hali test yo'q. Faylni yuboring yoki /newquiz 📄";
      return editId ? this.edit(editId, t, { reply_markup: kb([]) }) : this.send(t);
    }
    const pages = Math.ceil(total / PER);
    page = Math.min(Math.max(0, page), pages - 1);
    const rows = await store.listQuizzes(owner, page * PER, PER);
    const author = this.isAuthor(this.from);
    const kbRows = [];
    for (const r of rows) {
      const live = author ? r.public : r.chanMsg;
      const mark = r.status === "pending" ? "⏳" : live ? "📢" : r.chanReq ? "🕓" : "🎲";
      kbRows.push([btn(`${mark} ${r.title} · ${r.count} savol`.slice(0, 64), `open:${r.id}`)]);
      const act = r.status === "pending" ? null
        : author ? btn(r.public ? "🔒 Kanaldan yashirish" : "📢 Kanalga chiqarish", `pub:${r.id}:${page}`)
        : btn(r.chanMsg ? "🔕 Kanaldan olib tashlash" : r.chanReq ? "↩️ So'rovni bekor qilish" : "📢 Kanalga chiqarish", `chan:${r.id}:${page}`);
      kbRows.push(act ? [act, btn("🗑 O'chirish", `mdel:${r.id}:${page}`)] : [btn("🗑 O'chirish", `mdel:${r.id}:${page}`)]);
    }
    const nav = [];
    if (page > 0) nav.push(btn("⬅️ Oldingi", `mypg:${page - 1}`));
    if (page < pages - 1) nav.push(btn("Keyingi ➡️", `mypg:${page + 1}`));
    if (nav.length) kbRows.push(nav);
    kbRows.push([btn(author ? "📢 Hammasini kanalga chiqarish" : "📢 Hammasini kanalga so'rash", "mbulk:pub"), btn(author ? "🔒 Hammasini yashirish" : "🔕 Hammasini kanaldan olish", "mbulk:hide")]);
    kbRows.push([btn(`🗑 Hammasini o'chirish (${total})`, "mdall")]);
    const text = `📚 <b>Sizning testlaringiz</b> (${total} ta)` + (pages > 1 ? ` — ${page + 1}/${pages}-sahifa` : "") +
      "\n\nTestni ochish uchun nomini bosing. Ostidagi tugmalar: 📢 kanalga chiqarish / yashirish, 🗑 o'chirish." +
      `\n<i>📢 — kanalda${this.isAuthor(this.from) ? " (hammaga ochiq)" : ""}${this.isAuthor(this.from) ? "" : " · 🕓 — muallif tasdig'ini kutmoqda"} · 🎲 — faqat sizda</i>`;
    return editId ? this.edit(editId, text, { reply_markup: kb(kbRows) }) : this.send(text, { reply_markup: kb(kbRows) });
  }

  // ---------- O'qituvchi hisoboti ----------
  async isGroupAdmin(chat, uid) {
    if (this.isAuthor(this.from)) return true;
    const m = await this.tgx("getChatMember", { chat_id: chat, user_id: uid });
    return ["administrator", "creator"].includes(m.result?.status);
  }
  async reportHome(uid, editId) {
    const groups = await this.store().groupsOf(uid);
    const text = groups.length ? "📊 <b>O'qituvchi hisoboti</b>\n\nQaysi guruh bo'yicha?\n<i>Hisobotni faqat guruh adminlari ko'ra oladi.</i>"
      : "📊 <b>O'qituvchi hisoboti</b>\n\nHali guruhda test o'tkazilmagan.\nTestni guruhda «👥 Guruhda boshlash» orqali o'tkazing — natijalar shu yerda yig'iladi. Guruhning o'zida /hisobot yozsangiz ham bo'ladi.";
    const rows = groups.map((g) => [btn(`👥 ${g.title || g.chat} · ${g.n} ta test`.slice(0, 60), `hr:g:${g.chat}:0`)]);
    return editId ? this.edit(editId, text, { reply_markup: kb(rows) }) : this.send(text, { reply_markup: kb(rows) });
  }
  async reportGroup(chat, page, editId) {
    const PER = 10;
    const r = await this.store().groupGames(chat, page * PER, PER);
    const pages = Math.max(1, Math.ceil(r.total / PER));
    const text = `📊 <b>${esc(r.title || "Guruh")}</b>\n\n🎲 O'tkazilgan testlar: ${r.total}` + (pages > 1 ? ` — ${page + 1}/${pages}-sahifa` : "") +
      "\n\nTestni tanlang — kim qatnashgani, ballar va eng ko'p xato qilingan so'zlar chiqadi.";
    const rows = r.rows.map((g) => [btn(`${fmtDate(g.created).slice(0, 5)} · ${g.title} · 👥${g.players}`.slice(0, 60), `hr:d:${g.id}`)]);
    const nav = [];
    if (page > 0) nav.push(btn("⬅️ Oldingi", `hr:g:${chat}:${page - 1}`));
    if (page < pages - 1) nav.push(btn("Keyingi ➡️", `hr:g:${chat}:${page + 1}`));
    if (nav.length) rows.push(nav);
    rows.push([btn("👤 O'quvchilar bo'yicha hisobot", `hr:s:${chat}`)], [btn("⬅️ Guruhlar", "hr:home")]);
    return editId ? this.edit(editId, text, { reply_markup: kb(rows) }) : this.send(text, { reply_markup: kb(rows) });
  }
  async reportGame(id, editId) {
    const r = await this.store().gameReport(+id);
    if (!r) return this.edit(editId, "❗ Hisobot topilmadi.");
    const { g, scores, words } = r;
    const medals = ["🥇", "🥈", "🥉"];
    let text = `🎲 <b>${esc(g.title)}</b>\n👥 ${esc(g.chatTitle)} · ${fmtDate(g.created)}\n🖊 ${g.asked} ta savol · 👤 ${scores.length} ta qatnashchi\n\n<b>Natijalar:</b>\n` +
      scores.slice(0, 40).map((u, i) => `${medals[i] || i + 1 + "."} ${esc(u.name)} — <b>${u.ok}</b>/${g.asked} (${Math.round(u.ok * 100 / Math.max(g.asked, 1))}%), ❌ ${u.bad}`).join("\n");
    if (scores.length > 40) text += `\n… yana ${scores.length - 40} kishi`;
    if (words.length) text += "\n\n<b>Eng ko'p xato qilingan so'zlar:</b>\n" +
      words.map((w) => `• ${esc(w.q)} → <i>${esc(w.ans)}</i> — ${w.wrong}/${w.total} kishi xato (${Math.round(w.wrong * 100 / w.total)}%)`).join("\n");
    else text += "\n\n✅ Hech bir so'zda xato bo'lmadi.";
    return this.edit(editId, text.slice(0, 4000), { reply_markup: kb([[btn("⬅️ Orqaga", `hr:g:${g.chat}:0`)]]) });
  }
  async reportStudents(chat, editId) {
    const rows = await this.store().groupStudents(chat);
    let text = "👤 <b>O'quvchilar bo'yicha hisobot</b>\n<i>Guruhdagi testlar · botdagi barcha testlari · takrorlash</i>\n\n";
    text += rows.length ? rows.map((r, i) => `${i + 1}. <b>${esc(r.name)}</b>\n   👥 Guruhda: ${r.games} ta test, ${Math.round(r.ok * 100 / Math.max(r.asked, 1))}% to'g'ri` +
      `\n   📚 Jami yechgan testlari: ${r.solo} ta${r.soloAvg != null ? `, o'rtacha ${r.soloAvg}% (eng yaxshi urinishlar)` : ""}` +
      `\n   🧠 Takrorlash: ${r.review} ta so'z${r.due ? ` (bugun ${r.due})` : ""}, ✅ o'zlashtirgan: ${r.mastered}`).join("\n") : "Hali ma'lumot yo'q.";
    return this.edit(editId, text.slice(0, 4000), { reply_markup: kb([[btn("⬅️ Orqaga", `hr:g:${chat}:0`)]]) });
  }

  // Takrorlash: o'quvchining barcha testlardagi xatolaridan bitta umumiy test
  async reviewMenu(uid, editId) {
    const r = await this.store().reviewSummary(uid);
    let text, rows = [];
    if (!r.total) {
      text = "🧠 <b>Takrorlash</b>\n\nHozircha ro'yxatingiz bo'sh.\nQaysi testni yechmang, xato qilgan so'zlaringiz shu yerga — bitta umumiy ro'yxatga tushadi. Bot ularni 1, 3 va 7 kundan keyin qayta so'raydi. 3 marta to'g'ri topilgan so'z «✅ o'zlashtirildi» bo'lib ro'yxatdan chiqadi.";
    } else {
      text = `🧠 <b>Takrorlash</b>\n\n📋 Ro'yxatingizda: <b>${r.total}</b> ta so'z\n` +
        (r.due ? `📅 Bugun takrorlash kerak: <b>${r.due}</b> ta so'z` : `✅ Bugun uchun takrorlash yo'q.${r.next ? `\n⏭ Keyingi takrorlash: ${fmtDate(r.next)}` : ""}`) +
        (r.due > REVIEW_MAX ? `\n<i>Bir martada ${REVIEW_MAX} tadan so'raladi.</i>` : "");
      if (r.due) rows.push([btn(`▶️ Takrorlashni boshlash (${Math.min(r.due, REVIEW_MAX)})`, "rv:due")]);
      else rows.push([btn(`🔁 Hozir mashq qilish (${Math.min(r.total, REVIEW_MAX)})`, "rva:all")]);
    }
    return editId ? this.edit(editId, text, { reply_markup: kb(rows) }) : this.send(text, { reply_markup: kb(rows) });
  }
  async startReview(uid, all, msgId) {
    const items = await this.store().reviewItems(uid, !all);
    if (!items.length) return this.reviewMenu(uid, msgId);
    return this.prepareSession({ id: "review", title: "Umumiy takrorlash", description: "", timer: 30, shuffle: "all", questions: items },
      uid, "private", { record: false, review: !all });
  }

  async showCard(quiz, uid, editId) {
    const owner = quiz.owner === uid;
    const isAdmin = String(uid) === String(await this.store().getSetting("authorId"));
    if (quiz.status === "pending" && !isAdmin)
      return this.send(owner ? "⏳ Bu test hali tekshiruvda. Muallif ko'rib chiqqach ochiladi." : "❗ Test topilmadi yoki o'chirilgan.");
    const takers = owner ? await this.store().takers(quiz.id) : null;
    const author = owner && String(uid) === String(await this.store().getSetting("authorId"));
    const c = await cardContent(this.env, quiz, { owner, takers, author });
    if (!owner && isAdmin) c.reply_markup.inline_keyboard.push(
      [btn("🗑 Admin: o'chirish", `mod:del:${quiz.id}`), btn("🚫 Tuzuvchini bloklash", `mod:ban:${quiz.id}`)]);
    else if (!owner && String(quiz.owner) !== String(await this.store().getSetting("authorId")))
      c.reply_markup.inline_keyboard.push([btn("⚠️ Shikoyat qilish", `rep:${quiz.id}`)]);
    return editId ? this.edit(editId, c.text, { reply_markup: c.reply_markup }) : this.send(c.text, { reply_markup: c.reply_markup });
  }

  async openQuiz(id, from, chatType) {
    const quiz = await this.store().getQuiz(id);
    if (!quiz || (quiz.status === "pending" && chatType !== "private")) return this.send("❗ Test topilmadi yoki o'chirilgan.");
    if (chatType === "private") return this.showCard(quiz, from.id);
    if (!(await this.isMember(from.id))) {
      return this.send(`📢 Testni boshlash uchun avval kanallarimizga a'zo bo'ling.`, { reply_markup: kb(joinRows(this.env)) });
    }
    return this.prepareSession(quiz, from.id, chatType);
  }

  // ---------- Tahrirlash ----------
  async editMenu(quiz, msgId) {
    const text = `✏️ <b>${esc(quiz.title)}</b> — nimani o'zgartiramiz?`;
    const reply_markup = kb([
      [btn("✏️ Nomi", `ef:title:${quiz.id}`), btn("📝 Tavsif", `ef:desc:${quiz.id}`)],
      [btn("⏱ Vaqt", `ef:timer:${quiz.id}`), btn("🔀 Aralashtirish", `ef:shuf:${quiz.id}`)],
      [btn("🖼 Savollarga rasm va izoh", `qe:${quiz.id}:0`)],
      [btn("🗑 O'chirish", `del:${quiz.id}`)],
      [btn("⬅️ Orqaga", `open:${quiz.id}`)],
    ]);
    return this.edit(msgId, text, { reply_markup });
  }

  async questionList(quiz, page, msgId) {
    const qs = quiz.questions || [];
    const per = 8, pages = Math.max(1, Math.ceil(qs.length / per));
    page = Math.min(Math.max(0, page), pages - 1);
    const rows = qs.slice(page * per, page * per + per).map((q, k) => {
      const i = page * per + k;
      const icons = (q.img ? "🖼" : "") + (q.exp ? "💬" : "");
      return [btn(`${i + 1}. ${icons ? icons + " " : ""}${q.q}`.slice(0, 60), `qs:${quiz.id}:${i}`)];
    });
    const nav = [];
    if (page > 0) nav.push(btn("⬅️", `qe:${quiz.id}:${page - 1}`));
    if (page < pages - 1) nav.push(btn("➡️", `qe:${quiz.id}:${page + 1}`));
    rows.push(nav, [btn("⬅️ Orqaga", `edit:${quiz.id}`)]);
    const text = `🖼 <b>Rasm va izohlar</b> — ${esc(quiz.title)}${pages > 1 ? ` (${page + 1}/${pages})` : ""}\n\n` +
      "Savolni tanlang. 🖼 — rasmi bor, 💬 — izohi bor.\nIzoh javob berilgandan keyin 💡 belgisi ostida ko'rinadi.";
    return msgId ? this.edit(msgId, text, { reply_markup: kb(rows) }) : this.send(text, { reply_markup: kb(rows) });
  }
  async questionView(id, idx, uid, msgId) {
    const quiz = await this.store().getQuiz(id);
    const q = quiz?.questions?.[idx];
    if (!q || quiz.owner !== uid) return this.send("❗ Savol topilmadi.");
    const L = "ABCDEFGHIJ";
    const text = `<b>${idx + 1}-savol:</b> ${esc(q.q)}\n\n` + q.opts.map((o, k) => `${k === q.correct ? "✅" : "▫️"} ${L[k]}) ${esc(o)}`).join("\n") +
      `\n\n🖼 Rasm: ${q.img ? "bor" : "yo'q"}\n💬 Izoh: ${q.exp ? esc(q.exp) : "yo'q"}`;
    const rows = [[btn(q.img ? "🖼 Rasmni almashtirish" : "🖼 Rasm qo'shish", `qa:img:${id}:${idx}`),
      btn(q.exp ? "💬 Izohni o'zgartirish" : "💬 Izoh yozish", `qa:exp:${id}:${idx}`)]];
    const rm = [];
    if (q.img) rm.push(btn("👁 Rasmni ko'rish", `qa:see:${id}:${idx}`), btn("🗑 Rasm", `qa:rmimg:${id}:${idx}`));
    if (q.exp) rm.push(btn("🗑 Izoh", `qa:rmexp:${id}:${idx}`));
    rows.push(rm, [btn("⬅️ Savollar ro'yxati", `qe:${id}:${Math.floor(idx / 8)}`)]);
    return msgId ? this.edit(msgId, text, { reply_markup: kb(rows) }) : this.send(text, { reply_markup: kb(rows) });
  }

  async onEditText(ed, text, uid, from = { id: uid }) {
    if (ed.field === "qimg") return this.send("🖼 Rasm yuboring (rasm sifatida, fayl emas) yoki /cancel");
    if (ed.field === "qexp") {
      const v = text.trim();
      if (v.length > EXP_MAX) return this.send(`❗ Izoh ${EXP_MAX} belgidan oshmasin (hozir ${v.length}). Qisqaroq yozing.`);
      if (await this.rejectLinks([v])) return;
      if (!this.isAuthor(from) && badWord([v])) return this.send("❗ Bu matnda bot qoidalariga to'g'ri kelmaydigan so'z bor. Boshqacha yozing.");
      await this.st.delete("edit");
      await this.store().updateQuestion(ed.id, uid, ed.idx, { exp: v === "-" ? null : v });
      await this.send("✅ Izoh saqlandi.");
      return this.questionView(ed.id, ed.idx, uid);
    }
    await this.st.delete("edit");
    const field = ed.field === "title" ? "title" : "description";
    const value = text.trim() === "/skip" || text.trim() === "-" ? "" : text.trim().slice(0, field === "title" ? 100 : 300);
    if (field === "title" && !value) return this.send("Nom bo'sh bo'lishi mumkin emas.");
    if (await this.rejectLinks([value])) return;
    if (!this.isAuthor(from) && badWord([value]))
      return this.send("❗ Bu matnda bot qoidalariga to'g'ri kelmaydigan so'z bor. Boshqacha yozing.");
    const store = this.store();
    await store.updateQuiz(ed.id, uid, field, value);
    await this.send("✅ Saqlandi.");
    const quiz = await store.getQuiz(ed.id);
    if (quiz) return this.showCard(quiz, uid);
  }

  // ---------- Tugmalar ----------
  async onCallback(cq) {
    const data = cq.data || "";
    const msgId = cq.message.message_id;
    const uid = cq.from.id;
    const answer = (text, alert = false) =>
      this.tgx("answerCallbackQuery", { callback_query_id: cq.id, text, show_alert: alert });
    const i = data.indexOf(":");
    const [kind, val] = i < 0 ? [data, ""] : [data.slice(0, i), data.slice(i + 1)];
    const store = this.store();

    if (kind === "ad" || kind === "admode" || kind === "adgo" || kind === "adrm" || kind === "adrmok" || kind === "adre" || kind === "adq") {
      if (!this.isAuthor(cq.from)) return answer();
      const caster = this.env.CASTER.get(this.env.CASTER.idFromName("main"));
      if (kind === "ad" && val === "menu") { await answer(); return this.adMenu(msgId); }
      if (kind === "ad" && val === "new") {
        await this.st.put("awaitAd", true);
        await answer();
        return this.send("📝 Reklama postini yuboring: matn, rasm, video, GIF, albom yoki fayl.\nTugmali post kerak bo'lsa — kanaldan forward qiling.\nBekor qilish: /cancel");
      }
      if (kind === "ad" && val === "cancel") {
        await this.st.delete("adDraft");
        await answer("Bekor qilindi");
        return this.edit(msgId, "❌ Reklama bekor qilindi.");
      }
      if (kind === "admode") {
        const d = await this.st.get("adDraft");
        if (!d) return answer("Postni qayta yuboring: /reklama", true);
        await answer();
        const days = [1, 3, 7, 30];
        return this.edit(msgId, `${val === "pin" ? "📌 Qadab" : "📤 Post qilib"} yuboriladi.\n\n⏳ Reklama qancha vaqt tursin? Muddat tugagach u barcha chatlardan o'zi olib tashlanadi.`,
          { reply_markup: kb([days.map((d) => btn(`${d} kun`, `adgo:${val}:${d}`)), [btn("♾ Muddatsiz", `adgo:${val}:0`)], [btn("❌ Bekor qilish", "ad:cancel")]]) });
      }
      if (kind === "adgo") {
        const [mode, daysStr] = val.split(":");
        const d = await this.st.get("adDraft");
        if (!d) return answer("Postni qayta yuboring: /reklama", true);
        await this.st.delete("adDraft");
        const days = parseInt(daysStr, 10) || 0;
        const id = await store.addAd({ fromChat: d.fromChat, msgIds: d.msgIds, pin: mode === "pin", title: d.title,
          expires: days ? Date.now() + days * 86400e3 : null });
        const pos = await caster.enqueue({ type: "send", ad: id, admin: this.chatId });
        await answer("Navbatga qo'shildi!");
        return this.edit(msgId, `✅ «${esc(d.title)}» reklamasi ${pos > 1 ? `navbatga qo'shildi (${pos}-o'rinda)` : "tarqatilmoqda"}.` +
          `\n${mode === "pin" ? "📌 Qadaladi." : "📤 Post qilib yuboriladi."} ⏳ ${days ? `${days} kun (${fmtDate(Date.now() + days * 86400e3)} gacha)` : "Muddatsiz"}` +
          "\nTugagach xabar beraman. Boshqaruv: /reklama");
      }
      if (kind === "adre") {
        const ad = await store.getAd(+val);
        if (!ad || !ad.active) return answer("Reklama faol emas", true);
        const pos = await caster.enqueue({ type: "send", ad: ad.id, admin: this.chatId });
        await answer("Navbatga qo'shildi");
        return this.send(`📤 «${esc(ad.title)}» hali olmaganlarga qayta yuborilmoqda${pos > 1 ? ` (navbatda ${pos}-o'rinda)` : ""}. Olganlarga takror bormaydi. Tugagach xabar beraman.`);
      }
      if (kind === "adq") {
        await caster.clearQueue();
        await answer("🧹 Tozalandi");
        return this.send("🧹 Reklama navbati tozalandi. Endi «📤 yetmaganlarga yuborish» ni bosing: /adcheck");
      }
      if (kind === "adrm") {
        const ad = await store.getAd(+val);
        if (!ad || !ad.active) { await answer("Bu reklama allaqachon o'chirilgan"); return this.adMenu(msgId); }
        await answer();
        return this.edit(msgId, `🗑 «${esc(ad.title)}» reklamasini barcha chatlardan olib tashlaymizmi?`,
          { reply_markup: kb([[btn("Ha, olib tashlash", `adrmok:${ad.id}`), btn("Yo'q", "ad:menu")]]) });
      }
      if (kind === "adrmok") {
        const ad = await store.getAd(+val);
        if (!ad || !ad.active) return answer("Allaqachon o'chirilgan", true);
        await store.deactivateAd(ad.id);
        await caster.enqueue({ type: "remove", ad: ad.id, admin: this.chatId, reason: "siz o'chirdingiz" });
        await answer("O'chirilmoqda…");
        return this.adMenu(msgId);
      }
    }

    if (kind === "rep") {
      const quiz = await store.getQuiz(val);
      if (!quiz) return answer("Test topilmadi", true);
      if (await this.st.get("rep:" + quiz.id)) return answer("Siz bu test haqida allaqachon xabar bergansiz", true);
      await this.st.put("rep:" + quiz.id, 1);
      const who = [cq.from.first_name, cq.from.last_name].filter(Boolean).join(" ");
      await this.reportToAdmin(quiz, "⚠️ <b>Foydalanuvchi shikoyati</b>",
        `📣 Shikoyatchi: <a href="tg://user?id=${uid}">${esc(who || uid)}</a>\n`);
      return answer("✅ Rahmat! Shikoyatingiz muallifga yuborildi.", true);
    }

    if (kind === "mod") {
      if (String(uid) !== String(await store.getSetting("authorId"))) return answer();
      const [act, qid] = val.split(":");
      const quiz = await store.getQuiz(qid);
      if (!quiz) { await answer("Test allaqachon o'chirilgan"); return; }
      if (act === "ok") {
        await store.setStatus(quiz.id, "ok");
        await answer("✅ Ruxsat berildi");
        await this.tgx("sendMessage", { chat_id: quiz.owner, text: `✅ «${esc(quiz.title)}» testingiz tekshiruvdan o'tdi. Endi uni ishlatishingiz va xohlasangiz kanalga joylashingiz mumkin: /mytests`, parse_mode: "HTML" });
        return this.edit(msgId, `✅ «${esc(quiz.title)}» — ruxsat berildi.`);
      }
      if (act === "del") {
        const post = await store.adminDeleteQuiz(quiz.id);
        if (post && this.env.TESTS_CHANNEL) await this.tgx("deleteMessage", { chat_id: this.env.TESTS_CHANNEL, message_id: post });
        await this.tgx("sendMessage", { chat_id: quiz.owner, text: `🗑 «${esc(quiz.title)}» testingiz bot qoidalariga zid bo'lgani uchun o'chirildi.`, parse_mode: "HTML" });
        await answer("🗑 O'chirildi");
        return this.edit(msgId, `🗑 «${esc(quiz.title)}» — o'chirildi.`);
      }
      if (act === "ban") {
        if (String(quiz.owner) === String(uid)) return answer("O'zingizni bloklay olmaysiz", true);
        const res = await this.banUser(quiz.owner, "", `«${quiz.title}»`);
        await answer("🚫 Bloklandi");
        return this.edit(msgId, `🚫 Foydalanuvchi <code>${quiz.owner}</code> bloklandi.\n🗑 Uning ${res.quizzes} ta testi o'chirildi.\nBlokdan chiqarish: <code>/unban ${quiz.owner}</code>`);
      }
      return answer();
    }

    if (kind === "langmenu") { await answer(); return this.langPicker(msgId); }

    if (kind === "deldata") {
      await answer();
      if (val === "ok") {
        const res = await store.deleteUserData(uid);
        if (this.env.TESTS_CHANNEL)
          for (const mid of res.posts) await this.tgx("deleteMessage", { chat_id: this.env.TESTS_CHANNEL, message_id: mid });
        for (const k of ["sess", "create", "edit", "retry", "reg", "awaitAd", "adDraft", "awaitMat", "pendingStart"]) await this.st.delete(k);
        return this.edit(msgId, `✅ Ma'lumotlaringiz o'chirildi.\n🎲 O'chirilgan testlar: ${res.quizzes}\n\nBotdan yana foydalanishingiz mumkin — /start`);
      }
      if (val !== "no")
        return this.edit(msgId, "🗑 <b>Ma'lumotlaringizni o'chirasizmi?</b>\n\nBotdagi barcha testlaringiz (kanaldagi postlari bilan), natijalaringiz va reytingdagi o'rningiz butunlay o'chiriladi. Buni qaytarib bo'lmaydi.",
          { reply_markup: kb([[btn("Ha, o'chirish", "deldata:ok"), btn("Yo'q", "deldata:no")]]) });
      return this.settingsMenu(msgId);
    }

    if (kind === "chan") {
      const [cqid, cpg] = val.split(":");
      const quiz = await store.getQuiz(cqid);
      if (!quiz || quiz.owner !== uid) return answer("Faqat test egasi uchun", true);
      if (quiz.status === "pending") return answer("⏳ Test tekshiruvda", true);
      if (!this.env.TESTS_CHANNEL) return answer("Kanal sozlanmagan", true);
      if (quiz.chanMsg) {
        await this.tgx("deleteMessage", { chat_id: this.env.TESTS_CHANNEL, message_id: quiz.chanMsg });
        await store.setChanMsg(quiz.id, null);
        await answer("🔕 Kanaldan olib tashlandi");
      } else if (quiz.chanReq) {
        await store.setChanReq(quiz.id, null);
        await answer("↩️ So'rov bekor qilindi");
      } else {
        const name = [cq.from.first_name, cq.from.last_name].filter(Boolean).join(" ") || "obunachi";
        await store.setChanReq(quiz.id, name);
        const admin = await this.adminChat();
        if (admin) {
          const n = quiz.questions?.length || quiz.count;
          const sample = (quiz.questions || []).slice(0, 5).map((q, i) => `${i + 1}. ${esc(q.q.slice(0, 100))} — <i>${esc(String(q.opts?.[q.correct] ?? "").slice(0, 60))}</i>`).join("\n");
          await this.tgx("sendMessage", { chat_id: admin, parse_mode: "HTML",
            text: `📢 <b>Kanalga chiqarish so'rovi</b>\n\n🎲 <b>${esc(quiz.title)}</b>\n` + (quiz.description ? `<i>${esc(quiz.description)}</i>\n` : "") +
              `🖊 ${n} ta savol\n👤 Tuzuvchi: ${esc(name)}${cq.from.username ? ` (@${esc(cq.from.username)})` : ""}\n\n<b>Savollardan namuna:</b>\n${sample}`,
            reply_markup: kb([[btn("✅ Kanalga chiqarish", `chq:ok:${quiz.id}`), btn("❌ Rad etish", `chq:no:${quiz.id}`)], [btn("👁 Testni ochish", `open:${quiz.id}`)]]) });
        }
        await answer("📨 So'rov muallifga yuborildi. Tasdiqlangach test kanalda chiqadi.", true);
      }
      if (cpg !== undefined) return this.myTests(uid, +cpg || 0, msgId);
      return this.showCard(await store.getQuiz(quiz.id), uid, msgId);
    }
    if (kind === "chq") {
      if (String(uid) !== String(await store.getSetting("authorId"))) return answer();
      const [act, qid] = val.split(":");
      const quiz = await store.getQuiz(qid);
      if (!quiz) { await answer("Test o'chirilgan"); return this.edit(msgId, "🗑 Bu test o'chirilgan."); }
      if (!quiz.chanReq) { await answer("So'rov bekor qilingan yoki ko'rib chiqilgan"); return this.edit(msgId, `ℹ️ «${esc(quiz.title)}» bo'yicha so'rov allaqachon yopilgan.`); }
      const who = quiz.chanReq;
      await store.setChanReq(quiz.id, null);
      if (act === "ok") {
        if (!quiz.chanMsg) await this.postToChannel(quiz, { id: quiz.owner, first_name: who });
        await this.tgx("sendMessage", { chat_id: quiz.owner, parse_mode: "HTML", text: `✅ «${esc(quiz.title)}» testingiz tasdiqlandi va testlar kanaliga chiqarildi!` });
        await answer("✅ Kanalga chiqarildi");
        return this.edit(msgId, `✅ «${esc(quiz.title)}» — kanalga chiqarildi (${esc(who)}).`);
      }
      await this.tgx("sendMessage", { chat_id: quiz.owner, parse_mode: "HTML", text: `❌ «${esc(quiz.title)}» testingizni kanalga chiqarish so'rovi rad etildi. Test botda o'zingizda qoladi.` });
      await answer("❌ Rad etildi");
      return this.edit(msgId, `❌ «${esc(quiz.title)}» — rad etildi (${esc(who)}).`);
    }

    if (kind === "pub") {
      const [pqid, ppg] = val.split(":");
      const quiz = await store.getQuiz(pqid);
      if (!quiz || quiz.owner !== uid || !this.isAuthor(cq.from)) return answer("Faqat muallif uchun", true);
      const on = !quiz.public;
      await store.setPublic(quiz.id, on);
      if (on) {
        await this.postToChannel(quiz, cq.from);
        await answer("🌐 Endi hammaga ko'rinadi va kanalga joylandi");
      } else {
        if (quiz.chanMsg && this.env.TESTS_CHANNEL) await this.tgx("deleteMessage", { chat_id: this.env.TESTS_CHANNEL, message_id: quiz.chanMsg });
        await store.setChanMsg(quiz.id, null);
        await answer("🔒 Obunachilardan yashirildi");
      }
      if (ppg !== undefined) return this.myTests(uid, +ppg || 0, msgId);
      return this.showCard(await store.getQuiz(quiz.id), uid, msgId);
    }

    if (kind === "lv" || kind === "ls" || kind === "bk") {
      const b = await this.st.get("book");
      if (!b) return answer("Faylni qayta yuboring", true);
      await answer();
      if (kind === "lv") return this.lessonMenu(val, msgId);
      if (kind === "bk" && val === "back") return this.levelMenu(msgId);
      if (kind === "ls") {
        const i = +val;
        return this.offerSections(b.all.filter((p) => p[3] === i), b.sections, b.lessons[i]?.name || b.title, msgId);
      }
      if (val === "all") return this.offerSections(b.all, b.sections, b.title, msgId);
      const idx = b.lessons.map((l, i) => (l.level === val ? i : -1)).filter((i) => i >= 0);
      return this.offerSections(b.all.filter((p) => idx.includes(p[3])), b.sections, `${b.title} — ${val}`, msgId);
    }

    if (kind === "g") {
      await answer();
      if (val === "getbot" || val === "getfmt") return this.sendGuide(val.slice(3));
      if (val === "bot" || val === "fmt") return this.isAuthor(cq.from) ? this.guideAdmin(val, msgId) : this.sendGuide(val);
      if (val === "smp") return this.samplesMenu(msgId);
      await this.st.delete("awaitMat");
      return this.guideMenu(msgId);
    }
    if (kind === "smp") {
      const list = await this.samples();
      await answer();
      if (val === "all") { for (const s of list) await this.sendSample(s); return; }
      const s = list[+val];
      return s ? this.sendSample(s) : this.samplesMenu(msgId);
    }
    if (kind === "mt") {
      if (!this.isAuthor(cq.from)) return answer("Faqat muallif uchun", true);
      const [act, arg] = val.split(":");
      const list = await this.samples();
      if (act === "set") {
        await this.st.put("awaitMat", arg);
        await answer();
        return this.send(arg === "guide" ? "📖 Yangi bot yo'riqnomasini (PDF) yuboring. Eskisi almashtiriladi.\nBekor qilish: /cancel"
          : "📘 Yangi «Test fayli qanday bo'lishi kerak» yo'riqnomasini (PDF) yuboring. Eskisi almashtiriladi.\nBekor qilish: /cancel");
      }
      if (act === "del") {
        await store.setSetting(arg, "");
        await answer("🗑 O'chirildi");
        return this.guideAdmin(arg === "fguide" ? "fmt" : "bot", msgId);
      }
      if (act === "rmask") {
        await answer();
        return this.edit(msgId, `⚠️ Barcha ${list.length} ta namuna o'chirilsinmi?`,
          { reply_markup: kb([[btn("🗑 Ha, o'chirish", "mt:rmall"), btn("⬅️ Yo'q", "g:smp")]]) });
      }
      if (act === "add") {
        await this.st.put("awaitMat", "smp");
        await answer();
        return this.send("🗂 Namuna fayllarni yuboring (bir nechtasini ketma-ket yuborsa bo'ladi).\nFayl izohiga (caption) nom yozsangiz — o'sha nom bilan chiqadi, aks holda fayl nomi olinadi.\nTugatish: «✅ Tayyor» yoki /cancel");
      }
      if (act === "done") {
        await this.st.delete("awaitMat");
        await answer("✅");
        return this.samplesMenu();
      }
      if (act === "rm") {
        const gone = list.splice(+arg, 1)[0];
        await store.setSetting("samples", JSON.stringify(list));
        await answer(gone ? "🗑 O'chirildi: " + gone.title.slice(0, 40) : "🗑");
        return this.samplesMenu(msgId);
      }
      if (act === "rmall") {
        await store.setSetting("samples", "[]");
        await answer("🗑 O'chirildi");
        return this.samplesMenu(msgId);
      }
      return answer();
    }

    if (kind === "cat") { await answer(); return this.catalog(parseInt(val, 10) || 0, msgId); }

    if (kind === "chk") {
      if (!(await this.isMember(uid))) return answer("❗ Siz hali kanalga a'zo bo'lmadingiz.", true);
      await answer("✅ Rahmat!");
      await this.edit(msgId, "✅ Rahmat! Endi botdan foydalanishingiz mumkin.");
      const pending = await this.st.get("pendingStart");
      if (pending) {
        await this.st.delete("pendingStart");
        return this.openQuiz(pending, cq.from, "private");
      }
      return this.sendHelp();
    }

    // Test yaratish
    if (["sec", "secp", "cnt", "dir", "ttl", "dsc", "tm", "shf", "spl", "spo"].includes(kind)) {
      const create = await this.st.get("create");
      if (!create) return answer("Faylni qayta yuboring", true);
      if (kind === "secp") {
        if (!create.all) return answer("Faylni qayta yuboring", true);
        await answer();
        return this.sectionPage(create, +val || 0, msgId);
      }
      if (kind === "sec") {
        if (!create.all) return answer("Faylni qayta yuboring", true);
        const nm = val === "all" ? null : create.secNames?.[+val];
        const pairs = uniqWords(create.all.filter((p) => !nm || p[2] === nm));
        await this.askCount(pairs, nm ? `${create.title} — ${nm}` : create.title, msgId);
        return answer();
      }
      if (!create.pairs) return answer("Faylni qayta yuboring", true);
      if (kind === "spl") {
        await answer();
        const n = create.pairs.length;
        if (val === "back") { delete create.split; return this.askCount(create.pairs, create.title, msgId, { mcq: create.mcq }); }
        if (val === "custom") {
          create.step = "splitcustom";
          await this.st.put("create", create);
          return this.edit(msgId, `✏️ Har bir qismda nechta savol bo'lsin? (2–${n - 1}) Raqam yozing:`);
        }
        const [t, v] = val.split(":");
        const size = t === "p" ? Math.ceil(n / Math.max(2, +v)) : Math.max(2, +v);
        create.split = { size };
        return this.askSplitOrder(create, msgId);
      }
      if (kind === "spo") {
        await answer();
        if (!create.split) return this.askSplit(create, msgId);
        create.split.order = val === "rnd" ? "rnd" : "seq";
        create.count = create.pairs.length;
        if (create.mcq) return this.askTitle(create, msgId);
        create.step = "dir";
        await this.st.put("create", create);
        return this.askDirection(msgId);
      }
      if (kind === "cnt") {
        if (val === "split") { await answer(); return this.askSplit(create, msgId); }
        if (val === "custom") {
          create.step = "custom";
          await this.st.put("create", create);
          await this.edit(msgId, `Nechta savol? (1–${create.pairs.length}) Raqam yozing:`);
        } else {
          create.count = Math.min(parseInt(val, 10), create.pairs.length);
          if (create.mcq) {
            await this.askTitle(create, msgId);
          } else {
            create.step = "dir";
            await this.st.put("create", create);
            await this.askDirection(msgId);
          }
        }
        return answer();
      }
      if (kind === "dir") {
        create.direction = DIRS[val] ? val : "fwd";
        await this.askTitle(create, msgId);
        return answer();
      }
      if (kind === "ttl") { await this.askDesc(create, msgId); return answer(); }
      if (kind === "dsc") { create.description = ""; await this.askTimer(create, msgId); return answer(); }
      if (kind === "tm") {
        create.timer = parseInt(val, 10) || 30;
        create.step = "shuffle";
        await this.st.put("create", create);
        await this.edit(msgId, "🔀 Savollar va javob variantlari aralashtirilsinmi?\n<i>Har safar boshqacha tartibda chiqadi.</i>",
          { reply_markup: shuffleKb("shf") });
        return answer();
      }
      if (kind === "shf") {
        if (!create.count || !create.timer) return answer("Faylni qayta yuboring", true);
        create.shuffle = SHUFFLE[val] ? val : "all";
        await answer("Test yaratildi!");
        return this.finishCreate(create, uid, msgId, cq.from);
      }
    }

    // Testlarim: ro'yxatdan o'chirish
    if (kind === "mypg") { await answer(); return this.myTests(uid, +val || 0, msgId); }
    if (kind === "mdel" || kind === "mdelok") {
      const [id, pg] = val.split(":");
      const quiz = await store.getQuiz(id);
      if (!quiz || quiz.owner !== uid) { await answer("Test topilmadi", true); return this.myTests(uid, +pg || 0, msgId); }
      if (kind === "mdel") {
        await answer();
        return this.edit(msgId, `🗑 <b>${esc(quiz.title)}</b> testini o'chirasizmi?\nNatijalar va testlar kanalidagi posti ham o'chadi.`,
          { reply_markup: kb([[btn("🗑 Ha, o'chirish", `mdelok:${id}:${pg}`), btn("⬅️ Yo'q", `mypg:${pg}`)]]) });
      }
      if (quiz.chanMsg && this.env.TESTS_CHANNEL) await this.tgx("deleteMessage", { chat_id: this.env.TESTS_CHANNEL, message_id: quiz.chanMsg });
      await store.deleteQuiz(id, uid);
      await answer("🗑 O'chirildi");
      return this.myTests(uid, +pg || 0, msgId);
    }
    // Hammasini kanalga chiqarish / kanaldan olish (avval tasdiq so'raladi)
    if (kind === "mbulk" || kind === "mbulkok") {
      await answer();
      const author = this.isAuthor(cq.from);
      const all = (await store.ownerQuizzes(uid)).filter((q) => q.status !== "pending");
      const pub = val === "pub";
      const todo = all.filter((q) => author ? (pub ? !q.public : q.public || q.chanMsg) : (pub ? !q.chanMsg && !q.chanReq : q.chanMsg || q.chanReq));
      if (!todo.length) return this.edit(msgId, pub ? "ℹ️ Hamma testlaringiz allaqachon kanalda" + (author ? "." : " yoki so'rov yuborilgan.") : "ℹ️ Kanalda testingiz yo'q.",
        { reply_markup: kb([[btn("⬅️ Testlarim", "mypg:0")]]) });
      if (kind === "mbulk") {
        const what = pub ? (author ? `${todo.length} ta testni kanalga chiqaraymi?` : `${todo.length} ta test uchun muallifga kanalga chiqarish so'rovi yuborilsinmi?`)
          : `${todo.length} ta testni kanaldan olaymi?` + (author ? " Ular «Muallif testlari»dan ham yashiriladi." : "");
        return this.edit(msgId, `${pub ? "📢" : "🔒"} ${what}`, { reply_markup: kb([[btn("✅ Ha", `mbulkok:${val}`), btn("⬅️ Yo'q", "mypg:0")]]) });
      }
      const ch = this.env.TESTS_CHANNEL;
      let done = 0, stopped = false;
      if (author && pub) {
        for (const q of todo) {
          const quiz = await store.getQuiz(q.id);
          const r = await this.postToChannel(quiz, cq.from);
          if (ch && !r?.ok) { stopped = true; break; }
          await store.setPublic(q.id, true);
          done++;
        }
      } else if (!author && pub) {
        const name = [cq.from.first_name, cq.from.last_name].filter(Boolean).join(" ") || "obunachi";
        for (const q of todo) await store.setChanReq(q.id, name);
        done = todo.length;
        const admin = await this.adminChat();
        if (admin) await this.tgx("sendMessage", { chat_id: admin, parse_mode: "HTML",
          text: `📢 <b>Kanalga chiqarish so'rovi — ${done} ta test</b>\n👤 ${esc(name)}${cq.from.username ? ` (@${esc(cq.from.username)})` : ""}\n\n` +
            todo.slice(0, 30).map((q, i) => `${i + 1}. ${esc(q.title)} — ${q.count} savol`).join("\n") + (todo.length > 30 ? `\n… yana ${todo.length - 30} ta` : ""),
          reply_markup: kb([[btn("✅ Hammasini tasdiqlash", `chqa:ok:${uid}`), btn("❌ Hammasini rad etish", `chqa:no:${uid}`)],
            ...todo.slice(0, 5).map((q) => [btn(`👁 ${q.title}`.slice(0, 60), `open:${q.id}`)])]) });
      } else {
        for (const q of todo) {
          if (q.chanMsg && ch) await this.tgx("deleteMessage", { chat_id: ch, message_id: q.chanMsg });
          await store.setChanMsg(q.id, null);
          if (author) await store.setPublic(q.id, false);
          else if (q.chanReq) await store.setChanReq(q.id, null);
          done++;
        }
      }
      const msg = pub ? (author ? `📢 ${done} ta test kanalga chiqarildi.` : `📨 ${done} ta test uchun so'rov muallifga yuborildi. Tasdiqlangach kanalda chiqadi.`)
        : `🔒 ${done} ta test kanaldan olindi.`;
      await this.send(msg + (stopped ? `\n⏳ Telegram kanalga birdaniga ko'p post yuborishni cheklaydi — qolgan ${todo.length - done} tasi uchun 1 daqiqadan keyin yana bosing.` : ""));
      return this.myTests(uid, 0);
    }
    // Muallif: foydalanuvchining barcha so'rovlarini birdaniga tasdiqlash / rad etish
    if (kind === "chqa") {
      if (String(uid) !== String(await store.getSetting("authorId"))) return answer();
      await answer();
      const [act, owner] = val.split(":");
      const list = (await store.ownerQuizzes(+owner)).filter((q) => q.chanReq && q.status !== "pending");
      if (!list.length) return this.edit(msgId, "ℹ️ Bu foydalanuvchining kutilayotgan so'rovi qolmagan.");
      let done = 0, stopped = false;
      for (const q of list) {
        const quiz = await store.getQuiz(q.id);
        if (act === "ok" && !quiz.chanMsg) {
          const r = await this.postToChannel(quiz, { id: quiz.owner, first_name: q.chanReq });
          if (this.env.TESTS_CHANNEL && !r?.ok) { stopped = true; break; }
        }
        await store.setChanReq(q.id, null);
        done++;
      }
      await this.tgx("sendMessage", { chat_id: +owner, parse_mode: "HTML", text: act === "ok"
        ? `✅ ${done} ta testingiz tasdiqlandi va testlar kanaliga chiqarildi!` : `❌ ${done} ta testingizni kanalga chiqarish so'rovi rad etildi. Testlar botda o'zingizda qoladi.` });
      return this.edit(msgId, (act === "ok" ? `✅ ${done} ta test kanalga chiqarildi.` : `❌ ${done} ta so'rov rad etildi.`) +
        (stopped ? `\n⏳ Telegram cheklovi — qolgan ${list.length - done} tasi uchun 1 daqiqadan keyin yana bosing.` : ""),
        stopped ? { reply_markup: kb([[btn("✅ Qolganini tasdiqlash", `chqa:ok:${owner}`)]]) } : {});
    }
    if (kind === "mdall") {
      await answer();
      const n = await store.countQuizzes(uid);
      return this.edit(msgId, `⚠️ <b>Barcha ${n} ta testingiz</b> o'chirilsinmi?\n\nNatijalar va testlar kanalidagi postlar ham o'chadi. Buni qaytarib bo'lmaydi.`,
        { reply_markup: kb([[btn("🗑 Ha, hammasini o'chirish", "mdallok")], [btn("⬅️ Yo'q, orqaga", "mypg:0")]]) });
    }
    if (kind === "mdallok") {
      const res = await store.deleteAllQuizzes(uid);
      if (this.env.TESTS_CHANNEL)
        for (let i = 0; i < res.posts.length; i += 100)
          await this.tgx("deleteMessages", { chat_id: this.env.TESTS_CHANNEL, message_ids: res.posts.slice(i, i + 100) });
      await answer("🗑 O'chirildi");
      return this.edit(msgId, `🗑 ${res.n} ta test o'chirildi.`, { reply_markup: kb([]) });
    }

    // Test kartasi va tahrirlash
    if (kind === "open") {
      const quiz = await store.getQuiz(val);
      await answer();
      if (!quiz) return this.send("❗ Test topilmadi.");
      return this.showCard(quiz, uid, cq.message.text?.startsWith("✏️") || cq.message.text?.startsWith("📊") ? msgId : undefined);
    }
    if (kind === "man") {
      const man = await this.st.get("manual");
      if (val === "cancel") {
        await this.st.delete("manual");
        await answer("Bekor qilindi");
        return this.edit(msgId, "❌ Savollar bekor qilindi.");
      }
      if (!man?.questions?.length) return answer("Avval viktorina yuboring", true);
      if (val === "undo") {
        man.questions.pop();
        await this.st.put("manual", man);
        await answer("Oxirgi savol o'chirildi");
        return this.edit(msgId, `↩️ Oxirgi savol o'chirildi. Hozir ${man.questions.length} ta savol.`, { reply_markup: this.manualKb(man.questions.length) });
      }
      if (val === "done") {
        await this.st.delete("manual");
        await answer();
        const d = new Date(Date.now() + 5 * 3600e3);
        const title = `Test ${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
        return this.askTitle({ pairs: man.questions, title, mcq: true, count: man.questions.length }, msgId);
      }
      return answer();
    }

    if (kind === "qe" || kind === "qs" || kind === "qa") {
      const parts = val.split(":");
      const act = kind === "qa" ? parts.shift() : null;
      const [id, n] = parts;
      const quiz = await store.getQuiz(id);
      if (!quiz) return answer("Test topilmadi", true);
      if (quiz.owner !== uid) return answer("Faqat test egasi o'zgartira oladi", true);
      await answer();
      if (kind === "qe") return this.questionList(quiz, parseInt(n, 10) || 0, msgId);
      const idx = parseInt(n, 10) || 0;
      if (kind === "qs") return this.questionView(id, idx, uid, msgId);
      if (act === "img") {
        await this.st.put("edit", { id, field: "qimg", idx });
        return this.send(`🖼 ${idx + 1}-savol uchun rasmni yuboring.\nBekor qilish: /cancel`);
      }
      if (act === "exp") {
        await this.st.put("edit", { id, field: "qexp", idx });
        return this.send(`💬 ${idx + 1}-savol uchun izoh yozing (${EXP_MAX} belgigacha).\nIzoh o'quvchi javob bergandan keyin ko'rinadi.\nBekor qilish: /cancel`);
      }
      if (act === "see") {
        const q = quiz.questions?.[idx];
        if (q?.img) await this.tgx("sendPhoto", { chat_id: this.chatId, photo: q.img, caption: `${idx + 1}-savol rasmi` });
        return;
      }
      if (act === "rmimg" || act === "rmexp") {
        await store.updateQuestion(id, uid, idx, act === "rmimg" ? { img: null } : { exp: null });
        return this.questionView(id, idx, uid, msgId);
      }
      return;
    }

    if (["edit", "ef", "et", "es", "del", "delok", "stat"].includes(kind)) {
      const id = val.split(":").pop();
      const quiz = await store.getQuiz(id);
      if (!quiz) return answer("Test topilmadi", true);
      if (kind === "stat") {
        await answer();
        const top = await store.top(id, 5);
        const takers = await store.takers(id);
        const medals = ["🥇", "🥈", "🥉"];
        const lines = top.map((r, k) => `${medals[k] || k + 1 + "."} ${esc(r.name)} — ${r.ok}/${r.total} (${fmtTime(r.secs)})`);
        return this.edit(msgId, `📊 <b>${esc(quiz.title)}</b>\n\n👥 ${takers} kishi yechgan` +
          (lines.length ? `\n\n🏆 Eng yaxshi 5 natija (to'g'ri javoblar, keyin vaqt bo'yicha):\n${lines.join("\n")}` : ""),
          { reply_markup: kb([[btn("⬅️ Orqaga", `open:${id}`)]]) });
      }
      if (quiz.owner !== uid) return answer("Faqat test egasi o'zgartira oladi", true);
      await answer();
      if (kind === "edit") return this.editMenu(quiz, msgId);
      if (kind === "ef") {
        const field = val.split(":")[0];
        if (field === "title" || field === "desc") {
          await this.st.put("edit", { id, field });
          return this.send(field === "title" ? `✏️ Yangi nomni yozing:\n(hozirgi: <b>${esc(quiz.title)}</b>)` :
            "📝 Yangi tavsifni yozing (o'chirish uchun «-» yozing):");
        }
        if (field === "timer") return this.edit(msgId, "⏱ Yangi vaqtni tanlang:", { reply_markup: timerKb("et", `:${id}`) });
        if (field === "shuf") return this.edit(msgId, "🔀 Aralashtirishni tanlang:", { reply_markup: shuffleKb("es", `:${id}`) });
      }
      if (kind === "et" || kind === "es") {
        const v = val.split(":")[0];
        if (kind === "et") await store.updateQuiz(id, uid, "timer", parseInt(v, 10) || 30);
        else await store.updateQuiz(id, uid, "shuffle", SHUFFLE[v] ? v : "all");
        return this.showCard(await store.getQuiz(id), uid, msgId);
      }
      if (kind === "del") {
        return this.edit(msgId, `🗑 <b>${esc(quiz.title)}</b> testini o'chirasizmi? Natijalar ham o'chadi.`,
          { reply_markup: kb([[btn("Ha, o'chirish", `delok:${id}`), btn("Yo'q", `edit:${id}`)]]) });
      }
      if (kind === "delok") {
        if (quiz.chanMsg && this.env.TESTS_CHANNEL) await this.tgx("deleteMessage", { chat_id: this.env.TESTS_CHANNEL, message_id: quiz.chanMsg });
        await store.deleteQuiz(id, uid);
        return this.edit(msgId, "🗑 Test o'chirildi.");
      }
    }

    // Test o'tkazish
    if (kind === "run") {
      const quiz = await store.getQuiz(val);
      if (!quiz) return answer("Test o'chirilgan", true);
      if (quiz.status === "pending" && String(uid) !== String(await store.getSetting("authorId"))) return answer("⏳ Test tekshiruvda", true);
      const type = cq.message.chat.type;
      if (type !== "private" && !(await this.isMember(uid))) return answer(`Avval kanallarga a'zo bo'ling: ${channelsOf(this.env).map((c) => c.name).join(", ")}`, true);
      await answer();
      return this.prepareSession(quiz, uid, type);
    }
    if (kind === "hr") {
      await answer();
      const [act, a, b] = val.split(":");
      if (act === "home") return this.reportHome(uid, msgId);
      if (act === "d") {
        const r = await store.gameReport(+a);
        if (!r || !(await this.isGroupAdmin(r.g.chat, uid))) return this.edit(msgId, "❗ Bu hisobot faqat guruh adminlari uchun.");
        return this.reportGame(a, msgId);
      }
      if (!(await this.isGroupAdmin(+a, uid))) return this.edit(msgId, "❗ Bu hisobot faqat guruh adminlari uchun.");
      if (act === "g") return this.reportGroup(+a, +b || 0, msgId);
      if (act === "s") return this.reportStudents(+a, msgId);
      return;
    }
    if (kind === "dn") {
      if (!this.isAuthor(cq.from)) return answer();
      await answer();
      if (val === "del") { await store.setSetting("donate", ""); return this.edit(msgId, "🗑 Donat ma'lumoti o'chirildi. Qayta sozlash: /donatsozla"); }
      return this.donateSetup();
    }
    if (kind === "tl") {
      await answer();
      if (val === "cancel") { await this.st.delete("tool"); return this.edit(msgId, "❌ Bekor qilindi. /vositalar"); }
      if (val === "go") return this.runTool(msgId);
      if (["img", "merge", "csv", "txt"].includes(val)) return this.startTool(val, msgId);
      return this.toolsMenu(msgId);
    }
    if (kind === "sup") {
      await answer();
      if (val === "new") return this.askSupport();
      if (val.startsWith("r:")) {
        if (!this.isAuthor(cq.from)) return;
        const target = +val.slice(2);
        await this.st.put("awaitReply", target);
        return this.send(`✍️ <code>${target}</code> ga javobingizni yozing (matn, rasm, fayl, ovozli xabar).\nBekor qilish: /cancel`);
      }
      return;
    }
    if (kind === "src") {
      await answer();
      if (val === "del") {
        await this.st.delete("src");
        return this.edit(msgId, "🗑 Fayl o'chirildi. Yangi test uchun faylni qayta yuboring.");
      }
      const src = await this.getSrc();
      if (!src) return this.edit(msgId, "⌛ Fayl saqlanish muddati (1 soat) tugadi va o'chirildi. Test tuzish uchun faylni qayta yuboring.");
      await this.st.delete("edit");
      return this.beginCreate(src.parsed, src.name);
    }
    if (kind === "rvm") { await answer(); return this.reviewMenu(uid, msgId); }
    if (kind === "rv" || kind === "rva") { await answer(); return this.startReview(uid, kind === "rva", msgId); }
    if (kind === "retry") {
      const r = await this.st.get("retry");
      await this.st.delete("retry");
      if (!r) return answer("Ma'lumot eskirgan", true);
      await answer();
      return this.prepareSession({ id: r.qid, title: r.title + " — xatolar", description: "", timer: r.timer, shuffle: "all",
        questions: r.questions }, uid, "private", { record: false });
    }
    if (kind === "go") return this.onReady(cq, answer);
    if (kind === "now") return this.onStartNow(cq, answer);
    if (kind === "resume") {
      const s = await this.st.get("sess");
      if (!s || s.phase !== "paused") return answer();
      s.phase = "run";
      s.miss = 0;
      await this.st.put("sess", s);
      await answer("Davom etamiz!");
      await this.edit(msgId, "▶️ Davom etamiz!");
      return this.st.setAlarm(Date.now() + 500);
    }
    return answer();
  }

  // ---------- Test sessiyasi ----------
  async prepareSession(quiz, userId, chatType, { record = true, review = false } = {}) {
    const old = await this.st.get("sess");
    if (old) {
      // Tayyorgarlik bosqichida qolib ketgan eski sessiyani almashtiramiz
      if (old.phase === "ready" && Date.now() - old.created > 30 * 60e3) await this.st.delete("sess");
      else return this.send("⏳ Bu chatda test davom etmoqda. To'xtatish: /stop");
    }
    const isGroup = chatType === "group" || chatType === "supergroup";
    const questions = prepare(quizQuestions(quiz), quiz.shuffle || "all");
    if (!questions.length) return this.send("❗ Savol tuzib bo'lmadi.");
    const timer = quiz.timer || (isGroup ? 30 : 0);
    const sess = { qid: quiz.id, title: quiz.title, questions, idx: -1, timer, isGroup, starter: userId,
      scores: {}, wrong: [], right: [], asked: 0, cur: null, stopped: false, phase: "ready", miss: 0, ready: [], record, review,
      quizTimer: quiz.timer, created: Date.now() };
    let text = `🎲 <b>${esc(quiz.title)}</b> testiga tayyorlaning\n`;
    if (quiz.description) text += `<i>${esc(quiz.description)}</i>\n`;
    text += `\n🖊 ${questions.length} ta savol\n⏱ Har bir savolga ${timerLabel(timer)}\n`;
    let markup;
    if (isGroup) {
      text += `\n🏁 Kamida ${MIN_READY} kishi «Tayyorman» tugmasini bosganda test boshlanadi.\nTo'xtatish: /stop`;
      markup = kb([[btn(`✅ Tayyorman! (0/${MIN_READY})`, "go")], [btn("▶️ Hozir boshlash", "now")]]);
    } else {
      text += "\n🏁 Tayyor bo'lsangiz, pastdagi tugmani bosing.\nTo'xtatish: /stop";
      markup = kb([[btn("✅ Tayyorman!", "go")]]);
    }
    const r = await this.send(text, { reply_markup: markup });
    sess.readyMsg = r.result?.message_id;
    sess.readyText = text;
    await this.st.put("sess", sess);
  }

  async onReady(cq, answer) {
    const s = await this.st.get("sess");
    if (!s || s.phase !== "ready") return answer();
    const uid = cq.from.id;
    if (!s.isGroup) {
      if (uid !== s.starter) return answer();
      return this.launch(s, answer);
    }
    if (!(await this.isMember(uid))) return answer(`Avval kanallarga a'zo bo'ling: ${channelsOf(this.env).map((c) => c.name).join(", ")}`, true);
    if (s.ready.includes(uid)) return answer("Siz allaqachon tayyorsiz ✅");
    s.ready.push(uid);
    if (s.ready.length >= MIN_READY) return this.launch(s, answer);
    await this.st.put("sess", s);
    await answer("✅ Tayyor!");
    return this.tgx("editMessageReplyMarkup", { chat_id: this.chatId, message_id: s.readyMsg,
      reply_markup: kb([[btn(`✅ Tayyorman! (${s.ready.length}/${MIN_READY})`, "go")], [btn("▶️ Hozir boshlash", "now")]]) });
  }

  async onStartNow(cq, answer) {
    const s = await this.st.get("sess");
    if (!s || s.phase !== "ready") return answer();
    if (cq.from.id !== s.starter) {
      const m = await this.tgx("getChatMember", { chat_id: this.chatId, user_id: cq.from.id });
      if (!["administrator", "creator"].includes(m.result?.status))
        return answer("Faqat testni boshlagan kishi yoki admin bosishi mumkin", true);
    }
    return this.launch(s, answer);
  }

  async launch(s, answer) {
    s.phase = "run";
    await this.st.put("sess", s);
    await answer("Boshladik!");
    if (s.readyMsg) await this.edit(s.readyMsg, s.readyText.replace(/\n🏁[\s\S]*$/, "\n\n🚀 Test boshlandi!"));
    await this.st.setAlarm(Date.now() + (s.isGroup ? 3000 : 500));
  }

  // Taymer: joriy savolni yopadi va keyingisini yuboradi
  async alarm() {
    this.chatId = await this.st.get("chatId");
    await this.loadLang();
    // Saqlangan fayl muddati tugagan bo'lsa — o'chiramiz
    const src = await this.st.get("src");
    if (src && src.exp <= Date.now()) await this.st.delete("src");
    const sess = await this.st.get("sess");
    if (!sess || sess.phase !== "run") {
      if (src && src.exp > Date.now()) await this.st.setAlarm(src.exp + 1000);
      return;
    }
    if (sess.cur) {
      if (!sess.cur.answered.length) {
        sess.miss++;
        if (!sess.isGroup) sess.wrong.push(sess.questions[sess.idx].pair);
      } else sess.miss = 0;
      sess.cur = null;
      if (sess.miss >= 2 && !sess.stopped && sess.idx + 1 < sess.questions.length) {
        if (sess.isGroup) {
          sess.stopped = true;
          sess.note = "Hech kim javob bermagani uchun test to'xtatildi.";
        } else {
          sess.phase = "paused";
          await this.st.put("sess", sess);
          return this.send("⏸ Siz javob bermaganingiz uchun test to'xtab turibdi.", { reply_markup: kb([[btn("▶️ Davom etish", "resume")]]) });
        }
      }
    }
    if (sess.stopped || sess.idx + 1 >= sess.questions.length) {
      await this.st.delete("sess");
      return this.finish(sess);
    }
    sess.idx++;
    const q = sess.questions[sess.idx];
    const num = `[${sess.idx + 1}/${sess.questions.length}]`;
    let question = `${num} ${q.q}`;
    const long = question.length > 300;
    if (q.img) {
      // Rasmli savol: avval rasm (uzun savol matni izohida), keyin viktorina — QuizBot kabi
      const ph = await this.tgx("sendPhoto", { chat_id: this.chatId, photo: q.img,
        ...(long ? { caption: `<b>${num}</b> ${esc(q.q)}`.slice(0, 1024), parse_mode: "HTML" } : {}) });
      if (long) question = ph.ok ? `${num} ${this.T("⬆️ Rasmdagi savolga javob bering")}` : question.slice(0, 297) + "…";
    } else if (long) {
      // Uzun savol: matnini alohida xabar qilib, so'rovnomada qisqa yozamiz
      await this.send(`<b>${num}</b> ${esc(q.q)}`);
      question = `${num} ${this.T("⬆️ Yuqoridagi savolga javob bering")}`;
    }
    const body = { chat_id: this.chatId, question,
      options: q.opts.map((o) => ({ text: o.length > 100 ? o.slice(0, 99) + "…" : o })),
      type: "quiz", correct_option_id: q.correct, is_anonymous: false };
    if (q.exp) body.explanation = q.exp.slice(0, EXP_MAX);
    if (sess.timer) body.open_period = sess.timer;
    const r = await this.tgx("sendPoll", body);
    if (!r.ok) {
      await this.st.delete("sess");
      return this.send("⚠️ Xatolik yuz berdi, test to'xtatildi.");
    }
    sess.cur = { pid: r.result.poll.id, sent: Date.now(), answered: [] };
    sess.asked++;
    await this.st.put("sess", sess);
    await this.store().mapPoll(sess.cur.pid, this.chatId);
    await this.st.setAlarm(Date.now() + ((sess.timer || 600) + 1) * 1000);
  }

  async pollAnswer(pa) {
    const sess = await this.st.get("sess");
    if (!sess?.cur || sess.phase !== "run" || sess.cur.pid !== pa.poll_id || !pa.user || !pa.option_ids?.length) return;
    const u = pa.user;
    if (sess.cur.answered.includes(u.id)) return;
    sess.cur.answered.push(u.id);
    const q = sess.questions[sess.idx];
    const ok = pa.option_ids[0] === q.correct;
    const name = [u.first_name, u.last_name].filter(Boolean).join(" ");
    const sc = (sess.scores[u.id] ??= { name, ok: 0, bad: 0, t: 0 });
    sc[ok ? "ok" : "bad"]++;
    sc.t += (Date.now() - sess.cur.sent) / 1000;
    if (!sess.isGroup && !ok) sess.wrong.push(q.pair);
    if (sess.isGroup) { const st = ((sess.qstat ??= {})[sess.idx] ??= [0, 0]); st[1]++; if (!ok) st[0]++; }
    if (!sess.isGroup && ok) (sess.right ??= []).push(q.pair);
    await this.st.put("sess", sess);
    if (!sess.isGroup) await this.st.setAlarm(Date.now() + 1000);
  }

  async stop(userId) {
    this.chatId ??= await this.st.get("chatId");
    if (!this.lang) await this.loadLang();
    const sess = await this.st.get("sess");
    if (!sess) return this.send("Hozir test ketmayapti.");
    if (sess.isGroup && userId !== sess.starter) {
      const m = await this.tgx("getChatMember", { chat_id: this.chatId, user_id: userId });
      if (!["administrator", "creator"].includes(m.result?.status))
        return this.send("Faqat testni boshlagan kishi yoki admin to'xtata oladi.");
    }
    if (sess.phase !== "run") {
      await this.st.delete("sess");
      return this.send("⏹ Test bekor qilindi.");
    }
    sess.stopped = true;
    await this.st.put("sess", sess);
    await this.send("⏹ Test to'xtatildi.");
    await this.st.setAlarm(Date.now() + 500);
  }

  async finish(s) {
    const title = esc(s.title);
    const store = this.store();
    const me = await botName(this.env);
    const shareRow = s.record ? [{ text: "🔗 Ulashish", switch_inline_query: s.qid }] : null;
    if (s.isGroup) {
      const board = Object.entries(s.scores).sort(([, a], [, b]) => b.ok - a.ok || a.t - b.t);
      if (s.record) for (const [uid, u] of board) await store.addResult(s.qid, +uid, u.name, u.ok, s.asked, u.t);
      if (s.asked && board.length) {
        const chatInfo = await this.tgx("getChat", { chat_id: this.chatId });
        const words = Object.entries(s.qstat || {}).map(([i, [wrong, total]]) => {
          const q = s.questions[+i];
          return { q: String(q?.q || "").slice(0, 120), ans: String(q?.opts?.[q.correct] ?? "").slice(0, 80), wrong, total };
        });
        await store.saveGame({ chat: this.chatId, chatTitle: chatInfo.result?.title || "", qid: s.qid, title: s.title, starter: s.starter, asked: s.asked,
          scores: board.map(([uid, u]) => ({ uid: +uid, name: u.name, ok: u.ok, bad: u.bad, t: u.t })), words });
      }
      let text = `🏁 <b>${title}</b> testi yakunlandi!\n`;
      if (s.note) text += `<i>${s.note}</i>\n`;
      text += `\n${s.asked} ta savolga javob berildi.\n\n`;
      if (!board.length) text += "Hech kim qatnashmadi.";
      else {
        const medals = ["🥇", "🥈", "🥉"];
        text += board.slice(0, 20).map(([, u], i) =>
          `${medals[i] || i + 1 + "."} ${esc(u.name)} — <b>${u.ok}</b> (${fmtTime(u.t)})`).join("\n");
        text += "\n\n🏆 G'oliblarni tabriklaymiz!";
      }
      const ch = channelsOf(this.env).find((c) => c.id === this.env.TESTS_CHANNEL);
      return this.send(text, { reply_markup: kb([ch ? [{ text: "📢 Yangi testlar kanaliga o'tish", url: ch.link }] : [btn("🔁 Yana o'ynash", `run:${s.qid}`)],
        [{ text: "📚 Botga o'tish", url: `https://t.me/${me}?start=${s.qid}` }]]) });
    }
    const [uid, sc] = Object.entries(s.scores)[0] || [s.starter, { name: "", ok: 0, bad: 0, t: 0 }];
    const missed = s.asked - sc.ok - sc.bad;
    let text = `🏁 <b>${title}</b> testi yakunlandi!\n\nSiz ${s.asked} ta savolga javob berdingiz:\n\n` +
      `✅ To'g'ri — ${sc.ok}\n❌ Xato — ${sc.bad}\n⌛️ O'tkazilgan — ${missed}\n⏱ ${fmtTime(sc.t)}`;
    if (s.record && s.asked) {
      const pl = await store.addResult(s.qid, +uid, sc.name || "Foydalanuvchi", sc.ok, s.asked, sc.t);
      if (pl) {
        text += `\n\n🏆 Siz ${pl.total} ishtirokchi ichida <b>${pl.place}-o'rin</b>dasiz.`;
        if (pl.improved) text += "\n📈 Yangi rekord! Natijangiz yangilandi.";
        else if (!pl.first) text += "\n<i>Reytingda eng yaxshi natijangiz saqlanadi.</i>";
        const top = await store.top(s.qid, 5);
        const medals = ["🥇", "🥈", "🥉", "4.", "5."];
        text += "\n\n<b>Eng yaxshi 5 natija:</b>\n" + top.map((r, k) => `${medals[k]} ${esc(r.name)} — ${r.ok}/${r.total} (${fmtTime(r.secs)})`).join("\n");
      }
    }
    // Takrorlash ro'yxatini yangilash (shu test bo'yicha, shu o'quvchi uchun)
    if (s.asked) {
      const wrongQs0 = s.questions.filter((q) => s.wrong.some((w) => w[0] === q.pair[0] && w[1] === q.pair[1]));
      const rv = await store.reviewUpdate(+uid, wrongQs0, s.right || [], !!s.review, s.title.replace(/ — (xatolar|takrorlash)$/, ""));
      if (s.review) {
        text += `\n\n🧠 <b>Takrorlash natijasi:</b>` + (rv.mastered ? `\n✅ O'zlashtirildi: ${rv.mastered} ta so'z` : "") +
          (rv.advanced ? `\n📈 Keyingi bosqichga o'tdi: ${rv.advanced} ta` : "") +
          (s.wrong.length ? `\n🔁 Xato — ertaga yana so'raladi: ${s.wrong.length} ta` : "") +
          `\n📋 Takrorlash ro'yxatingizda qoldi: ${rv.left} ta`;
      } else if (rv.added) text += `\n\n🧠 ${rv.added} ta so'z umumiy takrorlash ro'yxatingizga qo'shildi (jami ${rv.left} ta). Ertaga takrorlang: /takrorlash`;
    }
    const rows = [[btn(s.review ? "🧠 Takrorlash ro'yxati" : "🔁 Qayta urinish", s.review ? "rvm" : `run:${s.qid}`)]];
    if (s.wrong.length && !s.review) {
      const wrongQs = s.questions.filter((q) => s.wrong.some((w) => w[0] === q.pair[0] && w[1] === q.pair[1]));
      await this.st.put("retry", { qid: s.qid, title: s.title.replace(/ — xatolar$/, ""), timer: s.quizTimer, questions: wrongQs });
      text += "\n\n📝 <b>Takrorlash kerak:</b>\n" + s.wrong.slice(0, 30).map(([a, b]) => `• ${esc(a)} — ${esc(b)}`).join("\n");
      rows.unshift([btn(`🎯 Xatolarni qayta ishlash (${s.wrong.length})`, "retry")]);
    }
    if (shareRow) rows.push(shareRow);
    const tch = channelsOf(this.env).find((c) => c.id === this.env.TESTS_CHANNEL);
    if (tch) rows.push([{ text: "📢 Yangi testlar kanali", url: tch.link }]);
    return this.send(text, { reply_markup: kb(rows) });
  }
}

function timerKb(prefix, suffix = "") {
  const b = (t) => btn(timerShort(t), `${prefix}:${t}${suffix}`);
  return kb([TIMERS.slice(0, 4).map(b), TIMERS.slice(4, 7).map(b), TIMERS.slice(7).map(b)]);
}
function shuffleKb(prefix, suffix = "") {
  return kb(Object.entries(SHUFFLE).map(([k, v]) => [btn(v, `${prefix}:${k}${suffix}`)]));
}

// ---------------- Inline ulashish (@bot <test>) ----------------
async function onInline(iq, env) {
  const store = env.STORE.get(env.STORE.idFromName("db"));
  const q = (iq.query || "").trim();
  let quizzes = [];
  const one = q && /^[A-Za-z0-9]{6,12}$/.test(q) ? await store.getQuiz(q) : null;
  if (one) quizzes = [one];
  else quizzes = await store.searchQuizzes(iq.from.id, q);
  const me = await botName(env);
  const lang = detectLang(iq.from.language_code);
  const results = [];
  for (const z of quizzes.slice(0, 20)) {
    const n = z.questions?.length || z.count;
    let text = `🎲 <b>${esc(z.title)}</b>\n`;
    if (z.description) text += `<i>${esc(z.description)}</i>\n`;
    text += `\n🖊 ${n} ta savol\n⏱ Har bir savolga ${timerLabel(z.timer)}`;
    results.push({
      type: "article", id: z.id, title: z.title, description: tr(lang, `${n} ta savol · ${timerLabel(z.timer)}`),
      input_message_content: { message_text: tr(lang, text), parse_mode: "HTML" },
      reply_markup: trMarkup(lang, kb([[{ text: "▶️ Testni boshlash", url: `https://t.me/${me}?start=${z.id}` }],
        [{ text: "👥 Guruhda boshlash", url: `https://t.me/${me}?startgroup=${z.id}` }]])),
    });
  }
  return tg(env, "answerInlineQuery", { inline_query_id: iq.id, results, cache_time: 0, is_personal: true });
}

// Reklamani bitta chatga nusxalash (bitta post yoki albom). Yuborilgan xabarlar id larini qaytaradi.
// Reklamani qadash va "… pinned …" xizmat xabarini darhol o'chirish (keyin "pinned Deleted message" qolmasin)
async function pinAd(env, chatId, msgs) {
  const r = await tg(env, "pinChatMessage", { chat_id: chatId, message_id: msgs[0], disable_notification: true });
  if (r.ok) await tg(env, "deleteMessage", { chat_id: chatId, message_id: msgs[msgs.length - 1] + 1 });
}
async function copyAd(env, chatId, ad) {
  const ids = ad.msgIds || [ad.msgId];
  if (ids.length === 1) {
    const r = await tg(env, "copyMessage", { chat_id: chatId, from_chat_id: ad.fromChat, message_id: ids[0] });
    return { ...r, msgs: r.ok ? [r.result.message_id] : [] };
  }
  const r = await tg(env, "copyMessages", { chat_id: chatId, from_chat_id: ad.fromChat, message_ids: [...ids].sort((a, b) => a - b) });
  return { ...r, msgs: r.ok ? r.result.map((x) => x.message_id) : [] };
}

const fmtDate = (t) => {
  const d = new Date(t + 5 * 3600e3);
  const z = (n) => String(n).padStart(2, "0");
  return `${z(d.getUTCDate())}.${z(d.getUTCMonth() + 1)} ${z(d.getUTCHours())}:${z(d.getUTCMinutes())}`;
};

// ---------------- Reklama tarqatuvchi (navbat bilan, Telegram limitlariga mos) ----------------
// Cloudflare pullik tarifida bitta ishga tushishda 1000+ tashqi so'rov mumkin.
// Har bir foydalanuvchiga 2 tagacha so'rov (yuborish + qadash) ketadi, shuning uchun kichik bo'laklarda ishlaymiz.
const BATCH = 40;
const MAX_ERRORS = 5;
export class Caster extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.st = ctx.storage;
  }
  store() {
    return this.env.STORE.get(this.env.STORE.idFromName("db"));
  }
  notify(chat, text) {
    return tg(this.env, "sendMessage", { chat_id: chat, text, parse_mode: "HTML" });
  }
  async status() {
    const q = (await this.st.get("queue")) || [];
    return { queue: q.length, progress: q[0] ? q[0].ok + q[0].fail : null };
  }
  async details() {
    const q = (await this.st.get("queue")) || [];
    return { jobs: q.map((j) => ({ type: j.type, ad: j.ad, ok: j.ok, fail: j.fail, blocked: j.blocked || 0, after: j.after,
      errors: j.errors || 0, lastError: j.lastError || "", age: Math.round((Date.now() - j.started) / 60000) })),
      alarm: await this.st.getAlarm(), lastCrash: (await this.st.get("lastCrash")) || "" };
  }
  async clearQueue() {
    await this.st.put("queue", []);
    await this.st.delete("lastCrash");
    await this.scheduleExpiry();
  }
  // Vazifani navbatga qo'shish; navbatdagi o'rnini qaytaradi
  async enqueue(job) {
    const q = (await this.st.get("queue")) || [];
    q.push({ ...job, after: 0, ok: 0, fail: 0, blocked: 0, started: Date.now() });
    await this.st.put("queue", q);
    await this.kick();
    return q.length;
  }
  // Navbatda ish bo'lsa — darhol ishga tushirish (qotib qolgan navbatni ham uyg'otadi)
  async kick() {
    const q = (await this.st.get("queue")) || [];
    if (!q.length) return;
    const a = await this.st.getAlarm();
    if (!a || a > Date.now() + 3000) await this.st.setAlarm(Date.now() + 200);
  }
  async scheduleExpiry() {
    const t = await this.store().nextExpiry();
    if (t) await this.st.setAlarm(Math.max(Date.now() + 1000, t));
  }
  async alarm() {
    try {
      await this.work();
    } catch (e) {
      // Xato bo'lsa navbat qotib qolmasin: biroz kutib davom etamiz, takrorlansa — bu bo'lakni o'tkazib yuboramiz
      console.log("Reklama xatosi", e);
      await this.st.put("lastCrash", `${fmtDate(Date.now())}: ${String(e?.message || e).slice(0, 150)}`);
      const q = (await this.st.get("queue")) || [];
      if (q[0]) {
        q[0].errors = (q[0].errors || 0) + 1;
        if (q[0].errors >= MAX_ERRORS) { q[0].errors = 0; q[0].skipNext = true; }
        await this.st.put("queue", q);
      }
      await this.st.setAlarm(Date.now() + 15000);
    }
  }
  async work() {
    const store = this.store();
    let q = (await this.st.get("queue")) || [];
    // Muddati tugagan reklamalarni o'chirish vazifasiga qo'shamiz
    for (const id of await store.expiredAds(Date.now())) {
      await store.deactivateAd(id);
      const ad = await store.getAd(id);
      q.push({ type: "remove", ad: id, admin: ad.fromChat, reason: "muddati tugadi", after: 0, ok: 0, fail: 0, started: Date.now() });
    }
    const job = q[0];
    if (!job) { await this.st.put("queue", q); return this.scheduleExpiry(); }
    const ad = await store.getAd(job.ad);
    const done = async (text) => {
      q.shift();
      await this.st.put("queue", q);
      if (text) await this.notify(job.admin, text);
      if (q.length) await this.st.setAlarm(Date.now() + 500);
      else await this.scheduleExpiry();
    };
    if (!ad) return done();

    if (job.type === "send") {
      if (!ad.active) return done(`ℹ️ «${esc(ad.title)}» reklamasi o'chirilgani uchun tarqatish to'xtatildi (${job.ok} kishiga yetib borgan edi).`);
      const users = await store.listUsers(job.after, BATCH);
      if (!users.length) {
        await store.adStats(ad.id, job.ok, job.fail);
        const mins = Math.max(1, Math.round((Date.now() - job.started) / 60000));
        const other = job.fail - (job.blocked || 0);
        return done(`✅ <b>Reklama tarqatildi!</b>\n«${esc(ad.title)}»\n\n📤 Yetib bordi: <b>${job.ok}</b>` +
          `\n🚫 Botni bloklaganlar: ${job.blocked || 0}` + (other > 0 ? `\n⚠️ Boshqa xato: ${other}${job.lastError ? ` (${esc(job.lastError)})` : ""}` : "") +
          `\n⏱ ${mins} daqiqa` + (ad.pin ? "\n📌 Tepaga qadaldi." : "") +
          (ad.expires ? `\n⏳ ${fmtDate(ad.expires)} da avtomatik olib tashlanadi.` : "") + "\n\nBoshqaruv: /reklama");
      }
      if (job.skipNext) { // shu bo'lakda takroriy xato — o'tkazib yuboramiz
        job.skipNext = false;
        job.fail += users.length;
        job.after = users[users.length - 1];
        q[0] = job;
        await this.st.put("queue", q);
        return this.st.setAlarm(Date.now() + 1000);
      }
      const rows = [];
      let wait = 1100;
      const already = new Set(await store.deliveredTo(ad.id, users));
      for (const uid of users) {
        if (already.has(uid)) { job.ok++; job.after = uid; continue; }
        const r = await copyAd(this.env, uid, ad);
        if (r.ok) {
          if (ad.pin && r.msgs[0]) await pinAd(this.env, uid, r.msgs);
          rows.push([uid, r.msgs]);
          job.ok++;
        } else if (r.error_code === 429) {
          wait = ((r.parameters?.retry_after || 5) + 1) * 1000; // Telegram "sekinroq" dedi — keyinroq shu odamdan davom etamiz
          break;
        } else if (r.error_code === 400 && /message to copy not found|message_id_invalid|MESSAGE_ID_INVALID/i.test(r.description || "")) {
          // Asl post o'chirib yuborilgan — davom etishning ma'nosi yo'q
          await store.deactivateAd(ad.id);
          return done("❗ Reklamaning asl posti botdagi chatingizdan o'chirilgan, shuning uchun uni nusxalab bo'lmadi.\n" +
            `«${esc(ad.title)}» to'xtatildi (${job.ok} kishiga yetib borgan edi). Postni qayta yuborib, yangi reklama qiling: /reklama`);
        } else {
          job.fail++;
          if (r.error_code === 403 || /chat not found|deactivated|blocked/i.test(r.description || "")) {
            job.blocked = (job.blocked || 0) + 1;
            await store.markBlocked(uid);
          } else job.lastError = (r.description || "").slice(0, 80);
        }
        job.after = uid;
      }
      if (rows.length) await store.addDeliveries(ad.id, rows);
      job.errors = 0;
      q[0] = job;
      await this.st.put("queue", q);
      return this.st.setAlarm(Date.now() + wait);
    }

    if (job.type === "remove") {
      const rows = await store.listDeliveries(ad.id, job.after, BATCH);
      if (!rows.length) {
        await store.clearDeliveries(ad.id);
        return done(`🗑 «${esc(ad.title)}» reklamasi ${job.ok} ta chatdan olib tashlandi (${job.reason || "o'chirildi"}).`);
      }
      for (const { uid, msgs } of rows) {
        if (ad.pin && msgs[0]) await tg(this.env, "unpinChatMessage", { chat_id: uid, message_id: msgs[0] });
        // Qadalgan reklamaning xizmat xabari ham (oldingi versiyada qolib ketganlari uchun) o'chiriladi
        const r = await tg(this.env, "deleteMessages", { chat_id: uid, message_ids: ad.pin && msgs.length ? [...msgs, msgs[msgs.length - 1] + 1] : msgs });
        if (r.error_code === 429) { await this.st.put("queue", q); return this.st.setAlarm(Date.now() + ((r.parameters?.retry_after || 5) + 1) * 1000); }
        job.ok++;
        job.after = uid;
      }
      q[0] = job;
      await this.st.put("queue", q);
      return this.st.setAlarm(Date.now() + 1100);
    }
    return done();
  }
}

// ---------------- Kirish nuqtasi ----------------
async function route(update, env) {
  const chatStub = (id) => env.CHAT.get(env.CHAT.idFromName(String(id)));
  if (update.inline_query) return onInline(update.inline_query, env);
  if (update.poll_answer) {
    const store = env.STORE.get(env.STORE.idFromName("db"));
    const chat = await store.pollChat(update.poll_answer.poll_id);
    if (chat) await chatStub(chat).pollAnswer(update.poll_answer);
    return;
  }
  const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
  if (chatId != null) await chatStub(chatId).handle(update, chatId);
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (!env.BOT_TOKEN) return new Response("BOT_TOKEN o'rnatilmagan", { status: 500 });
    if (url.pathname === "/setup") {
      const r = await tg(env, "setWebhook", {
        url: `${url.origin}/webhook`,
        secret_token: await webhookSecret(env),
        allowed_updates: ["message", "callback_query", "poll_answer", "inline_query"],
        drop_pending_updates: true,
      });
      await tg(env, "setMyCommands", { commands: USER_COMMANDS });
      for (const lc of ["ru", "en", "tr"]) await tg(env, "setMyCommands", { commands: trCommands(lc, USER_COMMANDS), language_code: lc });
      let msg = r.ok ? "✅ Bot ulandi! Endi Telegramda botingizga /start yozing." : "❌ Xato: " + r.description;
      const me = (await tg(env, "getMe", {})).result;
      for (const ch of channelsOf(env)) {
        const cm = await tg(env, "getChatMember", { chat_id: ch.id, user_id: me?.id });
        const admin = cm.ok && cm.result.status === "administrator";
        msg += admin ? `\n✅ Kanal tekshiruvi ishlaydi: ${ch.name}`
          : `\n⚠️ Bot ${ch.name} kanalida admin emas — a'zolik tekshirilmaydi. Botni kanalga admin qilib qo'shing.`;
        if (admin && ch.id === env.TESTS_CHANNEL)
          msg += cm.result.can_post_messages ? "\n✅ Yangi testlar shu kanalga avtomatik joylanadi."
            : "\n⚠️ Botga testlar kanalida «Xabar joylash» huquqini bering.";
      }
      return new Response(msg, { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    if (url.pathname === "/webhook" && req.method === "POST") {
      if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== (await webhookSecret(env)))
        return new Response("forbidden", { status: 403 });
      const update = await req.json();
      ctx.waitUntil(route(update, env).catch((e) => console.log("Xato", e)));
      return new Response("ok");
    }
    return new Response("LingoUP bot ishlayapti ✅", { headers: { "content-type": "text/plain; charset=utf-8" } });
  },
};
