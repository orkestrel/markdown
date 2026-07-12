# PROPOSAL: `@orkestrel/guide`

> A parity checker for `@orkestrel` guides. Any package installs it as a devDependency and runs it against its `guides/` folder to prove — mechanically, in CI — that every guide is in **bijection** with the code it documents. Built on `@orkestrel/markdown` (the parsing engine) and `@orkestrel/contract` (the report/guard machinery).

## 1. Motivation & doctrine — AGENTS §22 made executable

AGENTS §22 declares docs to be *enforced contracts*, not comments: every backticked API in a guide resolves to a real export, every public export is documented, every behavioral interface's `## Methods` table lists exactly its call-signature members, each implementing class exposes exactly its interface's methods, and a guide scopes parity to its concept's source. Today that contract is asserted by hand-written, per-repo parity tests. `contract.md` even spells the machine-checkable spec out as its `## Contract` invariants 1 (surface bijection, both directions) and 6 (method bijection + class-no-extra-surface) — but `markdown.md` has **no** `## Contract` section at all. The enforcement is real but bespoke, duplicated, and asymmetric across repos.

`@orkestrel/guide` turns §22 into one reusable engine. It reads a guide as data, reflects the source as truth, and reports every drift as a typed `Finding` with a stable exit code. The doctrine: **a guide is a claim about code; the checker is the proof.** Drift fails CI — that is the system working (§22), not a test to suppress.

## 2. The guide-format contract (normative)

The checker enforces a structural contract every conforming guide MUST satisfy. This is the guide anatomy both existing repos already share, promoted to a spec.

**Guide anatomy** (`guides/src/<name>.md`), in order:

1. `# Title` — a single H1.
2. **Summary** — one blockquote (`>`) immediately after the title, ending with `Source:` + `barrel` pointers.
3. `## Surface` — one or more H3 subsections; each H3 is either a backticked identifier heading (a documented class/entity) OR a category (`### Types`, `### Helpers`, …) followed by **one table** whose **first column** is a backticked identifier and whose **second column** is a `Kind` ∈ {`type`, `interface`, `const`, `function`}.
4. `## Methods` — one H4 `` #### `InterfaceName` `` per behavioral interface, each followed by one `| Method | Returns | Behavior |` table.
5. **Prose sections** — free-form domain explanation (unconstrained).
6. `## Patterns` — one or more ` ```ts ` fenced blocks, executable/typecheckable.
7. `## Tests` — bullet list of relative links to test files, with coverage notes.
8. `## Contract` — the numbered parity invariants (REQUIRED for any guide that has a `## Methods` section; see C6 for the severity timeline).
9. `## See also` — links to `AGENTS.md`, the guides `README.md`, and any dependency guides.

**Manifest format** (`guides/README.md`) — the machine-readable map:

- A `## By concept` table `| Concept | Spec | Source | Tests |` — each row maps a guide (`Spec`) to its source directory (`Source`) and tests directory (`Tests`). This is the run manifest: one row = one check target.
- A `## By directory` reverse table `| Directory | Guide |`.
- An optional `## Dependency reference` section whose links cite sibling guides documenting runtime-dependency packages (e.g. `markdown/guides/README.md` cites `contract.md`). These supply the **attributed-externals** allow-set for C4.

Convention over configuration: the manifest + the anatomy are the entire contract. There is no config file. The one escape hatch is the dependency-reference section (which externals a guide may legitimately name) — itself a documented, checkable convention, not a private config.

## 3. Package identity & dependencies

- **Name:** `@orkestrel/guide` · **Repo:** `orkestrel/guide` · ESM-only · `node >=24` · house template layout, core + server surfaces + a `bin/`.
- **Runtime deps:**
  - `@orkestrel/markdown` — the guide/manifest parsing engine. `new Markdown(source)` + `walk`/`filter`/`find` + node guards + `flattenText` extract the structured view over the AST. Pure, core-safe.
  - `@orkestrel/contract` — the report layer. `ContractShape` + `createContract` compile the `Finding`/`Report`/`Summary` types into `is`/`parse`/`schema`/`generate` bundles; its guard combinators back the from-unknown validators. Pure, core-safe.
- **Peer dep:** `typescript` (`>=6 <7`). Source reflection uses the **consumer's** compiler and the **consumer's** `tsconfig.json`, so the checker must bind the same TypeScript the consumer builds and type-checks with. Pinning our own copy would risk reflecting a different language version than the one the guide's code is written against. A peer dep (with a matching `devDependency` here for our own tests) is the correct shape: the consumer owns the compiler, we consume it. Range `>=6 <7` because the compiler API surface we touch (`getExportsOfModule`, `getDeclaredTypeOfSymbol`, `getCallSignatures`, `parseJsonConfigFileContent`) is stable within a major but not guaranteed across one.

## 4. Architecture

Two surfaces, split by the strict-core rule: `core` is pure ECMAScript and may not touch a host global; the TypeScript compiler API and `node:fs` need Node, so they live in `server`. Core parses strings and runs pure check algorithms; server does all I/O and reflection and injects it into core through an interface.

```
src/core/     pure engine: guide parsing, check algorithms, report model
src/server/   node: TS-compiler reflection, fs loaders, the CLI runner
bin/guide.ts  the `guide` executable entrypoint
```

### `src/core` (pure, published as `@orkestrel/guide/core`)

| File            | Holds                                                                                                      |
| --------------- | ---------------------------------------------------------------------------------------------------------- |
| `types.ts`      | **source of truth** — every interface/type below                                                            |
| `constants.ts`  | `CHECKS`, `REQUIRED_SECTIONS`, `SURFACE_KINDS`, `LANGUAGE_LITERALS`, `EXIT_OK/FINDINGS/USAGE/INTERNAL`       |
| `helpers.ts`    | pure leaves — `diffSets`, `flattenCell`, `identifiers` (tokenizer), `resolveToken`, `normalizeLink`          |
| `parsers.ts`    | guide/manifest extraction pipeline over the Markdown AST (the structured spine)                              |
| `validators.ts` | `isFinding`/`isReport`/`isSeverity`/`isCheck`/`isManifest` guards (from-unknown, via contract combinators)   |
| `shapers.ts`    | `findingShape`, `severityShape`, `reportShape`, `summaryShape`, `manifestEntryShape` (`ContractShape`)       |
| `Guide.ts`      | the `Guide` class (stateful structured view over a guide)                                                    |
| `Checker.ts`    | the `Checker` class — `run()` composes the checks over a `Guide` + injected `SourceInterface`                |
| `factories.ts`  | `createGuide`, `createChecker`, `createFindingContract`, `createReportContract`, `createSummaryContract`    |
| `index.ts`      | the sole core barrel                                                                                         |

Homes follow §5 kind-purity: **guide-structure extraction** is a parsing pipeline → `parsers.ts` (mirroring how `@orkestrel/markdown` uses `parsers.ts` for its block/inline spine); its pure scanning leaves → `helpers.ts`. The **eight check algorithms** are the `Checker`'s behavior — genuine orchestration comparing two enumerations and emitting findings — so they are `#` private methods on `Checker` (§7), never file-local functions; their extractable leaves (set diff, token resolution, kind mapping) live in `helpers.ts`, keeping `Checker` a real composition, not a hollow delegate. **Report shapes** → `shapers.ts`, compiled in `factories.ts`.

### `src/server` (node, published as `@orkestrel/guide`)

| File           | Holds                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------- |
| `types.ts`     | server-local: `SourceOptions`, `RunnerOptions`                                                   |
| `constants.ts` | `DEFAULT_TSCONFIG`, `DEFAULT_MANIFEST` path conventions                                          |
| `helpers.ts`   | reflection leaves — `symbolToExport`, `interfaceMembers`, `classMembers`, `loadFile`, `format`   |
| `Source.ts`    | the `Source` class — implements `SourceInterface`: TS-compiler reflection + fs + diagnostics     |
| `Runner.ts`    | the `Runner` class — manifest-driven multi-guide orchestration                                   |
| `factories.ts` | `createSource`, `createRunner`                                                                   |
| `index.ts`     | the sole server barrel                                                                           |

Dependency direction: server imports core; core never imports server. `Source` (server) implements `SourceInterface` (declared in core `types.ts`), so core's checks depend only on the interface — the dependency-inversion seam that lets pure core call `source.exists(...)` / `source.members(...)` without importing `node:fs` or `typescript`. Per §6 neither barrel re-exports the other's symbols; a consumer imports the value API from `@orkestrel/guide` and report **types** from `@orkestrel/guide/core`.

### Public API sketch

```ts
// ---- report model (core/types.ts) ----
type Severity = 'error' | 'warning' | 'info'
type Check = 'surface' | 'methods' | 'kind' | 'resolve' | 'link' | 'structure' | 'tests' | 'patterns'
interface Finding {                       // one drift, plain data (no behavior)
	readonly check: Check                 // which check produced it
	readonly severity: Severity           // error fails CI; warning/info do not
	readonly guide: string                // guide path it belongs to
	readonly message: string              // human-readable summary
	readonly identifier?: string          // the offending symbol/token, when applicable
	readonly location?: string            // section / line pointer
}
interface Report {                        // one guide's outcome
	readonly guide: string
	readonly findings: readonly Finding[]
	readonly passed: boolean              // no error-severity findings
}
interface Summary {                       // a whole run
	readonly reports: readonly Report[]
	readonly errors: number               // total error-severity findings
	readonly warnings: number
	readonly passed: boolean
}

// ---- reflected source truth (core/types.ts; implemented in server) ----
type ExportKind = 'type' | 'interface' | 'const' | 'function' | 'class'
interface Export { readonly name: string; readonly kind: ExportKind; readonly implements?: readonly string[] }
interface Member { readonly name: string; readonly callable: boolean }  // callable = a method; else a data member
interface Diagnostic { readonly message: string; readonly line: number }
interface SourceInterface {
	exports(): readonly Export[]                    // every barrel export incl. type-only
	export(name: string): Export | undefined        // one export by name
	members(name: string): readonly Member[]         // an interface's or class's public members
	exists(path: string): boolean                    // fs existence of a resolved relative path
	diagnose(fence: string): readonly Diagnostic[]   // typecheck one ```ts pattern fence
}

// ---- the structured guide view (core/types.ts) ----
interface SurfaceEntry { readonly name: string; readonly kind: ExportKind }
interface MethodGroup { readonly interface: string; readonly methods: readonly string[]; readonly data: readonly string[] }
interface Claim { readonly token: string; readonly hard: boolean; readonly location: string }
interface GuideInterface {
	readonly title: string                 // the H1 text
	readonly summary: string               // the blockquote summary, flattened
	sections(): readonly string[]          // ## heading names, in order
	surface(): readonly SurfaceEntry[]     // every Surface-table identifier + Kind
	methods(): readonly MethodGroup[]      // one per documented behavioral interface
	claims(): readonly Claim[]             // every backticked token, tagged hard vs prose
	patterns(): readonly string[]          // ```ts fence bodies under ## Patterns
	tests(): readonly string[]             // relative test links under ## Tests
	links(): readonly string[]             // every relative link target in the guide
}

// ---- the check engine (core/types.ts) ----
interface CheckerInterface { run(): Report }             // runs the enabled checks over one guide
interface RunnerInterface { run(): Promise<Summary> }    // runs every manifest row (server)

// ---- factories ----
function createGuide(source: string): GuideInterface
function createChecker(options: CheckerOptions): CheckerInterface   // { guide, source, checks?, patterns? }
function createSource(options: SourceOptions): SourceInterface      // { tsconfig, root } (server)
function createRunner(options: RunnerOptions): RunnerInterface      // { root, manifest?, checks?, patterns? } (server)
```

`CheckerOptions`: `{ guide: GuideInterface; source: SourceInterface; checks?: readonly Check[]; patterns?: 'off' | 'typecheck' | 'execute' }` — `checks` scopes which checks run (default all), enabling per-check fixture testing.

## 5. The check catalog

Each check is deterministic; a passing check emits zero findings; every failure is a `Finding`. `guide`/`location` fields are elided from payloads below for brevity.

**C1 — Surface bijection (`surface`).** DOC = the identifiers in every `## Surface` table's first column ∪ every backticked `## Surface` H3 heading. SRC = `source.exports()` names (the Source-dir barrel, incl. type-only). Assert `DOC == SRC` both directions. Payload: `{ check: 'surface', severity: 'error', direction: 'doc→source' | 'source→doc', identifier }` — e.g. `{ direction: 'source→doc', identifier: 'flattenText', message: 'export `flattenText` is undocumented' }`.

**C2 — Methods bijection (`methods`).** For each `MethodGroup` (interface `I`): DOC_M = its Methods-table `Method` cells; SRC_M = `source.members(I)` filtered to `callable`. Assert `DOC_M == SRC_M` both directions; assert no non-`callable` member of `I` appears in DOC_M (data members belong in Surface). Then find implementer `X` (convention `I = XInterface → X`, verified by `source.export('X').implements` including `I`) and assert `source.members('X')` callable set `== SRC_M` (no extra public surface). Payload: `{ check: 'methods', severity: 'error', interface, identifier: member, direction, class? }`.

**C3 — Kind agreement (`kind`).** For each `SurfaceEntry {name, kind}`, assert `source.export(name).kind == kind`. Payload: `{ check: 'kind', severity: 'error', identifier, message: 'documented `const`, reflected `function`' }`.

**C4 — Backtick resolution (`resolve`).** `guide.claims()` tags each backticked token. **Hard claims** — Surface first-column cells, Methods `Method` cells, backticked H3/H4 headings — must resolve to a real export/member (already covered by C1/C2; C4 also covers hard tokens in non-first cells, e.g. a `Shape` column naming another type). **Prose claims** — every other backtick — are resolved only if identifier-shaped (the `identifiers` tokenizer splits a fenced expression like `T | undefined` into `T`, `undefined`, discards operators/punctuation). Resolution order, first match wins:

1. a name in `source.exports()`;
2. a documented field/member name (any Surface `Shape` field or Methods member of this guide);
3. an **attributed external** — a name documented in a dependency-reference guide's surface (e.g. `createContract`, `Guard` via `contract.md`);
4. a `LANGUAGE_LITERALS` token (`true`/`false`/`undefined`/`null`/`string`/`number`/`boolean`/`readonly`/`Promise`/`Generator`/`ReadableStream`/…).

No match → `{ check: 'resolve', severity: 'error', identifier: token, message: 'unresolved backticked identifier' }`. C4 runs at `warning` in v0.1 (tiers 2 + 4 only, no reflection), promoted to `error` once tiers 1 + 3 land.

**C5 — Link integrity (`link`).** For each `guide.links()` target, resolve against the guide's directory and assert `source.exists(path)`. Payload: `{ check: 'link', severity: 'error', identifier: href, message: 'broken link → missing file' }`.

**C6 — Structure lint (`structure`).** Assert the §2 anatomy: title, summary blockquote, `## Surface` (each H3 well-formed: category-H3 → a first-column-backticked, Kind-second table), `## Methods` (H4 per interface + `| Method | Returns | Behavior |` table), `## Patterns` (≥1 ts fence), `## Tests`, `## See also`, and `## Contract` **when a `## Methods` section exists**. The `## Contract` requirement resolves the markdown.md ↔ contract.md asymmetry: it is `warning` in v0.1 (so markdown.md's absence is surfaced, not fatal) and `error` in v1 once adopted. Payload: `{ check: 'structure', severity, identifier: section, message: 'required section `## Contract` missing' }`.

**C7 — Tests existence (`tests`).** Each `guide.tests()` link exists on disk (`source.exists`). Opt-in **mirror** sub-check (`warning`): every source file in the Source dir except non-behavioral kinds (`types.ts`/`constants.ts`/`index.ts`/`errors.ts`, §16) has a linked test. Payload: `{ check: 'tests', severity, identifier: path }`.

**C8 — Patterns executability (`patterns`).** For each `guide.patterns()` fence, `source.diagnose(fence)` typechecks it under the consumer's tsconfig, with `@src/core` resolving to the Source-dir barrel (the fence is added to the program as a virtual `.ts` file; diagnostics filtered to it). Default tier `typecheck` when a tsconfig is available, else `off`; `execute` is deferred (a parity checker proves the examples *compile against current signatures* — deterministic and hermetic; running them needs a runtime and side-effect isolation, out of scope for v1). Payload: `{ check: 'patterns', severity: 'error', location: 'pattern #2', message: diagnostic }`.

## 6. CLI & vitest integration

**Bin `guide`.** Invocations: `guide` (check every `## By concept` row of the nearest `guides/README.md`), `guide <guide.md>` (one guide), flags `--patterns=off|typecheck|execute`, `--tests=mirror`, `--json`, `--quiet`. Manifest discovery walks up from cwd to the first `guides/README.md`, parses its concept table, and for each row builds a `Guide` (from the loaded `Spec` file) + a `Source` (from the consumer tsconfig + the `Source` dir), runs a `Checker`, and aggregates into a `Summary`.

```
$ guide
guide  markdown  src/markdown.md
  ✖ surface   export `flattenText` is undocumented                     (source→doc)
  ✖ methods   `MarkdownInterface.walk` documented, not on interface    (doc→source)
  ⚠ structure required section `## Contract` missing
  12 checks · 2 errors · 1 warning

Summary: 1 guide · 2 errors · 1 warning  → exit 1
```

**Exit-code contract (stable for CI):** `0` no errors (warnings allowed); `1` ≥1 error finding; `2` usage error (manifest/guide/tsconfig not found, empty manifest); `3` internal error (compiler failed to build a program). Constants `EXIT_OK/FINDINGS/USAGE/INTERNAL`.

**The blessed vitest pattern** a consumer writes (`tests/guides/parity.test.ts`, a Node test project):

```ts
import { createRunner } from '@orkestrel/guide'
import type { Finding } from '@orkestrel/guide/core'
import { describe, expect, it } from 'vitest'

const summary = await createRunner({ root: process.cwd() }).run()

describe('guide parity', () => {
	for (const report of summary.reports) {
		it(`${report.guide} has no parity errors`, () => {
			const errors: readonly Finding[] = report.findings.filter((f) => f.severity === 'error')
			expect(errors.map((e) => e.message)).toEqual([])
		})
	}
})
```

## 7. How it uses `@orkestrel/markdown`

`Guide` wraps `new Markdown(source)` and, in its constructor, runs the `parsers.ts` extraction once, caching the structured model its accessors project. The AST is flat (headings and following blocks are siblings under `document.children`), so extraction is an ordered walk that tracks the current heading context.

```ts
// parsers.ts — attach each table to the H2/H3 it follows (Surface extraction)
export function collectSurface(markdown: MarkdownInterface): readonly SurfaceEntry[] {
	const out: SurfaceEntry[] = []
	let inSurface = false
	for (const node of markdown.document.children) {
		if (isHeadingNode(node)) inSurface = node.level === 2 ? flattenText(node) === 'Surface' : inSurface
		if (inSurface && isTableNode(node)) out.push(...surfaceRows(node))
	}
	return out
}
```

```ts
// helpers.ts — a table cell's identifier is its flattened text (codeSpan value drops backticks)
export function flattenCell(cell: readonly InlineNode[]): string {
	return flattenText({ element: 'paragraph', children: cell }).trim()
}
```

```ts
// parsers.ts — harvest every prose backtick as a claim token
export function collectClaims(markdown: MarkdownInterface): readonly Claim[] {
	return markdown.filter(isCodeSpanNode).map((node) => ({ token: node.value, hard: false, location: '' }))
	// the ordered pass re-tags first-column/Method/heading tokens as hard: true
}
```

Manifest parsing reuses the same primitives: `parseManifest` finds the `## By concept` table and maps each row's `[Concept, Spec, Source, Tests]` cells via `flattenCell` + link-href extraction.

## 8. How it reflects source truth

`Source` (server) is the only place the TypeScript compiler API is used:

1. **Program from the consumer's tsconfig.** `ts.readConfigFile` + `ts.parseJsonConfigFileContent` → `{ options, fileNames }`; `ts.createProgram(fileNames, options)` → `program.getTypeChecker()`. Reflection targets the consumer's **source** barrel (`src/core/index.ts`), not `dist` — parity checks source truth, and the consumer's tsconfig path alias (`@src/core`) already points there.
2. **Barrel enumeration incl. type-only.** `checker.getExportsOfModule(moduleSymbol)` returns every exported symbol — crucially **including interfaces and type aliases**, which are invisible to runtime `import` reflection. This is why the compiler API is mandatory: `export type * from './types.js'` members only appear here. `symbolToExport` maps `symbol.flags` → `ExportKind` (`Interface`/`TypeAlias`/`Function`/`Class`/`BlockScopedVariable`→`const`).
3. **Interface members.** `checker.getDeclaredTypeOfSymbol(sym).getProperties()`; a member is `callable` iff `checker.getTypeOfSymbolAtLocation(member, decl).getCallSignatures().length > 0` — exactly §22's method-vs-data-member distinction.
4. **Class public members.** The class symbol's members minus `#`-private identifiers (the `private` keyword is banned, §1); heritage via `implements` clauses populates `Export.implements`.
5. **Diagnostics for C8.** A virtual `SourceFile` per fence is added to a throwaway program sharing the consumer's options; `getPreEmitDiagnostics` filtered to that file.

**Fallbacks/limits.** No consumer tsconfig or a program that fails to build → the reflection-dependent checks (C1/C2/C3/C8) SKIP with an `info` finding rather than emitting false errors; the markdown-and-fs checks (C4-tiers-2/4, C5, C6, C7) still run. A missing Source barrel is a usage error (exit 2). Compiler-version skew is contained by the peer range (§3) and by touching only stable checker APIs.

## 9. Testing strategy for `@orkestrel/guide` itself

- **Fixture guides** (`tests/fixtures/`): a *good* guide paired with a tiny fixture module (one interface + its class, one function, one const, one type + a matching tsconfig) that passes every check; plus one *broken* fixture per failure mode (undocumented export, extra class method, wrong Kind, unresolved backtick, broken link, missing `## Contract`, missing test file, type-erroring pattern) — each isolates one check's error path, driven through `createChecker({ checks: ['…'] })`.
- **Unit tests** mirror source (§16): `tests/src/core/parsers.test.ts` (guide/manifest extraction), `helpers.test.ts` (tokenizer, set diff, resolution leaves), `validators.test.ts`, `shapers.test.ts` + `factories.test.ts` (contract round-trips), `Guide.test.ts`, `Checker.test.ts` (each check via fixtures). Server: `tests/src/server/Source.test.ts` (reflection against the fixture tsconfig — type-only enumeration, call-signature detection, class heritage), `Runner.test.ts` (manifest run + exit codes). All deterministic, no network, seeded generators for report fixtures.
- **Self-dogfooding** (acceptance criterion): the package ships its own `guides/src/guide.md` documenting `GuideInterface`/`SourceInterface`/`CheckerInterface`/`RunnerInterface` (with `## Methods` + `## Contract`), and `tests/src/server/self.test.ts` runs `createRunner({ root })` against this repo asserting zero error findings. The checker must pass its own checker.

## 10. Adoption plan — `contract` and `markdown` repos

For **both** repos: add `@orkestrel/guide` as a devDependency; add `tests/guides/parity.test.ts` (§6) wired into a Node test project; add `check:guides` (`guide`) to the scripts and to the `prepublishOnly` gate chain after `test`. Run once and reconcile whatever the checker surfaces (undocumented exports, extra class surface, kind drift) — docs or code, per §22.

For **markdown** specifically: add the missing `## Contract` section to `markdown.md` (invariants mirroring contract.md's — surface bijection, method bijection + class-no-extra, guard totality, types-as-source-of-truth, the never-throw/round-trip laws), satisfying C6's Contract requirement before it promotes to `error`. Its `README.md` already carries a `## Dependency reference` citing `contract.md` — formalize that as the C4 attributed-externals source (no edit needed; the checker reads it).

Manifest tweaks: both `## By concept` tables already expose `Spec`/`Source`/`Tests` pointing at the exact dirs the checker resolves (`src/*.md`, `../src/core`, `../tests/src/core`) — machine-readable as-is, no changes required. `contract.md` has no runtime dep, so it needs no dependency-reference section.

## 11. Risks & open questions

**Risks (priority-ordered):**

1. **C4 false positives on prose backticks** — the hardest determinism problem; an over-eager resolver flags legitimate prose and trains authors to suppress. *Mitigation:* strict identifier tokenizer + explicit four-tier resolution order + attributed-externals via dependency guides; ship C4 at `warning` in v0.1 and promote to `error` only after tuning against both real guides.
2. **TS compiler API cost & version skew** — the peer `typescript` is consumer-controlled and the compiler API is not fully stable across versions. *Mitigation:* peer range `>=6 <7`, only stable checker APIs, one `Source` engine, graceful skip (info finding) when a program fails to build.
3. **Core/server purity + source-not-dist targeting** — reflecting the consumer's *source* via *their* tsconfig, from a devDep whose own code is built, while keeping core lib-pure. *Mitigation:* the `SourceInterface` dependency-inversion seam keeps `node`/`typescript` out of core entirely; `Source` takes explicit `{ tsconfig, root }` derived by convention from the manifest + cwd, documented and overridable.

**Open questions (to decide before v1):**

1. **`## Contract` — required or recommended, and the promotion timeline?** Proposal: `warning` in v0.1 → `error` in v1 after markdown.md adopts. Confirm markdown.md must adopt before v1 ships.
2. **C8 execution tier** — is typecheck-only acceptable for v1, with execution deferred? Proposal: yes.
3. **Attributed-externals mechanism** — is resolving against dependency-reference guides sufficient, or is a minimal allow-list escape file warranted despite the no-config stance? Proposal: guides-only; no config file.

## 12. Phased roadmap

- **v0.1 — no-compiler tier.** Core `Guide` + manifest parsing; server fs loaders + `Runner` + `bin/guide`; checks C6 (structure), C5 (link), C7 (tests-existence), C4 (tiers 2 + 4, `warning`). Report model + exit-code contract + report contracts. Self-guide dogfoods these checks. No `typescript` dependency exercised yet.
- **v0.5 — reflection tier.** `Source` (TS compiler API); checks C1 (surface bijection), C2 (methods bijection + class-no-extra), C3 (kind). C4 upgraded to tiers 1 + 3 (real exports + attributed externals).
- **v1.0 — full catalog.** C8 (patterns typecheck), C7 mirror sub-check, C4 + `## Contract` promoted to `error`; `contract` and `markdown` repos adopted and green; report contracts (`shapers.ts` + `factories.ts`) shipped for consumer typing.
- **v1.x — future.** C8 `execute` tier (opt-in, isolated), `--watch` mode, and additional `--json` report consumers.
