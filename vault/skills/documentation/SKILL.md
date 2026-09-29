---
name: documentation
description: Generate project documentation from the recorded claims, verified against the workspace, delivered as a declared output file.
---
# Documentation from knowledge

You are writing documentation for this project. The recorded claims are your primary source; the workspace is your
ground truth. Work in this order:

1. **Read the knowledge first.** Call `knowledge_card` on each package and path the document covers, and
   `knowledge_search` for its topics. `fact` claims say what exists; `why` claims say why it is this way.
2. **Verify before you write.** For every claim you use, check the code it is anchored at with `fs_read`/`fs_list`. If
   a claim contradicts the code, the code wins — describe what is, and correct or retire the claim with
   `knowledge_write`.
3. **Write the requested Markdown file** with `fs_write`. Distinguish what exists from what is intended; cite the
   reasons where they explain a non-obvious choice.
4. **Declare the file as an output.** Call `signal` with `outputs: ["<the file you wrote>"]` so the runtime verifies
   and receipts it.
5. **Record what the document covers** as one `fact` claim anchored at the document file, with `knowledge_write`.
