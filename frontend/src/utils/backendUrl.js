const DEAD_REMOTE_HOSTS = new Set([
  'class-ai-backend.onrender.com',
  'classai-backend.onrender.com',
])

function isLocalHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1'
}

function normalizeUrl(value) {
  if (!value || typeof value !== 'string') return null

  try {
    return new URL(value).toString().replace(/\/$/, '')
  } catch {
    return null
  }
}



export function resolveBackendUrl() {
  const envUrl = normalizeUrl(import.meta.env.VITE_BACKEND_URL)
  const browserUrl = typeof window !== 'undefined' ? new URL(window.location.href) : null
  const localBackendUrl = browserUrl
    ? `${browserUrl.protocol}//${browserUrl.hostname}:8000`
    : 'http://localhost:8000'

  if (!browserUrl) {
    return envUrl || 'http://localhost:8000'
  }

  const queryBackendUrl = normalizeUrl(browserUrl.searchParams.get('backend'))
  const storedBackendUrl =
    normalizeUrl(window.sessionStorage?.getItem('classroomBackendUrl'))
    || normalizeUrl(window.localStorage?.getItem('classroomBackendUrl'))
  const configuredUrl = queryBackendUrl || storedBackendUrl || envUrl
  const browserIsLocal = isLocalHost(browserUrl.hostname)

  if (configuredUrl) {
    const configuredHost = new URL(configuredUrl).hostname

    if (browserIsLocal) {
      if (isLocalHost(configuredHost)) return configuredUrl
      if (DEAD_REMOTE_HOSTS.has(configuredHost) || configuredHost.endsWith('.onrender.com')) {
        return localBackendUrl
      }
      return configuredUrl
    }

    try {
      window.sessionStorage?.setItem('classroomBackendUrl', configuredUrl)
      window.localStorage?.setItem('classroomBackendUrl', configuredUrl)
    } catch {
      // Ignore storage write failures and keep using the resolved URL.
    }

    return configuredUrl
  }

  if (browserUrl.port && browserUrl.port !== '8000') {
    return localBackendUrl
  }

  const inferredUrl = browserUrl.origin.replace(/\/$/, '')

  try {
    window.sessionStorage?.setItem('classroomBackendUrl', inferredUrl)
    window.localStorage?.setItem('classroomBackendUrl', inferredUrl)
  } catch {
    // Ignore storage write failures and keep using the inferred URL.
  }

  return inferredUrl
}

export const BACKEND_URL = resolveBackendUrl()
