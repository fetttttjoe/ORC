#!/bin/sh
# Records a hand-made commit — one that never went through a task's autoCommit/scoped_changes
# healing pipeline — into the kernel's event log as a commit_recorded event, so the graph the rest
# of the system already reads off that log (notesCitingPaths and its drift healing) at least sees
# that the commit happened.
#
# git runs post-commit SYNCHRONOUSLY on every `git commit` in this repo, so this hook's SUCCESS
# path — bun startup plus a Postgres round-trip — is a real, constant tax, not just a failure to
# guard against. So this file does ONLY the cheap synchronous part (capture the sha and the paths
# the commit touched) and then DETACHES the actual append: `nohup bun … &`, stdio redirected to
# /dev/null, stdin closed, no wait. `git commit` returns as soon as this script exits — which
# happens immediately after the spawn — never after bun has started or the database has answered.
#
# Trade-off, accepted rather than accidental: a backgrounded child can in principle be reaped
# before its DB round-trip finishes if the surrounding shell is torn down HARD instead of exiting
# normally — a container's PID-1 exiting, a CI runner killing its whole process group — which would
# lose the event silently. Weighed against taxing every commit in this repo with a synchronous DB
# round-trip, this is the smaller cost. See the grounding note in project memory
# (post-commit-hook-event-kernel-event-for-out-of-task-commits) for the record of this trade-off.
#
# Silent degrade lives in post-commit-append.ts, not here: absent `.orc`, an unreachable database,
# anything — it exits without printing a byte, the same rule packages/cli/src/actions.ts's
# buildModelDiscovery follows for its taskless append (`.catch(() => {})`). This script itself
# never prints either, and always exits 0: a hand-made commit that could not be recorded is still
# a commit — the append is a courtesy to the log, never a gate on the commit succeeding.
hook_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 0

sha=$(git rev-parse HEAD 2>/dev/null) || exit 0
paths=$(git show --name-only --format= HEAD 2>/dev/null)

nohup bun "$hook_dir/post-commit-append.ts" "$sha" "$paths" >/dev/null 2>&1 </dev/null &

exit 0
