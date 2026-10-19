<script lang="ts">
  import EllipsisIcon from '@lucide/svelte/icons/ellipsis'
  import * as Dialog from '$lib/components/ui/dialog'
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import ConfirmDialog from './ConfirmDialog.svelte'
  import { api } from '$lib/api/client'
  import { actions, type PurgeReport } from '$lib/api/actions'
  import { notify } from '$lib/notify'
  import { session } from '$lib/stores/session.svelte'

  // chat lifecycle: create, rename, and the two destructive ones behind typed confirmation

  const current = $derived(session.projects.find(p => p.id === session.sel.project))
  const name = $derived(current?.name ?? session.sel.project.slice(0, 8))

  let renameOpen = $state(false)
  let createOpen = $state(false)
  let deleteOpen = $state(false)
  let purgeOpen = $state(false)

  let newName = $state('')
  let newDir = $state('')
  let busy = $state(false)

  async function refreshProjects(): Promise<void> {
    session.projects = await api.projects()
  }

  function report(result: PurgeReport, done: string): void {
    notify(result.warnings.length > 0 ? `${done} — ${result.warnings.join('; ')}` : done, result.warnings.length > 0 ? 'warn' : 'ok')
  }

  async function rename(): Promise<void> {
    if (busy || newName.trim() === '') return
    busy = true
    try {
      await actions.renameProject(newName.trim())
      await refreshProjects()
      notify('chat renamed', 'ok')
      renameOpen = false
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      busy = false
    }
  }

  async function create(): Promise<void> {
    if (busy || newName.trim() === '' || newDir.trim() === '') return
    busy = true
    try {
      await actions.newProject(newDir.trim(), newName.trim())
      await refreshProjects()
      notify('chat created', 'ok')
      createOpen = false
      newName = ''
      newDir = ''
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      busy = false
    }
  }
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <Button {...props} variant="ghost" size="icon" class="size-6" title="chat actions" aria-label="chat actions"><EllipsisIcon /></Button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content align="start" class="w-44">
    <DropdownMenu.Group>
      <DropdownMenu.Item onSelect={() => { newName = ''; newDir = session.info.defaultCwd ?? ''; createOpen = true }}>new chat</DropdownMenu.Item>
      {#if session.canAct()}
        <DropdownMenu.Item onSelect={() => { newName = name; renameOpen = true }}>rename chat</DropdownMenu.Item>
        <DropdownMenu.Separator />
        <DropdownMenu.Item variant="destructive" onSelect={() => (purgeOpen = true)}>purge chat…</DropdownMenu.Item>
      {/if}
      <DropdownMenu.Item variant="destructive" onSelect={() => (deleteOpen = true)}>delete chat…</DropdownMenu.Item>
    </DropdownMenu.Group>
  </DropdownMenu.Content>
</DropdownMenu.Root>

<Dialog.Root bind:open={renameOpen}>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>rename chat</Dialog.Title>
      <Dialog.Description>the name is a label — ids, history and knowledge are untouched.</Dialog.Description>
    </Dialog.Header>
    <Input bind:value={newName} disabled={busy} class="h-8 text-xs" placeholder="chat name" />
    <Dialog.Footer>
      <Button variant="outline" size="sm" disabled={busy} onclick={() => (renameOpen = false)}>cancel</Button>
      <Button size="sm" disabled={busy || newName.trim() === ''} onclick={() => void rename()}>rename</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={createOpen}>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>new chat</Dialog.Title>
      <Dialog.Description>a chat is one project directory — requests run against the code that lives there.</Dialog.Description>
    </Dialog.Header>
    <div class="flex flex-col gap-2">
      <Input bind:value={newName} disabled={busy} class="h-8 text-xs" placeholder="chat name" />
      <Input bind:value={newDir} disabled={busy} class="h-8 font-mono text-xs" placeholder="project directory" />
    </div>
    <Dialog.Footer>
      <Button variant="outline" size="sm" disabled={busy} onclick={() => (createOpen = false)}>cancel</Button>
      <Button size="sm" disabled={busy || newName.trim() === '' || newDir.trim() === ''} onclick={() => void create()}>create</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<ConfirmDialog
  bind:open={purgeOpen}
  title="purge"
  description={`purge “${name}” — cancels running work and deletes the project's history: ALL requests and their events. Knowledge files in the repository stay, and so does the empty chat.`}
  confirmWord={name}
  confirmLabel={`type “${name}” to confirm`}
  onconfirm={async () => {
    report(await actions.purgeProject(), 'purged')
    await refreshProjects()
  }}
/>

<ConfirmDialog
  bind:open={deleteOpen}
  title="delete"
  description={`delete “${name}” — removes this chat and all its data permanently.`}
  confirmWord={name}
  confirmLabel={`type “${name}” to confirm`}
  onconfirm={async () => {
    const target = session.sel.project
    report(await actions.deleteProject(target), 'chat deleted')
    await refreshProjects()
    // land on whatever chat remains; none left leaves the empty shell
    session.navigate({ project: session.projects[0]?.id ?? '', node: null })
  }}
/>
