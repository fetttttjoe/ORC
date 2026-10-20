#!/bin/sh
# Records a hand-made commit as a commit_recorded event; always exits 0
hook_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 0

sha=$(git rev-parse HEAD 2>/dev/null) || exit 0
paths=$(git show --name-only --format= HEAD 2>/dev/null)

# detached, off the commit path git waits on; a hard teardown can drop the append (accepted)
nohup bun "$hook_dir/post-commit-append.ts" "$sha" "$paths" >/dev/null 2>&1 </dev/null &

exit 0
