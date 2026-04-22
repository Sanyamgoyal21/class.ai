const DEAD_REMOTE_HOSTS = new Set([
  'class-ai-backend.onrender.com',
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
    ? `${browserUrl.protocol}//${browserUrl.hostname}:5000`
    : 'http://localhost:5000'

  if (!browserUrl) {
    return envUrl || 'http://localhost:5000'
  }

  const browserIsLocal = isLocalHost(browserUrl.hostname)

  if (browserIsLocal) {
    if (envUrl) {
      const envHost = new URL(envUrl).hostname
      if (isLocalHost(envHost)) return envUrl
      if (!DEAD_REMOTE_HOSTS.has(envHost)) return envUrl
    }

    return localBackendUrl
  }

  if (envUrl) return envUrl

  if (browserUrl.port && browserUrl.port !== '5000') {
    return localBackendUrl
  }

  return browserUrl.origin.replace(/\/$/, '')
}

export const BACKEND_URL = resolveBackendUrl()
