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
const MAIN_KB = { keyboard: [[{ text: BTN_NEW }, { text: BTN_MY }], [{ text: BTN_GUIDE }, { text: BTN_AUTHOR }]], resize_keyboard: true, is_persistent: false, one_time_keyboard: true };
const authorOf = (env) => env.AUTHOR || "@Shehroz_hoca";

const HELP =
  "📚 <b>LingoUP bot</b>\n\n" +
  "Fayl yuboring — bot undan tayyor test tuzib beradi.\n\n" +
  "1️⃣ Faylni yuboring (PDF, Word, Excel, .txt)\n" +
  "2️⃣ Bo'lim va savollar sonini tanlang\n" +
  "3️⃣ Test nomi, tavsifi, vaqti va aralashtirishni belgilang\n" +
  "4️⃣ Tayyor! O'zingiz yeching, guruhda o'tkazing yoki ulashing 👥\n\n" +
  "/newquiz — yangi test\n/mytests — mening testlarim\n/guide — yo'riqnoma\n/stop — testni to'xtatish\n/cancel — bekor qilish";

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

function newId() {
  const abc = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const b = crypto.getRandomValues(new Uint8Array(8));
  return [...b].map((x) => abc[x % abc.length]).join("");
}

async function webhookSecret(env) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("wh:" + env.BOT_TOKEN));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40);
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
    out.push({ q: q.slice(0, 280), opts, correct: opts.indexOf(a), pair: [word, tr] });
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
    for (const col of ["description TEXT", "shuffle TEXT", "questions TEXT"]) {
      try { this.sql.exec(`ALTER TABLE quizzes ADD COLUMN ${col}`); } catch {}
    }
    this.sql.exec(`CREATE TABLE IF NOT EXISTS polls(id TEXT PRIMARY KEY, chat TEXT, created INTEGER)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS results(qid TEXT, uid INTEGER, name TEXT, ok INTEGER, total INTEGER,
      secs REAL, created INTEGER, PRIMARY KEY(qid, uid))`);
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
  // Faqat birinchi urinish reytingga yoziladi (QuizBot kabi)
  addResult(qid, uid, name, ok, total, secs) {
    this.sql.exec("INSERT OR IGNORE INTO results VALUES(?,?,?,?,?,?,?)", qid, uid, name, ok, total, secs, Date.now());
    return this.placeOf(qid, uid);
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
  top(qid, n = 10) {
    return this.sql.exec("SELECT name,ok,total,secs FROM results WHERE qid=? ORDER BY ok DESC, secs ASC LIMIT ?", qid, n).toArray();
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
async function cardContent(env, quiz, { owner = false, takers = null } = {}) {
  const me = await botName(env);
  const n = quiz.questions?.length || quiz.count;
  let text = `🎲 <b>${esc(quiz.title)}</b>\n`;
  if (quiz.description) text += `<i>${esc(quiz.description)}</i>\n`;
  text += `\n🖊 ${n} ta savol\n⏱ Har bir savolga ${timerLabel(quiz.timer)}\n🔀 ${SHUFFLE[quiz.shuffle || "all"]}`;
  if (takers != null) text += `\n👥 ${takers} kishi yechgan`;
  text += `\n\n🔗 https://t.me/${me}?start=${quiz.id}`;
  const rows = [
    [btn("▶️ Testni boshlash", `run:${quiz.id}`)],
    [{ text: "👥 Guruhda boshlash", url: `https://t.me/${me}?startgroup=${quiz.id}` }],
    [{ text: "🔗 Testni ulashish", switch_inline_query: quiz.id }],
  ];
  if (owner) rows.push([btn("✏️ Tahrirlash", `edit:${quiz.id}`), btn("📊 Statistika", `stat:${quiz.id}`)]);
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
    const ch = this.env.CHANNEL;
    if (!ch) return true;
    const until = await this.st.get("m:" + uid);
    if (until && until > Date.now()) return true;
    const r = await tg(this.env, "getChatMember", { chat_id: ch, user_id: uid });
    if (!r.ok) return true; // bot kanalda admin bo'lmasa — hammani o'tkazamiz (loglarda xato ko'rinadi)
    const s = r.result.status;
    const ok = ["creator", "administrator", "member"].includes(s) || (s === "restricted" && r.result.is_member);
    if (ok) await this.st.put("m:" + uid, Date.now() + 3600e3);
    return ok;
  }
  joinPrompt() {
    const ch = this.env.CHANNEL;
    return this.send(
      `📢 Botdan foydalanish uchun avval kanalimizga a'zo bo'ling:\n👉 ${esc(ch)}\n\nA'zo bo'lgach, «✅ Tekshirish» tugmasini bosing.\n\n👨‍🏫 Muallif: ${esc(authorOf(this.env))}`,
      { reply_markup: kb([[{ text: "📢 Kanalga o'tish", url: channelUrl(ch) }], [btn("✅ Tekshirish", "chk")]]) });
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

  async handle(update, chatId) {
    this.chatId = chatId;
    await this.st.put("chatId", chatId);
    const m = update.message;
    const cq = update.callback_query;
    const isPrivate = (m?.chat || cq?.message?.chat)?.type === "private";
    const uid = (m || cq)?.from?.id;
    if (isPrivate && uid && cq?.data !== "chk" && !(await this.isMember(uid))) {
      const arg = m?.text?.match(/^\/start\s+(\S+)/)?.[1];
      if (arg) await this.st.put("pendingStart", arg);
      if (cq) await tg(this.env, "answerCallbackQuery", { callback_query_id: cq.id });
      return this.joinPrompt();
    }
    if (m) return this.onMessage(m);
    if (cq) return this.onCallback(cq);
  }

  // ---------- Xabarlar ----------
  async onMessage(m) {
    const isPrivate = m.chat.type === "private";
    const isGroup = m.chat.type === "group" || m.chat.type === "supergroup";
    const text = m.text || "";
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
          return this.send("📄 Test tuzish uchun faylni yuboring (PDF, Word, Excel, .txt) yoki matnni xabar qilib yozing.");
        case "mytests":
        case "myquizzes":
          return isPrivate ? this.myTests(m.from.id) : null;
        case "cancel":
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
    // Pastki tugmalar
    if (text === BTN_NEW) {
      await this.st.delete("create");
      await this.st.delete("edit");
      return this.send("📄 Test tuzish uchun faylni yuboring (PDF, Word, Excel, .txt) yoki matnni xabar qilib yozing.");
    }
    if (text === BTN_MY) return this.myTests(m.from.id);
    if (text === BTN_AUTHOR) return this.sendAuthor();
    if (text === BTN_GUIDE) return this.sendGuide();
    if (!text) return;

    // Tahrirlash uchun matn kutilmoqda
    const ed = await this.st.get("edit");
    if (ed) return this.onEditText(ed, text, m.from.id);

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

  async finishCreate(create, uid, msgId) {
    let questions, pairs = create.pairs, direction = create.direction || "fwd";
    if (create.mcq) {
      // Tayyor savollar: kerakli sonini tanlab, asl tartibini saqlaymiz
      const idx = sample([...create.pairs.keys()], create.count).sort((a, b) => a - b);
      questions = idx.map((i) => create.pairs[i]).map((q) => ({ q: q.q, opts: q.opts.map((o) => o || "—"), correct: q.correct,
        pair: [q.q.length > 80 ? q.q.slice(0, 77) + "…" : q.q, q.opts[q.correct]] }));
      pairs = [];
      direction = "mcq";
    } else questions = buildQuestions(create.pairs, create.count, direction);
    const store = this.store();
    const id = await store.saveQuiz({ owner: uid, title: create.title, description: create.description || "",
      pairs, direction, timer: create.timer, shuffle: create.shuffle, questions });
    await this.st.delete("create");
    const quiz = await store.getQuiz(id);
    const c = await cardContent(this.env, quiz, { owner: true, takers: 0 });
    await this.edit(msgId, "👍 Test yaratildi! Endi uni yechishingiz, guruhda o'tkazishingiz yoki ulashishingiz mumkin.");
    return this.send(c.text, { reply_markup: c.reply_markup });
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
    const takers = owner ? await this.store().takers(quiz.id) : null;
    const c = await cardContent(this.env, quiz, { owner, takers });
    return editId ? this.edit(editId, c.text, { reply_markup: c.reply_markup }) : this.send(c.text, { reply_markup: c.reply_markup });
  }

  async openQuiz(id, from, chatType) {
    const quiz = await this.store().getQuiz(id);
    if (!quiz) return this.send("❗ Test topilmadi yoki o'chirilgan.");
    if (chatType === "private") return this.showCard(quiz, from.id);
    if (!(await this.isMember(from.id))) {
      return this.send(`📢 Testni boshlash uchun avval kanalga a'zo bo'ling: ${esc(this.env.CHANNEL)}`,
        { reply_markup: kb([[{ text: "📢 Kanalga o'tish", url: channelUrl(this.env.CHANNEL) }]]) });
    }
    return this.prepareSession(quiz, from.id, chatType);
  }

  // ---------- Tahrirlash ----------
  async editMenu(quiz, msgId) {
    const text = `✏️ <b>${esc(quiz.title)}</b> — nimani o'zgartiramiz?`;
    const reply_markup = kb([
      [btn("✏️ Nomi", `ef:title:${quiz.id}`), btn("📝 Tavsif", `ef:desc:${quiz.id}`)],
      [btn("⏱ Vaqt", `ef:timer:${quiz.id}`), btn("🔀 Aralashtirish", `ef:shuf:${quiz.id}`)],
      [btn("🗑 O'chirish", `del:${quiz.id}`)],
      [btn("⬅️ Orqaga", `open:${quiz.id}`)],
    ]);
    return this.edit(msgId, text, { reply_markup });
  }

  async onEditText(ed, text, uid) {
    await this.st.delete("edit");
    const field = ed.field === "title" ? "title" : "description";
    const value = text.trim() === "/skip" || text.trim() === "-" ? "" : text.trim().slice(0, field === "title" ? 100 : 300);
    if (field === "title" && !value) return this.send("Nom bo'sh bo'lishi mumkin emas.");
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
        return this.finishCreate(create, uid, msgId);
      }
    }

    // Test kartasi va tahrirlash
    if (kind === "open") {
      const quiz = await store.getQuiz(val);
      await answer();
      if (!quiz) return this.send("❗ Test topilmadi.");
      return this.showCard(quiz, uid, cq.message.text?.startsWith("✏️") || cq.message.text?.startsWith("📊") ? msgId : undefined);
    }
    if (["edit", "ef", "et", "es", "del", "delok", "stat"].includes(kind)) {
      const id = val.split(":").pop();
      const quiz = await store.getQuiz(id);
      if (!quiz) return answer("Test topilmadi", true);
      if (kind === "stat") {
        await answer();
        const top = await store.top(id, 10);
        const takers = await store.takers(id);
        const medals = ["🥇", "🥈", "🥉"];
        const lines = top.map((r, k) => `${medals[k] || k + 1 + "."} ${esc(r.name)} — ${r.ok}/${r.total} (${fmtTime(r.secs)})`);
        return this.edit(msgId, `📊 <b>${esc(quiz.title)}</b>\n\n👥 ${takers} kishi yechgan` +
          (lines.length ? `\n\n🏆 Eng yaxshi natijalar:\n${lines.join("\n")}` : ""),
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
        await store.deleteQuiz(id, uid);
        return this.edit(msgId, "🗑 Test o'chirildi.");
      }
    }

    // Test o'tkazish
    if (kind === "run") {
      const quiz = await store.getQuiz(val);
      if (!quiz) return answer("Test o'chirilgan", true);
      const type = cq.message.chat.type;
      if (type !== "private" && !(await this.isMember(uid))) return answer(`Avval kanalga a'zo bo'ling: ${this.env.CHANNEL}`, true);
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
    if (!(await this.isMember(uid))) return answer(`Avval kanalga a'zo bo'ling: ${this.env.CHANNEL}`, true);
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
    if (question.length > 300) {
      // Uzun savol: matnini alohida xabar qilib, so'rovnomada qisqa yozamiz
      await this.send(`<b>${num}</b> ${esc(q.q)}`);
      question = `${num} ⬆️ Yuqoridagi savolga javob bering`;
    }
    const body = { chat_id: this.chatId, question,
      options: q.opts.map((o) => ({ text: o.length > 100 ? o.slice(0, 99) + "…" : o })),
      type: "quiz", correct_option_id: q.correct, is_anonymous: false };
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
      return this.send(text, { reply_markup: kb([[btn("🔁 Yana o'ynash", `run:${s.qid}`)],
        [{ text: "📚 Botga o'tish", url: `https://t.me/${me}?start=${s.qid}` }]]) });
    }
    const [uid, sc] = Object.entries(s.scores)[0] || [s.starter, { name: "", ok: 0, bad: 0, t: 0 }];
    const missed = s.asked - sc.ok - sc.bad;
    let text = `🏁 <b>${title}</b> testi yakunlandi!\n\nSiz ${s.asked} ta savolga javob berdingiz:\n\n` +
      `✅ To'g'ri — ${sc.ok}\n❌ Xato — ${sc.bad}\n⌛️ O'tkazilgan — ${missed}\n⏱ ${fmtTime(sc.t)}`;
    if (s.record && s.asked) {
      const pl = await store.addResult(s.qid, +uid, sc.name || "Foydalanuvchi", sc.ok, s.asked, sc.t);
      if (pl) text += `\n\n🏆 Siz ${pl.total} ishtirokchi ichida <b>${pl.place}-o'rin</b>dasiz.`;
    }
    const rows = [[btn("🔁 Qayta urinish", `run:${s.qid}`)]];
    if (s.wrong.length) {
      const wrongQs = s.questions.filter((q) => s.wrong.some((w) => w[0] === q.pair[0] && w[1] === q.pair[1]));
      await this.st.put("retry", { qid: s.qid, title: s.title.replace(/ — xatolar$/, ""), timer: s.quizTimer, questions: wrongQs });
      text += "\n\n📝 <b>Takrorlash kerak:</b>\n" + s.wrong.slice(0, 30).map(([a, b]) => `• ${esc(a)} — ${esc(b)}`).join("\n");
      rows.unshift([btn(`🎯 Xatolarni qayta ishlash (${s.wrong.length})`, "retry")]);
    }
    if (shareRow) rows.push(shareRow);
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
      await tg(env, "setMyCommands", { commands: [
        { command: "start", description: "Boshlash" },
        { command: "newquiz", description: "Yangi test yaratish" },
        { command: "mytests", description: "Mening testlarim" },
        { command: "stop", description: "Testni to'xtatish" },
        { command: "cancel", description: "Bekor qilish" },
        { command: "guide", description: "Yo'riqnoma (PDF)" },
        { command: "author", description: "Muallif bilan bog'lanish" },
        { command: "help", description: "Yordam" },
      ] });
      let msg = r.ok ? "✅ Bot ulandi! Endi Telegramda botingizga /start yozing." : "❌ Xato: " + r.description;
      if (env.CHANNEL) {
        const me = (await tg(env, "getMe", {})).result;
        const cm = await tg(env, "getChatMember", { chat_id: env.CHANNEL, user_id: me?.id });
        msg += cm.ok && cm.result.status === "administrator"
          ? `\n✅ Kanal tekshiruvi ishlaydi: ${env.CHANNEL}`
          : `\n⚠️ Bot ${env.CHANNEL} kanalida admin emas — a'zolik tekshirilmaydi. Botni kanalga admin qilib qo'shing.`;
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
