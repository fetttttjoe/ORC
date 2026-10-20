# packages/contracts/src/encoding.ts

## Why
- Double-escaped tool arguments are detected once at the boundary every argument crosses and refused only when long content holds literal \n with no real newline, since \n and \" are legal in source. {s258y59i @packages/contracts/src/encoding.ts#doubleEncodedField}
