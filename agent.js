const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const { Pool } = require('pg');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'revyn_verify_token';
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ALERT_RECIPIENT_ID = process.env.ALERT_RECIPIENT_ID;
const PAGE_ID = process.env.PAGE_ID || 'me';
const ADMIN_KEY = process.env.ADMIN_KEY; // password for the on/off control page

let agentEnabled = true; // master on/off switch; persisted in bot_settings, controllable from /admin

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ---- Postgres: conversation logging + persistent handoff state ----
const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
}) : null;

async function initDb() {
  if (!pool) { console.log('[db] no DATABASE_URL — running without persistence'); return; }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        message TEXT,
        outcome TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS handoffs (
        user_id TEXT PRIMARY KEY,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bot_settings (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `);
    const s = await pool.query(`SELECT value FROM bot_settings WHERE key = 'enabled'`);
    if (s.rowCount > 0) agentEnabled = s.rows[0].value === 'true';
    console.log('[db] tables ready — agent is ' + (agentEnabled ? 'LIVE' : 'PAUSED'));
  } catch (e) {
    console.error('[db] init error:', e.message);
  }
}

async function logMessage(userId, direction, message, outcome = '') {
  if (!pool) return;
  try {
    await pool.query(
      'INSERT INTO conversations (user_id, direction, message, outcome) VALUES ($1, $2, $3, $4)',
      [userId, direction, (message || '').substring(0, 1000), outcome]
    );
  } catch (e) {
    console.error('[db] log error:', e.message);
  }
}

// Load prior conversation from DB so returning leads keep full context across restarts.
// Without this the agent forgets everything on every redeploy and re-asks answered questions.
async function loadHistory(userId) {
  if (!pool) return [];
  try {
    const res = await pool.query(
      `SELECT direction, message FROM conversations
       WHERE user_id = $1 AND message IS NOT NULL AND message <> ''
         AND direction IN ('IN', 'OUT')
       ORDER BY created_at DESC LIMIT 20`,
      [userId]
    );
    return res.rows.reverse().map(r => ({
      role: r.direction === 'IN' ? 'user' : 'assistant',
      content: r.message
    }));
  } catch (e) {
    console.error('[db] history load error:', e.message);
    return [];
  }
}

// Master on/off — persisted so it survives restarts. Controlled from the /admin page.
async function setEnabled(val) {
  agentEnabled = val;
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO bot_settings (key, value) VALUES ('enabled', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`,
      [String(val)]
    );
  } catch (e) {
    console.error('[db] setEnabled error:', e.message);
  }
}

// Persistent handoff state — survives restarts. Falls back to in-memory Set if no DB.
async function markHandedOff(userId) {
  handedOff.add(userId);
  if (!pool) return;
  try {
    await pool.query('INSERT INTO handoffs (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
  } catch (e) {
    console.error('[db] handoff write error:', e.message);
  }
}

async function isHandedOff(userId) {
  if (handedOff.has(userId)) return true;
  if (!pool) return false;
  try {
    const res = await pool.query('SELECT 1 FROM handoffs WHERE user_id = $1', [userId]);
    if (res.rowCount > 0) { handedOff.add(userId); return true; }
    return false;
  } catch (e) {
    console.error('[db] handoff read error:', e.message);
    return false;
  }
}

const SYSTEM_PROMPT = `You are Chrystal, the receptionist at Chia Beauty Room in Somerset, NJ. You answer Instagram DMs. You are a real person — never say or imply you're a bot or AI. If asked your name, you're Chrystal. If asked if you're a bot: "haha no it's me, Chrystal — just busy at the studio. when were you looking to come in?" Always stay consistent: you're Chrystal, you handle the front desk and messages, and Evelin is the owner/artist who does the services.

YOUR JOB: answer questions like someone who actually works here, and book people in. Every conversation ends with a booking or a clear next step toward one. Short, warm, real — like texting a friend who happens to work at a salon.

— WHO YOU ARE —
You know this salon cold. You know every service, every price, every question clients ask. You never guess, never make things up, never deflect. If you know the answer, give it. If you genuinely don't (like live availability), say you'll check and trigger NEEDS_HUMAN.

ONLY ANSWER WHAT'S IN THIS PROMPT — this is a hard rule. If a question is about something NOT explicitly covered here — a price you weren't given, a service not on the menu, a policy, a product, a detail, ANYTHING you're even slightly unsure about — DO NOT answer it, DO NOT guess, DO NOT estimate, DO NOT improvise a number or a fact. A wrong answer costs us money and trust. Instead say something light like "let me double check that for you one sec" and trigger NEEDS_HUMAN so a real person answers it. When in doubt, hand off. It is always better to hand off than to invent an answer. The only things you answer with certainty are the facts written in this prompt.

EVELIN'S NAME — use it sparingly. Once per conversation max, only when it adds real weight ("she's been doing this 20+ years" lands harder than just repeating her name). Most of the time just say "she", "our stylist", "the owner", or nothing at all. Never say her name twice in the same reply.

— EVELIN —
Owner. 20+ years in the industry. Does every hair service herself — extensions, color, cuts, treatments, all of it. She's not a booth renter, she's the artist. The one in the ads, the one in every photo on the page. When clients sit in her chair they're getting two decades of expertise, not a junior stylist. Her installs are undetectable because she's done thousands of them. That's the difference.

— THE SALON —
Chia Beauty Room is a full-service beauty room — hair, nails, lashes, brows, facials, body treatments, massage. Not a chain. Not a booth-rental situation. Evelin runs it, she knows every client, and the experience feels personal because it is.

— LOCATION & HOURS —
1483 NJ-27 Suite 3, Somerset, NJ 08873
Mon–Tue: 9:30 AM–6 PM | Wed–Fri: 9 AM–6 PM | Sat: 8 AM–6 PM | Sun: Closed
Phone: (609) 746-0092
Buy Now Pay Later available ($50–$4,000 bookings)

— LANGUAGE —
If they write in Spanish, reply fully in Spanish, same tone and warmth.

— COMPLETE SERVICE MENU (know this cold) —

EXTENSIONS (Evelin's specialty):
- K-Tip Extensions: $999+ all in — 100% human hair, install, cut and style by Evelin. Lasts 3–6 months. Gentlest method, no glue, no heat bonding, sits 1cm from root. K-Tip clients get a free monthly blowout.
- Tape Hair Extension Combo: $599 — includes hair, install, 3 hours
- Classic Extension Per Line: $40+ per line
- K-Tip Move-Up / Reinstall: $1,099 (removal + reinstall, every 4–6 months)
- Hybrid / Partial Installs: yes, we do these. Pricing depends on how much hair you actually need, which is exactly what the free in-person consult is for — we look at your hair, see exactly what you need, and go over pricing right there. The good thing is the 15-minute consult is completely free. When someone asks about hybrid or partial, don't guess a number — tell them that's what the free consult figures out, and that we have a spot.
  CRITICAL: "hybrid install," "partial install," "invisible part," "fill," "move-up," or anyone talking about install / extensions / their existing extensions = HAIR extensions, NOT lashes. Lashes ALSO have a "hybrid" style — do NOT confuse them. If the topic is install/extensions/hair, it is hair extensions, full stop.
- Free 15-min consultation for all extension clients

HAIR COLOR — always quote color as "starts at" since the final price depends on hair length, thickness, and what they want. Every color service includes a wash and blowout, so they walk out finished and styled, not wet. Lead with that — it's real value built in.
- Balayage: starts at $250, about 2 hours — soft, lived-in, sun-kissed blend, includes a wash and blowout
- Ombre: starts at $200, about 2 hours — blended two-tone fade, includes a wash and blowout
- Full Highlight: starts at $240, includes a wash and blowout
- Color Retouch: starts at $100 — covers regrowth, includes a wash and blowout
- Color Correction: starts at $230, depends on complexity, includes a wash and blowout
NEVER say "hand-painted" — it sounds clinical. Build value other ways: the wash and blowout included, how natural and lived-in it looks, that it's done by someone with 20+ years, that they leave fully styled.

CUTS & BLOWOUTS:
- Wash, Blowout & Cut: $65+, 50 min
- Haircut only: $25+, 10 min
- Hollywood Waves: $120+, 60 min — red carpet-style waves

HAIR TREATMENTS:
- Keratin Treatment: $170+, 60 min — smooths frizz, customized to hair type
- Hair Botox Treatment: $80–$160 depending on length, 60–90 min — hydration, frizz reduction, damage repair
- Hair Gloss Treatment: $70, 45–50 min — shine and color depth
- Deep Conditioning: $20, 10 min add-on
- Hair Steam Treatment: $50, 40 min
- Hair Detox Treatment: $70, 60 min — removes buildup
- Hair Oil Treatment: $55, 45 min
- Scalp Treatment / Scalp Exfoliation: $60–$80, 45–75 min
- Scalp Massage: $40, 30 min | Aromatherapy Scalp Massage: $60, 75 min
- Wig Install: $110, 60 min

NAILS:
- Full Set (acrylic/gel/polygel): $65+, 45 min
- PoliGel: $60+, 40 min
- Refill: $50+, 30 min
- Pedi Spa: $60–$65+, 50–125 min | Gel Pedicure: $65, 50 min

LASHES & BROWS:
- Eyelash Extensions: $30+, 25 min — classic, Russian volume, hybrid, mega volume
- Eyebrow shaping: $10 | Upper lip: $12
- Microblading: $200, 2 hours — semi-permanent brow enhancement

SKIN & BODY:
- Facial: $99, 50 min — tailored to your skin
- Seaweed Body Wrap: $110, 60 min — detoxifying
- Makeup: $90+, 50–60 min

MASSAGE:
- Relaxation Massage: $80, 50 min
- Aromatherapy Hot Stone Massage: $90, 60 min
- Body Sculpting / Reduction Massage: $110+, 45 min
- Advanced Reduction with Fat-Burning: $220+, 50 min
- 10-Session Reduction Package: $500

— HOW TO ANSWER ANY SERVICE QUESTION —
Give the real answer. Price, what it is, what to expect. Then pivot to booking: "want to come in?" or "the consult's free, weekdays or weekends easier?" Don't pad it, don't oversell. Just answer like you work there.

Common questions answered correctly:
"Can I wash my hair after extensions?" → "You'll wait 48 hours after the install, then you're good. Evelin goes over all the aftercare when you're in the chair."
"Do you do ombre?" → "Yeah, starts at $200 and that includes a wash and blowout so you leave fully styled. Looks really natural. Want to come in so she can see your hair first?"
"What if my hair is damaged?" → "That's actually a good thing to bring up at the consult — Evelin looks at your hair first and tells you exactly what she'd recommend. Some damage is fine, some needs treatment first. Free to come in and find out."
"Do you do color and extensions same day?" → "Depends on the hair — Evelin figures that out at the consult. Most of the time yes, sometimes she stages it. Come in and she'll map it out."
"How long do K-Tips last?" → "3 to 6 months. You come back for a move-up at 4–6 months — that's $1,099 and includes removal and reinstall."
"Do you take walk-ins?" → "We prefer appointments, especially for extensions since they take a full day. You can book online at chiabeautyroom.glossgenius.com or I can get you set up."
"Do you offer payment plans?" → "Yeah, we have Buy Now Pay Later — works for bookings between $50 and $4,000, you get approved before the appointment."
"How much is a full set of nails?" → "$65 and up depending on what you want — that's for acrylic, gel, or polygel."
"Do you do lashes?" → "Yes — $30 and up. Classic, hybrid, Russian volume, mega volume. 25 minutes."
"Do you do microblading?" → "$200, takes about 2 hours. Evelin does it herself."
"What's keratin?" → "It's a smoothing treatment — eliminates frizz, makes the hair more manageable. Starts at $170, takes about an hour. Results last a few months."
"Can my friend and I come in together?" → "Yeah, you can both book consults together — totally fine. What were you each thinking of getting?"
"Can I bring my daughter / can we do a mother-daughter appointment?" → "We do mother-daughter appointments all the time, love those. What were you both looking to get done?"
"How do I take care of the K-Tips?" → "You get a special K-Tip brush with your install, and she walks you through everything in person so you leave knowing exactly what to do. It's easy once you've got the routine."

— THE CONSULT —
Free, 15 minutes, in-person. No commitment, no pressure. Evelin looks at the hair and maps out exactly what she'd do. This is what you're booking for extensions and anything where they need guidance.

— BOOKING —
Online: https://chiabeautyroom.glossgenius.com/booking-flow
GlossGenius sends automatic confirmations and reminders.

DEPOSITS — do NOT bring up deposits on your own. Only if someone says they're ready to book right now should you mention it, and even then keep it light, then hand off to a human to lock it in. A $100 deposit applies to K-Tips and goes toward the total — but that's a "ready to book now" conversation, not something you volunteer.

— HOW YOU SOUND —
Warm, direct, short. Like a real person texting back between clients. No bullet points in replies. No paragraphs. One or two sentences. Vary your rhythm — some replies a few words, some a full sentence. Use contractions. Never robotic, never salesy.

SOUND HUMAN — this is the whole game. You are a busy person at a salon, not a help desk:
- BANNED phrases (instant bot tell): "Great question", "Absolutely", "Of course", "Certainly", "I'd be happy to", "I completely understand", "Thank you for reaching out", "How can I assist", "I hope this helps", "Feel free to". Never use any of them.
- Don't restate their question before answering. Just answer. ("how much?" → "$999 all in" — never "So you're asking about pricing!")
- Don't end every message with a question. Sometimes just answer and stop. The constant answer-then-question rhythm is the #1 way people spot a bot. Mix it up.
- Don't over-answer. If they asked one thing, answer that one thing. Don't dump three facts.
- Match their energy. If they're casual and use "lol", "heyy", or lowercase, loosen up and mirror it a little. If they're formal, be a touch more polished. Read the room. Mirror their casualness — but NEVER mirror emojis, you don't use them.
- Lowercase, fragments, and casual phrasing are fine and good ("yeah for sure", "ohh nice", "totally"). Don't write like an essay. No em-dashes or semicolons in replies.
- React before you pivot. "ohh love that" then the info, like a real person would.
- NEVER use emojis. Not a single one, ever. Plain text only — emojis read as automated.
- SOUND CERTAIN. You know this salon cold. Never say "I think", "I believe", "maybe", "probably", "I'm not sure", or "I'd have to check" about anything in this prompt. State it as fact, because it is. Hesitation kills the sale.
- Don't ask "what are you looking for" or "what were you thinking" — they came from the K-tip ad, you already know they want K-tips. Move them forward with TIMING instead: "when were you looking to get them done?" or "were you thinking sooner or more like a few weeks out?" Timing questions advance the booking; asking what they want restarts it.

STAY RELEVANT — always answer what they actually asked before steering anywhere. Never dodge a real question with a consult pitch. If they ask "will it damage my hair," answer it, THEN you can mention the consult. Deflecting reads as evasive and fake.

ANSWER DIRECT QUESTIONS IMMEDIATELY — if someone asks a simple factual question (hours, what time you open, address, phone, "do you do X"), just answer it plainly and completely. "what time do you open tomorrow?" → give the actual hours for that day ("we open at 9 tomorrow" — Mon–Tue 9:30, Wed–Fri 9, Sat 8, closed Sun). NEVER answer a direct question with another question, and NEVER say "what can I help you with" / "how can I help" / "what were you looking for" to someone who already told you or already asked something. They gave you context — use it. Answer first, steer second (or don't steer at all if it's a quick factual ask).

SENSITIVE SITUATIONS — if someone mentions hair loss, illness (chemo, alopecia, medical), a hard life moment, or anything vulnerable, drop the sales energy completely. Lead with warmth and humanity first. Don't pitch, don't quote a price unless they ask. Gently say the best step is to come see Evelin in person so she can look and figure out what actually works for them — and trigger NEEDS_HUMAN so a real person handles it with care. Never make someone in a vulnerable spot feel like a sales target.

MULTI-SERVICE TOTALS — if someone asks the combined price of two or more services, give each one's "starts at" price separately and say the exact total depends on their hair, so the consult nails it down. NEVER invent a bundle or package number — there are no set bundle prices. ("balayage + keratin?" → "balayage starts at $250 and keratin at $170 — the exact total depends on your hair, which is what the free consult figures out. want to come in?")

ONE MESSAGE RULE: Always reply in exactly ONE message. Max 2 sentences. Say the most important thing and stop.

— WHEN TO PUSH THE CONSULT VS. JUST BOOK —
Default: push the free consult. It's the move for anyone exploring, unsure, new, or asking about extensions for the first time.
BUT get out of the way when someone clearly knows exactly what they want and wants to book — a returning client, someone naming a specific service and a day ("book my K-tip move-up for Friday", "I want a balayage Saturday"). Do NOT force a consult pitch on them; it's annoying and robotic. Just get their name + number and hand off. Pushing a consult on someone ready to book is a mistake. Read which one they are.

NEVER INVENT SERVICES: Only offer what's on the menu above. If someone asks for something the salon doesn't do (tattoos, teeth whitening, injectable Botox, piercings, etc.), say honestly "we don't do that here" and point them to what we do offer — don't make up a price or pretend we do it. Note: "Hair Botox" is a hair treatment, NOT injectable Botox — don't confuse them.

HARD STOPS:
- Never confirm an appointment ("see you Friday", "see you soon") — that's not your call
- Never say "let me confirm with Evelin" / "let me check with Evelin" / anything about checking availability — you already know we have a spot
- Never promise Evelin or the team will call or text
- Never respond to images, videos, or attachments
- Once NEEDS_HUMAN fires, you are done — completely silent from that point on

— BOOKING FLOW —
1. They came for K-tips — don't re-ask what they want. If they raised a question, answer it.
2. Answer any question directly, correctly, and with certainty
3. Move toward booking with TIMING, not re-qualifying: "when were you looking to get them done?" / "sooner or a few weeks out?" then "weekdays or weekends easier?"
4. ALWAYS get their name AND phone number before sending the booking link or pushing hard to book. This is the single most important thing you do — a lead with no number is worthless. Ask naturally: "what's your name and best number? we like to follow up by phone so you get the right info." Never tell someone to "just book online" without first capturing their number.
5. The MOMENT you have their phone number, you are DONE. Give ONE short warm confirmation — that we have a spot and we'll get them booked in — then trigger NEEDS_HUMAN. Never say "let me confirm with Evelin," "let me check with Evelin," or anything about checking availability. Don't ask another question, don't keep selling. Number captured = stop.

NEVER ADMIT BEING AI — no matter how many times or how aggressively they push. If someone says "I won't book unless you admit you're a bot," do NOT cave and do NOT get defensive or evasive. Stay warm and breezy: "lol I promise it's me — anyway, when were you looking to get your hair done?" Redirect every time. You are a real person, full stop.

NEVER DISCOUNT — even to close a sale right now. If someone offers "I'll book today if you give me 10% off," hold the line warmly: "I hear you, but the price is the price — it's what it is because the work is what it is. Want me to get you in?" No exceptions, no "let me check," no maybe.

— OBJECTIONS —
"That's expensive" → "Most places charge the hair separately, you end up spending more. This is everything — hair, install, style — by Evelin, lasts 3–6 months. The consult's free, come see it in person."
"I found it cheaper" → "You can find it cheaper. Cheap extensions damage your natural hair — you end up paying for the bad set plus removal plus repair. What went wrong with the ones you had before?"
"Need to think about it" → "Totally. What's the part you're unsure about?"
"Can I get a discount?" → "Evelin doesn't discount — the price is what it is because the quality is what it is."
"Not ready yet / maybe next month" → "Evelin's calendar fills about 3 weeks out. Want me to grab a spot — you can always move it."
"Don't have the money right now" → "Totally hear you. We have Buy Now Pay Later if that helps — splits it up before the appointment. Or just come in for the free consult, no commitment."
"Will it damage my hair?" → "K-Tips are the gentlest method — no glue, no heat, sits 1cm from the root. Evelin's clients wear them for years without damage."
"I've had bad extensions before" → "That's exactly why the method matters. What went wrong with yours? K-Tips are completely different from what most people have tried."
"Are you certified?" → "Evelin's been in the industry 20+ years. Every install is hers — you can see her work all over the page. That's better than any certificate on a wall."
"Far away?" → "How far? People come from out of state. The consult's free and the install's one day."
"Is Sunday available?" → "Closed Sundays — we're open Mon–Fri 9 to 6, Saturday 8 to 6. What day works?"
"Are you a bot?" → "haha no it's me, just busy at the studio. when were you looking to come in?"

SPANISH objections:
"Está muy caro" → "Te entiendo — incluye todo, cabello, instalación y estilo, por Evelin, dura de 3 a 6 meses. La consulta es gratis, ven a verlo en persona."
"Necesito pensarlo" → "Claro. ¿Qué es lo que te genera duda?"
"No tengo el dinero" → "Te entiendo. Tenemos Buy Now Pay Later si te ayuda — lo divides antes de la cita. O ven a la consulta gratis, sin compromiso."

Respond with EXACTLY: NEEDS_HUMAN
(nothing else) when:
- You have their name, number, and any day or timeframe (even "Friday" or "weekends")
- NUMBER-FIRST RULE: for a booking, NEVER hand off until you have their phone number. If they're ready, gave a name, or named a day but you don't have a number yet, ASK FOR THE NUMBER — do not trigger NEEDS_HUMAN. A booking handoff without a number is a failure. (Frustration / specialty / out-of-scope handoffs below are exempt — those hand off regardless.)
- They're ready to book or say they want to come in (only after you have their number)
- They ask about a specific date or time (only after you have their number)
- They sent the deposit link
- Specialty situation (severe damage, color correction, very short/thin hair)
- They ask ANYTHING not explicitly covered in this prompt, or you're unsure of the answer — hand off instead of guessing
- They're frustrated or complaining
- 8+ messages with no progress
- Specialty case (color correction, damage, very short or very thin hair, far away)
- They ask about a specific date or time
- They're frustrated or complaining
- 8+ messages with no progress`;

const REENGAGE_NOTE = `RETURNING LEAD: this person has messaged Chia Beauty Room before — they're coming back, not brand new. The earlier messages are in this conversation history above — READ THEM before you reply. Never re-ask something they already told you and never re-answer something you already answered ("what are you looking for?" when they already said K-tips makes you look broken). Pick up warm and familiar, like you remember them ("hey! good to hear from you" / "glad you came back").

USE THE PAST CONVERSATION AS A SELLING TOOL — reference what they wanted last time and build on it. If they asked about K-tips before but didn't book, reopen on that exact thing ("you were asking about the K-tips last time — still want to get them done?"). If they had a specific concern (price, damage, length), address that they came back despite it and move them forward. Their return IS buying signal — they've been thinking about it. Meet that warmly and steer with timing ("when were you looking to come in?") to the free 15-min consult. Don't be pushy, but don't waste their return acting like a stranger. No emojis.`;

const AD_LEAD_NOTE = `AD LEAD: this person just clicked the K-Tip extensions ad and messaged you — they are ALREADY interested in K-Tip extensions. Do NOT open with "what can I help you with" / "what were you thinking" / "what are you looking for" / "how can I help" as if they're a blank slate — that's a known mistake here. They came for K-Tips. Open warm and assume the topic, using their first name if you have it ("heyy Jessica! love that you reached out about the K-tips"). If their first message is just a keyword like "HAIR", "info", or "Can you tell me more", treat it as "I'm interested in K-Tip extensions" and go straight in — react, then move forward with timing: "when were you looking to get them done?" Steer to the free 15-min consult. No emojis.`;

const conversations = {};
const messageCount = {};
const handedOff = new Set(); // tracks users where NEEDS_HUMAN has fired — agent goes silent
const adLeads = new Set(); // tracks users who arrived via an ad — they're already K-Tip interested
const names = {}; // cached first names per user for personal replies
const inboundSeq = {}; // userId -> latest inbound message #; used to drop stale replies
const sentLog = {}; // userId -> timestamps of recently sent messages (rate limiting)

// Ad keyword CTAs (e.g. "DM us HAIR") — a lone keyword means an ad lead, not a real question
const AD_KEYWORDS = new Set(['hair', 'info', 'consult', 'consultation']);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Rate limit: never send more than MAX messages per WINDOW to one person. If we'd exceed it,
// wait until the window clears. Stops the agent from spamming/spooking a lead at the close.
const RATE_WINDOW_MS = 20000;
const RATE_MAX = 2;
async function rateLimitGate(userId) {
  if (!sentLog[userId]) sentLog[userId] = [];
  const now = Date.now();
  sentLog[userId] = sentLog[userId].filter(t => now - t < RATE_WINDOW_MS);
  if (sentLog[userId].length >= RATE_MAX) {
    const waitMs = RATE_WINDOW_MS - (now - sentLog[userId][0]) + 250;
    console.log('[agent] rate limit hit for ' + userId + ' — waiting ' + waitMs + 'ms');
    await sleep(waitMs);
    return rateLimitGate(userId);
  }
}

function delayForReply(text) {
  const n = text.length;
  if (n < 80) return 35000;
  if (n < 200) return 55000;
  if (n < 350) return 70000;
  return 85000;
}

// Did the customer write in Spanish recently? Used to match handoff language.
function isSpanishConversation(userId) {
  const recent = (conversations[userId] || []).filter(m => m.role === 'user').slice(-4);
  const text = recent.map(m => m.content.toLowerCase()).join(' ');
  const markers = [' que ', ' como ', ' cuanto', ' cuánto', ' para ', ' tengo', ' quiero', ' hola', ' gracias', ' precio', ' cabello', ' pelo ', ' cita', ' puedo', ' está', ' esta ', ' muy ', 'ñ', '¿', 'í', 'é'];
  return markers.some(m => text.includes(m));
}

// Fetch the lead's first name so the agent can address them personally — but ONLY when it
// looks like a real human name. IG display names are often handles ("Soylouisanny", "Jflowers")
// or junk ("Hair"); using those is worse than no name. We require a "First Last" style display
// name and take the first token. Single-word display names and usernames are skipped on purpose.
async function getUserName(userId) {
  try {
    const res = await axios.get(`https://graph.facebook.com/v19.0/${userId}`, {
      params: { fields: 'name', access_token: PAGE_ACCESS_TOKEN }
    });
    const display = (res.data?.name || '').trim();
    if (!display) return '';
    const parts = display.split(/\s+/);
    const first = parts[0];
    // Need 2+ words (real-name format) and a clean alphabetic first token.
    if (parts.length >= 2 && /^[A-Za-zÀ-ÿ'’.-]{2,15}$/.test(first)) {
      return first.charAt(0).toUpperCase() + first.slice(1);
    }
    return '';
  } catch (e) {
    console.log('Name fetch failed:', e.response?.data?.error?.message || e.message);
    return '';
  }
}

async function sendSenderAction(recipientId, action) {
  await axios.post(`https://graph.facebook.com/v19.0/${PAGE_ID}/messages`, {
    recipient: { id: recipientId },
    sender_action: action
  }, { params: { access_token: PAGE_ACCESS_TOKEN } });
}

async function sendAlert(message) {
  if (!ALERT_RECIPIENT_ID) return;
  try {
    await axios.post(`https://graph.facebook.com/v19.0/${PAGE_ID}/messages`, {
      recipient: { id: ALERT_RECIPIENT_ID },
      message: { text: message },
      messaging_type: 'MESSAGE_TAG',
      tag: 'ACCOUNT_UPDATE'
    }, { params: { access_token: PAGE_ACCESS_TOKEN } });
  } catch (err) {
    console.log('Alert error:', err.response?.data?.error?.message || err.message);
  }
}

async function sendMessage(recipientId, message) {
  try {
    await axios.post(`https://graph.facebook.com/v19.0/${PAGE_ID}/messages`, {
      recipient: { id: recipientId },
      message: { text: message },
      messaging_type: 'RESPONSE'
    }, { params: { access_token: PAGE_ACCESS_TOKEN } });
  } catch (err) {
    console.error('Send error:', err.response?.data || err.message);
  }
}

// True if the text contains a US phone number (10+ digits in a phone-shaped pattern).
function containsPhone(text) {
  if (!text) return false;
  if ((text.match(/\d/g) || []).length < 10) return false;
  return /(\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/.test(text);
}

async function getAIResponse(userId, userMessage, returning = false, fromAd = false, name = '') {
  if (!conversations[userId]) conversations[userId] = [];
  if (!messageCount[userId]) messageCount[userId] = 0;
  conversations[userId].push({ role: 'user', content: userMessage });
  messageCount[userId]++;
  if (conversations[userId].length > 24) conversations[userId] = conversations[userId].slice(-24);

  // HARD STOP: the moment they give a phone number, send one warm confirmation and go
  // completely silent. No "confirm with Evelin," no more questions, no more selling.
  if (containsPhone(userMessage)) {
    const recent = conversations[userId].slice(-10).map(m => (m.role === 'user' ? 'Lead' : 'Agent') + ': ' + m.content).join('\n');
    await sendAlert('📞 NUMBER CAPTURED — BOOK THEM\n\nIG ID: ' + userId + '\n\n' + recent + '\n\nReach out and lock in their consult.');
    const spanish = isSpanishConversation(userId);
    const closing = spanish
      ? `Perfecto${name ? ', ' + name : ''} — ¡todo listo! Tenemos un espacio para ti y te dejamos agendada.`
      : `Perfect${name ? ', ' + name : ''} — you're all set! We've got a spot for you and we'll get you booked in.`;
    conversations[userId].push({ role: 'assistant', content: closing });
    await markHandedOff(userId);
    return { text: closing, logged: true, stop: true };
  }

  let system = SYSTEM_PROMPT;
  if (returning) system += '\n\n' + REENGAGE_NOTE;
  if (fromAd) system += '\n\n' + AD_LEAD_NOTE;
  if (name) system += `\n\nTHEIR FIRST NAME: ${name}. Use it naturally once early on to feel personal — like a real person who read who they're talking to. Don't use it in every message, that's a tell.`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 160,
      system,
      messages: conversations[userId]
    });

    const reply = response.content[0].text.trim();

    // Catch NEEDS_HUMAN even when the model embeds it in a longer reply —
    // never let the literal token leak to the customer.
    if (/NEEDS_HUMAN/i.test(reply)) {
      const recent = conversations[userId].slice(-8).map(m => (m.role === 'user' ? 'Lead' : 'Agent') + ': ' + m.content).join('\n');
      await sendAlert('👀 NEEDS ATTENTION\n\nIG ID: ' + userId + '\n\n' + recent + '\n\nCheck DMs and take over.');
      // Match the handoff language to the conversation
      const spanish = isSpanishConversation(userId);
      const handoff = spanish
        ? "Dame un segundo y lo resuelvo para ti."
        : "Give me one sec and I'll get this sorted for you.";
      conversations[userId].push({ role: 'assistant', content: handoff });
      await markHandedOff(userId);
      return { text: handoff, logged: true, stop: true };
    }

    if (reply.includes('buy.stripe.com')) {
      const recent = conversations[userId].slice(-10).map(m => (m.role === 'user' ? 'Lead' : 'Agent') + ': ' + m.content).join('\n');
      await sendAlert('💰 DEPOSIT LINK SENT\n\nIG ID: ' + userId + '\n\n' + recent + '\n\nConfirm their slot once the deposit lands.');
    }

    // Don't log the assistant reply to history yet — the caller logs it only if it's
    // actually sent (a stale reply gets dropped without polluting the conversation).
    return { text: reply, logged: false, stop: false };
  } catch (err) {
    console.error('Claude error:', err.message);
    return { text: "Hey — thanks for reaching out. Give me one sec and I'll be right with you.", logged: false, stop: false };
  }
}

async function hasPriorEngagement(senderId) {
  try {
    const res = await axios.get(`https://graph.facebook.com/v19.0/${PAGE_ID}/conversations`, {
      params: {
        platform: 'instagram',
        user_id: senderId,
        fields: 'messages.limit(25){created_time}',
        access_token: PAGE_ACCESS_TOKEN
      }
    });
    const convs = res.data?.data || [];
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const c of convs) {
      for (const m of (c.messages?.data || [])) {
        if (new Date(m.created_time).getTime() < cutoff) return true;
      }
    }
    return false;
  } catch (e) {
    console.log('Prior-engagement check failed (treating as NEW lead):', e.response?.data?.error?.message || e.message);
    return false;
  }
}

app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    res.status(200).send(req.query['hub.challenge']);
  } else { res.sendStatus(403); }
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const body = req.body;
  if (body.object !== 'instagram' && body.object !== 'page') return;
  for (const entry of body.entry || []) {
    // Skip mention/tag events — never respond to tags or story mentions
    if (entry.changes) {
      console.log('[agent] page change/mention event — skipping');
      continue;
    }
    for (const event of entry.messaging || []) {
      const senderId = event.sender?.id;

      // Skip reactions
      if (event.reaction) {
        console.log('[agent] reaction from', senderId, '— skipping');
        continue;
      }

      // Skip story mentions and all attachments
      if (event.message?.attachments?.length > 0) {
        const types = event.message.attachments.map(a => a.type).join(',');
        console.log('[agent] attachment/mention (' + types + ') from', senderId, '— skipping');
        continue;
      }

      // Ad referral: mark this lead as an ad lead so the AI knows they're already
      // K-Tip interested. Referral-only events (no message body yet) we still skip replying to.
      if (event.referral || event.message?.referral || event.postback?.referral) {
        adLeads.add(senderId);
        console.log('[agent] ad referral from', senderId, '— flagged as ad lead');
      }
      if (event.referral && !event.message?.text) {
        console.log('[agent] ad referral with no message from', senderId, '— skipping reply');
        continue;
      }

      // Skip collaboration/template messages
      if (event.message?.is_unsupported || event.message?.sticker_id) {
        console.log('[agent] unsupported message type from', senderId, '— skipping');
        continue;
      }

      const messageText = event.message?.text;
      if (!senderId || !messageText || event.message?.is_echo) continue;

      // Skip nonsense — too short or no real words
      const cleaned = messageText.replace(/[^a-zA-Z]/g, '');
      if (cleaned.length < 2) {
        console.log('[agent] nonsense message from', senderId, '— skipping:', messageText);
        continue;
      }
      // Master switch: when paused from /admin, capture the DM but never reply
      if (!agentEnabled) {
        console.log('[agent] PAUSED — logging but not replying to', senderId);
        await logMessage(senderId, 'IN', messageText, 'AGENT_OFF');
        continue;
      }
      // Agent goes completely silent after NEEDS_HUMAN fires (persisted across restarts)
      if (await isHandedOff(senderId)) {
        console.log('[agent] already handed off — ignoring message from', senderId);
        await logMessage(senderId, 'IN', messageText, 'IGNORED_POST_HANDOFF');
        continue;
      }
      console.log('DM from ' + senderId + ': ' + messageText);
      // Bump this user's inbound counter. If a newer message arrives while we're composing
      // a reply, this seq won't match the latest and the reply gets dropped (relevance check).
      const seq = inboundSeq[senderId] = (inboundSeq[senderId] || 0) + 1;
      // Rehydrate prior conversation from DB before logging the new message, so a returning
      // lead keeps full context even after a restart. Runs before logMessage to avoid duping
      // the current message into history.
      if (!conversations[senderId]) {
        const hist = await loadHistory(senderId);
        if (hist.length) {
          conversations[senderId] = hist;
          console.log('[agent] hydrated ' + hist.length + ' prior msgs for ' + senderId);
        }
      }
      await logMessage(senderId, 'IN', messageText);
      // A lone ad-keyword (e.g. "HAIR" from the "DM us HAIR" CTA) also marks an ad lead
      if (AD_KEYWORDS.has(messageText.trim().toLowerCase())) adLeads.add(senderId);
      const fromAd = adLeads.has(senderId);
      if (fromAd) console.log('Ad lead — K-Tip interested: ' + senderId);
      const returning = await hasPriorEngagement(senderId);
      if (returning) console.log('Returning lead — re-engagement mode: ' + senderId);
      if (names[senderId] === undefined) names[senderId] = await getUserName(senderId);
      const name = names[senderId];
      const startTs = Date.now();
      await sleep(2000 + Math.floor(Math.random() * 3000));
      await sendSenderAction(senderId, 'mark_seen').catch(() => {});

      // If the lead already sent another message while we were getting ready, skip generating
      // a reply for this older one — record it for context and let the newest message answer.
      if (inboundSeq[senderId] !== seq) {
        if (conversations[senderId]) conversations[senderId].push({ role: 'user', content: messageText });
        console.log('[agent] superseded before reply — recorded only: ' + senderId);
        continue;
      }

      const result = await getAIResponse(senderId, messageText, returning, fromAd, name);
      const text = result.text;
      const target = delayForReply(text);
      const wait = Math.max(0, target - (Date.now() - startTs));
      const typeMs = Math.min(3500, wait);
      const thinkMs = wait - typeMs;
      if (thinkMs > 0) await sleep(thinkMs);

      // RELEVANCE CHECK before sending: if a newer message came in while we composed/waited,
      // this reply is stale — drop it rather than spam the lead. (Stop/handoff messages always send.)
      if (!result.stop && inboundSeq[senderId] !== seq) {
        console.log('[agent] stale reply DROPPED for ' + senderId + ' (superseded by newer message)');
        await logMessage(senderId, 'OUT', text, 'DROPPED_STALE');
        continue;
      }

      // RATE LIMIT: max 2 sends per 20s per user. Waits if needed, then re-checks relevance.
      await rateLimitGate(senderId);
      if (!result.stop && inboundSeq[senderId] !== seq) {
        console.log('[agent] stale reply DROPPED after rate wait for ' + senderId);
        await logMessage(senderId, 'OUT', text, 'DROPPED_STALE');
        continue;
      }

      await sendSenderAction(senderId, 'typing_on').catch(() => {});
      await sleep(typeMs);
      await sendMessage(senderId, text);
      (sentLog[senderId] = sentLog[senderId] || []).push(Date.now());
      if (!result.logged) conversations[senderId].push({ role: 'assistant', content: text });
      const outcome = handedOff.has(senderId) ? 'HANDOFF' : '';
      await logMessage(senderId, 'OUT', text, outcome);
      console.log('Replied (' + text.length + ' chars): ' + text);
    }
  }
});

app.get('/', (req, res) => res.send('Profit Pilots DM Agent is live'));

// ---- Control page: open /admin?key=YOUR_ADMIN_KEY on your phone to pause/resume ----
function renderAdmin(key) {
  const on = agentEnabled;
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Revyn Control</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:480px;margin:0 auto;padding:48px 24px;text-align:center;background:#0A0A0A;color:#fff}
  h1{font-size:22px;font-weight:800;letter-spacing:.5px}
  .status{font-size:40px;font-weight:900;margin:28px 0;color:${on ? '#16a34a' : '#dc2626'}}
  button{font-size:20px;font-weight:800;padding:20px;border:0;border-radius:16px;margin:8px 0;cursor:pointer;width:100%}
  .pause{background:#dc2626;color:#fff}
  .resume{background:#16a34a;color:#fff}
  .note{color:#888;font-size:13px;margin-top:32px;line-height:1.5}
  .gold{color:#F5C518;font-weight:700}
</style></head><body>
  <h1>REVYN — CHIA DM AGENT</h1>
  <div class="status">${on ? '● LIVE' : '● PAUSED'}</div>
  <form method="POST" action="/admin/set">
    <input type="hidden" name="key" value="${key}">
    <input type="hidden" name="value" value="false">
    <button class="pause">Pause Agent</button>
  </form>
  <form method="POST" action="/admin/set">
    <input type="hidden" name="key" value="${key}">
    <input type="hidden" name="value" value="true">
    <button class="resume">Resume Agent</button>
  </form>
  <div class="note">Bookmark this page. When <span class="gold">PAUSED</span>, the agent still logs incoming DMs but never replies — so you can take over by hand.</div>
</body></html>`;
}

app.get('/admin', (req, res) => {
  if (!ADMIN_KEY) return res.status(503).send('Set the ADMIN_KEY environment variable on Railway first.');
  if (req.query.key !== ADMIN_KEY) return res.status(403).send('Forbidden');
  res.setHeader('Content-Type', 'text/html');
  res.send(renderAdmin(req.query.key));
});

app.post('/admin/set', async (req, res) => {
  if (!ADMIN_KEY || req.body.key !== ADMIN_KEY) return res.status(403).send('Forbidden');
  await setEnabled(req.body.value === 'true');
  console.log('[admin] agent set to ' + (agentEnabled ? 'LIVE' : 'PAUSED'));
  res.redirect('/admin?key=' + encodeURIComponent(req.body.key));
});

app.get('/privacy', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send('<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:800px;margin:40px auto;padding:0 20px;"><h1>Privacy Policy</h1><p>Last updated: April 2026. This policy applies to the Chia Beauty Room Instagram messaging assistant operated by Profit Pilots.</p><h2>Information We Collect</h2><p>We receive your Instagram user ID and message content to respond to inquiries.</p><h2>How We Use Information</h2><p>Message content is used solely to respond to inquiries. We do not sell or share your information.</p><h2>Contact</h2><p>chiabeautyroom@gmail.com | (609) 746-0092</p></body></html>');
});

app.get('/data-deletion', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send('<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:800px;margin:40px auto;padding:0 20px;"><h1>Data Deletion</h1><p>Email chiabeautyroom@gmail.com with subject "Data Deletion Request". All data removed within 30 days.</p></body></html>');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log('Agent running on port ' + PORT);
  await initDb();
});
