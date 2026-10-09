export function agentPath(beamId: string): string {
  return `/agents/${encodeURIComponent(beamId)}`
}
