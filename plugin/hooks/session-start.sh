#!/usr/bin/env bash
# SessionStart: brief in context, plain stdout, fail-open; 5 s timeout (brief ~1.6 s, DB 3.3 s).
run="$(cd "$(dirname "$0")/../bin" && pwd)/orc-run"
cd "${CLAUDE_PROJECT_DIR:-$PWD}" 2>/dev/null || exit 0

err=$(mktemp) || exit 0
trap 'rm -f "$err"' EXIT
out=$("$run" brief 2>"$err")
rc=$?

case $rc in
  # Empty output prints nothing.
  0) [ -n "$out" ] && printf '%s\n' "$out" ;;
  # EXIT_CODE.noProject (packages/cli/src/exit.ts): not an orc project, silent.
  3) ;;
  *)
    # First stderr line is the reason with URL credentials stripped (user:pass removed).
    reason=$(head -n 1 "$err" | sed -E -e 's#(://)[^/[:space:]]*@#\1#g' -e 's#^[[:space:]]+$##')
    printf 'orc: unavailable — %s\n' "${reason:-orc brief exited $rc}"
    ;;
esac
exit 0
