export const MAX_ATTACHMENT_BYTES = 6 * 1024 * 1024

export const ALLOWED_ATTACHMENT_TYPES = new Set([
  'application/pdf',
  'audio/mp4',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
  'text/plain',
])

export function isAllowedAttachmentMime(mimeType: string): boolean {
  return ALLOWED_ATTACHMENT_TYPES.has(mimeType.toLowerCase().trim())
}
