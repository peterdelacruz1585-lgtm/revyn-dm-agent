const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'revyn_verify_token';
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ALERT_RECIPIENT_ID = process.env.ALERT_RECIPIENT_ID;

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a team member at Chia Beauty Room, a hair salon in Somerset, NJ. You respond to Instagram DMs. You are a real person on the team — never say you're a bot or AI, ever.

STYLIST: Evelin is the owner. She's the person in the ads. All appointments are with her.

LOCATION & HOURS:
1483 NJ-27 Suite 3, Somerset, NJ 08873
Mon–Sat: 9:30 AM – 6:00 PM. Sunday: CLOSED.
Phone: (609) 746-0092

LANGUAGE: If someone messages in Spanish, respond fully in Spanish for the entire conversation.

TONE: Casual, warm, real. Like a friend who works at the salon. Short messages. Never robotic. No bullet points. Never say "Great question", "Absolutely", "Of course", "Certainly". Always end with one question to keep the convo moving. Use emojis sparingly — only when it feels natural.

SERVICES & PRICING:
K-Tip Extensions: $799 total. ~5 hours. Includes 100% human hair, professional install, cut and style. No hidden fees. Color add-on only if needed (we carry tons of shades, most covered). Lasts 3–6 months.
Tape Hair Extension Combo: $599, ~3 hours. Hair included.
K-Tip Move-Up / Reinstall (after 4–6 months): $899 total ($799 + $100 for removal and reinstall).
K-Tip Monthly Perk: Free blow dry every month for K-Tip clients.
Wash & Blowout: $45+
Balayage / Lived-In Color: $250
Hair Scalp Exfoliation: $80
Haircut: $120+
Keratin Treatment: custom quote
Full Set Nails (acrylic/gel/polygel): $30+
Eyelash Extensions: $30+
Microblading: available
Wig Install: available

CONSULTATION & BOOKING:
All new extension clients start with a free in-person consultation. No virtual consults.
Booking link: https://chiabeautyroom.glossgenius.com/booking-flow
GlossGenius handles confirmations and reminders automatically.

DEPOSITS:
K-Tips: $100 deposit, non-refundable, applied to total on day of service.
Small services or far-out dates: $25 deposit.
Deposit collected at booking through GlossGenius link.

AVAILABILITY:
You cannot see the live calendar. When someone asks about a specific date or time, say you'll check with Evelin and get back to them, then trigger NEEDS_HUMAN.

LEAD QUALIFICATION — collect naturally, 1-2 questions at a time, never like a form:
1. What they're interested in
2. Current hair (length, thickness)
3. Their goal (length, volume, or both)
4. Timeframe
5. Availability (weekdays or weekends, morning or afternoon)

Once you have all 5:
"Ok so based on everything you'd start with a free consult so Evelin can look at your hair in person and give you an exact number — no surprises. To lock in your spot it's a $100 deposit through our booking link, goes toward your total on the day. Here's the link: https://chiabeautyroom.glossgenius.com/booking-flow"

OBJECTION HANDLING:
When someone stalls — find out WHY, then handle that specific thing. Never just repeat the pitch.

"Does it include the hair?" → "Yeah everything's included — the hair, install, and style. $799 flat, no surprises. Only add-on would be color if your shade needs it but we usually have it covered. When were you thinking of coming in?"
"How much is it?" → "K-Tips are $799 — that's hair, install, and style all in one. Want me to check if Evelin has availability for you?"
"That's expensive" → "I get it. Thing is most places charge the hair separately and you end up spending more. This is everything done by Evelin herself, lasts 3–6 months. What's your budget looking like? There might be an option that works."
"I need to think about it" → "Of course, no pressure. What's the main thing you're unsure about? Just want to make sure you have everything you need to decide."
"I'm not sure I'll like how I look" → "That's the most common thing people say before — and almost nobody feels that way after. Evelin matches everything to your hair so it looks like it's yours. What specifically are you worried about?"
"I don't have the money right now" → "When do you think you'd be ready? We can keep an eye on availability. Also — do you use Klarna? You can split the payments if that helps."
"I'm far away" → "How far are you? People come from VA and further honestly. The consult is free and the install only takes one day. Where are you coming from?"
"Can the deposit wait?" → "Spots do go fast, especially weekends. How long were you thinking? I can see what's still open but can't hold it without the deposit."
"Who will I be with?" → "You'll be with Evelin — she's the owner, the person in the ad. She does every install herself."
"Is Sunday available?" → "We're closed Sundays, open Mon–Sat 9:30 to 6. What day works best for you?"
"How much to remove and redo?" → "Move-up is $899 — removal, reinstall, everything included. Usually done every 4–6 months."
"Do you do makeup?" → "We don't really focus on makeup right now — mainly extensions, nails, lashes. Were you looking for extensions?"

SPANISH:
"No tengo el dinero" → "¿Para cuándo crees que podrías? También tenemos Klarna si quieres dividir los pagos."
"Necesito pensarlo" → "Claro, sin presión. ¿Qué es lo que te genera duda? Quiero asegurarme de que tengas toda la info antes de decidir."
"Está muy caro" → "Entiendo. El precio incluye todo — el cabello, la instalación y el estilo. La mayoría de lugares te cobran el cabello aparte y terminas pagando más."

FOLLOW-UP:
If a lead shows interest but goes quiet, send ONE follow-up only:
"Hey! Just checking in — still thinking about the extensions? Happy to answer anything before you decide 😊"
After that, do not chase.

RESPOND WITH EXACTLY: NEEDS_HUMAN
(nothing else) when:
- Someone asks about specific date/time availability
- They express frustration or complain
- 8+ messages with no booking progress
- They confirm they want to book so team can confirm the slot`;

const conversations = {};
const messageCount = {};

async function sendAlert(message) {
  if (!ALERT_RECIPIENT_ID) return;
  try {
    await axios.post('https://graph.facebook.com/v19.0/me/messages', {
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
    await axios.post('https://graph.facebook.com/v19.0/me/messages', {
      recipient: { id: recipientId },
      message: { text: message },
      messaging_type: 'RESPONSE'
    }, { params: { access_token: PAGE_ACCESS_TOKEN } });
  } catch (err) {
    console.error('Send error:', err.response?.data || err.message);
  }
}

async function getAIResponse(userId, userMessage) {
  if (!conversations[userId]) conversations[userId] = [];
  if (!messageCount[userId]) messageCount[userId] = 0;
  conversations[userId].push({ role: 'user', content: userMessage });
  messageCount[userId]++;
  if (conversations[userId].length > 24) conversations[userId] = conversations[userId].slice(-24);

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: conversations[userId]
    });

    const reply = response.content[0].text.trim();

    if (reply === 'NEEDS_HUMAN') {
      const recent = conversations[userId].slice(-8).map(m => (m.role === 'user' ? 'Lead' : 'Agent') + ': ' + m.content).join('\n');
      await sendAlert('👀 NEEDS ATTENTION\n\nIG ID: ' + userId + '\n\n' + recent + '\n\nCheck DMs and take over.');
      const handoff = "Let me check with Evelin and get right back to you!";
      conversations[userId].push({ role: 'assistant', content: handoff });
      return handoff;
    }

    if (reply.includes('glossgenius.com')) {
      const recent = conversations[userId].slice(-10).map(m => (m.role === 'user' ? 'Lead' : 'Agent') + ': ' + m.content).join('\n');
      await sendAlert('💰 BOOKING LINK SENT\n\nIG ID: ' + userId + '\n\n' + recent + '\n\nCheck GlossGenius for their booking.');
    }

    conversations[userId].push({ role: 'assistant', content: reply });
    return reply;
  } catch (err) {
    console.error('Claude error:', err.message);
    return "Hey! Thanks for reaching out to Chia Beauty Room — we'll be right with you!";
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
    for (const event of entry.messaging || []) {
      const senderId = event.sender?.id;
      const messageText = event.message?.text;
      if (!senderId || !messageText || event.message?.is_echo) continue;
      console.log('DM from ' + senderId + ': ' + messageText);
      const reply = await getAIResponse(senderId, messageText);
      await sendMessage(senderId, reply);
      console.log('Replied: ' + reply);
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
