const configuredBackendUrl = import.meta.env.VITE_BACKEND_URL || 'https://classai-backend.onrender.com'
export const BACKEND_URL = configuredBackendUrl.replace(/\/$/, '')

// Attendance API goes through the Node backend proxy by default. The proxy can
// start the local Python service and keeps route compatibility in one place.
const configuredAttendanceUrl = import.meta.env.VITE_ATTENDANCE_URL || `${BACKEND_URL}/api`
export const ATTENDANCE_API_URL = `${configuredAttendanceUrl.replace(/\/$/, '')}/attendance`
