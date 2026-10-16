# packages/cli/src/auto-heal.test.ts

## Facts
- auto-heal.test.ts's 'sweepSpec' describe block pins the exact wording of sweepSpec's returned instructions with toContain assertions (e.g. the folder-anchor rule sentence, the listed-id/location format, the cap-and-count-the-rest behavior for more than SWEEP_LISTED_IDS suspects); a new instruction sentence added to sweepSpec must get its own toContain assertion here to be pinned, following the same pattern as the existing folder-anchor-rule test. {c1ery8eh @packages/cli/src/auto-heal.test.ts @packages/cli/src/auto-heal.ts#sweepSpec #auto-heal #test}
