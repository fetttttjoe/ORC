# Migration Guide: M3 Trust Store Setup (.orc/trust.json)

**ADR Reference:** ADR-007, M3-D3  
**Milestone:** M3 Plugins  
**Date:** 2026-07-17  
**Dependencies:** Migration 001–007 completed (M2 foundation + M3 plugin host)  
**Status:** Security-critical change — required before sharing `.orc/config.json` across teams

---

## Summary

M3 introduces a **trust store** — a local, never-committed file (`.orc/trust.json`) that explicitly grants permission for MCP servers and TypeScript extensions to run. This hardens the security model:

### What Changes

| Aspect | Before (M2) | After (M3) | Breaking? |
|---|---|---|---|
| **Config** | `.orc/config.json` declares MCP servers and extensions | Same, but now inert without trust grants | ✓ Behavioral |
| **Trust decision** | Implicit (first server spawn = approval) | Explicit (`orc mcp trust <id>`, `orc ext trust <path>`) | ✓ YES |
| **Committable** | N/A (M2 has no plugins) | `.orc/config.json` is safe to commit | ✓ YES (safe!) |
| **Never commit** | N/A | `.orc/trust.json` — add to `.gitignore` immediately | ✓ YES |
| **Sharing repos** | N/A | Cloned repos can't auto-execute plugins without local grant | ✓ YES (secure) |
| **Validation** | N/A | Plans referencing untrusted servers/extensions fail validation | ✓ YES |

### Why This Changes

- **Security:** A shared repo could declare malicious MCP servers or extensions. Without explicit local grants, any plugin activation is deferred until the user explicitly trusts it.
- **Auditability:** `.orc/trust.json` is a local audit log of what the developer opted into.
- **Simplicity for teams:** `.orc/config.json` is shareable/committable; trust is personal and local.

### Impact

**On team workflows:**
- Repo can declare MCP servers and extensions in `.orc/config.json`.
- Each developer runs `orc mcp trust` / `orc ext trust` locally.
- Once trusted, plugin runs silently (default behavior).
- Untrusted plugins are skipped with a warning.

**On plan validation:**
- If a plan references an untrusted server or extension, `orc propose` / `orc run` fails with a clear error.
- Developer must `orc mcp trust` or `orc ext trust` first, then retry.

**On CI/CD:**
- `.orc/trust.json` must be provisioned per environment (not committed).
- Add to `.gitignore` automatically.
- Each CI worker grants trust via environment-specific setup.

---

## Prerequisites

- ✓ Migrations 001–007 completed (M2 + M3 foundation)
- ✓ `.orc/config.json` exists (from `orc init`)
- ✓ Backup of `.orc/` directory
- ✓ Git configured in the repo (to update `.gitignore`)

---

## Migration Procedure

### Step 1: Create `.gitignore` Entry

Trust should never be committed. Add it:

```bash
# Ensure .orc/trust.json is in .gitignore
echo ".orc/trust.json" >> .gitignore

# Verify it's not already committed (it shouldn't be in M3+)
git status .gitignore
```

**Expected output:**
```
.gitignore
  modified:   .gitignore (added ".orc/trust.json")
```

### Step 2: Understand the Config Structure

Review your `.orc/config.json`. After M3, it looks like:

```json
{
  "projectId": "abc123",
  "skillsDir": "vault/skills",
  "mcpServers": {
    "web-search": {
      "command": "npx",
      "args": ["mcp-server-web"],
      "env": {}
    },
    "github": {
      "command": "node",
      "args": ["./mcp-servers/github.js"],
      "env": {
        "GITHUB_TOKEN": "$GITHUB_TOKEN"
      }
    }
  },
  "extensions": [
    "./extensions/custom-strategy.ts",
    "./extensions/monitoring-hook.ts"
  ]
}
```

**Note:** This is shareable and should be committed. Secrets like `GITHUB_TOKEN` use `$VAR` syntax (resolved from env at runtime, never stored).

### Step 3: Initialize the Trust Store

Create `.orc/trust.json` with no grants initially:

```bash
# Create empty trust store (0600 permissions for security)
mkdir -p .orc
cat > .orc/trust.json << 'EOF'
{
  "mcp": [],
  "extensions": []
}
EOF
chmod 600 .orc/trust.json

# Verify it exists and is not world-readable
ls -l .orc/trust.json
# Should show: -rw------- (mode 0600)
```

**Expected output:**
```
-rw------- 1 user group 32 Jul 17 12:00 .orc/trust.json
```

### Step 4: Grant Trust to MCP Servers

For each MCP server declared in `.orc/config.json`, grant trust:

```bash
# List declared servers
orc mcp list

# Output:
#   web-search (untrusted)
#   github (untrusted)

# Trust the web-search server
orc mcp trust web-search

# Verify it's now trusted
orc mcp list

# Output:
#   web-search (trusted)
#   github (untrusted)

# Trust github
orc mcp trust github
```

**What happens:**
- `orc mcp trust <id>` appends the server ID to `.orc/trust.json`.
- Once trusted, running `orc mcp tools <id>` spawns the server without a vetting prompt.

**Verification:**
```bash
cat .orc/trust.json

# Output:
# {
#   "mcp": ["web-search", "github"],
#   "extensions": []
# }
```

### Step 5: Grant Trust to Extensions

For each extension declared in `.orc/config.json`, grant trust:

```bash
# List declared extensions
orc ext list

# Output:
#   extensions/custom-strategy.ts (untrusted)
#   extensions/monitoring-hook.ts (untrusted)

# Trust the first extension
orc ext trust extensions/custom-strategy.ts

# Verify
orc ext list

# Output:
#   extensions/custom-strategy.ts (trusted)
#   extensions/monitoring-hook.ts (untrusted)

# Trust the second
orc ext trust extensions/monitoring-hook.ts
```

**Verification:**
```bash
cat .orc/trust.json

# Output:
# {
#   "mcp": ["web-search", "github"],
#   "extensions": [
#     "extensions/custom-strategy.ts",
#     "extensions/monitoring-hook.ts"
#   ]
# }
```

### Step 6: Validate Configuration

Now that trust is set up, run a validation to ensure everything is wired correctly:

```bash
# Test that plugins load without errors
orc ext list

# Output:
#   extensions/custom-strategy.ts (loaded, id: custom-strategy)
#   extensions/monitoring-hook.ts (loaded, id: monitoring-hook)

# Test that MCP servers can be queried
orc mcp tools web-search

# Output:
#   web_search (search the web)
#   get_page (fetch a page body)

# Test that skills are indexed
orc skills

# Output:
#   Index scan found X skills
#   skill-1 (✓) description here
#   ...
```

### Step 7: Test with a Plan

Create and approve a plan that uses the newly-trusted plugins:

```bash
# Create a task that might use MCP tools or skills
orc new "Search the web for Python 3.12 release notes"

# Review and approve
orc review

# Run it
orc run <task-id>

# Verify:
#   - No "untrusted server" errors
#   - MCP tools available to the model
#   - Execution completes
```

**If you see "untrusted server" error:**
```
Error: step validation failed: toolRefs references untrusted server 'web-search'
  Run: orc mcp trust web-search
```

Simply trust the server and retry:
```bash
orc mcp trust web-search
orc run <task-id>
```

### Step 8: Set Up Team Sharing

If you're sharing the repo with teammates:

1. **Commit `.orc/config.json`** with plugin declarations.
2. **Add `.orc/trust.json` to `.gitignore`** (already done in Step 1).
3. **Distribute setup instructions** to teammates:

```markdown
## First-Time Setup for Plugins

After cloning:

```bash
# Grant trust to all plugins declared in .orc/config.json
orc mcp list   # See what's declared
orc mcp trust web-search
orc mcp trust github

orc ext list   # See what's declared
orc ext trust extensions/custom-strategy.ts
orc ext trust extensions/monitoring-hook.ts

# Verify
orc skills
orc mcp tools web-search
```

---

## Configuration Reference

### MCP Server Config (in `.orc/config.json`)

```json
{
  "mcpServers": {
    "server-id": {
      "command": "executable-or-npm-package",
      "args": ["--arg1", "value1"],
      "env": {
        "SECRET_KEY": "$SECRET_ENV_VAR",
        "PLAIN_VALUE": "literal-string"
      }
    }
  }
}
```

**Fields:**
- `command`: Path to executable or npm package (resolved via PATH / local node_modules).
- `args`: Optional arguments passed to the executable.
- `env`: Optional environment variables. Values starting with `$` are resolved from the orc process environment at spawn time; if unset, a warning is logged and the var is omitted.

**Example: Web search server**
```json
{
  "mcpServers": {
    "web-search": {
      "command": "npx",
      "args": ["mcp-server-web"],
      "env": {}
    }
  }
}
```

### Extension Config (in `.orc/config.json`)

```json
{
  "extensions": [
    "path/to/extension.ts",
    "another/extension.ts"
  ]
}
```

**Path resolution:**
- Relative: resolved from `.orc/config.json` directory.
- Absolute: used as-is.

**Extension file format:**
```typescript
// extensions/my-strategy.ts
export default {
  id: 'my-strategy',
  async activate(api: ExtensionApi) {
    api.registerProvider('my-provider', myProvider);
    api.on('session_start', () => console.log('Session started'));
  }
};
```

### Trust Store Structure (`.orc/trust.json`, never committed)

```json
{
  "mcp": ["server-id-1", "server-id-2"],
  "extensions": [
    "path/to/extension.ts",
    "another/extension.ts"
  ]
}
```

**Format:**
- `mcp`: Array of server IDs to trust.
- `extensions`: Array of extension paths to trust.
- Both empty arrays = all plugins untrusted (default).

---

## Testing & Validation

### Test 1: Untrusted Server Behavior

```bash
# Declare a server in config but don't trust it
cat >> .orc/config.json << 'EOF'
,
"mcpServers": {
  "untrusted-example": {
    "command": "echo",
    "args": ["hello"]
  }
}
EOF

# Try to use it in a plan
orc new "Use the untrusted server"
orc propose  # Should fail validation
# Output: Error: toolRefs references untrusted server 'untrusted-example'

# Trust it and retry
orc mcp trust untrusted-example
orc propose  # Should succeed
```

### Test 2: Untrusted Extension Behavior

```bash
# Create an extension
mkdir -p extensions
cat > extensions/test.ts << 'EOF'
export default {
  id: 'test',
  async activate(api) {
    console.log('Test extension activated');
  }
};
EOF

# Declare it in config
echo '  "extensions": ["extensions/test.ts"]' >> .orc/config.json

# List without trusting
orc ext list
# Output: extensions/test.ts (untrusted) — not loaded

# Trust it
orc ext trust extensions/test.ts

# Verify it's loaded
orc ext list
# Output: extensions/test.ts (loaded, id: test)
```

### Test 3: Team Setup Simulation

```bash
# Simulate a fresh checkout (remove local trust)
rm .orc/trust.json

# Try to run a plan that uses plugins
orc run <task-id>
# Output: Error: plan validation failed (untrusted plugin refs)

# Follow the setup instructions
orc mcp trust web-search
orc ext trust extensions/my-strategy.ts

# Now it works
orc run <task-id>
# Output: [✓] Task completed
```

### Test 4: Permissions Verification

```bash
# Trust store should only be readable by the owner
ls -l .orc/trust.json
# Output: -rw------- (mode 0600)

# World-readable = security issue
chmod 644 .orc/trust.json  # ✗ BAD
ls -l .orc/trust.json
# Output: -rw-r--r-- (mode 0644) ← WARNING!

# Fix it
chmod 600 .orc/trust.json
```

---

## Rollback Procedure

If something goes wrong with the trust setup:

### Option 1: Revoke Specific Grants

```bash
# Edit .orc/trust.json manually
cat .orc/trust.json

# Remove entries from the arrays
nano .orc/trust.json

# Example: remove 'web-search' from mcp array
```

**Or use the CLI (if available):**
```bash
# (This command may not exist in M3; use manual edit for now)
# orc mcp untrust web-search
```

### Option 2: Reset All Trusts

```bash
# Delete and recreate empty trust store
rm .orc/trust.json
cat > .orc/trust.json << 'EOF'
{
  "mcp": [],
  "extensions": []
}
EOF
chmod 600 .orc/trust.json

# Re-grant trusts as needed
orc mcp trust web-search
orc ext trust extensions/my-extension.ts
```

### Option 3: Revert to Pre-M3

```bash
# If M3 migration caused issues
git checkout m2
bun install
# Plugins won't load (expected in M2)
```

---

## Known Issues & Caveats

### 1. Trust Store Permissions on Windows

**Issue:** Windows doesn't have Unix file permissions (`0600`).

**Workaround:** On Windows, use Windows ACLs to restrict access:
```powershell
# PowerShell: restrict .orc/trust.json to the current user
icacls ".orc\trust.json" /inheritance:r /grant:r "%USERNAME%:F"
```

### 2. Environment Variable Resolution at Spawn Time

**Issue:** MCP server env vars are resolved when the server is spawned, not when config is loaded.

**Implication:**
```json
{
  "mcpServers": {
    "github": {
      "env": {
        "GITHUB_TOKEN": "$GITHUB_TOKEN"
      }
    }
  }
}
```

If `GITHUB_TOKEN` is unset at the time `orc mcp tools github` is run, you'll get a warning:
```
Warn: environment variable GITHUB_TOKEN is not set
```

**Solution:** Set the env var before running:
```bash
export GITHUB_TOKEN="ghp_..."
orc mcp tools github
```

### 3. Path Resolution for Extensions

**Issue:** Extension paths are resolved relative to `.orc/config.json`, not the current directory.

**Example:**
```bash
# If .orc/config.json has:
# "extensions": ["../extensions/my-ext.ts"]

# And you're in project-root/, the path resolves to:
# project-root/../extensions/my-ext.ts ← relative to .orc/, not cwd!

# Safest: use absolute paths or paths relative to project root
# "extensions": ["./extensions/my-ext.ts"]
```

### 4. Trust Does Not Cascade

**Issue:** If an extension depends on an MCP server, you must trust both separately.

**Example:**
```json
{
  "mcpServers": {
    "web-search": { ... }
  },
  "extensions": [
    "./extensions/web-agent.ts"  // This extension uses web-search
  ]
}
```

**Setup required:**
```bash
orc mcp trust web-search    # Trust the server
orc ext trust ./extensions/web-agent.ts  # Trust the extension
```

Both grants are needed.

### 5. Trust Persists Across Upgrades

**Issue:** Upgrading orc doesn't clear `.orc/trust.json`.

**Behavior:** Grants remain until explicitly revoked. This is correct (you want trust to persist), but:
- If a declared server is removed from config, the trust entry becomes orphaned (harmless, but messy).
- If you clone a repo with an old trust file (shouldn't happen if `.gitignore` works), you inherit trusts.

**Solution:** Keep `.orc/trust.json` out of version control (already in `.gitignore`).

---

## Verification Checklist

- [ ] `.orc/trust.json` created and mode 0600
- [ ] `.orc/trust.json` added to `.gitignore`
- [ ] All MCP servers listed in config are trusted via `orc mcp trust`
- [ ] All extensions listed in config are trusted via `orc ext trust`
- [ ] `orc mcp list` shows all servers as "trusted"
- [ ] `orc ext list` shows all extensions as "loaded"
- [ ] `orc skills` indexes skills without errors
- [ ] A plan using MCP tools and/or extensions can be proposed and run
- [ ] Untrusted server/extension causes clear validation error
- [ ] Team setup instructions documented and tested

---

## Next Steps

1. **Read:** [Migration Guide: Plan Schema Updates](009-m3-plan-schema-toolrefs.md) — freeze tool surface at plan time
2. **Read:** [Migration Guide: MCP Server Integration](012-m3-mcp-server-integration.md) — server lifecycle and tool resolution
3. **Deploy:** Set up CI/CD to provision `.orc/trust.json` in each environment
4. **Document:** Add plugin setup to team onboarding
5. **Monitor:** Check `.orc/config.json` diffs to catch new undeclared plugins

---

## Related Documentation

- [M3 Plugins Design Spec](../superpowers/specs/2026-07-17-m3-plugins-design.md) — §3 Decision D3
- [Plugin Host Integration Migration](007-m3-plugin-host-integration.md) — Plugin loading architecture
- [MCP Server Integration Migration](012-m3-mcp-server-integration.md) — Server lifecycle, tool resolution
- [Extension Manifest Migration](010-m3-extension-manifest.md) — Extension authoring
- [GLOSSARY.md](../GLOSSARY.md) — `trust`, `MCP server`, `extension`, `plugin tier`

---

*Last updated: 2026-07-17 (Phase 3.2)*
