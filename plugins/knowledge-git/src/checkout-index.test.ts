import { afterEach, describe, expect, it } from 'bun:test'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { createCheckoutIndex } from './checkout-index'
import { GitFilesOptions } from './options'
import { gitCheckout } from './test-helpers'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('the checkout index', () => {
  it('a tracked manifest deleted from the working tree no longer makes its folder a package root', async () => {
    const checkout = gitCheckout()
    dirs.push(checkout)
    Bun.spawnSync(['git', '-C', checkout, 'add', 'pkg/package.json'])
    const index = createCheckoutIndex(GitFilesOptions.parse({}))
    expect((await index.snapshot(checkout)).packageRoots).toEqual(['pkg'])
    rmSync(path.join(checkout, 'pkg/package.json'))
    expect(Bun.spawnSync(['git', '-C', checkout, 'ls-files', '--cached']).stdout.toString()).toContain('pkg/package.json')
    expect((await index.snapshot(checkout)).packageRoots).toEqual([])
  })
})
