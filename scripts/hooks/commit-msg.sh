#!/bin/sh
# The commit-message rule, enforced by REFUSAL. This hook never edits the message.
#
# Its predecessor rewrote instead: an awk kept the first two surviving lines and dropped the rest,
# and deleted any line matching /claude|anthropic/. Both failures are in the history. Twenty of the
# last sixty commits carry a body cut mid-clause at a soft-wrap boundary — 5e837cb ends at "the
# log's expected", ffe517f at "tools.ts and", 79303eb at "finalize_plan and" — and every one of
# those bodies measures 62-88 characters, which is a wrap column, not an author stopping. A subject
# naming this repo's own `provider-anthropic` package would have been deleted outright, promoting a
# body line to subject. A gate that silently rewrites is worse than no gate: the author never sees
# what was recorded, so the defect survived weeks of commits before anyone traced it.
#
# Same rule as the kernel's git_commit refusal (commit-tool.ts, CommitInput) so both doors — agent
# and human — agree on what a message may be. Pinned by scripts/commit-msg-hook.test.ts.
f="$1"

# What git adds and then strips itself: comment lines, and everything under the `--verbose`
# scissors. Counting those would refuse every editor-authored message.
content=$(sed -e '/^#[[:space:]]*-\{1,\}[[:space:]]*>8[[:space:]]*-\{1,\}/,$d' -e '/^#/d' "$f" \
  | grep -v '^[[:space:]]*$')

refuse() {
  printf 'commit refused: %s\n' "$1" >&2
  printf '  the message is unchanged — edit it and commit again\n' >&2
  exit 1
}

if [ -z "$content" ]; then
  refuse 'the message is empty'
fi

subject=$(printf '%s\n' "$content" | sed -n '1p')
lines=$(printf '%s\n' "$content" | wc -l | tr -d ' ')

# One type, optional scope. Checked against the last 80 subjects: 79 pass. The one that does not
# is `docs,chore:` — a comma-separated TYPE list, which neither Conventional Commits nor this
# repo's own documented `<type>(<scope>): <subject>` allows. Left rejected on purpose; commas
# belong inside the scope parens (`feat(cli,kernel): …`), which this does accept.
if ! printf '%s' "$subject" \
  | grep -Eq '^(feat|fix|docs|refactor|test|perf|build|ci|chore|revert)(\([a-z0-9,+/. -]+\))?!?: .+'; then
  refuse "subject is not a conventional commit — $subject"
fi

if [ "$lines" -gt 2 ]; then
  refuse "$lines content lines; the rule is at most two (subject, plus one body line only when the subject cannot carry the WHY)"
fi

# Attribution patterns only. The old hook matched the bare words, which also ate any honest mention
# of the `provider-anthropic` package or a `claude-*` model ref — both routine subjects here.
if printf '%s\n' "$content" \
  | grep -Eqi '^(co-authored-by|generated with)[[:space:]:]|🤖|claude\.com/claude-code'; then
  refuse 'AI attribution is not recorded in this history'
fi

exit 0
