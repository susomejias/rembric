---
name: Bun
description: Use when building, running, testing, or bundling JavaScript/TypeScript applications. Reach for Bun when you need to execute scripts, manage dependencies, run tests, or bundle code for production. Bun is a drop-in replacement for Node.js with integrated package manager, test runner, and bundler.
metadata:
    mintlify-proj: bun
    version: "1.0"
---

# Bun Skill Reference

## Product Summary

Bun is an all-in-one JavaScript/TypeScript runtime and toolkit written in Zig, powered by JavaScriptCore. It replaces Node.js with 4x faster startup times and includes an integrated package manager (`bun install`), test runner (`bun test`), and bundler (`bun build`). Key files: `bunfig.toml` (configuration), `package.json` (scripts and dependencies), `bun.lock` (lockfile). Primary docs: https://bun.com/docs

## When to Use

Use Bun when:
- **Running scripts**: Execute `.ts`, `.tsx`, `.js`, `.jsx` files directly without compilation overhead
- **Managing dependencies**: Install packages 25x faster than npm with `bun install`
- **Running tests**: Execute Jest-compatible tests with TypeScript support via `bun test`
- **Bundling code**: Build optimized bundles for browsers or servers with `bun build`
- **Building HTTP servers**: Create high-performance servers with `Bun.serve()`
- **Replacing Node.js**: Drop-in replacement in existing Node.js projects with minimal changes
- **Monorepo workflows**: Use workspaces and filtering for multi-package projects

## Quick Reference

### Core Commands

| Task | Command | Notes |
|------|---------|-------|
| Run a file | `bun run index.ts` | Supports TS/TSX/JSX out of the box |
| Run a script | `bun run dev` | Executes `package.json` scripts |
| Install deps | `bun install` | Creates `bun.lock` lockfile |
| Add package | `bun add react` | Adds to `package.json` |
| Remove package | `bun remove react` | Removes from `package.json` |
| Run tests | `bun test` | Finds `*.test.ts`, `*.spec.ts` files |
| Build bundle | `bun build ./index.ts --outdir ./out` | Bundles for browser/server |
| Watch mode | `bun --watch run index.ts` | Re-runs on file changes |

### Configuration Files

| File | Purpose | Example |
|------|---------|---------|
| `bunfig.toml` | Bun-specific settings | `[test]`, `[install]`, `[run]` sections |
| `package.json` | Scripts, dependencies, metadata | `"scripts"`, `"dependencies"` |
| `tsconfig.json` | TypeScript compiler options | `"compilerOptions"` |
| `.env` | Environment variables | `FOO=bar` (auto-loaded) |
| `bun.lock` | Lockfile (text format) | Commit to version control |

### Key Bun APIs

```typescript
// HTTP server
Bun.serve({ port: 3000, fetch(req) { return new Response("Hello"); } })

// File I/O
Bun.file(path)           // Read file
Bun.write(path, data)    // Write file

// Environment
process.env.FOO          // Read env var
Bun.env.FOO              // Alias for process.env

// Bundling
await Bun.build({ entrypoints: ["./index.ts"], outdir: "./out" })

// Shell
import { $ } from "bun"
await $`echo hello`
```

## Decision Guidance

### When to Use Bun vs Node.js

| Scenario | Use Bun | Use Node.js |
|----------|---------|-----------|
| New project, greenfield | ✓ | |
| Existing Node.js project | ✓ (drop-in) | If no issues |
| Needs specific Node.js module | | ✓ (check compatibility) |
| Performance critical | ✓ | |
| Team unfamiliar with Bun | | ✓ |

### Bundler: `bun build` vs `bun run`

| Use Case | Command | Notes |
|----------|---------|-------|
| Development, quick iteration | `bun run index.ts` | No bundling, direct execution |
| Production deployment | `bun build ./index.ts --outdir ./out` | Optimized, minified output |
| Browser code | `bun build --target browser` | Default, uses browser exports |
| Server code | `bun build --target bun` | Optimized for Bun runtime |
| Node.js compatibility | `bun build --target node --format cjs` | CommonJS output |

### Package Manager: Installation Strategies

| Strategy | Command | Use Case |
|----------|---------|----------|
| Hoisted (npm-like) | `bun install --linker hoisted` | Traditional flat `node_modules` |
| Isolated (pnpm-like) | `bun install --linker isolated` | Strict dependency isolation |
| Default (new projects) | `bun install` | Isolated for workspaces, hoisted for single packages |

## Workflow

### 1. Initialize a Project
```bash
bun init my-app
# Choose template: Blank, React, or Library
cd my-app
```

### 2. Install Dependencies
```bash
bun install
# Or add specific packages
bun add react
bun add -d typescript @types/react
```

### 3. Configure (if needed)
Create `bunfig.toml` in project root:
```toml
[test]
coverage = true

[install]
optional = true
```

### 4. Write Code
- Create `.ts`, `.tsx`, `.js`, `.jsx` files
- Use `import`/`require` freely (both work)
- Reference `package.json` scripts in `"scripts"` field

### 5. Run Scripts
```bash
bun run dev          # Runs "dev" script from package.json
bun run index.ts     # Runs file directly
bun --watch run dev  # Watch mode
```

### 6. Test
```bash
# Write tests in *.test.ts files
bun test             # Run all tests
bun test --watch     # Watch mode
bun test --coverage  # Generate coverage report
```

### 7. Build for Production
```bash
bun build ./src/index.ts --outdir ./dist --minify
# Or use JavaScript API in build script
```

### 8. Deploy
- Commit `bun.lock` to version control
- Use `bun ci` in CI/CD (equivalent to `bun install --frozen-lockfile`)
- Deploy built artifacts or run with `bun run`

## Common Gotchas

- **Lockfile format**: Bun uses text-based `bun.lock` (not binary `bun.lockb`). Always commit to version control.
- **Node.js compatibility**: Not 100% complete. Check [compatibility page](/runtime/nodejs-compat) for unsupported APIs.
- **Lifecycle scripts**: Bun doesn't run `postinstall` scripts by default for security. Add trusted packages to `trustedDependencies` in `package.json`.
- **Environment variables**: Bun auto-loads `.env` files. Disable with `env = false` in `bunfig.toml` if needed.
- **Module resolution**: `require()` works in ESM files (returns namespace), but prefer `import` for new code.
- **Shebang handling**: `#!/usr/bin/env node` shebangs are respected. Use `bun run --bun` to force Bun execution.
- **TypeScript errors in editor**: Install `@types/bun` and configure `tsconfig.json` with `"lib": ["ESNext"]` and `"moduleResolution": "bundler"`.
- **Bundler output**: Default target is `"browser"`. Use `--target bun` or `--target node` for server code.
- **Test discovery**: Only finds files matching `*.test.ts`, `*_test.ts`, `*.spec.ts`, `*_spec.ts` patterns.
- **Peer dependencies**: Installed by default (unlike npm). Control with `[install] peer = false` in `bunfig.toml`.

## Verification Checklist

Before submitting work with Bun:

- [ ] `bun install` completes without errors
- [ ] `bun run <script>` executes the intended command
- [ ] `bun test` passes all tests (or `bun test --watch` for development)
- [ ] `bun build` produces output without errors
- [ ] `bunfig.toml` is valid TOML (if used)
- [ ] `package.json` has correct `"scripts"` and `"dependencies"`
- [ ] `.env` file is in `.gitignore` (if used)
- [ ] `bun.lock` is committed to version control
- [ ] TypeScript files compile without errors (check editor)
- [ ] No `node_modules` folder committed (use `bun.lock` instead)

## Resources

- **Comprehensive navigation**: https://bun.com/docs/llms.txt
- **Runtime API reference**: https://bun.com/docs/runtime
- **Package manager docs**: https://bun.com/docs/pm/cli/install
- **Bundler documentation**: https://bun.com/docs/bundler
- **Test runner guide**: https://bun.com/docs/test

---

> For additional documentation and navigation, see: https://bun.com/docs/llms.txt