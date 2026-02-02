import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const connectedDevices = new Map();

function getDeviceType(userAgent) {
  const ua = userAgent.toLowerCase();
  if (ua.includes('android') && !ua.includes('tablet')) return 'Mobile';
  if (ua.includes('tablet') || ua.includes('ipad') || (ua.includes('android') && ua.includes('tablet'))) return 'Tablet';
  if (ua.includes('mobile') && !ua.includes('android')) return 'Mobile'; // iPhone etc.
  return 'Laptop/Desktop';
}

io.on('connection', (socket) => {
  const ip = socket.handshake.address;
  const userAgent = socket.handshake.headers['user-agent'] || '';
  const deviceType = getDeviceType(userAgent);

  const deviceInfo = {
    id: socket.id,
    ip: ip,
    type: deviceType,
    userAgent: userAgent,
    connectedAt: new Date().toISOString()
  };

  connectedDevices.set(socket.id, deviceInfo);

  console.log(`Device connected: ${socket.id} - ${deviceType} - ${ip}`);

  // Send device info to this client
  socket.emit('device-info', deviceInfo);

  // Send updated device list to all clients
  io.emit('devices', Array.from(connectedDevices.values()));

  socket.on('disconnect', () => {
    connectedDevices.delete(socket.id);
    console.log(`Device disconnected: ${socket.id}`);
    io.emit('devices', Array.from(connectedDevices.values()));
  });

  socket.on('control', (data) => {
    console.log('Control action received:', data);
    // Forward control to target device
    if (data.targetId && connectedDevices.has(data.targetId)) {
      io.to(data.targetId).emit('controlled', {
        action: data.action,
        from: socket.id
      });
    }
  });

  socket.on('message', (data) => {
    console.log('Message from device:', socket.id, data);
    // Broadcast message to all or handle as needed
    socket.broadcast.emit('message', {
      from: socket.id,
      content: data.content
    });
  });

  socket.on('camera-image', (data) => {
    console.log(`Camera image from ${socket.id}, size: ${data.image.length}`);
    // Broadcast camera image to all clients (or specifically to desktop)
    socket.broadcast.emit('camera-image', {
      from: socket.id,
      image: data.image
    });
  });
});

server.listen(5000, '0.0.0.0', () => {
  console.log('🚀 Multi-device server running on http://0.0.0.0:5000');
});
