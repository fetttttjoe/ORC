#!/usr/bin/env bash
# SessionStart: put `orc brief` in front of the model before its first turn.
#
# Plain text on stdout, no JSON envelope and no parsing of the hook's stdin. Measured on Claude Code
# 2.1.274 with a throwaway plugin: a SessionStart hook's plain stdout reaches the model, and the
# hook's working directory, CLAUDE_PROJECT_DIR and the stdin `cwd` are one and the same path. So
# bash never has to decode or encode JSON, which it could only do by hand.
#
# FAIL-OPEN, ALWAYS EXIT 0. A non-zero SessionStart hook is reported into the session as a hook
# error, and this plugin installs at user scope — the hook runs in every repository the user opens,
# most of which are not orc projects. When orc has nothing to give it says at most one line.
#
# hooks.json gives this 11 s. Measured on a 1007-event project: 506-570 ms healthy (10 runs), the
# same within noise right after both databases restarted, and 5.37 s with SurrealDB down — orc
# waits out one 5 s connect timeout and still prints a brief marked "unknown" where it could not
# read. 11 s is twice that slowest useful run, rounded up (the unit is whole seconds). Past it
# Claude Code cancels the hook and the session starts without a brief.

# Resolved BEFORE the cd — $0 may be a relative path. bin/orc-run is how this plugin reaches orc;
# an orc it cannot find is one more failure below, with orc-run's own sentence as the reason.
run="$(cd "$(dirname "$0")/../bin" && pwd)/orc-run"
cd "${CLAUDE_PROJECT_DIR:-$PWD}" 2>/dev/null || exit 0

err=$(mktemp) || exit 0
trap 'rm -f "$err"' EXIT
out=$("$run" brief 2>"$err")
rc=$?

case $rc in
  # Nothing printed is nothing to add: an empty printf would still put a blank line in the context.
  0) [ -n "$out" ] && printf '%s\n' "$out" ;;
  # EXIT_CODE.noProject in packages/cli/src/exit.ts: this directory is not an orc project. Silence —
  # it is the normal case for every unrelated repository, not a fault worth a line of context.
  3) ;;
  *)
    # The first stderr line is orc's own explanation. Credentials come out of any URL in it: when
    # Postgres is down orc names the database URL, password included, and this line goes into the
    # model's context and the session transcript.
    # Everything from `://` to the LAST '@' before the next '/' or space goes: URL parsing splits
    # userinfo from host at the last '@', so a password may hold one. `g`, because a line can name
    # two stores. A line of only whitespace is no reason at all, hence the second substitution.
    reason=$(head -n 1 "$err" | sed -E -e 's#(://)[^/[:space:]]*@#\1#g' -e 's#^[[:space:]]+$##')
    printf 'orc: unavailable — %s\n' "${reason:-orc brief exited $rc}"
    ;;
esac
exit 0
