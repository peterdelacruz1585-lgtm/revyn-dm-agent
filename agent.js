const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const app = express();
app.use(express.json());
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'revyn_verify_token';
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const SYSTEM_PROMPT = 'You are a friendly assistant for Chia Beauty Room, a premium hair salon specializing in K-Tips hair extensions. Respond to Instagram DMs, qualify leads, and book consultations. Personality: warm, real, knowledgeable. Sound like a person, not a bot. Never say you are an AI. Goals: 1) Greet leads warmly 2) Ask qualifying questions: hair type, current length, desired look, timeline 3) Explain K-Tips (premium keratin bond, long-lasting, undetectable) 4) Push toward free consultation 5) When ready to book collect name and preferred day/time. Rules: Keep replies SHORT 2-3 sentences max. Always end with a question. If unsure say Let me check on that and get right back to you.';
const conversations = {};
async function sendMessage(recipientId, message) {
  try {
    await axios.post("https://graph.facebook.com/v19.0/me/messages", { recipient: { id: recipientId }, message: { text: message }, messaging_type: "RESPONSE" }, { params: { access_token: PAGE_ACCESS_TOKEN } });
  } catch (err) { console.error("Send error:", err.response?.data || err.message); }
}
async function getAIResponse(userId, userMessage) {
  if (!conversations[userId]) conversations[userId] = [];
  conversations[userId].push({ role: "user", content: userMessage });
  if (conversations[userId].length > 20) conversations[userId] = conversations[userId].slice(-20);
  try {
    const response = await client.messages.create({ model: "claude-sonnet-4-20250514", max_tokens: 300, system: SYSTEM_PROMPT, messages: conversations[userId] });
    const reply = response.content[0].text;
    conversations[userId].push({ role: "assistant", content: reply });
    return reply;
  } catch (err) { return "Hey! Thanks for reaching out to Chia Beauty Room! We will be right with you."; }
}
app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY_TOKEN) { res.status(200).send(req.query["hub.challenge"]); } else { res.sendStatus(403); }
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
      const reply = await getAIResponse(senderId, messageText);
      await sendMessage(senderId, reply);
    }
  }
});
app.get("/", (req, res) => res.send("Revyn DM Agent is live"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Agent running on port " + PORT));