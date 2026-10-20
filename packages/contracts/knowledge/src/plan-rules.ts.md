# packages/contracts/src/plan-rules.ts

## Why
- A zone entry must be one glob and a line-broken or whitespace-only entry is refused at write and freeze, because a frozen fence that matches no path would lock steps out of their own files with no repair path. {eofu63c3 @packages/contracts/src/plan-rules.ts#zoneEntryMisuse}
