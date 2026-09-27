import type { IncomingMessage, ServerResponse } from 'node:http'

export function trustedRequest(req: IncomingMessage): boolean {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')) return false
  if (req.headers['sec-fetch-site'] === 'cross-site' || !req.headers.host) return false
  try {
    const target = new URL(`http://${req.headers.host}`)
    if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)) return false
    return !req.headers.origin || new URL(req.headers.origin).host === target.host
  } catch { return false }
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(body))
}

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new Error('JSON content type required')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 256 * 1024) throw new Error('Request body exceeds 256 KiB')
    chunks.push(Buffer.from(chunk))
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON object required')
  return value as Record<string, unknown>
}
