// LingoUP bot — Cloudflare Workers versiyasi (bepul tarifda ishlaydi)
// QuizBot kabi ishlaydi, lekin savollar fayldan avtomatik tuziladi.
import { DurableObject } from "cloudflare:workers";
import { parseFile, parseText } from "./parse.js";

const MAX_FILE = 20 * 1024 * 1024;
const MAX_QUESTIONS = 300;
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
const NEWQUIZ_TEXT = "📄 <b>1-usul — fayldan (tez):</b> PDF, Word, Excel yoki .txt faylni yuboring yoki matnni xabar qilib yozing.\n" +
  "Savol ostiga <code>Izoh: ...</code> yozsangiz — javobdan keyin tushuntirish chiqadi. Word ichidagi rasmlar savolga o'zi biriktiriladi.\n\n" +
  "✍️ <b>2-usul — QuizBot kabi, bittalab:</b> 📎 → <b>So'rovnoma</b> → <b>Viktorina</b> rejimini yoqing, to'g'ri javobni belgilang (izoh ham yozish mumkin) va shu yerga yuboring.\n" +
  "🖼 Rasmli savol uchun avval rasmni yuboring, keyin viktorinani.";
const TG_DELETE_URL = "https://my.telegram.org/auth?to=delete";
const MAIN_KB = { keyboard: [[{ text: BTN_NEW }, { text: BTN_MY }], [{ text: BTN_CAT }], [{ text: BTN_GUIDE }, { text: BTN_AUTHOR }],
  [{ text: BTN_AD }, { text: BTN_SET }]], resize_keyboard: true, is_persistent: false, one_time_keyboard: true };
const authorOf = (env) => env.AUTHOR || "@Shehroz_hoca";

// Buyruqlar menyusi: hamma uchun va faqat muallif uchun
const USER_COMMANDS = [
  { command: "start", description: "Boshlash" },
  { command: "newquiz", description: "Yangi test yaratish" },
  { command: "mytests", description: "Mening testlarim" },
  { command: "tests", description: "🗂 Muallif testlari" },
  { command: "guide", description: "Yo'riqnoma (PDF)" },
  { command: "reklama", description: "📣 Botga reklama berish" },
  { command: "author", description: "Muallif bilan bog'lanish" },
  { command: "settings", description: "⚙️ Sozlamalar" },
  { command: "stop", description: "Testni to'xtatish" },
  { command: "cancel", description: "Bekor qilish" },
];
const ADMIN_COMMANDS = [
  { command: "start", description: "Boshlash" },
  { command: "newquiz", description: "Yangi test yaratish" },
  { command: "mytests", description: "Mening testlarim" },
  { command: "tests", description: "🗂 Muallif testlari" },
  { command: "reklama", description: "📣 Reklama boshqaruvi" },
  { command: "stat", description: "📊 Bot statistikasi" },
  { command: "setguide", description: "📖 Yo'riqnomani yangilash" },
  { command: "bans", description: "🚫 Bloklanganlar ro'yxati" },
  { command: "guide", description: "Yo'riqnoma (PDF)" },
  { command: "stop", description: "Testni to'xtatish" },
  { command: "cancel", description: "Bekor qilish" },
];

const HELP =
  "📚 <b>LingoUP bot</b>\n\n" +
  "Fayl yuboring — bot undan tayyor test tuzib beradi.\n\n" +
  "1️⃣ Faylni yuboring (PDF, Word, Excel, .txt)\n" +
  "2️⃣ Bo'lim va savollar sonini tanlang\n" +
  "3️⃣ Test nomi, tavsifi, vaqti va aralashtirishni belgilang\n" +
  "4️⃣ Tayyor! O'zingiz yeching, guruhda o'tkazing yoki ulashing 👥\n\n" +
  "/newquiz — yangi test\n/mytests — mening testlarim\n/tests — muallif testlari\n/guide — yo'riqnoma\n/reklama — botga reklama berish\n/stop — testni to'xtatish\n/cancel — bekor qilish";

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
  "porno", "porn", "xxx", "erotik", "erotic", "эрот", "порн", "секс", "seks", "sex", "hentai", "nude", "naked", "onlyfans",
  "yalang'och", "yalangoch", "fahsh", "fohisha", "intim", "orgazm", "orgasm", "sikish", "jalab", "qanjiq", "сиськ", "трах", "голая", "голые",
  "narkotik", "наркот", "giyohvand", "geroin", "героин", "kokain", "кокаин", "marixuana", "марихуан", "amfetamin", "амфетамин", "zakladka", "закладк",
  "terror", "террор", "jihod", "джихад", "bomba yasash", "portlovchi", "взрывчат", "qurol sotish", "оружие купить",
  "kazino", "казино", "casino", "1xbet", "stavka qil", "ставки на спорт",
];
export function badWord(texts) {
  const t = " " + texts.filter(Boolean).join(" ").toLowerCase().replace(/[‘’`ʻ]/g, "'") + " ";
  return BAD_WORDS.find((w) => t.includes(w)) || null;
}
function quizTexts(q) {
  const out = [q.title, q.description];
  for (const x of q.questions || []) out.push(x.q, x.exp, ...(x.opts || []));
  return out;
}

// Lug'atdan savollar tuzish (test yaratilganda bir marta)
export function buildQuestions(pairs, count, direction) {
  const chosen = sample(pairs, Math.min(count, pairs.length, MAX_QUESTIONS));
  const out = [];
  for (const [word, tr] of chosen) {
    const d = direction === "mix" ? (Math.random() < 0.5 ? "fwd" : "rev") : direction;
    const [q, ans, pool] = d === "fwd" ? [word, tr, pairs.map((p) => p[1])] : [tr, word, pairs.map((p) => p[0])];
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
    for (const col of ["description TEXT", "shuffle TEXT", "questions TEXT", "chanMsg INTEGER", "public INTEGER DEFAULT 0", "status TEXT DEFAULT 'ok'"]) {
      try { this.sql.exec(`ALTER TABLE quizzes ADD COLUMN ${col}`); } catch {}
    }
    this.sql.exec(`CREATE TABLE IF NOT EXISTS polls(id TEXT PRIMARY KEY, chat TEXT, created INTEGER)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS users(uid INTEGER PRIMARY KEY, created INTEGER, blocked INTEGER DEFAULT 0)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS ads(id INTEGER PRIMARY KEY AUTOINCREMENT, fromChat INTEGER, msgIds TEXT, pin INTEGER,
      title TEXT, created INTEGER, expires INTEGER, active INTEGER DEFAULT 1, sent INTEGER DEFAULT 0, fail INTEGER DEFAULT 0)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS deliveries(ad INTEGER, uid INTEGER, msgs TEXT, PRIMARY KEY(ad, uid))`);
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
  listQuizzes(owner) {
    return this.sql.exec("SELECT id,title,count FROM quizzes WHERE owner=? ORDER BY created DESC LIMIT 30", owner).toArray();
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
  text += `\n\n🔗 https://t.me/${me}?start=${quiz.id}`;
  const rows = [
    [btn("▶️ Testni boshlash", `run:${quiz.id}`)],
    [{ text: "👥 Guruhda boshlash", url: `https://t.me/${me}?startgroup=${quiz.id}` }],
    [{ text: "🔗 Testni ulashish", switch_inline_query: quiz.id }],
  ];
  if (owner) rows.push([btn("✏️ Tahrirlash", `edit:${quiz.id}`), btn("📊 Statistika", `stat:${quiz.id}`)]);
  if (author) rows.push([btn(quiz.public ? "🔒 Hammadan yashirish" : "🌐 Hammaga ko'rsatish", `pub:${quiz.id}`)]);
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
  send(text, extra = {}) {
    return tg(this.env, "sendMessage", { chat_id: this.chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });
  }
  edit(msgId, text, extra = {}) {
    return tg(this.env, "editMessageText", { chat_id: this.chatId, message_id: msgId, text, parse_mode: "HTML",
      disable_web_page_preview: true, ...extra });
  }

  // ---------- Kanalga a'zolik ----------
  async isMember(uid) {
    const chans = channelsOf(this.env);
    if (!chans.length) return true;
    const until = await this.st.get("m:" + uid);
    if (until && until > Date.now()) return true;
    for (const ch of chans) {
      const r = await tg(this.env, "getChatMember", { chat_id: ch.id, user_id: uid });
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

  sendHelp() {
    return this.send(HELP + `\n\n👨‍🏫 Muallif: ${esc(authorOf(this.env))}`, { reply_markup: MAIN_KB });
  }
  isAuthor(from) {
    const a = authorOf(this.env).replace(/^@/, "").toLowerCase();
    return (from?.username || "").toLowerCase() === a || (this.env.ADMIN_ID && String(from?.id) === String(this.env.ADMIN_ID));
  }
  async sendGuide() {
    const fid = await this.store().getSetting("guide");
    if (!fid) return this.send("📖 Yo'riqnoma hali yuklanmagan. Savollar bo'lsa, muallifga yozing: /author");
    return tg(this.env, "sendDocument", { chat_id: this.chatId, document: fid,
      caption: "📖 <b>LingoUP bot — foydalanish yo'riqnomasi</b>\n\nSavollar bo'lsa " + esc(authorOf(this.env)) + " bilan bog'laning.", parse_mode: "HTML" });
  }
  sendAuthor() {
    const a = authorOf(this.env);
    return this.send(`👨‍🏫 Bot muallifi: <b>${esc(a)}</b>\n\nTaklif, savol yoki hamkorlik bo'yicha yozing 👇`,
      { reply_markup: kb([[{ text: "✉️ Muallifga yozish", url: `https://t.me/${a.replace(/^@/, "")}` }]]) });
  }

  // Foydalanuvchini bloklash/blokdan chiqarish (muallif tomonidan chaqiriladi)
  async setBanned(v, chatId) {
    this.chatId = chatId;
    await this.st.put("chatId", chatId);
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
    if (isPrivate && (await this.st.get("banned"))) {
      if (cq) await tg(this.env, "answerCallbackQuery", { callback_query_id: cq.id, text: "🚫 Siz botdan bloklangansiz", show_alert: true });
      else if (((await this.st.get("bannedNote")) || 0) < Date.now()) {
        await this.st.put("bannedNote", Date.now() + 3600e3);
        await this.send(`🚫 Siz botdan bloklangansiz. E'tirozingiz bo'lsa: ${esc(authorOf(this.env))}`);
      }
      return;
    }
    // Yangi foydalanuvchini ro'yxatga olamiz (reklama uchun) va faol reklamani ko'rsatamiz
    let isNew = false;
    if (isPrivate && uid && !(await this.st.get("reg"))) {
      isNew = await this.store().addUser(uid);
      await this.st.put("reg", 1);
    }
    // Muallifga maxsus buyruqlar menyusi (faqat unga ko'rinadi)
    if (isPrivate && this.isAuthor((m || cq).from) && !(await this.st.get("adminCmds2"))) {
      await tg(this.env, "setMyCommands", { commands: ADMIN_COMMANDS, scope: { type: "chat", chat_id: uid } });
      await this.store().setSetting("authorId", String(uid));
      await this.st.put("adminCmds2", 1);
    }
    if (isPrivate && uid && cq?.data !== "chk" && !(await this.isMember(uid))) {
      const arg = m?.text?.match(/^\/start\s+(\S+)/)?.[1];
      if (arg) await this.st.put("pendingStart", arg);
      if (cq) await tg(this.env, "answerCallbackQuery", { callback_query_id: cq.id });
      await this.joinPrompt();
      if (isNew) await this.sendActiveAds(uid);
      return;
    }
    if (m) await this.onMessage(m);
    else if (cq) await this.onCallback(cq);
    if (isNew) await this.sendActiveAds(uid);
  }

  // Yangi foydalanuvchiga barcha faol reklamalarni yuborish
  async sendActiveAds(uid) {
    const store = this.store();
    for (const ad of await store.activeAds()) {
      const r = await copyAd(this.env, this.chatId, ad);
      if (!r.ok) continue;
      if (ad.pin && r.msgs[0]) await tg(this.env, "pinChatMessage", { chat_id: this.chatId, message_id: r.msgs[0], disable_notification: true });
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
    return tg(this.env, "sendMessage", { chat_id: admin, text, parse_mode: "HTML", reply_markup: kb([
      [btn("✅ Ruxsat berish", `mod:ok:${quiz.id}`), btn("🗑 O'chirish", `mod:del:${quiz.id}`)],
      [btn("🚫 Bloklash va testlarini o'chirish", `mod:ban:${quiz.id}`)],
      [btn("👁 Testni ko'rish", `open:${quiz.id}`)]]) });
  }
  async banUser(uid, name, reason) {
    const store = this.store();
    await store.ban(uid, name, reason);
    const res = await store.deleteUserData(uid);
    if (this.env.TESTS_CHANNEL)
      for (const mid of res.posts) await tg(this.env, "deleteMessage", { chat_id: this.env.TESTS_CHANNEL, message_id: mid });
    await this.env.CHAT.get(this.env.CHAT.idFromName(String(uid))).setBanned(true, uid);
    return res;
  }

  settingsMenu(editId) {
    const text = "⚙️ <b>Sozlamalar</b>\n\n" +
      "🗑 <b>Ma'lumotlarimni o'chirish</b> — botdagi barcha testlaringiz, natijalaringiz va reytingdagi o'rningiz butunlay o'chiriladi.\n\n" +
      "⚠️ <b>Telegram akkauntni o'chirish</b> — Telegram'ning rasmiy sahifasi ochiladi. U yerda telefon raqamingiz bilan kirib, " +
      "akkauntni o'chirishni o'zingiz tasdiqlaysiz. <b>Diqqat:</b> akkaunt o'chirilsa, barcha chatlar, kontaktlar va kanallar qaytarib bo'lmaydigan tarzda yo'qoladi!";
    const reply_markup = kb([[btn("🗑 Ma'lumotlarimni o'chirish", "deldata")], [{ text: "⚠️ Telegram akkauntni o'chirish", url: TG_DELETE_URL }]]);
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
    const status = await this.env.CASTER.get(this.env.CASTER.idFromName("main")).status();
    let text = `📣 <b>Reklama boshqaruvi</b>\n\n👥 Faol foydalanuvchilar: <b>${s.users}</b>\n🚫 Botni bloklaganlar: ${s.blocked}\n`;
    if (status.queue) text += `\n⏳ Navbatda: ${status.queue} ta vazifa${status.progress != null ? ` (hozirgisi: ${status.progress} ta yuborildi)` : ""}\n`;
    text += ads.length ? `\n<b>Faol reklamalar (${ads.length}):</b>\n` + ads.map((a) =>
      `${a.pin ? "📌" : "📤"} #${a.id} ${esc(a.title)} — ${a.sent} ta${a.expires ? `, ⏳ ${fmtDate(a.expires)} gacha` : ", muddatsiz"}`).join("\n") +
      "\n\nYangi foydalanuvchilar barcha faol reklamalarni avtomatik oladi." : "\nHozir faol reklama yo'q.";
    const rows = [[btn("➕ Yangi reklama", "ad:new")], ...ads.map((a) => [btn(`🗑 #${a.id} ${a.title}`.slice(0, 60), `adrm:${a.id}`)]),
      [btn("🔄 Yangilash", "ad:menu")]];
    return editId ? this.edit(editId, text, { reply_markup: kb(rows) }) : this.send(text, { reply_markup: kb(rows) });
  }

  // ---------- Xabarlar ----------
  async onMessage(m) {
    const isPrivate = m.chat.type === "private";
    const isGroup = m.chat.type === "group" || m.chat.type === "supergroup";
    const text = m.text || "";
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
      switch (cmd.toLowerCase()) {
        case "start":
          if (arg) return this.openQuiz(arg, m.from, m.chat.type);
          return isPrivate ? this.sendHelp() : target ? this.send(HELP) : null;
        case "author":
        case "muallif":
          return this.sendAuthor();
        case "reklama":
        case "ad":
          if (!isPrivate) return;
          if (!this.isAuthor(m.from)) return this.adContact();
          return this.adMenu();
        case "stat":
        case "stats": {
          if (!isPrivate || !this.isAuthor(m.from)) return;
          const s = await this.store().userStats();
          return this.send(`📊 <b>Bot statistikasi</b>\n\n👥 Foydalanuvchilar: ${s.users}\n🚫 Bloklaganlar: ${s.blocked}\n🎲 Testlar: ${s.quizzes}\n🏁 Yechilgan testlar: ${s.results}`);
        }
        case "guide":
        case "yoriqnoma":
          return this.sendGuide();
        case "setguide":
          if (!isPrivate) return;
          if (!this.isAuthor(m.from)) return this.send("Bu buyruq faqat bot muallifi uchun.");
          await this.st.put("awaitGuide", true);
          return this.send("📖 Yo'riqnoma PDF faylini yuboring. Obunachilar uni «📖 Yo'riqnoma» tugmasi orqali yuklab oladi.\nBekor qilish: /cancel");
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
          await this.st.delete("manual");
          await this.st.delete("awaitAd");
          await this.st.delete("awaitGuide");
          await this.st.delete("create");
          await this.st.delete("edit");
          return this.send("❌ Bekor qilindi.");
        case "skip":
          if (isPrivate) return this.onSkip();
          return;
      }
      return;
    }
    if (!isPrivate) return;
    if (m.document && (await this.st.get("awaitGuide")) && this.isAuthor(m.from)) {
      await this.st.delete("awaitGuide");
      await this.store().setSetting("guide", m.document.file_id);
      await this.send("✅ Yo'riqnoma saqlandi! Obunachilar endi uni «📖 Yo'riqnoma» tugmasi yoki /guide orqali yuklab olishadi.");
      return this.sendGuide();
    }
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
    if (text === BTN_GUIDE) return this.sendGuide();
    if (text === BTN_AD) return this.isAuthor(m.from) ? this.adMenu() : this.adContact();
    if (!text) return;

    // Tahrirlash uchun matn kutilmoqda
    const ed = await this.st.get("edit");
    if (ed) return this.onEditText(ed, text, m.from.id, m.from);

    const create = await this.st.get("create");
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
      create.title = text.trim().slice(0, 100);
      return this.askDesc(create);
    }
    if (create?.step === "desc") {
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
    try {
      const f = await tg(this.env, "getFile", { file_id: doc.file_id });
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
      return this.beginCreate(parsed, name.replace(/\.[^.]+$/, "").replace(/_/g, " "));
    } catch (e) {
      console.log("Fayl xatosi", e);
      return this.send("❗ Faylni o'qib bo'lmadi. Formatni tekshiring: /help");
    }
  }

  // ---------- Test yaratish bosqichlari ----------
  async beginCreate(parsed, fallbackTitle) {
    // Tayyor test savollari (istalgan fan)
    const mcq = parsed.mcq;
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
    const title = (parsed.title || fallbackTitle).slice(0, 60);
    const secs = parsed.sections
      .map((name, i) => ({ name, i, n: all.filter((p) => p[2] === i).length }))
      .filter((s) => s.n > 0);
    if (secs.length > 1) {
      await this.st.put("create", { all, title, secs, step: "sec" });
      const rows = secs.map((s) => [btn(`${s.name} (${s.n})`, `sec:${s.i}`)]);
      rows.push([btn(`📚 Hammasi (${all.length})`, "sec:all")]);
      return this.send(`📄 <b>${esc(title)}</b>\n📖 ${all.length} ta so'z topildi.\n\nQaysi bo'limdan test tuzamiz?`, { reply_markup: kb(rows) });
    }
    return this.askCount(all.map((p) => [p[0], p[1]]), title);
  }

  async askCount(pairs, title, editId, extra = {}) {
    if (!extra.mcq && pairs.length < 4) return this.send("❗ Bu bo'limda 4 tadan kam so'z bor. Boshqa bo'limni tanlang.");
    await this.st.put("create", { pairs, title, step: "count", mcq: !!extra.mcq });
    const n = pairs.length;
    const opts = [10, 20, 30, 50].filter((x) => x < n);
    const text = (extra.head || `📄 <b>${esc(title)}</b>\n📖 <b>${n}</b> ta so'z.`) + "\n\nNechta savol bo'lsin?";
    const reply_markup = kb([opts.map((x) => btn(String(x), `cnt:${x}`)),
      [btn(`Hammasi (${n})`, `cnt:${n}`), btn("✏️ Boshqa son", "cnt:custom")]]);
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
        : this.env.TESTS_CHANNEL ? "\n📢 Test kanalimizga ham joylandi." : ""));
    if (!author) await this.postToChannel(quiz, from);
    return this.send(c.text, { reply_markup: c.reply_markup });
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
    const r = await tg(this.env, "sendMessage", { chat_id: ch, text, parse_mode: "HTML",
      reply_markup: kb([[{ text: "▶️ Testni boshlash", url: `https://t.me/${me}?start=${quiz.id}` }],
        [{ text: "👥 Guruhda boshlash", url: `https://t.me/${me}?startgroup=${quiz.id}` }]]) });
    if (r.ok) await this.store().setChanMsg(quiz.id, r.result.message_id);
  }

  async myTests(owner) {
    const rows = await this.store().listQuizzes(owner);
    if (!rows.length) return this.send("Hali test yo'q. Faylni yuboring yoki /newquiz 📄");
    return this.send("📚 Sizning testlaringiz:", {
      reply_markup: kb(rows.map((r) => [btn(`🎲 ${r.title} · ${r.count} savol`, `open:${r.id}`)])),
    });
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
      tg(this.env, "answerCallbackQuery", { callback_query_id: cq.id, text, show_alert: alert });
    const i = data.indexOf(":");
    const [kind, val] = i < 0 ? [data, ""] : [data.slice(0, i), data.slice(i + 1)];
    const store = this.store();

    if (kind === "ad" || kind === "admode" || kind === "adgo" || kind === "adrm" || kind === "adrmok") {
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
        return this.edit(msgId, `✅ Reklama #${id} «${esc(d.title)}» ${pos > 1 ? `navbatga qo'shildi (${pos}-o'rinda)` : "tarqatilmoqda"}.` +
          `\n${mode === "pin" ? "📌 Qadaladi." : "📤 Post qilib yuboriladi."} ⏳ ${days ? `${days} kun (${fmtDate(Date.now() + days * 86400e3)} gacha)` : "Muddatsiz"}` +
          "\nTugagach xabar beraman. Boshqaruv: /reklama");
      }
      if (kind === "adrm") {
        const ad = await store.getAd(+val);
        if (!ad || !ad.active) { await answer("Bu reklama allaqachon o'chirilgan"); return this.adMenu(msgId); }
        await answer();
        return this.edit(msgId, `🗑 #${ad.id} «${esc(ad.title)}» reklamasini barcha chatlardan olib tashlaymizmi?`,
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
        await tg(this.env, "sendMessage", { chat_id: quiz.owner, text: `✅ «${esc(quiz.title)}» testingiz tekshiruvdan o'tdi. Endi uni ishlatishingiz mumkin: /mytests`, parse_mode: "HTML" });
        if (quiz.status === "pending") await this.postToChannel(quiz, { id: quiz.owner, first_name: "obunachi" });
        return this.edit(msgId, `✅ «${esc(quiz.title)}» — ruxsat berildi.`);
      }
      if (act === "del") {
        const post = await store.adminDeleteQuiz(quiz.id);
        if (post && this.env.TESTS_CHANNEL) await tg(this.env, "deleteMessage", { chat_id: this.env.TESTS_CHANNEL, message_id: post });
        await tg(this.env, "sendMessage", { chat_id: quiz.owner, text: `🗑 «${esc(quiz.title)}» testingiz bot qoidalariga zid bo'lgani uchun o'chirildi.`, parse_mode: "HTML" });
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

    if (kind === "deldata") {
      await answer();
      if (val === "ok") {
        const res = await store.deleteUserData(uid);
        if (this.env.TESTS_CHANNEL)
          for (const mid of res.posts) await tg(this.env, "deleteMessage", { chat_id: this.env.TESTS_CHANNEL, message_id: mid });
        for (const k of ["sess", "create", "edit", "retry", "reg", "awaitAd", "adDraft", "awaitGuide", "pendingStart"]) await this.st.delete(k);
        return this.edit(msgId, `✅ Ma'lumotlaringiz o'chirildi.\n🎲 O'chirilgan testlar: ${res.quizzes}\n\nBotdan yana foydalanishingiz mumkin — /start`);
      }
      if (val !== "no")
        return this.edit(msgId, "🗑 <b>Ma'lumotlaringizni o'chirasizmi?</b>\n\nBotdagi barcha testlaringiz (kanaldagi postlari bilan), natijalaringiz va reytingdagi o'rningiz butunlay o'chiriladi. Buni qaytarib bo'lmaydi.",
          { reply_markup: kb([[btn("Ha, o'chirish", "deldata:ok"), btn("Yo'q", "deldata:no")]]) });
      return this.settingsMenu(msgId);
    }

    if (kind === "pub") {
      const quiz = await store.getQuiz(val);
      if (!quiz || quiz.owner !== uid || !this.isAuthor(cq.from)) return answer("Faqat muallif uchun", true);
      const on = !quiz.public;
      await store.setPublic(quiz.id, on);
      if (on) {
        await this.postToChannel(quiz, cq.from);
        await answer("🌐 Endi hammaga ko'rinadi va kanalga joylandi");
      } else {
        if (quiz.chanMsg && this.env.TESTS_CHANNEL) await tg(this.env, "deleteMessage", { chat_id: this.env.TESTS_CHANNEL, message_id: quiz.chanMsg });
        await store.setChanMsg(quiz.id, null);
        await answer("🔒 Obunachilardan yashirildi");
      }
      return this.showCard(await store.getQuiz(quiz.id), uid, msgId);
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
    if (["sec", "cnt", "dir", "ttl", "dsc", "tm", "shf"].includes(kind)) {
      const create = await this.st.get("create");
      if (!create) return answer("Faylni qayta yuboring", true);
      if (kind === "sec") {
        if (!create.all) return answer("Faylni qayta yuboring", true);
        const s = create.secs.find((x) => String(x.i) === val);
        const pairs = create.all.filter((p) => !s || p[2] === s.i).map((p) => [p[0], p[1]]);
        await this.askCount(pairs, s ? `${create.title} — ${s.name}` : create.title, msgId);
        return answer();
      }
      if (!create.pairs) return answer("Faylni qayta yuboring", true);
      if (kind === "cnt") {
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
        if (q?.img) await tg(this.env, "sendPhoto", { chat_id: this.chatId, photo: q.img, caption: `${idx + 1}-savol rasmi` });
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
        if (quiz.chanMsg && this.env.TESTS_CHANNEL) await tg(this.env, "deleteMessage", { chat_id: this.env.TESTS_CHANNEL, message_id: quiz.chanMsg });
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
  async prepareSession(quiz, userId, chatType, { record = true } = {}) {
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
      scores: {}, wrong: [], asked: 0, cur: null, stopped: false, phase: "ready", miss: 0, ready: [], record,
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
    return tg(this.env, "editMessageReplyMarkup", { chat_id: this.chatId, message_id: s.readyMsg,
      reply_markup: kb([[btn(`✅ Tayyorman! (${s.ready.length}/${MIN_READY})`, "go")], [btn("▶️ Hozir boshlash", "now")]]) });
  }

  async onStartNow(cq, answer) {
    const s = await this.st.get("sess");
    if (!s || s.phase !== "ready") return answer();
    if (cq.from.id !== s.starter) {
      const m = await tg(this.env, "getChatMember", { chat_id: this.chatId, user_id: cq.from.id });
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
    const sess = await this.st.get("sess");
    if (!sess || sess.phase !== "run") return;
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
      const ph = await tg(this.env, "sendPhoto", { chat_id: this.chatId, photo: q.img,
        ...(long ? { caption: `<b>${num}</b> ${esc(q.q)}`.slice(0, 1024), parse_mode: "HTML" } : {}) });
      if (long) question = ph.ok ? `${num} ⬆️ Rasmdagi savolga javob bering` : question.slice(0, 297) + "…";
    } else if (long) {
      // Uzun savol: matnini alohida xabar qilib, so'rovnomada qisqa yozamiz
      await this.send(`<b>${num}</b> ${esc(q.q)}`);
      question = `${num} ⬆️ Yuqoridagi savolga javob bering`;
    }
    const body = { chat_id: this.chatId, question,
      options: q.opts.map((o) => ({ text: o.length > 100 ? o.slice(0, 99) + "…" : o })),
      type: "quiz", correct_option_id: q.correct, is_anonymous: false };
    if (q.exp) body.explanation = q.exp.slice(0, EXP_MAX);
    if (sess.timer) body.open_period = sess.timer;
    const r = await tg(this.env, "sendPoll", body);
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
    await this.st.put("sess", sess);
    if (!sess.isGroup) await this.st.setAlarm(Date.now() + 1000);
  }

  async stop(userId) {
    this.chatId ??= await this.st.get("chatId");
    const sess = await this.st.get("sess");
    if (!sess) return this.send("Hozir test ketmayapti.");
    if (sess.isGroup && userId !== sess.starter) {
      const m = await tg(this.env, "getChatMember", { chat_id: this.chatId, user_id: userId });
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
    const rows = [[btn("🔁 Qayta urinish", `run:${s.qid}`)]];
    if (s.wrong.length) {
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
  const results = [];
  for (const z of quizzes.slice(0, 20)) {
    const n = z.questions?.length || z.count;
    let text = `🎲 <b>${esc(z.title)}</b>\n`;
    if (z.description) text += `<i>${esc(z.description)}</i>\n`;
    text += `\n🖊 ${n} ta savol\n⏱ Har bir savolga ${timerLabel(z.timer)}`;
    results.push({
      type: "article", id: z.id, title: z.title, description: `${n} ta savol · ${timerLabel(z.timer)}`,
      input_message_content: { message_text: text, parse_mode: "HTML" },
      reply_markup: kb([[{ text: "▶️ Testni boshlash", url: `https://t.me/${me}?start=${z.id}` }],
        [{ text: "👥 Guruhda boshlash", url: `https://t.me/${me}?startgroup=${z.id}` }]]),
    });
  }
  return tg(env, "answerInlineQuery", { inline_query_id: iq.id, results, cache_time: 0, is_personal: true });
}

// Reklamani bitta chatga nusxalash (bitta post yoki albom). Yuborilgan xabarlar id larini qaytaradi.
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
const BATCH = 25;
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
  // Vazifani navbatga qo'shish; navbatdagi o'rnini qaytaradi
  async enqueue(job) {
    const q = (await this.st.get("queue")) || [];
    q.push({ ...job, after: 0, ok: 0, fail: 0, started: Date.now() });
    await this.st.put("queue", q);
    if (q.length === 1) await this.st.setAlarm(Date.now() + 200);
    return q.length;
  }
  async scheduleExpiry() {
    const t = await this.store().nextExpiry();
    if (t) await this.st.setAlarm(Math.max(Date.now() + 1000, t));
  }
  async alarm() {
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
      if (!ad.active) return done(`ℹ️ #${ad.id} «${esc(ad.title)}» o'chirilgani uchun tarqatish to'xtatildi (${job.ok} taga yetib borgan edi).`);
      const users = await store.listUsers(job.after, BATCH);
      if (!users.length) {
        await store.adStats(ad.id, job.ok, job.fail);
        const mins = Math.max(1, Math.round((Date.now() - job.started) / 60000));
        return done(`✅ <b>Reklama #${ad.id} tarqatildi!</b>\n«${esc(ad.title)}»\n\n📤 Yetib bordi: <b>${job.ok}</b>\n🚫 Yetib bormadi (botni bloklagan): ${job.fail}\n⏱ ${mins} daqiqa` +
          (ad.pin ? "\n📌 Barcha chatlarda tepaga qadaldi." : "") +
          (ad.expires ? `\n⏳ ${fmtDate(ad.expires)} da avtomatik olib tashlanadi.` : "") + "\n\nBoshqaruv: /reklama");
      }
      const rows = [];
      for (const uid of users) {
        const r = await copyAd(this.env, uid, ad);
        if (r.ok) {
          if (ad.pin && r.msgs[0]) await tg(this.env, "pinChatMessage", { chat_id: uid, message_id: r.msgs[0], disable_notification: true });
          rows.push([uid, r.msgs]);
          job.ok++;
        } else if (r.error_code === 429) {
          break; // Telegram "sekinroq" dedi — shu foydalanuvchidan keyinroq davom etamiz
        } else {
          job.fail++;
          if (r.error_code === 403 || /chat not found|deactivated|blocked/i.test(r.description || "")) await store.markBlocked(uid);
        }
        job.after = uid;
        if (job.ok % 500 === 0 && job.ok && r.ok) await store.adStats(ad.id, job.ok, job.fail);
      }
      if (rows.length) await store.addDeliveries(ad.id, rows);
      q[0] = job;
      await this.st.put("queue", q);
      return this.st.setAlarm(Date.now() + (rows.length < users.length && job.after !== users[users.length - 1] ? 6000 : 1100));
    }

    if (job.type === "remove") {
      const rows = await store.listDeliveries(ad.id, job.after, BATCH);
      if (!rows.length) {
        await store.clearDeliveries(ad.id);
        return done(`🗑 Reklama #${ad.id} «${esc(ad.title)}» ${job.ok} ta chatdan olib tashlandi (${job.reason || "o'chirildi"}).`);
      }
      for (const { uid, msgs } of rows) {
        if (ad.pin && msgs[0]) await tg(this.env, "unpinChatMessage", { chat_id: uid, message_id: msgs[0] });
        const r = await tg(this.env, "deleteMessages", { chat_id: uid, message_ids: msgs });
        if (r.error_code === 429) break;
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
