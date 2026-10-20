# packages/cli/src/shipped-skills.ts

## Why
- seedShippedSkills is the one way a project's skills directory comes to exist, called by `orc init` and every test harness, so a harness never resolves skills differently and hides a newly shipped skill that no real project has yet. {e0hoizdq @packages/cli/src/shipped-skills.ts#seedShippedSkills}
