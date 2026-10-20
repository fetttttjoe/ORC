import { Command } from 'commander'
import { initializeProject, listProjectIds, loadConfig, migrateDatabase } from '@orc/kernel'
import { seedShippedSkills } from './shipped-skills'
import { CLI_ORIGIN, type ProgramDeps } from './program-deps'

// idempotent: seeding runs every time, only the identity mint is guarded
export function initCommand(dir?: string): Command {
  return new Command('init')
    .description('seed the shipped skills and initialize project identity (.orc/identity.json — local, never committed)')
    .requiredOption('--name <name>', 'project name')
    .option('--force', 'mint a new identity for a deliberate fork of an existing project')
    .action((opts: { name: string; force?: boolean }) => {
      const projectDir = dir ?? process.cwd()
      const config = loadConfig(projectDir)
      const seeded = seedShippedSkills(config.skillsDir)
      const skillLine = seeded.length > 0 ? `seeded: ${seeded.join(', ')}` : 'skills up to date'
      // an identity already here and no --force: report what is, report what the seed did, exit 0
      if (config.projectId !== null && config.projectName !== null && !opts.force) {
        console.log(`project already initialized as '${config.projectName}' (${config.projectId}) in ${config.projectRoot}`)
        console.log(skillLine)
        return
      }
      const identity = initializeProject(projectDir, opts.name, { force: opts.force })
      console.log(`initialized project '${identity.projectName}' (${identity.projectId}) in ${identity.projectRoot}`)
      console.log(skillLine)
    })
}

export async function runInit(args: string[], dir?: string): Promise<void> {
  await initCommand(dir).parseAsync(args, { from: 'user' })
}

export function databaseCommand(dir?: string): Command {
  const database = new Command('db').description('database schema')
  database.command('migrate')
    .description('apply committed database migrations')
    .action(async () => {
      await migrateDatabase(loadConfig(dir).databaseUrl)
      console.log('database migrated')
    })
  return database
}

export async function runMigrate(args: string[], dir?: string): Promise<void> {
  await databaseCommand(dir).parseAsync(args, { from: 'user' })
}

export function projectCommands(deps: Pick<ProgramDeps, 'actions' | 'noProject' | 'plugin'>): Command[] {
  const { actions, noProject, plugin } = deps
  const group = new Command()
  group
    .command('purge <projectName>')
    .description("cancel running work and delete the named project's events and operations — identity and knowledge files stay (clean slate for re-testing)")
    .requiredOption('--yes', 'confirm: this irreversibly deletes the project history')
    .action(async (projectName: string) => {
      // naming the project makes a drifted cwd fail loudly: a script once purged a live run's history
      const cfg = plugin?.config
      if (!cfg?.projectName) throw noProject('purging needs a project context')
      const actual = cfg.projectName
      if (projectName !== actual)
        throw new Error(`refusing: this directory is project '${actual}' (${cfg.dir}), not '${projectName}'`)
      const r = await actions().purgeProject(CLI_ORIGIN)
      console.log(`purged ${r.events} event(s), ${r.operations} operation(s) from '${actual}'`)
      for (const w of r.warnings) console.log(`warning: ${w}`)
    })

  group
    .command('projects')
    .description('every project this database holds, including ones whose identity file is gone')
    .action(async () => {
      // a foreign project's name is not resolved: that would read every project's log for a label
      const cfg = plugin?.config
      if (!cfg) throw noProject('listing projects needs a project context')
      const ids = await listProjectIds(cfg.databaseUrl)
      if (ids.length === 0) return console.log('_no projects_')
      for (const id of ids)
        console.log(id === cfg.projectId ? `${id}\t${cfg.projectName}\t<- this directory` : `${id}\t(no identity here — delete with: orc delete --id ${id} --yes)`)
    })

  group
    .command('delete [projectName]')
    .description("delete a project entirely — history and durable-execution state (purge keeps the chat; this does not)")
    .option('--id <projectId>', 'delete a FOREIGN project by id — for one whose identity file is gone, so no name exists to confirm against (see: orc projects)')
    .requiredOption('--yes', 'confirm: this irreversibly deletes the project')
    .action(async (projectName: string | undefined, opts: { id?: string }) => {
      const cfg = plugin?.config
      if (!cfg) throw noProject('deleting a project needs a project context')
      if (opts.id !== undefined) {
        // an orphan has no name to confirm against: the id is the confirmation, and not the cwd's
        if (projectName !== undefined)
          throw new Error('pass a name or --id, not both: a name confirms the cwd project, --id targets a foreign one')
        if (opts.id === cfg.projectId)
          throw new Error(`refusing: ${opts.id} is THIS directory's project — delete it by name (orc delete ${cfg.projectName} --yes) so the name confirms the target`)
        const r = await actions().deleteProject(opts.id, CLI_ORIGIN)
        console.log(`deleted ${opts.id}: ${r.events} event(s), ${r.operations} operation(s)`)
        for (const w of r.warnings) console.log(`warning: ${w}`)
        return
      }
      // named like purge: a script in the wrong directory would delete a project it never meant to
      if (!cfg.projectName) throw noProject('deleting a project needs a project context')
      const actual = cfg.projectName
      if (projectName !== actual)
        throw new Error(`refusing: this directory is project '${actual}' (${cfg.dir}), not '${projectName}' — for a project with no identity file, use --id (see: orc projects)`)
      const r = await actions().deleteProject(cfg.projectId, CLI_ORIGIN)
      console.log(`deleted '${actual}': ${r.events} event(s), ${r.operations} operation(s)`)
      for (const w of r.warnings) console.log(`warning: ${w}`)
    })
  return [...group.commands]
}
