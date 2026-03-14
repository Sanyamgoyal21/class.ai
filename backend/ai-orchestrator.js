import axios from "axios";

const QWEN_MODEL = process.env.QWEN_MODEL || "qwen/qwen3-8b";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

const systemPrompt = `You are an AI Academic Assistant.
Explain clearly, step-by-step.
Encourage learning, not memorization.
Be concise and helpful.`;

// Doubt mode specific prompt - used when answering student doubts during video playback
const doubtModePrompt = `You are an AI Classroom Doubt Assistant integrated into a live classroom video system.

Your role is to answer student doubts based on the currently playing educational video.

Rules:
- Keep answers simple, clear, and classroom-friendly
- Use step-by-step explanations when needed
- Stay within the context of the video topic if provided
- Be concise - no emojis, no markdown formatting
- If the doubt is unclear, ask ONE short clarifying question only
- Do NOT introduce unrelated topics
- Speak like a teacher helping during a live class

If video context is provided, use it to give relevant answers.
If no context is available, answer the question to the best of your ability.`;

// Build context-aware prompt based on video context
function buildDoubtPrompt(videoContext) {
  let prompt = doubtModePrompt;

  if (videoContext) {
    const contextParts = [];
    if (videoContext.video_topic) {
      contextParts.push(`Current Topic: ${videoContext.video_topic}`);
    }
    if (videoContext.video_title) {
      contextParts.push(`Video: ${videoContext.video_title}`);
    }

    if (contextParts.length > 0) {
      prompt += `\n\nVideo Context:\n${contextParts.join('\n')}`;
    }
  }

  return prompt;
}

async function queryQwen(messages, context = null) {
  if (!OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY not configured");
  }

  const activeSystemPrompt = context ? buildDoubtPrompt(context) : systemPrompt;

  const res = await axios.post(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      model: QWEN_MODEL,
      messages: [
        { role: "system", content: activeSystemPrompt },
        ...messages,
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 45000,
    }
  );

  if (!res.data?.choices?.[0]?.message?.content) {
    throw new Error(
      `OpenRouter error: ${res.status} - ${JSON.stringify(res.data?.error || "no content")}`
    );
  }

  return { response: res.data.choices[0].message.content, source: "qwen" };
}

export async function generateResponse(messages, context = null) {
  return await queryQwen(messages, context);
}

export function getHealthStatus() {
  return {
    qwen: {
      available: !!OPENROUTER_API_KEY,
      model: QWEN_MODEL,
    },
  };
}
