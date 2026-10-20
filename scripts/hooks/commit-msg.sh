#!/bin/sh
# same rule as commit-tool.ts CommitInput; refuses, never rewrites: an edit hides the record
f="$1"

# comment lines and the --verbose scissors are git's own; counting them refuses editor messages
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

# a comma-separated TYPE list is rejected on purpose; commas belong inside the scope parens
if ! printf '%s' "$subject" \
  | grep -Eq '^(feat|fix|docs|refactor|test|perf|build|ci|chore|revert)(\([a-z0-9,+/. -]+\))?!?: .+'; then
  refuse "subject is not a conventional commit — $subject"
fi

if [ "$lines" -gt 2 ]; then
  refuse "$lines content lines; the rule is at most two (subject, plus one body line only when the subject cannot carry the WHY)"
fi

# attribution patterns only: bare words would also match `provider-anthropic` and `claude-*` refs
if printf '%s\n' "$content" \
  | grep -Eqi '^(co-authored-by|generated with)[[:space:]:]|🤖|claude\.com/claude-code'; then
  refuse 'AI attribution is not recorded in this history'
fi

exit 0
