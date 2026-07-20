// Bun HTML imports (full-stack Bun.serve routes): the import is an opaque bundle handle.
declare module '*.html' {
  const bundle: import('bun').HTMLBundle
  export default bundle
}
