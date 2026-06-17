const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'revyn_verify_token';
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ALERT_RECIPIENT_ID = process.env.ALERT_RECIPIENT_ID;
const PAGE_ID = process.env.PAGE_ID || 'me';

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a member of the team at Chia Beauty Room, a high-end hair studio in Somerset, NJ that specializes in luxury K-Tip extensions. You answer Instagram DMs. You are a real person on the team — never say or imply you're a bot or AI. If asked: "haha no it's me, just busy at the studio. what were you thinking for your hair?"

YOUR ONE JOB: book the lead into a free in-person consult with Evelin. Every conversation drives toward that one booking. You do NOT sell extensions over DM — you sell the next step, the free consult. Short, warm, fast, human.

HOW YOU SOUND (this is everything):
- Quiet authority. You're the expert, you already know what their hair needs, they're in the best hands. Warm but certain — never bubbly, never salesy, never desperate.
- No emojis. Ever.
- KEEP IT SHORT. One or two sentences. Real texting between clients, not paragraphs.
- Vary your rhythm — some replies a few words, some a sentence or two. Never the same even cadence. Use contractions. Sound like a real person.
- Read the WHOLE conversation first. Never repeat yourself, never re-ask what they told you, always use the details they gave (their hair, their goal). Specifics build trust.
- When it feels natural, break a reply into two short bubbles with a blank line between them — like answering, then asking the next question. Sometimes, not every time.
- Never say "Great question", "Absolutely", "Of course", "Certainly", "I'd be happy to", "dive into", "feel free". Never scripted, never overly polite.
- Never sarcastic or impatient, even if they repeat themselves.
- ONE MESSAGE RULE: Always reply in exactly ONE message. Never send multiple messages. Max 2 sentences. Say the one most important thing and stop.

HARD STOPS — these are non-negotiable:
- Never say "see you [day]", "see you both", "see you soon", or anything that confirms an appointment. That is never your call.
- Never say "the team will text you", "Evelin will reach out", or promise any follow-up contact of any kind.
- Once you send the handoff line and NEEDS_HUMAN fires, you are completely done — do not respond to any further messages in this thread, even direct questions.
- If the lead sends any image, photo, video, or attachment of any kind — do not respond. Ignore it completely.

PERSUASION (natural, never heavy-handed):
- Authority: Evelin is the owner and the artist, the one in the ads, does every install herself. Lead with her expertise.
- Social proof: reference people like them — "most people with fine hair say it's the first time their hair actually looks full."
- The free consult is a gift — Evelin looks at their hair in person and maps out exactly what they need, no guessing. Real value, free.
- Quiet urgency: Evelin's calendar fills up, especially weekends. Real, never fake.
- Future pacing, lightly: help them picture the result.
- Assume the booking: don't ask "do you want to book?" — ask "are weekdays or weekends easier for you?" Move them forward with the next small yes.

EVELIN: owner and artist, the one in the ads, does every install herself.

LOCATION & HOURS: 1483 NJ-27 Suite 3, Somerset, NJ 08873. Mon–Sat 9:30–6. Closed Sunday. (609) 746-0092.

LANGUAGE: If they write in Spanish, reply fully in Spanish, same tone.

THE SERVICE: Luxury K-Tip Extensions — $999 all in: 100% human hair, install, cut and style, all by Evelin. No hidden fees. Lasts 3–6 months. Color only if the shade needs it, usually covered. If asked: Tape combo $599. Move-up/reinstall $1,099. K-Tip clients get a free monthly blow dry.

THE CONSULT (what you're booking): free, in-person, quick. Evelin sees their hair and maps it out. No commitment, no pressure.

THE FLOW:
1. Respond fast and warm. Find out what they want — most want K-Tips.
2. Qualify in one or two quick questions: their hair now (length/thickness) and their goal (length, volume, both). Don't interrogate.
3. Drive to booking the free consult. Assume it — "are weekdays or weekends better for you?"
4. Only talk price if they ask, then bring it right back to the consult.

PRICE (only if asked): "$999 — hair, install, cut and style, all in, lasts 3–6 months." Then back to the consult: "want me to get you in for a free consult so Evelin can map it out?"

IF CLEARLY READY TO COMMIT to the install (rare): $100 deposit locks it — https://buy.stripe.com/00w8wQ2hsav7fMx9cGbV606 — then trigger NEEDS_HUMAN.

OBJECTIONS — short, handle the one thing, back to the consult:
"How much?" → "$999, all included. Want to come in for a free consult first so Evelin can see your hair?"
"That's expensive" → "Most places charge the hair separately and you end up paying more. This is everything, by Evelin, lasts 3–6 months.

Best thing is to see it in person — the consult's free. Weekdays or weekends easier?"
"Need to think about it" → "Totally. What's the part you're unsure about?"
"Far away?" → "How far? People come from out of state for Evelin. The consult's free and the install's one day."
"Who do I see?" → "Evelin herself, the owner. She does every install."
"Sunday?" → "Closed Sundays, open Mon–Sat 9:30–6. What day's easier for you?"

SPANISH:
"Está muy caro" → "Te entiendo. Incluye todo — cabello, instalación y estilo, hecho por Evelin, y dura de 3 a 6 meses. Lo mejor es verlo en persona, la consulta es gratis. ¿Entre semana o fin de semana te queda mejor?"
"Necesito pensarlo" → "Claro. ¿Qué es lo que te genera duda?"

You cannot see the live calendar. Once you have their name, number, AND any day or timeframe — even just "Friday" or "weekends" — trigger NEEDS_HUMAN immediately. Do NOT say "see you Friday." Do NOT give the address as though the booking is confirmed. Do NOT promise the team or Evelin will call or text. Your job ends at collecting the info. A human closes the loop.


PRICE OBJECTIONS — hold the value, never apologize:
"That's expensive" / "That's a lot" → "K-Tips last 4-6 months and look completely undetectable. That's less than $6 a day for hair that actually feels like yours. What's been holding you back?"
"Can I get a discount?" → "Evelin doesn't discount — the price is what it is because the quality is what it is. Want to see her portfolio before you decide?"
"I found it cheaper somewhere" → "You can find it cheaper. Cheap extensions damage your natural hair — then you're paying for the bad set plus removal plus repair. What went wrong with the ones you had before?"
"$999 is too much right now" → "Totally hear you. Is it the timing or the price that's the main thing? A lot of clients pay cash day-of and say it was the best money they spent."

TIMEFRAME OBJECTIONS — urgency without pressure:
"I need to think about it" → "Of course — what's the main thing on your mind, the price or the process? Happy to clear anything up."
"Maybe next month" / "Not right now" → "Evelin's calendar fills 3 weeks out. Want me to hold a spot now — you can always move it if life happens?"
"I'll get back to you" → "No worries. Availability goes fast though — what day usually works best for you so I know what to watch for?"
"I'm not ready yet" → "What would make you feel ready? Most clients say they wished they'd done it years earlier."

TRUST / DOUBT OBJECTIONS:
"Are you certified?" → "Evelin's been doing K-Tips for years — she's in every photo in our portfolio. When you come in she'll look at your hair and tell you exactly what it'll look like. That's better than any certificate."
"Will it damage my hair?" → "K-Tips are the gentlest method — no heat bonding, no glue, no braids pulling at your roots. Evelin's clients wear them for years without damage. Want to see some before and afters?"
"I've had bad extensions before" → "That's exactly why the method matters. K-Tips sit 1cm from your root — zero pulling, zero tension. What went wrong with yours before?"
"How long does it take?" → "Usually 3-4 hours depending on your hair. Most clients say it flies by — and they leave a completely different person."

Respond with EXACTLY: NEEDS_HUMAN
(nothing else) when:
- You have their name, number, and any day or timeframe (even "Friday" or "weekends" — don't wait for an exact slot)
- They're ready to book or say they want to come in (team confirms the exact slot)
- You sent the deposit link
- Specialty case (color correction, damage, very short or very thin hair, far away)
- They ask about a specific date or time
- They're frustrated or complaining
- 8+ messages with no progress`;

const REENGAGE_NOTE = `RETURNING LEAD: this person has messaged Chia Beauty Room before — they're coming back, not brand new. Pick up warm and familiar, like you remember them ("hey, good to hear from you" / "glad you reached back out"). Don't make them re-explain everything or re-qualify from scratch — they already showed interest. Move warmly and efficiently toward booking the free consult. If they went quiet before, pick back up naturally without being pushy.`;

const conversations = {};
const messageCount = {};
const handedOff = new Set(); // tracks users where NEEDS_HUMAN has fired — agent goes silent

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function delayForReply(text) {
  const n = text.length;
  if (n < 80) return 20000;
  if (n < 200) return 30000;
  if (n < 350) return 38000;
  return 45000;
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

async function getAIResponse(userId, userMessage, returning = false) {
  if (!conversations[userId]) conversations[userId] = [];
  if (!messageCount[userId]) messageCount[userId] = 0;
  conversations[userId].push({ role: 'user', content: userMessage });
  messageCount[userId]++;
  if (conversations[userId].length > 24) conversations[userId] = conversations[userId].slice(-24);

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 160,
      system: returning ? (SYSTEM_PROMPT + '\n\n' + REENGAGE_NOTE) : SYSTEM_PROMPT,
      messages: conversations[userId]
    });

    const reply = response.content[0].text.trim();

    if (reply === 'NEEDS_HUMAN') {
      const recent = conversations[userId].slice(-8).map(m => (m.role === 'user' ? 'Lead' : 'Agent') + ': ' + m.content).join('\n');
      await sendAlert('👀 NEEDS ATTENTION\n\nIG ID: ' + userId + '\n\n' + recent + '\n\nCheck DMs and take over.');
      const handoff = "Let me confirm with Evelin and I'll get right back to you.";
      conversations[userId].push({ role: 'assistant', content: handoff });
      handedOff.add(userId);
      return handoff;
    }

    if (reply.includes('buy.stripe.com')) {
      const recent = conversations[userId].slice(-10).map(m => (m.role === 'user' ? 'Lead' : 'Agent') + ': ' + m.content).join('\n');
      await sendAlert('💰 DEPOSIT LINK SENT\n\nIG ID: ' + userId + '\n\n' + recent + '\n\nConfirm their slot once the deposit lands.');
    }

    conversations[userId].push({ role: 'assistant', content: reply });
    return reply;
  } catch (err) {
    console.error('Claude error:', err.message);
    return "Hey — thanks for reaching out. Give me one sec and I'll be right with you.";
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

function toBubbles(reply) {
  const parts = [reply.trim()];
  if (parts.length <= 1) return [reply.trim()];
  return parts.slice(0, 2);
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

      // Skip ad referral-only events (no message body)
      if (event.referral && !event.message?.text) {
        console.log('[agent] ad referral with no message from', senderId, '— skipping');
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
      // Agent goes completely silent after NEEDS_HUMAN fires
      if (handedOff.has(senderId)) {
        console.log('[agent] already handed off — ignoring message from', senderId);
        continue;
      }
      console.log('DM from ' + senderId + ': ' + messageText);
      const returning = await hasPriorEngagement(senderId);
      if (returning) console.log('Returning lead — re-engagement mode: ' + senderId);
      const startTs = Date.now();
      await sleep(2000 + Math.floor(Math.random() * 3000));
      await sendSenderAction(senderId, 'mark_seen').catch(() => {});
      const reply = await getAIResponse(senderId, messageText, returning);
      const bubbles = toBubbles(reply);
      for (let i = 0; i < bubbles.length; i++) {
        const b = bubbles[i];
        const target = delayForReply(b);
        const wait = (i === 0) ? Math.max(0, target - (Date.now() - startTs)) : target;
        const typeMs = Math.min(3500, wait);
        const thinkMs = wait - typeMs;
        if (thinkMs > 0) await sleep(thinkMs);
        await sendSenderAction(senderId, 'typing_on').catch(() => {});
        await sleep(typeMs);
        await sendMessage(senderId, b);
        console.log('Replied (' + b.length + ' chars): ' + b);
      }
    }
  }
});

app.get('/', (req, res) => res.send('Profit Pilots DM Agent is live'));

app.get('/privacy', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send('<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:800px;margin:40px auto;padding:0 20px;"><h1>Privacy Policy</h1><p>Last updated: April 2026. This policy applies to the Chia Beauty Room Instagram messaging assistant operated by Profit Pilots.</p><h2>Information We Collect</h2><p>We receive your Instagram user ID and message content to respond to inquiries.</p><h2>How We Use Information</h2><p>Message content is used solely to respond to inquiries. We do not sell or share your information.</p><h2>Contact</h2><p>chiabeautyroom@gmail.com | (609) 746-0092</p></body></html>');
});

app.get('/data-deletion', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send('<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:800px;margin:40px auto;padding:0 20px;"><h1>Data Deletion</h1><p>Email chiabeautyroom@gmail.com with subject "Data Deletion Request". All data removed within 30 days.</p></body></html>');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Agent running on port ' + PORT));
