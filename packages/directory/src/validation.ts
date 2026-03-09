import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import AjvImport, { type ValidateFunction } from 'ajv'

export const BEAM_ID_RE = /^[a-z0-9_-]+@(?:[a-z0-9_-]+\.)?beam\.directory$/

interface CatalogParamRule {
  type?: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'integer'
  enum?: unknown[]
  required?: boolean
}

interface CatalogIntent {
  id: string
  payload?: Record<string, CatalogParamRule>
  params?: Record<string, CatalogParamRule>
}

interface CatalogFile {
  intents?: CatalogIntent[]
}

interface ValidationResult {
  valid: boolean
  error?: string
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const catalogPaths = [
  resolve(__dirname, '../../../intents/catalog.yaml'),
  resolve(__dirname, '../catalog.yaml'),
]

const AjvCtor = AjvImport as unknown as {
  new (options?: Record<string, unknown>): { compile: (schema: object) => ValidateFunction }
}
const ajv = new AjvCtor({ allErrors: true, strict: false })
const validators = new Map<string, ValidateFunction>()

function loadCatalog(): CatalogIntent[] {
  for (const catalogPath of catalogPaths) {
    try {
      const raw = readFileSync(catalogPath, 'utf8')
      const parsed = JSON.parse(raw) as CatalogFile
      const intents = Array.isArray(parsed.intents) ? parsed.intents : []
      if (intents.length > 0) {
        return intents
      }
    } catch {
    }
  }

  return []
}

function buildIntentSchema(intent: CatalogIntent): Record<string, unknown> {
  const rules = intent.payload ?? intent.params ?? {}
  const properties: Record<string, Record<string, unknown>> = {}
  const required: string[] = []

  for (const [key, rule] of Object.entries(rules)) {
    const property: Record<string, unknown> = {}
    if (rule.type) property.type = rule.type
    if (Array.isArray(rule.enum)) property.enum = rule.enum
    properties[key] = property
    if (rule.required === true) required.push(key)
  }

  return {
    type: 'object',
    properties,
    required,
    additionalProperties: true,
  }
}

function initValidators(): void {
  if (validators.size > 0) return

  const intents = loadCatalog()
  for (const intent of intents) {
    if (!intent || typeof intent.id !== 'string') continue
    validators.set(intent.id, ajv.compile(buildIntentSchema(intent)))
  }
}

export function validateIntentPayload(intentType: string, payload: unknown): ValidationResult {
  initValidators()

  const validator = validators.get(intentType)
  if (!validator) {
    return { valid: false, error: `Unknown intent type: ${intentType}` }
  }

  const valid = validator(payload)
  if (valid) {
    return { valid: true }
  }

  const detail = validator.errors?.[0]
  const suffix = detail?.message ? `: ${detail.message}` : ''
  const path = detail?.instancePath || '/'
  return { valid: false, error: `Invalid payload for intent ${intentType} at ${path}${suffix}` }
}

export function knownIntentTypes(): string[] {
  initValidators()
  return Array.from(validators.keys()).sort()
}
