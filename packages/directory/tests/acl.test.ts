import { afterEach, describe, expect, it } from 'vitest'
import type { Database } from 'better-sqlite3'
import { createAcl, deleteAcl, isIntentAllowed, listAclsForBeam, seedAclsFromCatalog } from '../src/acl.js'
import { createDatabase, registerAgent } from '../src/db.js'

function registerTestAgent(db: Database, name: string, org = 'coppen') {
  return registerAgent(db, {
    beamId: `${name}@${org}.beam.directory`,
    displayName: name,
    capabilities: ['agent.ping'],
    publicKey: `${name}-public-key`,
    org,
  })
}

describe('acl', () => {
  let db: Database

  afterEach(() => {
    db?.close()
  })

  it('creates, lists, upserts, and deletes ACL rows', () => {
    db = createDatabase(':memory:')
    registerTestAgent(db, 'jarvis')

    const first = createAcl(db, {
      targetBeamId: 'jarvis@coppen.beam.directory',
      intentType: 'system.broadcast',
      allowedFrom: 'alice@coppen.beam.directory',
    })

    expect(first.id).toBeGreaterThan(0)
    expect(first.intent_type).toBe('system.broadcast')

    const second = createAcl(db, {
      targetBeamId: 'jarvis@coppen.beam.directory',
      intentType: 'system.broadcast',
      allowedFrom: 'alice@coppen.beam.directory',
    })

    const rows = listAclsForBeam(db, 'jarvis@coppen.beam.directory')
    expect(rows).toHaveLength(1)
    expect(second.id).toBe(first.id)

    expect(deleteAcl(db, first.id)).toBe(true)
    expect(deleteAcl(db, first.id)).toBe(false)
    expect(listAclsForBeam(db, 'jarvis@coppen.beam.directory')).toEqual([])
  })

  it('checks exact and wildcard ACL matches', () => {
    db = createDatabase(':memory:')
    registerTestAgent(db, 'jarvis')

    createAcl(db, {
      targetBeamId: 'jarvis@coppen.beam.directory',
      intentType: 'escalation.request',
      allowedFrom: 'clara@coppen.beam.directory',
    })
    createAcl(db, {
      targetBeamId: 'jarvis@coppen.beam.directory',
      intentType: 'agent.ping',
      allowedFrom: '*',
    })

    expect(
      isIntentAllowed(db, {
        targetBeamId: 'jarvis@coppen.beam.directory',
        intentType: 'escalation.request',
        fromBeamId: 'clara@coppen.beam.directory',
      }),
    ).toBe(true)
    expect(
      isIntentAllowed(db, {
        targetBeamId: 'jarvis@coppen.beam.directory',
        intentType: 'escalation.request',
        fromBeamId: 'james@coppen.beam.directory',
      }),
    ).toBe(false)
    expect(
      isIntentAllowed(db, {
        targetBeamId: 'jarvis@coppen.beam.directory',
        intentType: 'agent.ping',
        fromBeamId: 'anyone@coppen.beam.directory',
      }),
    ).toBe(true)
    expect(
      isIntentAllowed(db, {
        targetBeamId: 'jarvis@coppen.beam.directory',
        intentType: 'unknown.intent',
        fromBeamId: 'clara@coppen.beam.directory',
      }),
    ).toBe(false)
  })

  it('seedAclsFromCatalog() creates catalog ACLs for known target agents', () => {
    db = createDatabase(':memory:')
    registerTestAgent(db, 'jarvis')
    registerTestAgent(db, 'fischer')
    registerTestAgent(db, 'clara')
    registerTestAgent(db, 'james')

    seedAclsFromCatalog(db)
    seedAclsFromCatalog(db)

    const jarvisAcls = listAclsForBeam(db, 'jarvis@coppen.beam.directory')
    const claraAcls = listAclsForBeam(db, 'clara@coppen.beam.directory')

    expect(jarvisAcls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ intent_type: 'escalation.request', allowed_from: 'clara@coppen.beam.directory' }),
        expect.objectContaining({ intent_type: 'escalation.request', allowed_from: 'fischer@coppen.beam.directory' }),
        expect.objectContaining({ intent_type: 'escalation.request', allowed_from: 'james@coppen.beam.directory' }),
        expect.objectContaining({ intent_type: 'agent.ping', allowed_from: '*' }),
        expect.objectContaining({ intent_type: 'task.delegate', allowed_from: '*' }),
      ]),
    )
    expect(claraAcls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ intent_type: 'sales.pipeline_summary', allowed_from: 'jarvis@coppen.beam.directory' }),
        expect.objectContaining({ intent_type: 'agent.introduce', allowed_from: '*' }),
      ]),
    )
  })
})
