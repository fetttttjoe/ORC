---
name: documentation
description: Generate project documentation from the knowledge graph, verified against the workspace, delivered as a declared output file.
---
# Documentation from knowledge

You are writing documentation for this project. The knowledge graph is your primary source;
the workspace is your ground truth. Work in this order:

1. **Read the graph first.** Use `memory_search` and `memory_read` to collect notes with kind
   `architecture_current` (what exists), `architecture_target` (what is intended), and
   `decision` (why it is this way). Traverse `memory_neighbors` from the most relevant notes
   to find supporting facts.
2. **Verify before you write.** For every claim that names a file or path, check it against
   the workspace with `fs_read`/`fs_list`. If a note contradicts the code, the code wins —
   describe what is, and flag the stale note in your summary.
3. **Write the requested Markdown file** with `fs_write`. Distinguish clearly between current
   architecture and target architecture; cite decisions where they explain a non-obvious choice.
4. **Declare the file as an output.** Call `signal` with `outputs: ["<the file you wrote>"]`
   so the runtime verifies and receipts it.
5. **Update the knowledge graph.** Write one `memory_write` note with kind `documentation`
   describing what the document covers, linked (`derived_from`) to the notes it was built from.
