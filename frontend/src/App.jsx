import React from 'react'
import Voice from './Pages/Voice.jsx'
import SuperNode from './Pages/SuperNode.jsx'
import CameraMonitor from './Pages/CameraMonitor.jsx'

export default function App() {
  const [currentPage, setCurrentPage] = React.useState('supernode')

  return (
    <div>
      <nav style={navStyle}>
        <button
          onClick={() => setCurrentPage('supernode')}
          style={currentPage === 'supernode' ? activeBtn : navBtn}
        >
          Dashboard
        </button>
        <button
          onClick={() => setCurrentPage('cameras')}
          style={currentPage === 'cameras' ? activeBtn : navBtn}
        >
          Camera Monitor
        </button>
        <button
          onClick={() => setCurrentPage('voice')}
          style={currentPage === 'voice' ? activeBtn : navBtn}
        >
          Voice Assistant
        </button>
      </nav>
      {currentPage === 'supernode' && <SuperNode />}
      {currentPage === 'cameras' && <CameraMonitor />}
      {currentPage === 'voice' && <Voice />}
    </div>
  )
}

const navStyle = {
  display: 'flex',
  gap: '0.5rem',
  padding: '0.5rem 1rem',
  backgroundColor: '#0f172a',
}

const navBtn = {
  padding: '0.5rem 1rem',
  border: 'none',
  borderRadius: '4px',
  backgroundColor: '#1e293b',
  color: '#94a3b8',
  cursor: 'pointer',
}

const activeBtn = {
  ...navBtn,
  backgroundColor: '#3b82f6',
  color: 'white',
}
