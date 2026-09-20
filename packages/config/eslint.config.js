// Shared ESLint flat config for Rembric workspace packages.
//
// Deliberately empty for now: no package consumes it yet. It will grow during
// the Next.js port with the shared rule set (type-checked typescript-eslint,
// import ordering, no-floating-promises) so each package keeps a one-line
// `eslint.config.js` re-exporting this array. It is not a replacement for the
// repository root config, which keeps linting the whole tree.
// `[{}]` rather than `[]`: ESLint warns on an empty config array, and both lint nothing.
export default [{}];
