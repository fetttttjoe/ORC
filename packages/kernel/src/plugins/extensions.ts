import { createRequire } from 'node:module'
import path from 'node:path'
import type { ExtensionApi, ExtensionManifest } from '@orc/contracts'

const require = createRequire(import.meta.url)

const isManifest = (v: unknown): v is ExtensionManifest =>
  typeof v === 'object' && v !== null &&
  typeof (v as ExtensionManifest).id === 'string' &&
  typeof (v as ExtensionManifest).activate === 'function'

export interface LoadedExtension { path: string; manifest: ExtensionManifest }

// T2 loader: full-access in-process code, gated by the local trust store. Reload is
// cache-eviction by directory prefix — evicting only the entry file would re-bind it
// to stale cached deps (spike 2026-07-17), so the whole extension dir is evicted.
export class ExtensionHost {
  loaded: LoadedExtension[] = []

  constructor(private readonly api: ExtensionApi) {}

  async load(declared: string[], isTrusted: (decl: string) => boolean, baseDir: string): Promise<void> {
    for (const decl of declared) {
      const abs = path.resolve(baseDir, decl)
      if (!isTrusted(decl)) {
        console.warn(`extension '${decl}' is declared but not trusted — skipped (grant with: orc ext trust ${decl})`)
        continue
      }
      await this.importAndActivate(abs, decl)
    }
  }

  async reload(): Promise<void> {
    const paths = this.loaded.map(l => l.path)
    await this.shutdown()
    for (const abs of paths) {
      const prefix = path.dirname(abs) + path.sep
      for (const key of Object.keys(require.cache))
        if (key.startsWith(prefix) || key === abs) delete require.cache[key]
      await this.importAndActivate(abs, abs)
    }
  }

  async shutdown(): Promise<void> {
    for (const l of this.loaded) {
      try {
        await l.manifest.deactivate?.()
      } catch (err) {
        console.warn(`extension '${l.manifest.id}' deactivate failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    this.loaded = []
  }

  private async importAndActivate(abs: string, label: string): Promise<void> {
    try {
      const mod = (await import(abs)) as { default?: unknown }
      if (!isManifest(mod.default)) {
        console.warn(`extension '${label}' has no valid default export ({ id, activate }) — skipped`)
        return
      }
      await mod.default.activate(this.api)
      this.loaded.push({ path: abs, manifest: mod.default })
    } catch (err) {
      console.warn(`extension '${label}' failed to load: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
