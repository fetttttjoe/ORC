// Head carries the lead, tail the summary (test totals, last hunk); each caller owns its budget.
export function clipMiddle(s: string, chars: number): string {
  return s.length <= 2 * chars
    ? s
    : `${s.slice(0, chars)}\n… [${s.length - 2 * chars} chars omitted] …\n${s.slice(-chars)}`
}
