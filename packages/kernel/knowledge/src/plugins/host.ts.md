# packages/kernel/src/plugins/host.ts

## Facts
- plugins/host.createPluginHost wires providers, executors, analyzers, skills, hooks, and extensions into one PluginHost whose refValidator checks each plan step's executorRef, provider, isolation tier, skillRefs, and toolRefs against loaded plugins and trust grants. {0ce29qrr @packages/kernel/src/plugins/host.ts#createPluginHost #architecture-current}
