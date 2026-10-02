/** COPPEN is the named Phase 1 pilot. The profile hides the agent when it is not public. */
export const EXAMPLE_BEAM_ID = 'coppen-assistant@coppen.beam.directory'

export function agentPath(beamId: string): string {
  return `/agents/${encodeURIComponent(beamId)}`
}
