import { createRequire } from 'node:module'
import { errorMessage } from '@orc/contracts'
import path from 'node:path'
import type { ExtensionApi, ExtensionManifest } from '@orc/contracts'

const require = createRequire(import.meta.url)

const isManifest = (v: unknown): v is ExtensionManifest =>
  typeof v === 'object' && v !== null &&
  'id' in v && typeof v.id === 'string' &&
  'activate' in v && typeof v.activate === 'function'

export interface LoadedExtension { path: string; manifest: ExtensionManifest }

// T2 loader: full-access in-process code, gated by the local trust store. Reload is
// cache-eviction by directory prefix — evicting only the entry file would re-bind it
// to stale cached deps (spike 2026-07-17), so the whole extension dir is evicted.
export class ExtensionHost {
  loaded: LoadedExtension[] = []
  private declarations: Array<{ declared: string; path: string }> = []
  private isTrusted: (declared: string) => boolean = () => false

  constructor(private readonly api: ExtensionApi) {}

  async load(declared: string[], isTrusted: (decl: string) => boolean, baseDir: string): Promise<void> {
    this.declarations = declared.map(value => ({ declared: value, path: path.resolve(baseDir, value) }))
    this.isTrusted = isTrusted
    for (const extension of this.declarations) await this.loadTrusted(extension)
  }

  async reload(): Promise<void> {
    await this.shutdown()
    for (const extension of this.declarations) {
      const prefix = path.dirname(extension.path) + path.sep
      for (const key of Object.keys(require.cache))
        if (key.startsWith(prefix) || key === extension.path) delete require.cache[key]
      await this.loadTrusted(extension)
    }
  }

  async shutdown(): Promise<void> {
    for (const l of this.loaded) {
      try {
        await l.manifest.deactivate?.()
      } catch (err) {
        console.warn(`extension '${l.manifest.id}' deactivate failed: ${errorMessage(err)}`)
      }
    }
    this.loaded = []
  }

  private async loadTrusted(extension: { declared: string; path: string }): Promise<void> {
    if (!this.isTrusted(extension.declared)) {
      console.warn(`extension '${extension.declared}' is declared but not trusted — skipped (grant with: orc ext trust ${extension.declared})`)
      return
    }
    await this.importAndActivate(extension.path, extension.declared)
  }

  private async importAndActivate(abs: string, label: string): Promise<void> {
    try {
      const mod: { default?: unknown } = await import(abs)
      if (!isManifest(mod.default)) {
        console.warn(`extension '${label}' has no valid default export ({ id, activate }) — skipped`)
        return
      }
      await mod.default.activate(this.api)
      this.loaded.push({ path: abs, manifest: mod.default })
    } catch (err) {
      console.warn(`extension '${label}' failed to load: ${errorMessage(err)}`)
    }
  }
}
