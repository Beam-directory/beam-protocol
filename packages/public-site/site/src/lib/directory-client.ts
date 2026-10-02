export function directoryApiBase(): string {
  const configured = import.meta.env.VITE_DIRECTORY_API_URL
  if (typeof configured === 'string' && configured.trim().length > 0) {
    return configured.trim().replace(/\/$/, '')
  }
  return 'https://api.beam.directory'
}

export async function directoryGet(path: string): Promise<unknown> {
  const response = await fetch(`${directoryApiBase()}${path}`, {
    headers: { accept: 'application/json' },
  })
  if (!response.ok) {
    throw new Error(`Verzeichnis antwortete mit ${response.status}`)
  }
  return response.json() as Promise<unknown>
}

export async function submitSealApplication(body: unknown): Promise<void> {
  const response = await fetch(`${directoryApiBase()}/waitlist`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(`Antrag konnte nicht gespeichert werden (${response.status})`)
  }
}
