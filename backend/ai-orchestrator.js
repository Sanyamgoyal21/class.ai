import fetch from "node-fetch";
import { GoogleGenerativeAI } from "@google/generative-ai";

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "phi";
const OLLAMA_TIMEOUT = parseInt(process.env.OLLAMA_TIMEOUT) || 10000;

let genAI = null;
let ollamaHealthy = true;
let lastOllamaCheck = 0;
const OLLAMA_RETRY_INTERVAL = 60000; // Retry Ollama every 60s after failure

// Initialize Gemini if API key is available
if (process.env.GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
}

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

async function queryOllama(messages, timeout = OLLAMA_TIMEOUT, context = null) {
  const conversation = messages
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n");

  // Use doubt-specific prompt if context is provided (indicates doubt mode)
  const activePrompt = context ? buildDoubtPrompt(context) : systemPrompt;
  const prompt = `${activePrompt}\n${conversation}\nASSISTANT:`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt,
        temperature: 0.4,
        stream: false,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Ollama returned ${response.status}`);
    }

    const data = await response.json();
    ollamaHealthy = true;
    return { response: data.response, source: "ollama" };
  } catch (err) {
    clearTimeout(timeoutId);
    ollamaHealthy = false;
    lastOllamaCheck = Date.now();
    throw err;
  }
}

async function queryGemini(messages, context = null) {
  if (!genAI) {
    throw new Error("Gemini API key not configured");
  }

  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

  const conversation = messages
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n\n");

  // Use doubt-specific prompt if context is provided (indicates doubt mode)
  const activePrompt = context ? buildDoubtPrompt(context) : systemPrompt;
  const prompt = `${activePrompt}\n\nConversation:\n${conversation}\n\nProvide a helpful response:`;

  const result = await model.generateContent(prompt);
  const response = result.response.text();

  return { response, source: "gemini" };
}

export async function generateResponse(messages, context = null) {
  // Check if we should retry Ollama
  const now = Date.now();
  if (!ollamaHealthy && now - lastOllamaCheck > OLLAMA_RETRY_INTERVAL) {
    ollamaHealthy = true; // Allow retry
  }

  // Try Ollama first if healthy
  if (ollamaHealthy) {
    try {
      return await queryOllama(messages, OLLAMA_TIMEOUT, context);
    } catch (err) {
      console.log(`Ollama failed (${err.message}), trying Gemini fallback...`);
    }
  }

  // Fallback to Gemini
  if (genAI) {
    try {
      return await queryGemini(messages, context);
    } catch (err) {
      console.error("Gemini also failed:", err.message);
      throw new Error("All AI providers failed");
    }
  }

  throw new Error("Ollama unavailable and Gemini not configured");
}

export function getHealthStatus() {
  return {
    ollama: {
      healthy: ollamaHealthy,
      url: OLLAMA_URL,
      model: OLLAMA_MODEL,
    },
    gemini: {
      available: genAI !== null,
    },
  };
}

export async function checkOllamaHealth() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    ollamaHealthy = response.ok;
    return ollamaHealthy;
  } catch {
    ollamaHealthy = false;
    return false;
  }
}
