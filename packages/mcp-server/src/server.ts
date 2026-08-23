import { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import type { BeamIdString, VerificationTier } from 'beam-protocol-sdk'
import { createBeamToolHandlers, type BeamGateway } from './tools.js'

export type BeamMcpAuditEvent = {
  tool: 'beam_status' | 'beam_prepare_handoff' | 'beam_send'
  outcome: 'success' | 'rejected'
  target?: string
  intent?: string
}

function toolSuccess(value: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value,
  }
}

function toolFailure(error: unknown) {
  const message = error instanceof Error ? error.message : 'Beam operation failed'
  return {
    isError: true,
    content: [{ type: 'text' as const, text: message }],
  }
}

const beamIdSchema = z.string().min(1).max(255).describe('Lowercase Beam ID such as assistant@company.beam.directory')
const contextSchema = z.record(z.string(), z.unknown()).optional().describe('Optional structured context; never include credentials')

export function assertBeamMcpScope(
  authorizationScopes: ReadonlySet<string> | undefined,
  scope: 'beam:read' | 'beam:send',
): void {
  if (authorizationScopes && !authorizationScopes.has(scope)) {
    throw new Error(`OAuth scope ${scope} is required for this tool`)
  }
}

export function createBeamMcpServer(options: {
  gateway: BeamGateway
  ownBeamId: BeamIdString
  allowedIntents: ReadonlySet<string>
  requireVerifiedTarget?: boolean
  minimumVerificationTier?: VerificationTier
  minimumTrustScore?: number
  authorizationScopes?: ReadonlySet<string>
  enableSend?: boolean
  audit?: (event: BeamMcpAuditEvent) => void
}): McpServer {
  const server = new McpServer({ name: 'beam-protocol', version: '0.1.0' })
  const handlers = createBeamToolHandlers(options)

  async function executeTool(
    event: Omit<BeamMcpAuditEvent, 'outcome'>,
    scope: 'beam:read' | 'beam:send',
    operation: () => Promise<Record<string, unknown>>,
  ) {
    try {
      assertBeamMcpScope(options.authorizationScopes, scope)
      const value = await operation()
      try { options.audit?.({ ...event, outcome: 'success' }) } catch { /* Audit sinks cannot change tool results. */ }
      return toolSuccess(value)
    } catch (error) {
      try { options.audit?.({ ...event, outcome: 'rejected' }) } catch { /* Audit sinks cannot change tool results. */ }
      return toolFailure(error)
    }
  }

  server.registerTool(
    'beam_status',
    {
      title: 'Beam status and identity lookup',
      description: 'Read Beam directory status and public trust metadata for this identity or an optional target. Does not send a message.',
      inputSchema: z.object({ target: beamIdSchema.optional() }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) => executeTool(
      { tool: 'beam_status', ...(input.target ? { target: input.target } : {}) },
      'beam:read',
      () => handlers.status(input),
    ),
  )

  server.registerTool(
    'beam_prepare_handoff',
    {
      title: 'Prepare a trusted Beam handoff',
      description: 'Validate a target and return public trust evidence, warnings, byte length, and a message digest. This is a read-only preview and never sends.',
      inputSchema: z.object({
        to: beamIdSchema,
        message: z.string().min(1).max(4_096),
        intent: z.string().min(1).max(128).optional(),
        context: contextSchema,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) => executeTool(
      { tool: 'beam_prepare_handoff', target: input.to, intent: input.intent ?? 'conversation.message' },
      'beam:read',
      () => handlers.prepareHandoff(input),
    ),
  )

  if (options.enableSend !== false) {
    server.registerTool(
      'beam_send',
      {
        title: 'Send an approved Beam handoff',
        description: 'EXTERNAL SIDE EFFECT: send a signed Beam intent to another agent. Call only after explicit human approval and set confirmed=true for that exact destination and content.',
        inputSchema: z.object({
          to: beamIdSchema,
          message: z.string().min(1).max(4_096),
          intent: z.string().min(1).max(128).optional(),
          context: contextSchema,
          timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
          confirmed: z.boolean().describe('Must be true only after the human explicitly approved this exact delivery'),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async (input) => executeTool(
        { tool: 'beam_send', target: input.to, intent: input.intent ?? 'conversation.message' },
        'beam:send',
        () => handlers.send(input),
      ),
    )
  }

  return server
}
