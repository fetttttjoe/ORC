// The primitive set — small, typed, composable. Bigger views (detail panel, sidebar) are
// compositions of these, the way shadcn components compose primitives once generated.
import { el, type Child } from './el'
import { errorMessage } from '@orc/contracts'

export type Tone = 'accent' | 'ok' | 'warn' | 'purple' | 'danger' | 'muted' | 'default'

export const Badge = (text: string, tone: Tone = 'default'): HTMLElement =>
  el('span', { class: `badge${tone === 'default' ? '' : ` ${tone}`}` }, text)

export const Dot = (kind: string): HTMLElement => el('span', { class: `dot ${kind}` })

export const Card = (title: Child[], ...children: Child[]): HTMLElement =>
  el('div', { class: 'card' }, el('div', { class: 'card-title' }, ...title), ...children)

// label/value grid; value can be text or any node (badges, code)
export const KV = (rows: Array<[string, Child]>): HTMLElement =>
  el('div', { class: 'kv' }, ...rows.flatMap(([k, v]) => [
    el('span', { class: 'k' }, k),
    el('span', { class: 'v' }, v),
  ]))

export const Pre = (text: string): HTMLElement => el('pre', { class: 'pre' }, text)

export const Section = (title: string, ...children: Child[]): HTMLElement =>
  el('div', { class: 'section' }, el('div', { class: 'section-title' }, title), ...children)

export const NavItem = (opts: {
  label: string
  meta?: string
  dot?: string
  active?: boolean
  onClick: () => void
}): HTMLElement =>
  el('button', { class: `navitem${opts.active ? ' active' : ''}`, onClick: opts.onClick, title: opts.label },
    opts.dot ? Dot(opts.dot) : null,
    el('span', { class: 'truncate' }, opts.label),
    opts.meta ? el('span', { class: 'meta' }, opts.meta) : null,
  )

export const Empty = (text: string): HTMLElement => el('div', { class: 'empty' }, text)

export const Link = (label: string, onClick: () => void): HTMLElement =>
  el('a', { class: 'link', onClick }, label)

// action button: disables itself while the handler runs; failures surface as toasts.
// type='button' — inside a <form>, the default type='submit' makes Enter "click" the first
// button (implicit submission), which turned Enter-in-a-dialog into cancel.
export const Btn = (label: string, onClick: () => Promise<void> | void, tone: Tone = 'accent'): HTMLElement => {
  const b = el('button', { class: `btn ${tone}` }, label)
  b.type = 'button'
  b.addEventListener('click', () => {
    b.toggleAttribute('disabled', true)
    void Promise.resolve()
      .then(onClick)
      .catch(err => toast(errorMessage(err), 'danger'))
      .finally(() => b.toggleAttribute('disabled', false))
  })
  return b
}

const recentToasts = new Map<string, number>()
export function toast(text: string, tone: Tone = 'default'): void {
  // identical messages within 3s collapse to one — a failing stream must not bury the page
  const now = Date.now()
  const last = recentToasts.get(text)
  if (last !== undefined && now - last < 3_000) return
  recentToasts.set(text, now)
  let host = document.querySelector('.toasts')
  if (!host) { host = el('div', { class: 'toasts' }); document.body.append(host) }
  const t = el('div', { class: `toast ${tone}` }, text)
  host.append(t)
  while (host.childElementCount > 4) host.firstElementChild!.remove()
  setTimeout(() => t.remove(), 4_000)
}

export interface DialogField {
  name: string
  label: string
  kind?: 'text' | 'textarea' | 'select'
  options?: Array<{ value: string; label: string }>
  suggestions?: string[] // native <datalist> autocompletion for text fields
  value?: string
  placeholder?: string
}

let datalistCounter = 0

// native <dialog>: modal, esc-to-close, focus-trapped by the platform.
// Submit failures render INSIDE the dialog — the modal lives in the browser top layer, so a
// toast (or anything else in the page) can never appear above it.
export function openDialog(
  title: string,
  fields: DialogField[],
  submitLabel: string,
  onSubmit: (values: Record<string, string>) => Promise<void> | void,
): void {
  const inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>()
  const dlg = el('dialog', { class: 'dlg' })
  const error = el('div', { class: 'dlg-error' })
  const submitBtn = Btn(submitLabel, async () => {
    error.textContent = ''
    try {
      await onSubmit(Object.fromEntries([...inputs].map(([name, input]) => [name, input.value])))
    } catch (err) {
      error.textContent = errorMessage(err)
      return // dialog stays open — the user reads the reason and fixes the input
    }
    dlg.close()
  }) as HTMLButtonElement
  const form = el('form', {},
    el('div', { class: 'card-title' }, title),
    ...fields.map(f => {
      const input = f.kind === 'textarea' ? el('textarea', {})
        : f.kind === 'select' ? el('select', {}, ...(f.options ?? []).map(o => new Option(o.label, o.value)))
        : el('input', {})
      if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
        input.value = f.value ?? ''
        input.placeholder = f.placeholder ?? ''
      }
      let datalist: HTMLElement | null = null
      if (f.suggestions?.length && input instanceof HTMLInputElement) {
        const listId = `dl-${++datalistCounter}`
        input.setAttribute('list', listId)
        datalist = el('datalist', {})
        datalist.id = listId
        for (const s of f.suggestions) datalist.append(new Option('', s))
      }
      inputs.set(f.name, input)
      return el('label', { class: 'field' }, el('span', {}, f.label), input, datalist)
    }),
    error,
    el('div', { class: 'dlg-buttons' },
      Btn('cancel', () => dlg.close(), 'muted'),
      submitBtn,
    ),
  )
  // Enter in a field submits the dialog (textareas keep Enter for newlines — implicit
  // submission never fires from a textarea)
  form.addEventListener('submit', ev => { ev.preventDefault(); submitBtn.click() })
  dlg.append(form)
  dlg.addEventListener('close', () => dlg.remove())
  document.body.append(dlg)
  dlg.showModal()
}

export const Tabs = (items: ReadonlyArray<{ id: string; label: string }>, active: string, onSelect: (id: string) => void): HTMLElement =>
  el('div', { class: 'tabs' }, ...items.map(t =>
    el('button', { class: `tab${t.id === active ? ' active' : ''}`, onClick: () => onSelect(t.id) }, t.label)))

// status → badge tone, shared by every view that shows a task/step status
export const statusTone = (status: string): Tone =>
  ({ done: 'ok', completed: 'ok', running: 'accent', approved: 'accent', failed: 'danger', cancelled: 'muted', blocked: 'warn', awaiting_approval: 'warn', pending: 'muted' } as Record<string, Tone>)[status] ?? 'default'
