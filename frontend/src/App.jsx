import React from 'react'
import Voice from './Pages/Voice.jsx'
import SuperNode from './Pages/SuperNode.jsx'
import CameraMonitor from './Pages/CameraMonitor.jsx'
import DoubtCanvas from './Pages/DoubtCanvas.jsx'
import './App.css'

export default function App() {
  const initialPage = new URLSearchParams(window.location.search).get('page') || 'launcher'
  const [currentPage, setCurrentPage] = React.useState(initialPage)
  const [roomNumber, setRoomNumber] = React.useState('')

  const navigateToPage = (page) => {
    setCurrentPage(page)
    const url = new URL(window.location.href)

    if (page === 'launcher') {
      url.searchParams.delete('page')
    } else {
      url.searchParams.set('page', page)
    }

    window.history.replaceState({}, '', url.toString())
  }

  const openClassroomDisplay = (event) => {
    event.preventDefault()
    const trimmedRoom = roomNumber.trim()
    if (!trimmedRoom) return
    window.location.href = `http://localhost:5173/classroom.html?name=${encodeURIComponent(trimmedRoom)}`
  }

  // DoubtCanvas is fullscreen - no nav
  if (currentPage === 'doubt') {
    return <DoubtCanvas />
  }

  if (currentPage === 'launcher') {
    return (
      <main className="launcher">
        <div className="launcher__backdrop launcher__backdrop--left" />
        <div className="launcher__backdrop launcher__backdrop--right" />

        <section className="launcher__hero">
          <p className="launcher__eyebrow">Central UI</p>
          <h1 className="launcher__title">Choose the display mode for this screen</h1>
          <p className="launcher__subtitle">
            Start the teacher control room or open a classroom display for a specific room number.
          </p>
        </section>

        <section className="launcher__grid">
          <article className="launcher__card">
            <span className="launcher__badge">Control Room Display</span>
            <h2 className="launcher__cardTitle">SuperNode dashboard</h2>
            <p className="launcher__cardText">
              Open the command center for classroom controls, monitoring, and teaching tools.
            </p>
            <button type="button" className="launcher__primaryBtn" onClick={() => navigateToPage('supernode')}>
              Open Control Room
            </button>
          </article>

          <article className="launcher__card launcher__card--classroom">
            <span className="launcher__badge launcher__badge--warm">Class Room Display</span>
            <h2 className="launcher__cardTitle">Classroom board</h2>
            <p className="launcher__cardText">
              Enter the class number and redirect this display to the classroom screen.
            </p>
            <form className="launcher__form" onSubmit={openClassroomDisplay}>
              <label className="launcher__label" htmlFor="room-number">
                Class no
              </label>
              <input
                id="room-number"
                className="launcher__input"
                type="text"
                placeholder="Room102"
                value={roomNumber}
                onChange={(event) => setRoomNumber(event.target.value)}
              />
              <button type="submit" className="launcher__secondaryBtn" disabled={!roomNumber.trim()}>
                Open Classroom
              </button>
            </form>
          </article>
        </section>
      </main>
    )
  }

  return (
    <div className="app-shell">
      <nav className="topbar">
        <div className="topbar__brand">
          <span className="topbar__eyebrow">Classroom Suite</span>
          <span className="topbar__title">Control, monitor, and broadcast from one place</span>
        </div>
        <div className="topbar__nav" aria-label="Primary navigation">
          <button
            onClick={() => navigateToPage('launcher')}
            className={`topbar__tab ${currentPage === 'launcher' ? 'topbar__tab--active' : ''}`}
          >
            Home
          </button>
          <button
            onClick={() => navigateToPage('supernode')}
            className={`topbar__tab ${currentPage === 'supernode' ? 'topbar__tab--active' : ''}`}
          >
            Dashboard
          </button>
          <button
            onClick={() => navigateToPage('cameras')}
            className={`topbar__tab ${currentPage === 'cameras' ? 'topbar__tab--active' : ''}`}
          >
            Camera Monitor
          </button>
          <button
            onClick={() => navigateToPage('voice')}
            className={`topbar__tab ${currentPage === 'voice' ? 'topbar__tab--active' : ''}`}
          >
            Voice Assistant
          </button>
        </div>
        <div className="topbar__status" aria-label="Connection status">
          <span className="topbar__status-dot" />
          System online
        </div>
      </nav>
      {currentPage === 'supernode' && <SuperNode />}
      {currentPage === 'cameras' && <CameraMonitor />}
      {currentPage === 'voice' && <Voice />}
    </div>
  )
}
