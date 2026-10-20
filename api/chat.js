// Vercel serverless function: the "brain" of the voice bot.
// Keeps the API key on the server. Set GEMINI_API_KEY in Vercel -> Settings -> Environment Variables.
// Optional: GEMINI_MODEL (default below).

const MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

// ---- Edit this block to sell any other SaaS product ----
const PRODUCT = `
Product: FlowDesk, a WhatsApp + Instagram CRM for small businesses in India.
What it does: puts all customer chats in one shared inbox, auto-replies to common questions,
sends payment and order reminders, tracks leads on a simple pipeline, and shows a daily sales report.
Plans: Starter Rs 999/month (1 user, 1 WhatsApp number), Growth Rs 2,499/month (5 users, automation, reports).
Offer: 14-day free trial, no card needed. Free 20-minute demo and setup help. Setup takes about 10 minutes.
Good fit: shops, clinics, coaching classes, salons, D2C brands that get leads over WhatsApp.
Common objections: price, "we already use WhatsApp Business", "no time to learn", "need to ask my partner".
`;
const COMPANY = "Sankar Group";
const BOT_NAME = "Aarav";
// ---------------------------------------------------------

const LANGS = {
  "en-IN": "English (simple, friendly Indian English)",
  "hi-IN": "Hindi, written in Devanagari script",
  "te-IN": "Telugu, written in Telugu script",
};

function salesSystem(lang) {
  return `You are ${BOT_NAME}, a friendly sales representative at ${COMPANY}, on a live phone call.
Sell this product:
${PRODUCT}
Speak only in ${LANGS[lang] || LANGS["en-IN"]}.
Rules:
- This is spoken audio. Keep every reply to 1-2 short sentences. No lists, no emojis, no markdown.
- First message: greet, say your name and company, ask if it is a good time to talk for a minute.
- Discover needs with one question at a time (business type, how they handle customer chats, biggest pain).
- Explain only the features that match what they said. Quote prices only when asked or when closing.
- Handle objections calmly, then ask for the next step. Try to convert: offer the free trial or a demo.
- If they agree, confirm the next step (trial link on WhatsApp, or a demo time) and say goodbye.
- If they clearly refuse twice, thank them politely and end.
Respond ONLY with JSON: {"reply": "<what you say>", "end_call": <true only when you have said goodbye>}`;
}

const SUMMARY_SYSTEM = `You analyse sales call transcripts. Respond ONLY with JSON in this shape:
{"summary": "2-3 sentence summary in English",
 "requirements": ["customer needs, in English"],
 "objections": ["objections raised, in English"],
 "next_steps": ["agreed or recommended next steps, in English"],
 "status": "one of: Converted | Interested | Follow-up Required | Not Interested | Demo Requested | No Response"}
Status rules: Converted = customer agreed to buy or start a trial/plan. Demo Requested = customer asked for or accepted a demo.
Interested = positive but no commitment. Follow-up Required = undecided, asked to call later or needs approval.
Not Interested = clearly declined. No Response = customer said almost nothing. Use empty arrays when nothing applies.`;

async function callGemini({ system, contents, temperature }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
      generationConfig: { temperature, responseMimeType: "application/json", maxOutputTokens: 600 },
    }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || `Gemini error ${r.status}`);
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  return text;
}

function parseJson(text) {
  const clean = String(text).replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(clean);
  } catch {
    const m = clean.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch {}
    }
    return null;
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: "GEMINI_API_KEY is not set on the server" });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const { mode, messages, transcript, lang } = body || {};

  try {
    if (mode === "summary") {
      const text = await callGemini({
        system: SUMMARY_SYSTEM,
        contents: [{ role: "user", parts: [{ text: String(transcript || "").slice(0, 12000) }] }],
        temperature: 0.2,
      });
      const out = parseJson(text) || {};
      return res.status(200).json(out);
    }

    const contents = (Array.isArray(messages) ? messages : []).slice(-30).map((m) => ({
      role: m.role === "bot" ? "model" : "user",
      parts: [{ text: String(m.text || "").slice(0, 1500) }],
    }));
    if (!contents.length || contents[0].role !== "user") {
      return res.status(400).json({ error: "messages must start with a user turn" });
    }
    const text = await callGemini({ system: salesSystem(lang), contents, temperature: 0.7 });
    const out = parseJson(text);
    if (out && typeof out.reply === "string") {
      return res.status(200).json({ reply: out.reply, end_call: !!out.end_call });
    }
    return res.status(200).json({ reply: String(text).replace(/[{}"]/g, "").trim(), end_call: false });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
