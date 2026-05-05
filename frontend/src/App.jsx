import React from 'react'
import { DotLottieReact } from '@lottiefiles/dotlottie-react'
import Voice from './Pages/Voice.jsx'
import SuperNode from './Pages/SuperNode.jsx'
import CameraMonitor from './Pages/CameraMonitor.jsx'
import DoubtCanvas from './Pages/DoubtCanvas.jsx'
import GateAttendance from './Pages/GateAttendance.jsx'
import { BACKEND_URL } from './utils/backendUrl'
import './App.css'

const QUESTION_STEPS = [
  {
    id: 'welcome',
    title: 'Welcome to Class.AI',
    description: 'We will set up your access flow in a few quick steps.',
    helper: 'Choose Continue to personalize your school workspace.',
    type: 'welcome',
  },
  {
    id: 'schoolName',
    title: 'What is your school name?',
    description: 'This helps us tailor the experience for your campus.',
    helper: 'Use the official school or institute name.',
    type: 'text',
    field: 'schoolName',
    placeholder: 'Green Valley Public School',
  },
  {
    id: 'userName',
    title: 'Who are we setting this up for?',
    description: 'We will use this in greetings and dashboard context.',
    helper: 'Add your full name or staff name.',
    type: 'text',
    field: 'userName',
    placeholder: 'Aditi Sharma',
  },
  {
    id: 'role',
    title: 'Which role matches you best?',
    description: 'We can highlight the tools you are most likely to use.',
    helper: 'Pick the closest fit for your daily work.',
    type: 'choice',
    field: 'role',
    options: [
      { value: 'administrator', label: 'Administrator', note: 'Manage systems, rooms, and school-wide operations.' },
      { value: 'teacher', label: 'Teacher', note: 'Run classes, monitor sessions, and share content.' },
      { value: 'operator', label: 'Gate Operator', note: 'Focus on attendance, gate flow, and security.' },
      { value: 'coordinator', label: 'Coordinator', note: 'Support timetables, announcements, and supervision.' },
    ],
  },
  {
    id: 'instituteType',
    title: 'What kind of institution is this?',
    description: 'This gives us the right usage context.',
    helper: 'Choose the closest campus profile.',
    type: 'choice',
    field: 'instituteType',
    options: [
      { value: 'school', label: 'School', note: 'For K-12 style campuses and day schools.' },
      { value: 'coaching', label: 'Coaching Center', note: 'For tuition, test prep, and batch learning.' },
      { value: 'college', label: 'College', note: 'For higher education classrooms and labs.' },
      { value: 'training', label: 'Training Institute', note: 'For skills, certification, and workshop spaces.' },
    ],
  },
  {
    id: 'curriculum',
    title: 'Which curriculum or board do you follow?',
    description: 'A quick profile detail for your setup record.',
    helper: 'Pick one that best represents the campus.',
    type: 'choice',
    field: 'curriculum',
    options: [
      { value: 'cbse', label: 'CBSE', note: 'Central Board aligned schools.' },
      { value: 'icse', label: 'ICSE', note: 'CISCE curriculum and exam flow.' },
      { value: 'state-board', label: 'State Board', note: 'Regional board and local academic operations.' },
      { value: 'international', label: 'International', note: 'IB, Cambridge, or mixed global programs.' },
    ],
  },
  {
    id: 'schoolSize',
    title: 'How large is your daily operation?',
    description: 'This helps estimate how many rooms and attendance points matter most.',
    helper: 'Choose the nearest size band.',
    type: 'choice',
    field: 'schoolSize',
    options: [
      { value: 'small', label: 'Up to 300 learners', note: 'A compact campus with fewer rooms to manage.' },
      { value: 'medium', label: '301 to 800 learners', note: 'A growing school with multiple active zones.' },
      { value: 'large', label: '801 to 1500 learners', note: 'A busy campus with more coordination needs.' },
      { value: 'enterprise', label: '1500+ learners', note: 'A large institution with heavy daily traffic.' },
    ],
  },
  {
    id: 'mainGoal',
    title: 'What do you want Class.AI to help with first?',
    description: 'We can prioritize your most important workflow.',
    helper: 'Pick the job you want to start with today.',
    type: 'choice',
    field: 'mainGoal',
    options: [
      { value: 'attendance', label: 'Gate Attendance', note: 'Start with entry capture and attendance accuracy.' },
      { value: 'classroom-control', label: 'Classroom Control', note: 'Run displays, content, and live sessions.' },
      { value: 'monitoring', label: 'Live Monitoring', note: 'Track rooms, devices, and activity centrally.' },
      { value: 'broadcast', label: 'Broadcast & Alerts', note: 'Send announcements and school-wide updates.' },
    ],
  },
  {
    id: 'shift',
    title: 'Which school shift is active right now?',
    description: 'We can align the setup with your current operating window.',
    helper: 'Choose the shift you are entering for.',
    type: 'choice',
    field: 'shift',
    options: [
      { value: 'morning', label: 'Morning Shift', note: 'Best for early classes and morning attendance.' },
      { value: 'day', label: 'Day Shift', note: 'Typical full-day school operations.' },
      { value: 'evening', label: 'Evening Shift', note: 'For later batches or after-school programs.' },
      { value: 'mixed', label: 'Mixed Schedule', note: 'For campuses running multiple schedules.' },
    ],
  },
  {
    id: 'destination',
    title: 'Where would you like to enter now?',
    description: 'Choose the destination for this session.',
    helper: 'If you pick Classroom, we will ask for the room number.',
    type: 'destination',
    field: 'entryPoint',
    options: [
      { value: 'supernode', label: 'Enter Supernode', note: 'Open the main control room and attendance dashboard.' },
      { value: 'classroom', label: 'Enter Classroom', note: 'Launch a classroom display for a specific room.' },
      { value: 'attendance', label: 'Gate Attendance', note: 'Open the live gate attendance terminal.' },
    ],
  },
]

export default function App() {
  const initialPage = new URLSearchParams(window.location.search).get('page') || 'launcher'
  const [currentPage, setCurrentPage] = React.useState(initialPage)
  const [roomNumber, setRoomNumber] = React.useState('')
  const [onboardingData, setOnboardingData] = React.useState({
    schoolName: '',
    userName: '',
    role: '',
    instituteType: '',
    curriculum: '',
    schoolSize: '',
    mainGoal: '',
    shift: '',
    entryPoint: '',
    classroomRoom: '',
  })

  React.useEffect(() => {
    try {
      window.localStorage.setItem('classroomBackendUrl', BACKEND_URL)
    } catch {
      // Ignore storage failures and rely on the query param fallback.
    }
  }, [])

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

  const openClassroomDisplay = (event, roomValue = roomNumber) => {
    event?.preventDefault?.()
    const trimmedRoom = roomValue.trim()
    if (!trimmedRoom) return
    const classroomUrl = new URL('/classroom.html', window.location.origin)
    classroomUrl.searchParams.set('name', trimmedRoom)
    classroomUrl.searchParams.set('backend', BACKEND_URL)
    window.location.href = classroomUrl.toString()
  }

  if (currentPage === 'doubt') {
    return <DoubtCanvas />
  }

  if (currentPage === 'attendance') {
    return <GateAttendance onExit={() => navigateToPage('launcher')} />
  }

  if (currentPage === 'onboarding') {
    return (
      <LaunchQuestionnaire
        formData={onboardingData}
        setFormData={setOnboardingData}
        onExit={() => navigateToPage('launcher')}
        onComplete={(destination, data) => {
          if (destination === 'classroom') {
            setRoomNumber(data.classroomRoom)
            openClassroomDisplay(null, data.classroomRoom)
            return
          }

          if (destination === 'attendance') {
            navigateToPage('attendance')
            return
          }

          navigateToPage('supernode')
        }}
      />
    )
  }

  if (currentPage === 'launcher') {
    return (
      <div className="lp">
        <header className="lp__nav">
          <div className="lp__logo">
            <img src="/logo.svg" alt="" className="lp__logoIcon" />
            <span className="lp__logoText">Class<em>.AI</em></span>
          </div>
          <button className="lp__navCta" onClick={() => navigateToPage('onboarding')}>
            Get Started
          </button>
        </header>

        <section className="lp__hero">
          <div className="lp__heroLeft">
            <span className="lp__pill">AI-powered classroom management</span>
            <h1 className="lp__heroTitle">
              The smarter,
              <br />
              <span className="lp__heroGrad">faster way</span>
              <br />
              to run your school
            </h1>
            <p className="lp__heroSub">
              Attendance, live monitoring, classroom broadcasts, and teacher controls all in one beautifully simple platform.
            </p>
            <button className="lp__ctaPrimary" onClick={() => navigateToPage('onboarding')}>
              Get Started {'->'}
            </button>
            <button className="lp__ctaGhost" onClick={() => navigateToPage('supernode')}>
              I already have an account
            </button>
          </div>

          <div className="lp__heroRight">
            <div className="lp__illoWrap">
              <img src="/Landing.jpg" alt="Class.AI interface preview" className="lp__illoImg" />
              <span className="lp__dot lp__dot--yellow" />
              <span className="lp__dot lp__dot--blue" />
              <span className="lp__dot lp__dot--pink" />
              <span className="lp__dot lp__dot--yellow2" />
            </div>
          </div>
        </section>

        <div className="lp__wave" aria-hidden="true">
          <svg viewBox="0 0 1440 110" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id="wg" x1="0" y1="0" x2="1440" y2="0" gradientUnits="userSpaceOnUse">
                <stop stopColor="#7c3aed" />
                <stop offset="0.5" stopColor="#ec4899" />
                <stop offset="1" stopColor="#f97316" />
              </linearGradient>
            </defs>
            <path d="M0,40 C320,110 720,0 1080,70 C1260,105 1380,30 1440,50 L1440,110 L0,110 Z" fill="url(#wg)" />
          </svg>
        </div>

        <section className="lp__features">
          <p className="lp__featEyebrow">What Class.AI does for you</p>
          <h2 className="lp__featTitle">Everything your school needs,<br />nothing it does not</h2>
          <div className="lp__featGrid">
            {[
              {
                svg: (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                    <circle cx="9" cy="7" r="4" />
                    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                  </svg>
                ),
                label: 'Smart Attendance',
                desc: 'Face recognition at the gate marks every student the moment they arrive with zero paperwork.',
              },
              {
                svg: (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="3" width="20" height="14" rx="2" />
                    <path d="M8 21h8" />
                    <path d="M12 17v4" />
                  </svg>
                ),
                label: 'Classroom Control',
                desc: 'Push videos, slides, or alerts to every classroom display from one dashboard.',
              },
              {
                svg: (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="20" x2="18" y2="10" />
                    <line x1="12" y1="20" x2="12" y2="4" />
                    <line x1="6" y1="20" x2="6" y2="14" />
                  </svg>
                ),
                label: 'Live Dashboard',
                desc: 'See real-time presence, active cameras, and daily summaries at a glance.',
              },
              {
                svg: (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                  </svg>
                ),
                label: 'Instant Broadcast',
                desc: 'One click sends an emergency alert or voice announcement to every room simultaneously.',
              },
            ].map((feature) => (
              <div key={feature.label} className="lp__featCard">
                <span className="lp__featIcon">{feature.svg}</span>
                <h3 className="lp__featCardTitle">{feature.label}</h3>
                <p className="lp__featCardText">{feature.desc}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="lp__bottom">
          <div className="lp__arch">
            <div className="lp__archDome" />
            <div className="lp__archMascotWrap">
              <img src="/mascot.png" alt="" className="lp__archMascot" />
              <span className="lp__ac lp__ac--y1" />
              <span className="lp__ac lp__ac--b1" />
              <span className="lp__ac lp__ac--g1" />
              <span className="lp__ac lp__ac--y2" />
              <span className="lp__ac lp__ac--p1" />
            </div>
          </div>

          <div className="lp__bottomText">
            <h2 className="lp__bottomTitle">
              The smarter, fun, and effective
              <br />
              way to manage your classroom!
            </h2>
            <button className="lp__ctaPrimary" onClick={() => navigateToPage('onboarding')}>
              Get Started
            </button>
            <button className="lp__ctaGhost" onClick={() => navigateToPage('supernode')}>
              I already have an account
            </button>
          </div>
        </section>

        <footer className="lp__footer">
          Copyright {new Date().getFullYear()} Class.AI - Classroom Intelligence Suite
        </footer>
      </div>
    )
  }

  const topNavItems = [
    { id: 'launcher', label: 'Home', tone: 'navTop__icon--slate', icon: 'H' },
    { id: 'supernode', label: 'Dashboard', tone: 'navTop__icon--violet', icon: 'D' },
    { id: 'cameras', label: 'Cameras', tone: 'navTop__icon--green', icon: 'C' },
  ]

  return (
    <div className="app-shell">
      {currentPage !== 'supernode' && (
        <header className="navTop">
          <div className="navTop__brand">
            <img src="/logo.svg" alt="" className="navTop__logo" />
            <span className="navTop__brandText">Class<em>.AI</em></span>
          </div>

          <nav className="navTop__menu" aria-label="Primary navigation">
            {topNavItems.map((item) => (
              <button
                key={item.id}
                onClick={() => navigateToPage(item.id)}
                className={`navTop__item ${currentPage === item.id ? 'navTop__item--active' : ''}`}
              >
                <span className={`navTop__icon ${item.tone}`}>{item.icon}</span>
                <span className="navTop__label">{item.label}</span>
              </button>
            ))}
          </nav>

          <div className="navTop__actions">
            <span className="navTop__status">
              <span className="navTop__statusDot" />
              Online
            </span>
          </div>
        </header>
      )}

      <main className="app-content">
        {currentPage === 'supernode' && <SuperNode />}
        {currentPage === 'cameras' && <CameraMonitor />}
        {currentPage === 'voice' && <Voice />}
        {currentPage === 'launcher' && (
          <div className="home-placeholder">
            <p className="home-placeholder__eyebrow">Classroom Suite</p>
            <h1 className="home-placeholder__title">Welcome back</h1>
            <p className="home-placeholder__sub">Select a section from the top navigation to get started.</p>
          </div>
        )}
      </main>
    </div>
  )
}

function LaunchQuestionnaire({ formData, setFormData, onExit, onComplete }) {
  const [stepIndex, setStepIndex] = React.useState(0)
  const step = QUESTION_STEPS[stepIndex]
  const totalSteps = QUESTION_STEPS.length
  const progress = Math.round(((stepIndex + 1) / totalSteps) * 100)

  const updateField = (field, value) => {
    setFormData((prev) => ({ ...prev, [field]: value }))
  }

  const canContinue = React.useMemo(() => {
    if (step.type === 'welcome') return true
    if (step.type === 'text') return Boolean(formData[step.field]?.trim())
    if (step.type === 'choice') return Boolean(formData[step.field])
    if (step.type === 'destination') {
      if (formData.entryPoint !== 'classroom') return Boolean(formData.entryPoint)
      return Boolean(formData.entryPoint && formData.classroomRoom.trim())
    }
    return true
  }, [formData, step])

  const handleNext = () => {
    if (!canContinue) return
    if (stepIndex === totalSteps - 1) {
      onComplete(formData.entryPoint, formData)
      return
    }
    setStepIndex((prev) => prev + 1)
  }

  return (
    <div className="quest">
      <div className="quest__glow quest__glow--one" />
      <div className="quest__glow quest__glow--two" />

      <header className="quest__topbar">
        <div className="quest__progressMeta">
          <span>Step {stepIndex + 1} of {totalSteps}</span>
          <span>{progress}%</span>
        </div>
        <div className="quest__progressTrack" aria-hidden="true">
          <div className="quest__progressFill" style={{ width: `${progress}%` }} />
        </div>
      </header>

      <main className="quest__shell">
        <section className="quest__mascotPane">
          <div key={`mascot-${step.id}`} className="quest__mascotWrap quest__stepEnter">
            <div className="quest__mascotStage">
              <DotLottieReact className="quest__lottie" src="/animations/mascot-hover.json" autoplay loop />
            </div>
            <span className="quest__tag">Class.AI Assistant</span>
            <p className="quest__mascotText">
              {step.type === 'welcome'
                ? 'I will guide you through a quick setup so you can enter the right workspace without extra clicks.'
                : `You are setting up ${formData.schoolName || 'your school'} for ${formData.userName || "today's session"}.`}
            </p>
          </div>
        </section>

        <section className="quest__contentPane">
          <div key={`content-${step.id}`} className="quest__card quest__stepEnter">
            <p className="quest__eyebrow">{step.id === 'destination' ? 'Final step' : 'Quick questionnaire'}</p>
            <h1 className="quest__title">{step.title}</h1>
            <p className="quest__description">{step.description}</p>

            {step.type === 'welcome' && (
              <div className="quest__welcome">
                <p className="quest__welcomeLine">School details, your role, operating preference, and your destination.</p>
                <p className="quest__welcomeLine">You will land in Supernode, Classroom, or Gate Attendance based on your final choice.</p>
              </div>
            )}

            {step.type === 'text' && (
              <label className="quest__field">
                <span className="quest__fieldLabel">{step.helper}</span>
                <input
                  className="quest__input"
                  type="text"
                  value={formData[step.field]}
                  onChange={(event) => updateField(step.field, event.target.value)}
                  placeholder={step.placeholder}
                />
              </label>
            )}

            {step.type === 'choice' && (
              <div className="quest__options">
                {step.options.map((option) => {
                  const isSelected = formData[step.field] === option.value
                  return (
                    <button
                      key={option.value}
                      type="button"
                      className={`quest__option ${isSelected ? 'quest__option--selected' : ''}`}
                      onClick={() => updateField(step.field, option.value)}
                    >
                      <span className="quest__optionLabel">{option.label}</span>
                      <span className="quest__optionNote">{option.note}</span>
                    </button>
                  )
                })}
              </div>
            )}

            {step.type === 'destination' && (
              <div className="quest__destination">
                <div className="quest__options">
                  {step.options.map((option) => {
                    const isSelected = formData.entryPoint === option.value
                    return (
                      <button
                        key={option.value}
                        type="button"
                        className={`quest__option ${isSelected ? 'quest__option--selected' : ''}`}
                        onClick={() => updateField('entryPoint', option.value)}
                      >
                        <span className="quest__optionLabel">{option.label}</span>
                        <span className="quest__optionNote">{option.note}</span>
                      </button>
                    )
                  })}
                </div>

                {formData.entryPoint === 'classroom' && (
                  <label className="quest__field">
                    <span className="quest__fieldLabel">Enter class number or room number to launch the classroom display.</span>
                    <input
                      className="quest__input"
                      type="text"
                      value={formData.classroomRoom}
                      onChange={(event) => updateField('classroomRoom', event.target.value)}
                      placeholder="Room 204 or Class 10-A"
                    />
                  </label>
                )}
              </div>
            )}

            <div className="quest__footer">
              <div className="quest__helper">{step.helper}</div>
              <button type="button" className="quest__next" onClick={handleNext} disabled={!canContinue}>
                {stepIndex === totalSteps - 1 ? 'Continue to workspace' : 'Continue'}
              </button>
            </div>
          </div>
        </section>
      </main>
    </div>
  )
}
