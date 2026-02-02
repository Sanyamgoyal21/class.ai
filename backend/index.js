import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const MODEL = "phi";

app.post("/chat", async (req, res) => {
  try {
    const userMessages = req.body.messages;

    const systemPrompt = `
        You are an AI Academic Assistant.
        Explain clearly, step-by-step.
        Encourage learning, not memorization.
`;

    const conversation = userMessages
      .map(m => `${m.role.toUpperCase()}: ${m.content}`)
      .join("\n");

    const prompt = `${systemPrompt}\n${conversation}\nASSISTANT:`;

    const ollamaRes = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        prompt,
        temperature: 0.4,
        stream: false
      })
    });

    const data = await ollamaRes.json();

    res.json({
      choices: [
        {
          message: {
            role: "assistant",
            content: data.response
          }
        }
      ]
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Ollama error" });
  }
});

app.listen(5000, () =>
  console.log("🚀 Backend running on http://localhost:5000")
);