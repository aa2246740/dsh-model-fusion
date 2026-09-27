import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PromptBundle } from './profile/resolve.js'
import { promptDigests } from './profile/resolve.js'

const here = dirname(fileURLToPath(import.meta.url))

export function defaultPromptDir(): string {
  return join(here, '..', 'prompts')
}

export function loadPromptBundle(dir = defaultPromptDir()): PromptBundle {
  return {
    lead: readFileSync(join(dir, 'lead.md'), 'utf8'),
    worker: readFileSync(join(dir, 'worker.md'), 'utf8'),
    compact: readFileSync(join(dir, 'compact.md'), 'utf8'),
  }
}

export function loadModelPromptBundle(dir = defaultPromptDir()): PromptBundle {
  return {
    lead: readFileSync(join(dir, 'model-lead.md'), 'utf8'),
    worker: readFileSync(join(dir, 'model-worker.md'), 'utf8'),
    compact: readFileSync(join(dir, 'compact.md'), 'utf8'),
  }
}

export function promptManifest(dir = defaultPromptDir()) {
  const prompts = loadPromptBundle(dir)
  return { prompts, digests: promptDigests(prompts) }
}
