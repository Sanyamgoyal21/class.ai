import { useState, useEffect, useRef } from 'react'
import { io } from 'socket.io-client'
import './App.css'

function App() {
  const [devices, setDevices] = useState([])
  const [myDevice, setMyDevice] = useState(null)
  const [socket, setSocket] = useState(null)
  const [messages, setMessages] = useState([])
  const [controlAction, setControlAction] = useState('')
  const [stream, setStream] = useState(null)
  const [cameraImages, setCameraImages] = useState({})
  const [cameraInterval, setCameraInterval] = useState(null)
  const videoRef = useRef(null)

  useEffect(() => {
    const s = io('http://10.213.184.82:5000')
    setSocket(s)

    s.on('device-info', (info) => {
      setMyDevice(info)
    })

    s.on('devices', (devs) => {
      setDevices(devs)
    })

    s.on('controlled', (data) => {
      if (data.action === 'ping') {
        alert(`Ping received from ${data.from.slice(0, 8)}...`);
      } else if (data.action === 'alert') {
        alert(`Alert! Action from ${data.from.slice(0, 8)}...`);
      } else if (data.action === 'start-camera') {
        startCamera();
      } else if (data.action === 'stop-camera') {
        stopCamera();
      }
      setMessages(prev => [...prev, `Controlled: ${data.action} from ${data.from.slice(0, 8)}...`]);
    })

    s.on('message', (data) => {
      alert(`Broadcast: ${data.content}`);
      setMessages(prev => [...prev, `Message from ${data.from.slice(0, 8)}...: ${data.content}`]);
    })

    s.on('camera-image', (data) => {
      console.log('Received camera image from:', data.from, 'size:', data.image.length);
      setCameraImages(prev => ({
        ...prev,
        [data.from]: data.image
      }));
    });

    return () => {
      s.disconnect();
      // Stop camera if running
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
      }
      if (cameraInterval) {
        clearInterval(cameraInterval);
      }
    }
  }, [])

  const sendControl = (targetId, action) => {
    if (socket) {
      socket.emit('control', { targetId, action })
    }
  }

  const startCamera = async () => {
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' }, // Back camera for mobile
        audio: false
      });
      setStream(mediaStream);

      // Start sending images
      const video = document.createElement('video');
      video.srcObject = mediaStream;
      video.muted = true;

      // Set video on the ref for display
      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
      }

      // Wait for video to be ready
      video.onloadedmetadata = () => {
        console.log('Video loaded, dimensions:', video.videoWidth, video.videoHeight);
      };

      await new Promise((resolve) => {
        if (video.readyState >= 2) {
          resolve();
        } else {
          video.onloadeddata = () => resolve();
        }
      });

      video.play();

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');

      const sendImage = () => {
        if (stream && socket && socket.connected && video.videoWidth > 0) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          ctx.drawImage(video, 0, 0);
          const imageData = canvas.toDataURL('image/jpeg', 0.5);
          console.log('Sending camera image, size:', imageData.length);
          socket.emit('camera-image', { image: imageData });
        }
      };

      // Send image every 500ms
      const interval = setInterval(sendImage, 500);
      setCameraInterval(interval);

    } catch (err) {
      console.error('Camera access denied:', err);
      alert('Camera access denied. Please allow camera permissions.');
    }
  };

  const stopCamera = () => {
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
      setStream(null);
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
    }
    if (cameraInterval) {
      clearInterval(cameraInterval);
      setCameraInterval(null);
    }
  };

  const renderDeviceUI = () => {
    if (!myDevice) return <p>Connecting...</p>

    switch (myDevice.type) {
      case 'Mobile':
        return (
          <div className="mobile-ui">
            <h3>Mobile Interface</h3>
            <p>Simple controls for mobile</p>
            <button onClick={() => sendMessage('Hello from mobile!')}>Send Message</button>
            <div className="camera-controls">
              <button onClick={startCamera} disabled={!!stream}>Start Camera</button>
              <button onClick={stopCamera} disabled={!stream}>Stop Camera</button>
            </div>
            {stream && <video ref={videoRef} autoPlay playsInline muted />}
          </div>
        )
      case 'Tablet':
        return (
          <div className="tablet-ui">
            <h3>Tablet Interface</h3>
            <p>Medium controls for tablet</p>
            <input
              type="text"
              placeholder="Enter control action"
              value={controlAction}
              onChange={(e) => setControlAction(e.target.value)}
            />
            <button onClick={() => sendMessage(controlAction)}>Send Action</button>
            <div className="camera-controls">
              <button onClick={startCamera} disabled={!!stream}>Start Camera</button>
              <button onClick={stopCamera} disabled={!stream}>Stop Camera</button>
            </div>
            {stream && <video ref={videoRef} autoPlay playsInline muted />}
          </div>
        )
      case 'Laptop/Desktop':
        return (
          <div className="desktop-ui">
            <h3>Desktop Control Panel</h3>
            <p>Full controls for desktop</p>
            <div className="control-panel">
              <input
                type="text"
                placeholder="Enter message"
                value={controlAction}
                onChange={(e) => setControlAction(e.target.value)}
              />
              <button onClick={() => sendMessage(controlAction)}>Broadcast Message</button>
            </div>
            <div className="device-list">
              <h4>Connected Devices:</h4>
              {devices.map(d => (
                <div key={d.id} className="device-item">
                  <span>ID: {d.id.slice(0, 8)}... | Type: {d.type} | IP: {d.ip}</span>
                  <button onClick={() => sendControl(d.id, 'ping')}>Ping</button>
                  <button onClick={() => sendControl(d.id, 'alert')}>Alert</button>
                  <button onClick={() => sendControl(d.id, 'start-camera')}>Start Camera</button>
                  <button onClick={() => sendControl(d.id, 'stop-camera')}>Stop Camera</button>
                </div>
              ))}
            </div>
            <div className="camera-feeds">
              <h4>Camera Feeds:</h4>
              {Object.entries(cameraImages).map(([deviceId, imageData]) => (
                <div key={deviceId} className="camera-feed">
                  <h5>Device: {deviceId.slice(0, 8)}...</h5>
                  <img src={imageData} alt={`Camera from ${deviceId}`} />
                </div>
              ))}
            </div>
          </div>
        )
      default:
        return <p>Unknown device type</p>
    }
  }

  return (
    <div className="app">
      <h1>Multi-Device Controller</h1>
      {myDevice && <p>Your Device: {myDevice.type} (ID: {myDevice.id.slice(0, 8)}...)</p>}
      {renderDeviceUI()}
      <div className="messages">
        <h4>Messages:</h4>
        {messages.map((msg, i) => <p key={i}>{msg}</p>)}
      </div>
    </div>
  )
}

export default App
