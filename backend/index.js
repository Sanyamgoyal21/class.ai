import "dotenv/config";
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import { generateResponse, getHealthStatus, checkOllamaHealth } from "./ai-orchestrator.js";
import { setupSocketHandlers, getDeviceRegistry, getDeviceVideoState } from "./socket-handlers.js";

const app = express();
const httpServer = createServer(app);

// Socket.io server with CORS
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

app.use(cors());
app.use(express.json());

// Setup Socket.io event handlers
setupSocketHandlers(io);

// Health check endpoint
app.get("/health", async (req, res) => {
  const aiStatus = getHealthStatus();
  const devices = getDeviceRegistry();

  let onlineCount = 0;
  let offlineCount = 0;

  for (const device of devices.values()) {
    if (device.status === "online") onlineCount++;
    else offlineCount++;
  }

  res.json({
    status: aiStatus.ollama.healthy || aiStatus.gemini.available ? "healthy" : "degraded",
    components: {
      ...aiStatus,
      devices: {
        online: onlineCount,
        offline: offlineCount,
        total: devices.size,
      },
    },
    timestamp: new Date().toISOString(),
  });
});

// Chat endpoint (REST API for compatibility)
app.post("/chat", async (req, res) => {
  try {
    const userMessages = req.body.messages;
    const result = await generateResponse(userMessages);

    res.json({
      choices: [
        {
          message: {
            role: "assistant",
            content: result.response,
          },
        },
      ],
      source: result.source,
    });
  } catch (err) {
    console.error("Chat error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get device list (REST API)
app.get("/api/devices", (req, res) => {
  const devices = [];
  for (const device of getDeviceRegistry().values()) {
    devices.push({
      deviceId: device.deviceId,
      type: device.type,
      name: device.name,
      status: device.status,
      capabilities: device.capabilities,
      lastHeartbeat: device.lastHeartbeat,
    });
  }
  res.json(devices);
});

// Send control command (REST API alternative to WebSocket)
app.post("/api/control", (req, res) => {
  const { targetDeviceId, action, params } = req.body;

  // Find device
  let targetDevice = null;
  for (const device of getDeviceRegistry().values()) {
    if (device.deviceId === targetDeviceId) {
      targetDevice = device;
      break;
    }
  }

  if (!targetDevice) {
    return res.status(404).json({ error: "Device not found" });
  }

  const commandId = Date.now().toString();
  io.to(`device:${targetDeviceId}`).emit("control:command", {
    commandId,
    action,
    params,
    issuedBy: "api",
    timestamp: new Date().toISOString(),
  });

  res.json({ success: true, commandId });
});

// Broadcast message (REST API)
app.post("/api/broadcast", (req, res) => {
  const { content, type, priority, displayDuration } = req.body;

  io.to("device:classroom").emit("broadcast:message", {
    from: "Admin",
    type: type || "announcement",
    content,
    priority: priority || "normal",
    displayDuration: displayDuration || 30,
    timestamp: new Date().toISOString(),
  });

  res.json({ success: true });
});

// =================== VIDEO CONTROL REST API ===================

// Play video on classroom devices
app.post("/api/video/play", (req, res) => {
  const { targetDeviceIds, url, autoPlay = true, volume = 1.0 } = req.body;

  if (!targetDeviceIds || !Array.isArray(targetDeviceIds) || !url) {
    return res.status(400).json({ error: "targetDeviceIds (array) and url required" });
  }

  const commandId = `vid-api-${Date.now()}`;

  for (const deviceId of targetDeviceIds) {
    io.to(`device:${deviceId}`).emit("video:play", {
      commandId,
      url,
      autoPlay,
      volume,
      issuedBy: "api",
      timestamp: new Date().toISOString(),
    });
  }

  res.json({ success: true, commandId, targetCount: targetDeviceIds.length });
});

// Stop video on classroom devices
app.post("/api/video/stop", (req, res) => {
  const { targetDeviceIds } = req.body;

  if (!targetDeviceIds || !Array.isArray(targetDeviceIds)) {
    return res.status(400).json({ error: "targetDeviceIds (array) required" });
  }

  const commandId = `vid-stop-api-${Date.now()}`;

  for (const deviceId of targetDeviceIds) {
    io.to(`device:${deviceId}`).emit("video:stop", {
      commandId,
      issuedBy: "api",
      timestamp: new Date().toISOString(),
    });
  }

  res.json({ success: true, commandId, targetCount: targetDeviceIds.length });
});

// Get video state for all devices
app.get("/api/video/state", (req, res) => {
  res.json(getDeviceVideoState());
});

const PORT = process.env.PORT || 5000;

httpServer.listen(PORT, () => {
  console.log(`Supernode running on http://localhost:${PORT}`);
  console.log(`Socket.io server ready for device connections`);

  // Check Ollama health on startup
  checkOllamaHealth().then((healthy) => {
    if (healthy) {
      console.log(`Ollama connected at ${process.env.OLLAMA_URL || "http://localhost:11434"}`);
    } else {
      console.log("Ollama not available, will use Gemini fallback if configured");
    }
  });
});
