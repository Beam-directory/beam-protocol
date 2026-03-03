import {
  generateKeyPairSync,
  sign,
  verify,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  type KeyObject
} from 'node:crypto'
import type { BeamIdString, BeamIdentityConfig, BeamIdentityData } from './types.js'

export class BeamIdentity {
  readonly beamId: BeamIdString
  readonly publicKeyBase64: string
  private readonly _privateKey: KeyObject
  private readonly _publicKey: KeyObject

  private constructor(beamId: BeamIdString, privateKey: KeyObject, publicKey: KeyObject) {
    this.beamId = beamId
    this._privateKey = privateKey
    this._publicKey = publicKey
    this.publicKeyBase64 = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64')
  }

  static generate(config: BeamIdentityConfig): BeamIdentity {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const beamId = `${config.agentName}@${config.orgName}.beam.id` as BeamIdString
    return new BeamIdentity(beamId, privateKey, publicKey)
  }

  static fromData(data: BeamIdentityData): BeamIdentity {
    const privateKey = createPrivateKey({
      key: Buffer.from(data.privateKeyBase64, 'base64'),
      format: 'der',
      type: 'pkcs8'
    })
    const publicKey = createPublicKey({
      key: Buffer.from(data.publicKeyBase64, 'base64'),
      format: 'der',
      type: 'spki'
    })
    return new BeamIdentity(data.beamId, privateKey, publicKey)
  }

  export(): BeamIdentityData {
    return {
      beamId: this.beamId,
      publicKeyBase64: this.publicKeyBase64,
      privateKeyBase64: (this._privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer).toString('base64')
    }
  }

  sign(data: string): string {
    const signature = sign(null, Buffer.from(data, 'utf8'), this._privateKey)
    return (signature as Buffer).toString('base64')
  }

  static verify(data: string, signatureBase64: string, publicKeyBase64: string): boolean {
    try {
      const publicKey = createPublicKey({
        key: Buffer.from(publicKeyBase64, 'base64'),
        format: 'der',
        type: 'spki'
      })
      return verify(
        null,
        Buffer.from(data, 'utf8'),
        publicKey,
        Buffer.from(signatureBase64, 'base64')
      )
    } catch {
      return false
    }
  }

  static parseBeamId(beamId: string): { agent: string; org: string } | null {
    const match = beamId.match(/^([a-z0-9_-]+)@([a-z0-9_-]+)\.beam\.id$/)
    if (!match) return null
    return { agent: match[1], org: match[2] }
  }

  static generateNonce(): string {
    return randomUUID()
  }
}
