// Tidemark text-only build: transformers.js hard-requires sharp but only IMAGE pipelines
// call it. The real linux binary crashes at load on Lambda (version-mismatched libvips).
// This stub keeps module resolution alive and makes ANY actual use fail loudly.
// Marker for build verification: TIDEMARK_SHARP_STUB
const die = () => { throw new Error('sharp stubbed out in tidemark text-only build') }
module.exports = new Proxy(die, { get: (t, p) => (p === 'default' ? module.exports : die), apply: die })
