import { generateResponse } from "./ai-orchestrator.js";

// In-memory device registry
const deviceRegistry = new Map();
const HEARTBEAT_TIMEOUT = 90000; // 90 seconds (3 missed heartbeats at 30s interval)

// Video state tracking per device (for resume after announcements)
// Structure: deviceId -> { lastVideoUrl, isPlaying, announcementActive, announcementSessionId }
const deviceVideoState = new Map();

export function setupSocketHandlers(io) {
  // Cleanup stale devices periodically
  setInterval(() => {
    const now = Date.now();
    for (const [socketId, device] of deviceRegistry.entries()) {
      if (now - device.lastHeartbeat > HEARTBEAT_TIMEOUT) {
        console.log(`Device ${device.deviceId} timed out, marking offline`);
        device.status = "offline";
        io.emit("device:status", {
          deviceId: device.deviceId,
          status: "offline",
          reason: "heartbeat_timeout",
        });
      }
    }
  }, 30000);

  io.on("connection", (socket) => {
    console.log(`Client connected: ${socket.id}`);

    // Device registration
    socket.on("device:register", (data) => {
      const device = {
        socketId: socket.id,
        deviceId: data.deviceId,
        type: data.type, // 'classroom', 'gate', 'dashboard'
        name: data.name,
        capabilities: data.capabilities || [],
        ip: socket.handshake.address,
        status: "online",
        lastHeartbeat: Date.now(),
        registeredAt: new Date().toISOString(),
      };

      deviceRegistry.set(socket.id, device);
      socket.join(`device:${data.type}`);
      socket.join(`device:${data.deviceId}`);

      console.log(`Device registered: ${data.name} (${data.type})`);

      // Send acknowledgment
      socket.emit("device:registered", {
        success: true,
        config: {
          heartbeatInterval: 30000,
          serverTime: Date.now(),
        },
      });

      // Broadcast updated device list to dashboards
      broadcastDeviceList(io);
    });

    // Heartbeat handling
    socket.on("device:heartbeat", (data) => {
      const device = deviceRegistry.get(socket.id);
      if (device) {
        device.lastHeartbeat = Date.now();
        device.status = "online";
        device.metrics = data.metrics || {};

        // Notify dashboards of status update
        io.to("device:dashboard").emit("device:heartbeat-ack", {
          deviceId: device.deviceId,
          status: "online",
          metrics: device.metrics,
        });
      }
    });

    // Control commands from dashboard to devices
    socket.on("control:command", (data) => {
      const { targetDeviceId, action, params } = data;
      const sender = deviceRegistry.get(socket.id);

      // Only dashboards can send control commands
      if (!sender || sender.type !== "dashboard") {
        socket.emit("control:error", {
          error: "Unauthorized: Only dashboards can send commands",
        });
        return;
      }

      console.log(`Control command: ${action} -> ${targetDeviceId}`);

      // Find target device
      const targetDevice = findDeviceById(targetDeviceId);
      if (!targetDevice) {
        socket.emit("control:error", {
          error: `Device ${targetDeviceId} not found`,
          commandId: data.commandId,
        });
        return;
      }

      // Forward command to target device
      io.to(`device:${targetDeviceId}`).emit("control:command", {
        commandId: data.commandId || Date.now().toString(),
        action,
        params,
        issuedBy: sender.deviceId,
        timestamp: new Date().toISOString(),
      });
    });

    // Control command acknowledgment from devices
    socket.on("control:ack", (data) => {
      // Forward ACK to all dashboards
      io.to("device:dashboard").emit("control:ack", data);
    });

    // Attendance events from gate camera or classroom
    socket.on("attendance:entry", (data) => {
      const device = deviceRegistry.get(socket.id);
      console.log(
        `Attendance: ${data.studentName} at ${device?.name || "unknown"}`
      );

      // Broadcast to dashboards
      io.to("device:dashboard").emit("attendance:entry", {
        ...data,
        deviceId: device?.deviceId,
        deviceName: device?.name,
        receivedAt: new Date().toISOString(),
      });
    });

    // Presence updates from classroom (who is in frame)
    socket.on("presence:update", (data) => {
      const device = deviceRegistry.get(socket.id);

      // Forward to dashboards
      io.to("device:dashboard").emit("presence:update", {
        ...data,
        deviceId: device?.deviceId,
        deviceName: device?.name,
      });
    });

    // AI query from classroom devices
    socket.on("ai:query", async (data) => {
      const device = deviceRegistry.get(socket.id);
      const queryId = data.queryId || Date.now().toString();

      console.log(`AI query from ${device?.name}: ${data.text}`);

      try {
        const messages = [{ role: "user", content: data.text }];
        // Pass context to generateResponse for doubt-mode specific prompts
        const context = data.context || null;
        const result = await generateResponse(messages, context);

        // Send response back to the requesting device
        socket.emit("ai:response", {
          queryId,
          response: result.response,
          source: result.source,
          latencyMs: Date.now() - parseInt(queryId),
        });

        // Also broadcast to ALL classroom devices (so HTML display shows answer)
        io.to("device:classroom").emit("ai:response", {
          queryId,
          response: result.response,
          source: result.source,
          fromDevice: device?.deviceId,
          speaker: data.speaker,
        });

        // Also notify dashboards
        io.to("device:dashboard").emit("ai:query-log", {
          deviceId: device?.deviceId,
          speaker: data.speaker,
          query: data.text,
          response: result.response,
          source: result.source,
          context: context,
        });
      } catch (err) {
        socket.emit("ai:response", {
          queryId,
          error: err.message,
          response: "I'm sorry, the AI service is temporarily unavailable.",
        });
      }
    });

    // Camera image streaming (JPEG over WebSocket for MVP)
    socket.on("camera:frame", (data) => {
      const device = deviceRegistry.get(socket.id);
      if (!device) return;

      // Forward to dashboards viewing this camera
      io.to("device:dashboard").emit("camera:frame", {
        deviceId: device.deviceId,
        frame: data.frame, // base64 JPEG
        timestamp: data.timestamp,
      });
    });

    // Broadcast message from dashboard to all devices
    socket.on("broadcast:message", (data) => {
      const sender = deviceRegistry.get(socket.id);
      if (!sender || sender.type !== "dashboard") return;

      console.log(`Broadcast: ${data.content}`);

      // Send to all classroom devices
      io.to("device:classroom").emit("broadcast:message", {
        from: sender.name || "Admin",
        type: data.type || "announcement",
        content: data.content,
        priority: data.priority || "normal",
        displayDuration: data.displayDuration || 30,
        timestamp: new Date().toISOString(),
      });
    });

    // =================== EMERGENCY BROADCAST ===================

    // Emergency broadcast - sends urgent alert to ALL classrooms
    socket.on("emergency:broadcast", (data) => {
      const sender = deviceRegistry.get(socket.id);

      // Only dashboards can send emergency broadcasts
      if (!sender || sender.type !== "dashboard") {
        socket.emit("emergency:error", { error: "Unauthorized" });
        return;
      }

      const { message, targetDeviceIds } = data;

      if (!message) {
        socket.emit("emergency:error", { error: "Missing message" });
        return;
      }

      console.log(`EMERGENCY BROADCAST: ${message}`);

      // Send to specified devices or all classrooms
      const targets = targetDeviceIds || [];
      if (targets.length > 0) {
        for (const deviceId of targets) {
          io.to(`device:${deviceId}`).emit("emergency:alert", {
            message,
            from: sender.name || "Admin",
            timestamp: new Date().toISOString(),
            priority: "critical",
          });
        }
      } else {
        // Fallback: send to all classroom devices
        io.to("device:classroom").emit("emergency:alert", {
          message,
          from: sender.name || "Admin",
          timestamp: new Date().toISOString(),
          priority: "critical",
        });
      }

      // Acknowledge to sender
      socket.emit("emergency:sent", {
        message,
        targetCount: targets.length || "all",
      });
    });

    // =================== VIDEO CONTROL EVENTS ===================

    // Play video on selected classroom devices
    socket.on("video:play", (data) => {
      const sender = deviceRegistry.get(socket.id);

      // Only dashboards can send video commands
      if (!sender || sender.type !== "dashboard") {
        socket.emit("video:error", { error: "Unauthorized: Only dashboards can send commands" });
        return;
      }

      const { targetDeviceIds, url, autoPlay = true, volume = 1.0 } = data;

      if (!targetDeviceIds || !Array.isArray(targetDeviceIds) || !url) {
        socket.emit("video:error", { error: "Missing targetDeviceIds or url" });
        return;
      }

      const commandId = `vid-${Date.now()}`;
      console.log(`Video play: ${url} -> ${targetDeviceIds.length} device(s)`);

      let sentCount = 0;
      for (const deviceId of targetDeviceIds) {
        const device = findDeviceById(deviceId);
        if (device && device.type === "classroom") {
          // Track video state for this device (for resume after announcement)
          deviceVideoState.set(deviceId, {
            lastVideoUrl: url,
            isPlaying: true,
            announcementActive: false,
            startedAt: Date.now(),
          });

          // Send play command to classroom
          io.to(`device:${deviceId}`).emit("video:play", {
            commandId,
            url,
            autoPlay,
            volume,
            issuedBy: sender.deviceId,
            timestamp: new Date().toISOString(),
          });
          sentCount++;
        }
      }

      // Acknowledge to dashboard
      socket.emit("video:play-sent", {
        commandId,
        targetCount: sentCount,
        url,
      });
    });

    // Stop video on selected classroom devices
    socket.on("video:stop", (data) => {
      const sender = deviceRegistry.get(socket.id);

      if (!sender || sender.type !== "dashboard") {
        socket.emit("video:error", { error: "Unauthorized" });
        return;
      }

      const { targetDeviceIds } = data;

      if (!targetDeviceIds || !Array.isArray(targetDeviceIds)) {
        socket.emit("video:error", { error: "Missing targetDeviceIds" });
        return;
      }

      const commandId = `vid-stop-${Date.now()}`;
      console.log(`Video stop -> ${targetDeviceIds.length} device(s)`);

      let sentCount = 0;
      for (const deviceId of targetDeviceIds) {
        // Update video state
        const state = deviceVideoState.get(deviceId);
        if (state) {
          state.isPlaying = false;
        }

        // Send stop command
        io.to(`device:${deviceId}`).emit("video:stop", {
          commandId,
          issuedBy: sender.deviceId,
          timestamp: new Date().toISOString(),
        });
        sentCount++;
      }

      socket.emit("video:stop-sent", { commandId, targetCount: sentCount });
    });

    // Video state changed acknowledgment from classroom
    socket.on("video:state-changed", (data) => {
      const device = deviceRegistry.get(socket.id);
      if (!device) return;

      const { state, url, currentTime } = data;

      // Update tracked state
      const videoState = deviceVideoState.get(device.deviceId) || {};
      videoState.isPlaying = state === "playing";
      videoState.currentTime = currentTime;
      if (url) videoState.lastVideoUrl = url;
      deviceVideoState.set(device.deviceId, videoState);

      // Forward to all dashboards so they can update UI
      io.to("device:dashboard").emit("video:state-changed", {
        deviceId: device.deviceId,
        deviceName: device.name,
        state,
        url,
        currentTime,
        timestamp: new Date().toISOString(),
      });
    });

    // =================== VIDEO PAUSE/RESUME FOR DOUBT MODE ===================

    // Pause video (from classroom device during doubt mode)
    socket.on("video:pause", (data) => {
      const device = deviceRegistry.get(socket.id);
      if (!device) return;

      const { reason, targetDeviceId } = data;
      console.log(`Video pause: ${device.deviceId} (reason: ${reason || "unknown"})`);

      // Determine target - use targetDeviceId if provided, otherwise broadcast to all classrooms
      const target = targetDeviceId || null;

      if (target) {
        // Update video state for specific device
        const videoState = deviceVideoState.get(target) || {};
        videoState.isPlaying = false;
        videoState.pausedAt = Date.now();
        videoState.pauseReason = reason;
        deviceVideoState.set(target, videoState);

        // Send pause command to specific classroom display
        io.to(`device:${target}`).emit("video:pause", {
          reason,
          timestamp: new Date().toISOString(),
        });
      } else {
        // Broadcast to ALL classroom devices (for doubt mode from Python runner)
        io.to("device:classroom").emit("video:pause", {
          reason,
          fromDevice: device.deviceId,
          timestamp: new Date().toISOString(),
        });

        // Update state for all classroom devices
        for (const [, dev] of deviceRegistry.entries()) {
          if (dev.type === "classroom") {
            const videoState = deviceVideoState.get(dev.deviceId) || {};
            videoState.isPlaying = false;
            videoState.pausedAt = Date.now();
            videoState.pauseReason = reason;
            deviceVideoState.set(dev.deviceId, videoState);
          }
        }
      }

      // Notify dashboards
      io.to("device:dashboard").emit("video:state-changed", {
        deviceId: target || device.deviceId,
        deviceName: device.name,
        state: "paused",
        reason,
        timestamp: new Date().toISOString(),
      });
    });

    // Resume video (from classroom device after doubt resolved)
    socket.on("video:resume", (data) => {
      const device = deviceRegistry.get(socket.id);
      if (!device) return;

      const { reason, targetDeviceId } = data;
      console.log(`Video resume: ${device.deviceId} (reason: ${reason || "unknown"})`);

      // Determine target - use targetDeviceId if provided, otherwise broadcast to all classrooms
      const target = targetDeviceId || null;

      if (target) {
        // Update video state for specific device
        const videoState = deviceVideoState.get(target) || {};
        videoState.isPlaying = true;
        videoState.pauseReason = null;
        deviceVideoState.set(target, videoState);

        // Send resume command to specific classroom display
        io.to(`device:${target}`).emit("video:resume", {
          reason,
          timestamp: new Date().toISOString(),
        });
      } else {
        // Broadcast to ALL classroom devices (for doubt mode from Python runner)
        io.to("device:classroom").emit("video:resume", {
          reason,
          fromDevice: device.deviceId,
          timestamp: new Date().toISOString(),
        });

        // Update state for all classroom devices
        for (const [, dev] of deviceRegistry.entries()) {
          if (dev.type === "classroom") {
            const videoState = deviceVideoState.get(dev.deviceId) || {};
            videoState.isPlaying = true;
            videoState.pauseReason = null;
            deviceVideoState.set(dev.deviceId, videoState);
          }
        }
      }

      // Notify dashboards
      io.to("device:dashboard").emit("video:state-changed", {
        deviceId: target || device.deviceId,
        deviceName: device.name,
        state: "playing",
        reason,
        timestamp: new Date().toISOString(),
      });
    });

    // =================== DOUBT MODE EVENTS ===================

    // Doubt mode entered (from classroom device - typically Python runner)
    socket.on("doubt:mode-entered", (data) => {
      const device = deviceRegistry.get(socket.id);
      if (!device) return;

      console.log(`Doubt mode entered: ${device.deviceId} (speaker: ${data.speaker || "unknown"})`);

      // Broadcast to ALL classroom devices (so HTML display receives it)
      io.to("device:classroom").emit("doubt:mode-entered", {
        speaker: data.speaker,
        fromDevice: device.deviceId,
        timestamp: new Date().toISOString(),
      });

      // Notify dashboards
      io.to("device:dashboard").emit("doubt:mode-entered", {
        deviceId: device.deviceId,
        deviceName: device.name,
        speaker: data.speaker,
        timestamp: new Date().toISOString(),
      });
    });

    // Doubt mode exited (from classroom device)
    socket.on("doubt:mode-exited", (data) => {
      const device = deviceRegistry.get(socket.id);
      if (!device) return;

      console.log(`Doubt mode exited: ${device.deviceId}`);

      // Broadcast to ALL classroom devices
      io.to("device:classroom").emit("doubt:mode-exited", {
        fromDevice: device.deviceId,
        timestamp: new Date().toISOString(),
      });

      // Notify dashboards
      io.to("device:dashboard").emit("doubt:mode-exited", {
        deviceId: device.deviceId,
        deviceName: device.name,
        timestamp: new Date().toISOString(),
      });
    });

    // Doubt query (from classroom device)
    socket.on("doubt:query", (data) => {
      const device = deviceRegistry.get(socket.id);
      if (!device) return;

      const { question, speaker, context } = data;
      console.log(`Doubt query from ${device.deviceId}: ${question}`);

      // Broadcast to ALL classroom devices for showing the question
      io.to("device:classroom").emit("doubt:question", {
        question,
        speaker,
        context,
        fromDevice: device.deviceId,
        timestamp: new Date().toISOString(),
      });

      // Notify dashboards
      io.to("device:dashboard").emit("doubt:query", {
        deviceId: device.deviceId,
        deviceName: device.name,
        question,
        speaker,
        context,
        timestamp: new Date().toISOString(),
      });
    });

    // =================== LIVE ANNOUNCEMENT (WEBRTC) EVENTS ===================

    // Start live announcement - pause videos and prepare for WebRTC
    socket.on("announcement:start", (data) => {
      const sender = deviceRegistry.get(socket.id);

      if (!sender || sender.type !== "dashboard") {
        socket.emit("announcement:error", { error: "Unauthorized" });
        return;
      }

      const { targetDeviceIds, type = "audio_video" } = data;

      if (!targetDeviceIds || !Array.isArray(targetDeviceIds)) {
        socket.emit("announcement:error", { error: "Missing targetDeviceIds" });
        return;
      }

      const sessionId = `ann-${Date.now()}`;
      console.log(`Announcement starting: ${type} -> ${targetDeviceIds.length} device(s)`);

      let sentCount = 0;
      for (const deviceId of targetDeviceIds) {
        const device = findDeviceById(deviceId);
        if (device && device.type === "classroom") {
          // Mark device as in announcement mode (preserve lastVideoUrl for resume)
          const currentState = deviceVideoState.get(deviceId) || { lastVideoUrl: null };
          deviceVideoState.set(deviceId, {
            ...currentState,
            announcementActive: true,
            announcementFrom: sender.deviceId,
            announcementSessionId: sessionId,
          });

          // Notify classroom to pause video and prepare for WebRTC
          io.to(`device:${deviceId}`).emit("announcement:start", {
            sessionId,
            type,
            from: sender.deviceId,
            fromName: sender.name || "Admin",
            timestamp: new Date().toISOString(),
          });
          sentCount++;
        }
      }

      // Acknowledge to dashboard with session info
      socket.emit("announcement:started", {
        sessionId,
        targetCount: sentCount,
        targetDeviceIds: targetDeviceIds.filter(id => {
          const d = findDeviceById(id);
          return d && d.type === "classroom";
        }),
      });
    });

    // End live announcement - close WebRTC and resume video
    socket.on("announcement:end", (data) => {
      const sender = deviceRegistry.get(socket.id);

      if (!sender || sender.type !== "dashboard") {
        socket.emit("announcement:error", { error: "Unauthorized" });
        return;
      }

      const { sessionId, targetDeviceIds } = data;
      console.log(`Announcement ending: ${sessionId}`);

      for (const deviceId of targetDeviceIds) {
        const state = deviceVideoState.get(deviceId);
        const lastVideoUrl = state?.lastVideoUrl;

        // Clear announcement state
        if (state) {
          state.announcementActive = false;
          state.announcementFrom = null;
          state.announcementSessionId = null;
        }

        // Notify classroom to end WebRTC and optionally resume video
        io.to(`device:${deviceId}`).emit("announcement:end", {
          sessionId,
          resumeVideo: !!lastVideoUrl,
          resumeUrl: lastVideoUrl,
          timestamp: new Date().toISOString(),
        });
      }

      socket.emit("announcement:ended", { sessionId });
    });

    // Classroom signals it's ready for WebRTC stream
    socket.on("announcement:ready", (data) => {
      const device = deviceRegistry.get(socket.id);
      if (!device) return;

      const { sessionId } = data;
      const state = deviceVideoState.get(device.deviceId);

      // Notify the dashboard that initiated the announcement
      if (state?.announcementFrom) {
        io.to("device:dashboard").emit("announcement:device-ready", {
          sessionId,
          deviceId: device.deviceId,
          deviceName: device.name,
        });
      }
    });

    // WebRTC signaling
    socket.on("webrtc:offer", (data) => {
      io.to(`device:${data.to}`).emit("webrtc:offer", {
        from: deviceRegistry.get(socket.id)?.deviceId || socket.id,
        sdp: data.sdp,
      });
    });

    socket.on("webrtc:answer", (data) => {
      io.to(`device:${data.to}`).emit("webrtc:answer", {
        from: deviceRegistry.get(socket.id)?.deviceId || socket.id,
        sdp: data.sdp,
      });
    });

    socket.on("webrtc:ice-candidate", (data) => {
      io.to(`device:${data.to}`).emit("webrtc:ice-candidate", {
        from: deviceRegistry.get(socket.id)?.deviceId || socket.id,
        candidate: data.candidate,
      });
    });

    // Disconnect handling
    socket.on("disconnect", () => {
      const device = deviceRegistry.get(socket.id);
      if (device) {
        console.log(`Device disconnected: ${device.name} (${device.type})`);
        device.status = "offline";

        // Notify dashboards
        io.to("device:dashboard").emit("device:status", {
          deviceId: device.deviceId,
          status: "offline",
          reason: "disconnected",
        });

        // Remove from registry after a delay (allow reconnection)
        setTimeout(() => {
          if (deviceRegistry.get(socket.id)?.status === "offline") {
            deviceRegistry.delete(socket.id);
            broadcastDeviceList(io);
          }
        }, 30000);
      }
    });

    // Send current device list on request
    socket.on("devices:list", () => {
      socket.emit("devices:list", getDeviceList());
    });
  });
}

function findDeviceById(deviceId) {
  for (const device of deviceRegistry.values()) {
    if (device.deviceId === deviceId) {
      return device;
    }
  }
  return null;
}

function getDeviceList() {
  const devices = [];
  for (const device of deviceRegistry.values()) {
    devices.push({
      deviceId: device.deviceId,
      type: device.type,
      name: device.name,
      status: device.status,
      capabilities: device.capabilities,
      lastHeartbeat: device.lastHeartbeat,
      metrics: device.metrics,
    });
  }
  return devices;
}

function broadcastDeviceList(io) {
  io.to("device:dashboard").emit("devices:list", getDeviceList());
}

export function getDeviceRegistry() {
  return deviceRegistry;
}

// Export video state for REST API queries
export function getDeviceVideoState() {
  const states = {};
  for (const [deviceId, state] of deviceVideoState.entries()) {
    states[deviceId] = { ...state };
  }
  return states;
}
