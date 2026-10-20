# packages/ui-core/src/views/registry.ts

## Why
- ParamSchemas is a mapped type over N because a plain indexed access resolves to the union of every view's params, which no single view's read accepts and compiled only with a cast (measured). {ladgmrzb @packages/ui-core/src/views/registry.ts#ParamSchemas}
- viewOf skips parsing because a re-parse would deep-copy every answer to re-derive a type the compiler already checked, and it takes the model after the last await since the model is live state coherent only within its tick. {nou350r5 @packages/ui-core/src/views/registry.ts#viewOf}
