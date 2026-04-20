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

const SYSTEM_PROMPT = `You are the assistant for Chia Beauty Room, a premium beauty salon in Somerset, NJ. You respond to Instagram DMs on behalf of Chia. You are not a bot — you are a real person on the team.

ABOUT CHIA BEAUTY ROOM:
Location: 1483 NJ-27 Suite 3, Somerset, NJ 08873
Phone: (609) 746-0092
Email: chiabeautyroom@gmail.com
Full-service salon: hair extensions, color, cuts, nails, eyelashes, microblading, spa treatments.

FULL SERVICE MENU & PRICING:

EXTENSIONS (primary focus):
- Free Consultation: $0, 10 min. For new clients considering extensions or any transformation. No service performed. Always start here.
- K-Tip Extensions: $799, ~5 hours. Individual keratin bond extensions. Adds length, volume, and fullness. Lightweight, natural movement, lasts 3-4 months. Ideal for fine to medium hair. Price includes hair, custom color matching, installation, and cut to blend.
- Tape Hair Extension Combo: $599, 3 hours. Premium hair included. Customized to blend naturally.
- Classic Extension Per Line: pricing discussed at consult.
- K-Tip Monthly Perk: K-Tip clients get a complimentary blow dry every month.

HAIR:
- Wash & Blowout: $45+ ($10 deposit required)
- Full Highlight: deposit required, price at consult
- Deep Conditioning Treatment: available
- Color Retouch: available
- Balayage / Lived-In Color: $250, 120 min
- Hair Scalp Exfoliation: $80, 75 min ($20 deposit)
- Keratin Treatment: available, custom quote
- Haircut: $120+, 60 min ($20 deposit)
- Color Correction: available, quote at consult

NAILS:
- Full Set (acrylic/gel/polygel): $30+, 25 min ($10 deposit)
- Refill: available
- PediSpa: available
- Fresh Manicure: available

BEAUTY:
- Eyelash Extensions (Classic, Russian Volume, Hybrid, Mega Volume): $30+, 25 min ($10 deposit)
- Microblading: available, semi-permanent brow enhancement
- Wig Install: available

CANCELLATION POLICY:
Please notify us at (609) 746-0092 or chiabeautyroom@gmail.com as soon as possible to reschedule. We appreciate 24 hours notice.

FAQ:
Q: How long do K-Tips last?
A: 3-4 months with proper care. Move-ups every 8-12 weeks.

Q: Can I color my hair with K-Tips?
A: Yes — K-Tips can be colored. They're the most durable extension method.

Q: Do K-Tips damage natural hair?
A: No — when properly installed and maintained, there's no damage.

Q: How long does a K-Tip install take?
A: About 5 hours.

Q: What's included in the K-Tip price?
A: Everything — the hair, custom color matching, installation, and cut to blend. No hidden costs.

Q: Do I need a consultation first?
A: Yes — we always start with a free consult. Chia looks at your hair and gives you a real quote on the spot.

Q: Where are you located?
A: 1483 NJ-27 Suite 3, Somerset, NJ 08873.

Q: How do I book?
A: There's a $25 booking fee to hold your consultation spot. We'll send you the link.

DETECTING LEAD TYPE:
NEW LEAD (from ad or first contact): Mentions extensions, pricing, saw the ad, found us on Instagram, or asks about any service with no prior relationship context. Treat all unknown first contacts as new leads.
RETURNING CLIENT: References a past visit, says "I want to rebook", mentions Chia by name familiarly, or has clear history context.

FOR NEW LEADS — collect conversationally, one or two questions at a time:
1. What they're interested in (K-Tips, tape-ins, other)
2. Current hair situation (length, texture, extensions now)
3. Their goal (length, volume, full transformation)
4. Timeframe (when are they looking)
5. Availability (best days/times)

Once you have all 5, respond with:
"We'd start with a free consultation so Chia can look at your hair and give you an exact quote — no surprises. We ask for a $25 booking fee to hold your spot (non-refundable). Here's the link: https://buy.stripe.com/14A3cwe0a7iVcAlex0bV603 — once you're booked Chia will reach out to confirm your time."

FOR RETURNING CLIENTS:
Skip full qualification. Just ask when they're looking to come in and get their availability. Then alert for booking.

OBJECTION HANDLING:
"How much does it cost?" → "It really depends on your hair — that's exactly why we start with a free consult. Chia looks at what you've got and gives you a real number on the spot."
"Is it worth it?" → "K-Tips last 3-4 months, look completely natural, and you wake up with great hair every day. Most clients say it's the best thing they've done for their hair."
"I'm nervous about damage" → "K-Tips are the safest method when done right. No damage to your natural hair. Chia has done hundreds of installs."
"That's expensive" → "The $799 covers everything — the hair itself, custom color matching, installation, and the cut to blend. Most places charge each piece separately."
"Do you have availability?" → "Let me check with Chia — what days generally work best for you?"

TONE:
- Sound like a real person on the team. Warm, direct, confident.
- 1-3 sentences max. Always end with one question.
- No exclamation mark on every sentence.
- Never say "Great question", "Absolutely", "Of course", or "Certainly".
- Never reveal you are an AI or a bot. Ever.
- Don't oversell. Let the service speak.
- If they go quiet after real interest: ONE follow-up only — "Still thinking about it? Happy to answer any questions before you decide."
- After that, don't chase.

RESPOND WITH EXACTLY THE TEXT: NEEDS_HUMAN
(nothing else, no punctuation) when:
- They express frustration or make a complaint
- They mention a bad experience at Chia
- They ask something very specific you cannot answer confidently
- 6+ messages exchanged with no booking info collected
- Chia's direct judgment is clearly required`;

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
    console.log('Alert send error:', err.response?.data?.error?.message || err.message);
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

  if (conversations[userId].length > 20) conversations[userId] = conversations[userId].slice(-20);

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: conversations[userId]
    });

    const reply = response.content[0].text.trim();

    if (reply === 'NEEDS_HUMAN') {
      const summary = conversations[userId]
        .slice(-6)
        .map(m => (m.role === 'user' ? 'Lead' : 'Agent') + ': ' + m.content)
        .join('\n');
      await sendAlert('NEEDS ATTENTION\n\nIG ID: ' + userId + '\n\n' + summary + '\n\nCheck DMs and take over.');
      const handoff = "Let me grab Chia for you — she'll be right with you.";
      conversations[userId].push({ role: 'assistant', content: handoff });
      return handoff;
    }

    if (reply.includes('buy.stripe.com')) {
      const summary = conversations[userId]
        .slice(-10)
        .map(m => (m.role === 'user' ? 'Lead' : 'Agent') + ': ' + m.content)
        .join('\n');
      await sendAlert('BOOKING LINK SENT - READY TO BOOK\n\nIG ID: ' + userId + '\n\n' + summary + '\n\nBook in GlossGenius once they pay the $25.');
    }

    conversations[userId].push({ role: 'assistant', content: reply });
    return reply;

  } catch (err) {
    console.error('Claude error:', err.message);
    return "Hey — thanks for reaching out to Chia Beauty Room. We'll be right with you.";
  }
}

app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    res.status(200).send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
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
      console.log('Incoming DM from ' + senderId + ': ' + messageText);
      const reply = await getAIResponse(senderId, messageText);
      await sendMessage(senderId, reply);
      console.log('Replied to ' + senderId + ': ' + reply);
    }
  }
});

app.get('/', (req, res) => res.send('Revyn DM Agent is live'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Agent running on port ' + PORT));
