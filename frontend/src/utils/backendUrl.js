const configuredBackendUrl = import.meta.env.VITE_BACKEND_URL || 'https://classai-backend.onrender.com'
export const BACKEND_URL = configuredBackendUrl.replace(/\/$/, '')

// Attendance API talks directly to the local Python service.
// VITE_ATTENDANCE_URL defaults to localhost:8000 so images go straight
// to the machine running the Python backend — not through the Render proxy.
const configuredAttendanceUrl = import.meta.env.VITE_ATTENDANCE_URL || 'http://localhost:8000'
export const ATTENDANCE_API_URL = `${configuredAttendanceUrl.replace(/\/$/, '')}/attendance`
