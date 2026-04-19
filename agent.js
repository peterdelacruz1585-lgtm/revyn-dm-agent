const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'revyn_verify_token';
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ALERT_RECIPIENT_ID = process.env.ALERT_RECIPIENT_ID; // Your personal IG user ID

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are the assistant for Chia Beauty Room, a premium hair extension salon in [CITY]. You respond to Instagram DMs on behalf of Chia.

Your job is to figure out if someone is a new lead (coming from an ad or discovering us) or a returning client, then collect the right info so Chia can book them manually.

DETECTING LEAD TYPE:
- NEW LEAD / AD: First message mentions extensions, pricing, "saw your ad", "found you on Instagram", asks about services for the first time, or has no prior context. Treat all unknown first-time contacts as new leads.
- RETURNING CLIENT: They mention "I was just in", "I came in last time", "it's me [name]", "can I rebook", reference a past appointment, or Chia knows them.

FOR NEW LEADS — your goal is to collect:
1. Their name
2. What service they're interested in (K-Tips, tape-ins, other)
3. Their hair situation (length, texture, any extensions currently)
4. When they're looking to come in (timeframe)
5. Best days/times that work for them

Do this conversationally — one or two questions at a time, never a form-style list. Once you have all 5, say: "Perfect, let me get you locked in — I'll have Chia reach out to confirm your exact time."

FOR RETURNING CLIENTS — skip the full qualification. Just ask:
"Hey! Good to hear from you — when are you looking to come in?" Then get their preferred day/time.

TONE RULES:
- Sound like a real person working at the salon — warm, casual, confident
- Short replies — 1-3 sentences max
- No exclamation points on every sentence
- Never say "Great question" or "Absolutely"
- Never say you are an AI or a bot
- Don't chase. If they go quiet after showing interest, one gentle follow-up max: "Still looking to book? Just let me know."
- We don't do pressure. The work sells itself.

INTERVENTION — respond with exactly the text "NEEDS_HUMAN" (nothing else) if:
- They express strong frustration or a complaint
- They ask something highly specific you cannot answer (e.g. exact pricing tiers, medical questions)
- They say something that requires a human judgment call
- They've sent 6+ messages and haven't given booking info yet
- They mention they had a bad experience at Chia previously`;

const conversations = {};
const messageCount = {};

async function sendAlert(leadInfo) {
  if (!ALERT_RECIPIENT_ID) return;
  try {
    await axios.post(`https://graph.facebook.com/v19.0/me/messages`, {
      recipient: { id: ALERT_RECIPIENT_ID },
      message: { text: leadInfo },
      messaging_type: "MESSAGE_TAG",
      tag: "ACCOUNT_UPDATE"
    }, { params: { access_token: PAGE_ACCESS_TOKEN } });
  } catch (err) {
    console.log('Alert error (non-critical):', err.response?.data?.error?.message);
  }
}

async function sendMessage(recipientId, message) {
  try {
    await axios.post("https://graph.facebook.com/v19.0/me/messages", {
      recipient: { id: recipientId },
      message: { text: message },
      messaging_type: "RESPONSE"
    }, { params: { access_token: PAGE_ACCESS_TOKEN } });
  } catch (err) {
    console.error("Send error:", err.response?.data || err.message);
  }
}

async function getAIResponse(userId, userMessage) {
  if (!conversations[userId]) conversations[userId] = [];
  if (!messageCount[userId]) messageCount[userId] = 0;
  
  conversations[userId].push({ role: "user", content: userMessage });
  messageCount[userId]++;
  
  if (conversations[userId].length > 20) conversations[userId] = conversations[userId].slice(-20);

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: conversations[userId]
    });

    const reply = response.content[0].text.trim();
    
    // Check if agent is flagging for human intervention
    if (reply === 'NEEDS_HUMAN') {
      const convoSummary = conversations[userId]
        .slice(-6)
        .map(m => (m.role === 'user' ? 'Lead: ' : 'Agent: ') + m.content)
        .join('\n');
      
      await sendAlert(`🚨 LEAD NEEDS ATTENTION\n\nInstagram ID: ${userId}\n\nRecent convo:\n${convoSummary}\n\nCheck DMs and take over.`);
      
      conversations[userId].push({ role: "assistant", content: "Let me grab Chia real quick — she'll be with you in a moment." });
      return "Let me grab Chia real quick — she'll be with you in a moment.";
    }

    // Check if agent has collected all lead info (heuristic: 5+ exchanges and reply mentions locking in)
    if (messageCount[userId] >= 5 && reply.toLowerCase().includes("get you locked in")) {
      const convoSummary = conversations[userId]
        .slice(-10)
        .map(m => (m.role === 'user' ? 'Lead: ' : 'Agent: ') + m.content)
        .join('\n');
      
      await sendAlert(`📅 NEW BOOKING LEAD — READY TO BOOK\n\nInstagram ID: ${userId}\n\nConvo:\n${convoSummary}\n\nBook them in GlossGenius.`);
    }

    conversations[userId].push({ role: "assistant", content: reply });
    return reply;

  } catch (err) {
    console.error('Claude error:', err.message);
    return "Hey! Thanks for reaching out to Chia Beauty Room — we'll be right with you.";
  }
}

app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY_TOKEN) {
    res.status(200).send(req.query["hub.challenge"]);
  } else {
    res.sendStatus(403);
  }
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  const body = req.body;
  if (body.object !== "instagram" && body.object !== "page") return;

  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      const senderId = event.sender?.id;
      const messageText = event.message?.text;
      if (!senderId || !messageText || event.message?.is_echo) continue;
      
      console.log(`Incoming DM from ${senderId}: ${messageText}`);
      const reply = await getAIResponse(senderId, messageText);
      await sendMessage(senderId, reply);
      console.log(`Replied to ${senderId}: ${reply}`);
    }
  }
});

app.get("/", (req, res) => res.send("Revyn DM Agent is live"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Agent running on port " + PORT));
