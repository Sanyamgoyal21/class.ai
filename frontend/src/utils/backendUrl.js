const configuredBackendUrl = import.meta.env.VITE_BACKEND_URL || 'http://localhost:5000'

export const BACKEND_URL = configuredBackendUrl.replace(/\/$/, '')
export const ATTENDANCE_API_URL = `${BACKEND_URL}/api/attendance`
