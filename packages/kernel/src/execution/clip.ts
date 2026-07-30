// Middle-out truncation: keep the head and the tail, drop the middle. commit-tool's diff preview
// and exec-tool's stdout/stderr both want "enough to write an honest message / diagnose a failure,
// never an unbounded prompt" — the head carries the lead (typecheck errors, the first files touched)
// and the tail carries the trailing summary (test totals, the last hunk). One truncator; each call
// site keeps its own budget constant (12k for a diff, 8k per exec stream) since the right size is
// content-specific, not the algorithm.
export function clipMiddle(s: string, chars: number): string {
  return s.length <= 2 * chars
    ? s
    : `${s.slice(0, chars)}\n… [${s.length - 2 * chars} chars omitted] …\n${s.slice(-chars)}`
}
