// Drive a running DSH web Host through its public session and Fusion HTTP APIs.
// Authentication uses the Harness's own dshx helpers, so no token is handled here.
//
//   DSH_ROOT=/path/to/deepseek-harness node --experimental-strip-types dsh.mjs <command> [...]
//
//   start   <cwd> <provider> <model> [effort] <promptFile>   -> prints {"sessionId": ...}; DSH_PRESET=<name> switches the permission preset first
//   select  <cwd> <provider> <model> [effort]               -> select in a blank session (DSH saves it as the default model)
//   prompt  <sessionId> <promptFile>                        -> queue a follow-up user turn in an existing session
//   running <sessionId>                                     -> prints {"running": bool}
//   busy                                                    -> sessions currently running (check before quitting the Host)
//   cancel  <sessionId>
//   settings                                                -> Fusion pair/policy (no catalog)
//   cache                                                   -> Fusion per-model cache keepalive view
//   catalog                                                 -> provider/model ids with efforts
//   pair    <leadJson> <workerJson>                         -> save the Fusion pair (e.g. '{"provider":"zai","model":"glm-5.3","reasoningEffort":"max"}')
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.env.DSH_ROOT
if (!root) throw new Error('Set DSH_ROOT to the deepseek-harness checkout that runs the Host')
const access = await import(pathToFileURL(resolve(root, 'tools/dshx/src/internal/browser-access.ts')).href)
const { createWebProofRequest } = await import(pathToFileURL(resolve(root, 'tools/dshx/src/internal/web-proof-auth.ts')).href)
const host = access.discoverBrowserHost(root)
const request = createWebProofRequest(host.port, access.browserStartup(root, host).startup)

async function rpc(method, args) {
  const response = await request('/api/' + method, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }) })
  const body = await response.json()
  if (response.status !== 200 || !body.result?.ok) throw new Error(`${method} ${response.status} ${JSON.stringify(body).slice(0, 500)}`)
  return body.result.value
}
async function fusion(query) {
  const response = await request('/api/model-fusion?' + query)
  if (response.status !== 200) throw new Error(`model-fusion ${query} ${response.status}`)
  return response.json()
}

const [command, ...args] = process.argv.slice(2)
const out = value => console.log(JSON.stringify(value))
if (command === 'start') {
  const [cwd, provider, model, ...rest] = args
  const promptFile = rest.pop(), effort = rest[0]
  const { sessionId } = await rpc('session/create', { request: { cwd } })
  const selected = await rpc('session/selectModel', { request: { sessionId, provider, model, ...(effort ? { reasoningEffort: effort } : {}) } })
  // DSH_PRESET: switch the session's permission preset first (the same /permission line the UI submits),
  // so unattended runs never wait on a human approval.
  if (process.env.DSH_PRESET) {
    const run = await rpc('commands/execute', { agentId: sessionId, line: `/permission ${process.env.DSH_PRESET}`, submittedAttachments: [] })
    if (run?.result?.kind !== 'success') throw new Error('permission preset: ' + JSON.stringify(run))
  }
  await rpc('session/prompt', { request: { requestId: randomUUID(), sessionId, mode: 'queue',
    content: [{ type: 'text', text: readFileSync(promptFile, 'utf8') }], clientTimeZone: 'UTC' } })
  out({ sessionId, selected: selected.selected, hostPid: host.pid })
} else if (command === 'select') {
  // Select a model in a blank session without prompting. DSH records the last selection as the
  // profile's default model, so this is also how a run restores the user's default afterwards.
  const [cwd, provider, model, effort] = args
  const { sessionId } = await rpc('session/create', { request: { cwd } })
  const selected = await rpc('session/selectModel', { request: { sessionId, provider, model, ...(effort ? { reasoningEffort: effort } : {}) } })
  out({ sessionId, selected: selected.selected })
} else if (command === 'preset-probe') {
  // Create a session, switch its preset, and report the result without prompting any model.
  const { sessionId } = await rpc('session/create', { request: { cwd: args[0] } })
  out({ sessionId, run: await rpc('commands/execute', { agentId: sessionId, line: `/permission ${args[1] ?? ''}`.trim(), submittedAttachments: [] }) })
} else if (command === 'prompt') {
  await rpc('session/prompt', { request: { requestId: randomUUID(), sessionId: args[0], mode: 'queue',
    content: [{ type: 'text', text: readFileSync(args[1], 'utf8') }], clientTimeZone: 'UTC' } })
  out({ sessionId: args[0], queued: true })
} else if (command === 'running') {
  const list = await rpc('session/list', { _request: {} })
  const item = list.items.find(row => row.sessionId === args[0])
  out({ running: Boolean(item?.running), known: Boolean(item) })
} else if (command === 'busy') {
  const list = await rpc('session/list', { _request: {} })
  out({ total: list.items.length, running: list.items.filter(row => row.running).map(row => ({ sessionId: row.sessionId, title: row.title, cwd: row.cwd })) })
} else if (command === 'cancel') {
  out(await rpc('session/cancel', { request: { sessionId: args[0] } }))
} else if (command === 'settings') {
  const { catalog: _catalog, ...rest } = await fusion('view=settings')
  out(rest)
} else if (command === 'cache') {
  out(await fusion('view=cache'))
} else if (command === 'catalog') {
  const { catalog } = await fusion('view=settings')
  out(catalog.groups.map(group => ({ provider: group.id, models: group.models.map(m => ({ id: m.id, efforts: m.reasoning?.efforts?.map(e => e.id) ?? [] })) })))
} else if (command === 'pair') {
  const before = await fusion('view=settings')
  const pair = { ...(before.pair ?? {}), lead: JSON.parse(args[0]), worker: JSON.parse(args[1]) }
  const response = await request('/api/model-fusion', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'configure', revision: before.revision, pair }) })
  const body = await response.json()
  if (response.status !== 200) throw new Error('configure ' + JSON.stringify(body))
  const { catalog: _c, ...after } = await fusion('view=settings')
  out(after)
} else {
  throw new Error('Unknown command; see the header of this file')
}
