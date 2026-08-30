import { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import type { BeamIdString, VerificationTier } from 'beam-protocol-sdk'
import type { BeamNetworkGateway } from './network-client.js'
import { createBeamToolHandlers, type BeamGateway } from './tools.js'

export type BeamMcpAuditEvent = {
  tool:
    | 'beam_status'
    | 'beam_prepare_handoff'
    | 'beam_send'
    | 'beam_network_identity'
    | 'beam_network_discover'
    | 'beam_network_connections'
    | 'beam_network_conversations'
    | 'beam_network_messages'
    | 'beam_network_request_connection'
    | 'beam_network_respond_connection'
    | 'beam_network_open_direct'
    | 'beam_network_create_group'
    | 'beam_network_send_message'
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

const beamIdSchema = z.string()
  .regex(/^[a-z0-9_-]+@(?:[a-z0-9_-]+\.)?beam\.directory$/)
  .max(255)
  .describe('Lowercase Beam ID such as assistant@company.beam.directory')
const contextSchema = z.record(z.string(), z.unknown()).optional().describe('Optional structured context; never include credentials')
const networkObjectIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/)
const confirmationSchema = z.boolean().describe('Must be true only after the human approved this exact external action')

function requireHumanConfirmation(confirmed: boolean): void {
  if (!confirmed) throw new Error('Explicit human approval is required for this exact Beam Network action')
}

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
  networkGateway?: BeamNetworkGateway
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
      async () => ({
        ...await handlers.status(input),
        connector: {
          transport: options.authorizationScopes ? 'remote-oauth' : 'local-stdio',
          networkRead: Boolean(options.networkGateway),
          networkWrite: Boolean(options.networkGateway) && options.enableSend !== false,
          handoffSend: options.enableSend !== false,
        },
      }),
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

  if (options.networkGateway) {
    const network = options.networkGateway
    server.registerTool(
      'beam_network_identity',
      {
        title: 'Show my Beam Network identity',
        description: 'Read the connected Beam identity and contact-request counts. Does not change network state.',
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      async () => executeTool({ tool: 'beam_network_identity' }, 'beam:read', () => network.identity()),
    )

    server.registerTool(
      'beam_network_discover',
      {
        title: 'Find a Beam identity',
        description: 'Find a public Beam identity by name or organization, or a private identity by its exact Beam ID.',
        inputSchema: z.object({ query: z.string().min(3).max(128) }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      async (input) => executeTool({ tool: 'beam_network_discover' }, 'beam:read', () => network.discover(input.query.trim())),
    )

    server.registerTool(
      'beam_network_connections',
      {
        title: 'List Beam Network contacts',
        description: 'List accepted contacts and pending connection requests, including relationship type and current presence.',
        inputSchema: z.object({
          statuses: z.array(z.enum(['pending', 'accepted', 'declined', 'blocked', 'cancelled'])).max(5).optional(),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      async (input) => executeTool({ tool: 'beam_network_connections' }, 'beam:read', () => network.connections(input.statuses)),
    )

    server.registerTool(
      'beam_network_conversations',
      {
        title: 'List Beam Network conversations',
        description: 'List direct and group conversations with unread counts, members, presence, and the latest message.',
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      async () => executeTool({ tool: 'beam_network_conversations' }, 'beam:read', () => network.conversations()),
    )

    server.registerTool(
      'beam_network_messages',
      {
        title: 'Read Beam Network messages',
        description: 'Read up to 100 messages from a direct or group conversation visible to this Beam identity.',
        inputSchema: z.object({
          conversationId: networkObjectIdSchema,
          limit: z.number().int().min(1).max(100).optional(),
          before: z.string().min(20).max(40).optional(),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      async (input) => executeTool(
        { tool: 'beam_network_messages', target: input.conversationId },
        'beam:read',
        () => network.messages(input.conversationId, input.limit ?? 80, input.before),
      ),
    )

    if (options.enableSend !== false) {
      server.registerTool(
        'beam_network_request_connection',
        {
          title: 'Send a Beam Network connection request',
          description: 'EXTERNAL SIDE EFFECT: send a signed contact request to an assured Beam identity after exact human approval.',
          inputSchema: z.object({
            recipientBeamId: beamIdSchema,
            message: z.string().max(280).optional(),
            confirmed: confirmationSchema,
          }),
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        },
        async (input) => executeTool(
          { tool: 'beam_network_request_connection', target: input.recipientBeamId },
          'beam:send',
          async () => {
            requireHumanConfirmation(input.confirmed)
            return network.requestConnection(input.recipientBeamId as BeamIdString, input.message?.trim() ?? '')
          },
        ),
      )

      server.registerTool(
        'beam_network_respond_connection',
        {
          title: 'Respond to a Beam Network connection request',
          description: 'EXTERNAL SIDE EFFECT: accept, decline, or block one pending connection request after exact human approval.',
          inputSchema: z.object({
            connectionId: networkObjectIdSchema,
            decision: z.enum(['accepted', 'declined', 'blocked']),
            confirmed: confirmationSchema,
          }),
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        },
        async (input) => executeTool(
          { tool: 'beam_network_respond_connection', target: input.connectionId },
          'beam:send',
          async () => {
            requireHumanConfirmation(input.confirmed)
            return network.respondConnection(input.connectionId, input.decision)
          },
        ),
      )

      server.registerTool(
        'beam_network_open_direct',
        {
          title: 'Open a Beam Network direct conversation',
          description: 'EXTERNAL SIDE EFFECT: create or reopen a signed direct conversation with an accepted contact.',
          inputSchema: z.object({ counterpartBeamId: beamIdSchema, confirmed: confirmationSchema }),
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        },
        async (input) => executeTool(
          { tool: 'beam_network_open_direct', target: input.counterpartBeamId },
          'beam:send',
          async () => {
            requireHumanConfirmation(input.confirmed)
            return network.openDirect(input.counterpartBeamId as BeamIdString)
          },
        ),
      )

      server.registerTool(
        'beam_network_create_group',
        {
          title: 'Create a Beam Network agent team',
          description: 'EXTERNAL SIDE EFFECT: create a signed group conversation with accepted contacts after exact human approval.',
          inputSchema: z.object({
            title: z.string().min(2).max(80),
            memberBeamIds: z.array(beamIdSchema).min(1).max(49),
            confirmed: confirmationSchema,
          }),
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        },
        async (input) => executeTool(
          { tool: 'beam_network_create_group' },
          'beam:send',
          async () => {
            requireHumanConfirmation(input.confirmed)
            return network.createGroup(
              input.title.replace(/\s+/g, ' ').trim(),
              [...new Set(input.memberBeamIds)] as BeamIdString[],
            )
          },
        ),
      )

      server.registerTool(
        'beam_network_send_message',
        {
          title: 'Send a Beam Network message',
          description: 'EXTERNAL SIDE EFFECT: send one signed text message to a direct or group conversation after approval of the exact content.',
          inputSchema: z.object({
            conversationId: networkObjectIdSchema,
            body: z.string().min(1).max(4_000),
            confirmed: confirmationSchema,
          }),
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        },
        async (input) => executeTool(
          { tool: 'beam_network_send_message', target: input.conversationId, intent: 'network.message' },
          'beam:send',
          async () => {
            requireHumanConfirmation(input.confirmed)
            return network.sendMessage(input.conversationId, input.body.trim())
          },
        ),
      )
    }
  }

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
