# PROPOSAL: `@orkestrel/guide`

> A guides-parity **test helper** for `@orkestrel` packages. A consumer adds it as a devDependency, drops one short test file into `tests/guides/src/parity.test.ts`, wires a vitest `guides` project, and thereafter every guide is proven — mechanically, in CI, as ordinary vitest assertions — to be in **bijection** with the code it documents. No CLI, no runner, no exit-code contract: it is a library of extraction + reflection helpers that your test suite calls. Built on `@orkestrel/markdown`.

## 1. Motivation & doctrine — AGENTS §22 as a vitest suite

AGENTS §22 declares docs to be *enforced contracts*, not comments: every public export is documented, every behavioral interface's `## Methods` table lists exactly its call-signature members, each implementing class exposes exactly those methods, and every relative link resolves. Today that enforcement exists only as convention plus a proven-but-project-bound helper — the earlier terrain project's `setupGuides.ts` — and neither `contract` nor `markdown` runs a parity suite at all yet.

`@orkestrel/guide` promotes that proven helper into one reusable package. The doctrine is unchanged — **a guide is a claim about code; the test is the proof** — but the delivery is deliberately humble: it is not a program you *run*, it is a set of functions your existing test project *imports*. Drift surfaces as a red vitest assertion with an excellent diff (`expect(missing).toEqual([])` → `[ 'function flattenText' ]`), reconciled like any other failing test. This is a direct modernization of terrain's `setupGuides.ts`, ported onto the new stateful `@orkestrel/markdown` API and packaged for reuse.

## 2. The guide-format contract + manifest

The helpers assume the guide anatomy both existing repos already share; no config file, convention only.

**Guide anatomy** (`guides/src/<name>.md`):

1. `# Title` (single H1) and a `>` summary blockquote.
2. `## Surface` — one or more H3 subsections. Each H3 is either a **category** (`### Types`, `### Helpers`, …) followed by one table whose **first column** is a backticked identifier and which carries a **`Kind`** column (`type` / `interface` / `const` / `function` / `class`), OR a **backticked entity heading** (`` ### `Markdown` ``) documenting a class export.
3. `## Methods` — one H4 `` #### `InterfaceName` `` per behavioral interface, each followed by one `| Method | … |` table whose first column is the backticked member name.
4. `## Tests` — a bullet list of relative links to the test files.
5. Free-form prose, `## Patterns`, `## See also` — unconstrained by the checks.

**Manifest** (`guides/README.md`) — the run map. A `## By concept` table `| Concept | Spec | Source | Tests |`; one row = one check target. `Spec` links the guide, `Source` links its source directory (a cell MAY link several directories — a layer guide spanning a core module plus its backend implementations — which parse to a multi-directory scope), `Tests` links its test directory. Adding a row auto-extends coverage with **zero test edits**. An optional `## Dependency reference` section names sibling guides for runtime-dependency packages (e.g. `markdown` cites `contract.md`); it is documentation, not consumed by v1's checks.

## 3. Package identity & dependencies

- **Name** `@orkestrel/guide` · **repo** `orkestrel/guide` · ESM-only · `node >=24` · house layout, `core` + `server` surfaces, **no `bin/`**.
- **Runtime dependency — exactly one:** `@orkestrel/markdown`. `createMarkdown` / the `MarkdownInterface` (`walk` / `find` / `filter`), the `is*Node` guards, `walkNodes`, and `flattenText` are the entire engine the extraction layer needs. Pure and core-safe.
- **`@orkestrel/contract` — deliberately NOT a direct dependency.** The v1 proposal used contract to compile a `Finding`/`Report`/`Summary` model. This redesign drops that model entirely (§4): findings are `readonly string[]` diffs asserted with `expect(diff).toEqual([])`, which yields a better vitest failure diff than any custom report and costs zero dependencies (AGENTS §1: no unsolicited deps). `contract` remains only a *documented* dependency-reference in the markdown guide, not a code import.
- **No peer `typescript`.** Source truth is read with line scanners (§7), not the compiler API — so there is no peer compiler to bind, no version-skew surface, and type-only exports are read directly from source text.

## 4. Architecture & public API

Two surfaces, split by the strict-core rule. `core` is pure ECMAScript: it parses guide markdown and runs the pure comparison leaves. `server` owns all I/O — `node:fs` directory walking and file reads. Dependency direction: server imports core; core never imports server. `Source` (server) implements `SourceInterface` (declared in core `types.ts`), the dependency-inversion seam that lets the pure comparison helpers depend only on the interface.

The design is intentionally lean: **no `validators.ts`, no `shapers.ts`, no `Checker`/`Runner` classes.** The "checks" are pure set-difference helpers the drop-in test composes directly, so there is no orchestration entity to own.

### `src/core` (pure, `@orkestrel/guide/core`)

| File           | Holds                                                                                                                               |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`     | source of truth — `SurfaceSymbol`, `ExportKind`, `GuideModule`, `ManifestEntry`, `MethodGroup`, `GuideInterface`, `SourceInterface`   |
| `constants.ts` | `EXTERNAL_SCHEMES`, `SURFACE`, `METHODS`, `TESTS`, `MANIFEST` heading literals                                                        |
| `helpers.ts`   | pure leaves — `symbolKey`, `findMissing`, `missingSymbols`, `isExternalLink`, `resolveLink`, `resolvePath`, `firstCode`, `kindIndex`  |
| `parsers.ts`   | guide/manifest extraction over the Markdown AST — `extractSurface`, `extractMethods`, `extractLinks`, `extractTests`, `sectionBlocks`, `parseManifest` |
| `Guide.ts`     | the `Guide` class — a stateful structured view over one guide (extraction cached in the constructor)                                  |
| `factories.ts` | `createGuide`                                                                                                                         |
| `index.ts`     | the sole core barrel                                                                                                                  |

### `src/server` (node, `@orkestrel/guide`)

| File           | Holds                                                                                                                        |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`     | server-local `SourceOptions`                                                                                                   |
| `helpers.ts`   | scanner grammar + fs leaves — `exportsFrom`, `declarationBody`, `joinHead`, `memberMethods`, `moduleFiles`, `readText`, `pathExists` |
| `Source.ts`    | the `Source` class — implements `SourceInterface`: reflects exports/members/existence off disk via line scanners               |
| `factories.ts` | `createSource`                                                                                                                 |
| `index.ts`     | the sole server barrel                                                                                                         |

### Public API sketch

```ts
// ---- core/types.ts ----
type ExportKind = 'type' | 'interface' | 'const' | 'function' | 'class'
interface SurfaceSymbol {                     // one documented / exported symbol
	readonly name: string                     // its identifier
	readonly kind: ExportKind                 // its declaration kind — half of the bijection key
}
type GuideModule = string | readonly string[] // one source dir, or several (a layer guide's scope)
interface ManifestEntry {                     // one `## By concept` row, paths normalized to workspace root
	readonly concept: string
	readonly spec: string                     // the guide .md, root-relative
	readonly source: GuideModule              // the source dir(s) it documents
	readonly tests: string                    // the tests dir
}
interface MethodGroup {                       // one `#### `Interface`` block in `## Methods`
	readonly interface: string                // the backticked interface name
	readonly methods: readonly string[]       // its documented Method-cell identifiers
}
interface GuideInterface {                    // the structured view of one guide (pure)
	sections(): readonly string[]             // `##` heading names, in order (empty-extraction guard)
	surface(): readonly SurfaceSymbol[]       // every Surface identifier + Kind, table rows ∪ entity headings
	methods(): readonly MethodGroup[]         // one group per documented behavioral interface
	links(): readonly string[]                // every link href in the guide (incl. table cells)
	tests(): readonly string[]                // the relative test links under `## Tests`
}
interface SourceInterface {                   // reflected source truth (implemented in server)
	exports(): readonly SurfaceSymbol[]       // every module-scope export incl. type-only, by (name, kind)
	methods(name: string): readonly string[] // the call-signature members of `class`/`interface` `name`
	exists(relative: string): boolean         // fs existence of a workspace-root-relative path
}

// ---- core: pure comparison leaves + factory ----
function symbolKey(symbol: SurfaceSymbol): string                                    // `${kind} ${name}`
function findMissing(names: readonly string[], source: readonly string[]): readonly string[]        // set difference
function missingSymbols(symbols: readonly SurfaceSymbol[], source: readonly SurfaceSymbol[]): readonly string[] // symbolKey diff
function isExternalLink(href: string): boolean                                       // http/https/mailto/tel/# → skip
function resolveLink(from: string, target: string): string                           // resolve a link vs the guide's dir
function parseManifest(markdown: string, base: string): readonly ManifestEntry[]     // `## By concept` → entries
function createGuide(source: string): GuideInterface                                 // parse + cache extraction

// ---- server: reflection + factory ----
interface SourceOptions { readonly root: string; readonly module: GuideModule }
function createSource(options: SourceOptions): SourceInterface
function readText(root: string, relative: string): string                            // read a workspace file
```

## 5. The check catalog

Each check is a pure comparison that a passing run reduces to `expect([]).toEqual([])`. Every check pairs with an explicit **non-vacuousness guard** so a renamed heading or a moved section fails *loudly* instead of extracting nothing and passing.

**SB — Surface bijection (kind folded in).** *Inputs:* `guide.surface()` (each Surface table's first-column code span + its `Kind` cell, located by header text; plus each backticked entity H3 as `{name, kind:'class'}`) vs `source.exports()`. *Algorithm:* `missingSymbols` both directions over `symbolKey` — so a symbol can drift in neither name **nor** kind (kind agreement is not a separate check; it is baked into the key). *Guard:* `guide.surface().length > 0`. *Failing diff:* `[ 'function flattenText' ]` (an export with no Surface row) or `[ 'const MAX_DEPTH' ]` (documented `function`, declared `const`).

**MB — Methods bijection + class-no-extra.** *Inputs:* per `MethodGroup`, its documented `methods` vs `source.methods(group.interface)`. *Algorithm:* `findMissing` both directions; then derive the implementer by convention (`XInterface → X`) and assert `findMissing(source.methods('X'), group.methods)` is empty — the class exposes **no** public method the interface does not document. The scanner's member regex already excludes `constructor`, getters/setters, `static`, and `#` privates, and the documented `readonly document`-style data member never matches (no `(`), so this mirrors §22's method-vs-data-member line exactly. *Guard:* `group.methods.length > 0`. *Failing diff:* `[ 'stream' ]`.

**LI — Link integrity.** *Inputs:* `guide.links()` (a full-AST `filter(isLinkNode)` — table cells included). *Algorithm:* drop `isExternalLink` hrefs, `resolveLink` the rest against the guide's directory, keep those failing `source.exists`. *Guard:* the SB/MB extractions already prove the AST walk is live. *Failing diff:* `[ 'src/core/gone.ts' ]`.

**TE — Tests-link existence.** *Inputs:* `guide.tests()` (the `## Tests` bullet links). *Algorithm:* `resolveLink` + `source.exists`; keep the missing. *Failing diff:* `[ 'tests/src/core/missing.test.ts' ]`.

**NV — Non-vacuousness (the minimal structure guard).** Not a body of anatomy rules — just the assertions that keep every other check honest: `parseManifest` yields ≥1 entry (an empty manifest must not pass a whole empty suite), `guide.surface()` is non-empty, and each `MethodGroup` is non-empty. A guide whose `## Surface` or `## Methods` heading was renamed extracts an empty set and **fails here**, rather than passing vacuously. Full anatomy linting, backtick-prose resolution, and pattern typechecking are deferred (§10).

## 6. The drop-in

This is the centerpiece: the entire consumer-side footprint is one short test file, one vitest project, one script.

**`tests/guides/src/parity.test.ts`** (blessed, ~45 lines):

```ts
import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import {
	createGuide,
	findMissing,
	isExternalLink,
	missingSymbols,
	parseManifest,
	resolveLink,
} from '@orkestrel/guide/core'
import { createSource, readText } from '@orkestrel/guide'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const manifest = parseManifest(readText(ROOT, 'guides/README.md'), 'guides')

it('manifest lists at least one guide', () => {
	expect(manifest.length).toBeGreaterThan(0)
})

for (const entry of manifest) {
	const guide = createGuide(readText(ROOT, entry.spec))
	const source = createSource({ root: ROOT, module: entry.source })

	describe(entry.concept, () => {
		it('extracts a non-empty documented surface', () => {
			expect(guide.surface().length).toBeGreaterThan(0)
		})
		it('documents every source export', () => {
			expect(missingSymbols(source.exports(), guide.surface())).toEqual([])
		})
		it('documents only real exports', () => {
			expect(missingSymbols(guide.surface(), source.exports())).toEqual([])
		})

		for (const group of guide.methods()) {
			const members = source.methods(group.interface)
			const entity = group.interface.replace(/Interface$/, '')
			describe(group.interface, () => {
				it('documents at least one method', () => {
					expect(group.methods.length).toBeGreaterThan(0)
				})
				it('documents every interface method', () => {
					expect(findMissing(members, group.methods)).toEqual([])
				})
				it('documents no phantom method', () => {
					expect(findMissing(group.methods, members)).toEqual([])
				})
				if (entity !== group.interface) {
					it(`${entity} exposes no undocumented method`, () => {
						expect(findMissing(source.methods(entity), group.methods)).toEqual([])
					})
				}
			})
		}

		it('resolves every relative link', () => {
			const broken = guide
				.links()
				.filter((href) => !isExternalLink(href))
				.map((href) => resolveLink(entry.spec, href))
				.filter((path) => !source.exists(path))
			expect(broken).toEqual([])
		})
		it('links only to test files that exist', () => {
			const missing = guide
				.tests()
				.map((href) => resolveLink(entry.spec, href))
				.filter((path) => !source.exists(path))
			expect(missing).toEqual([])
		})
	})
}
```

**`vite.config.ts`** — add a `guides` project extending the repo's existing single `srcCore` config (Node env, its own include glob), and register it. Adapted from terrain's pattern to markdown/contract's shape:

```ts
// Extends srcCore: the guides-parity suite. Node env — it reads the real
// guides/*.md and the documented source modules off disk — but resolves like core tests.
export const guides = (config?: UserConfig): UserConfig =>
	srcCore(
		mergeConfig(
			{
				test: {
					name: { label: 'guides', color: 'green' },
					include: ['tests/guides/**/*.test.ts'],
					exclude: ['tests/src/**/*.test.ts', 'tests/setup.test.ts'],
				},
			},
			config ?? {},
		),
	)

// ...in defineConfig:
	test: { projects: [srcCore, guides] }
```

**`package.json`** — one script:

```json
"test:guides": "vitest run --project guides"
```

Add `test:guides` to the `prepublishOnly` gate chain after the existing test step. That is the whole adoption footprint.

## 7. Source-scanning fidelity

`Source` reflects truth with **line scanners over source text**, not the TypeScript compiler API — a direct port of terrain's proven `setupGuides.ts` scanners.

- **Exports.** Per module file, `exportsFrom` matches `^export (?:async )?(function|class|const|interface|type) (\w+)` → `{name, kind}`. The name is always on the first line even when oxfmt wraps the signature, so no join is needed here.
- **Members.** `declarationBody(files, keyword, name)` finds the declaration head, uses `joinHead` to fold an oxfmt-wrapped head (printWidth 100; nested generics like `<T = Record<string, unknown>>` still match) into one line ending in `{`, then collects lines to the column-0 `}`. `memberMethods` matches `^\t(?:async )?\*?(\w+)(<[^>]*>)?\??\(` — plain / `async` / generator / optional methods count; getters, setters, `static`, `#` privates, and data members never do (their shape breaks the `name(` match); `constructor` is filtered out.
- **File walking.** `moduleFiles` recurses each `GuideModule` directory, unions multi-dir scopes, and excludes `index.ts` and `*.test.ts`.

```ts
export function joinHead(lines: readonly string[], start: number): { text: string; end: number } | undefined {
	const parts: string[] = []
	for (let i = start; i < lines.length; i += 1) {
		const line = lines[i]
		if (line === undefined) break
		parts.push(i === start ? line.trimEnd() : line.trim())
		if (line.trimEnd().endsWith('{')) return { text: parts.join(' '), end: i }
	}
	return undefined
}
```

**Why line scanning has high fidelity here — and is the right v1 choice.** AGENTS *locks the grammar the scanner assumes*, and the format/lint gates enforce that lock on every commit: §5 requires every module-scope declaration to be exported (nothing hides from the scanner), §6 permits exactly one export style, §3 mandates tabs, and oxfmt fixes the wrap shape `joinHead` decodes. The scanner reads **source text**, so type-only exports (`export interface`, `export type`) — the exact symbols invisible to runtime reflection — are trivially visible. It has zero dependencies, runs in milliseconds, and needs no peer compiler.

**Honest limits.** The approach is *style-coupled*: a repo that does not obey AGENTS' export style, indentation, or format width would mis-scan. That is an acceptable v1 constraint because the target repos are exactly the ones whose gates enforce the style. The TypeScript compiler API (a `Source` variant reflecting via `getExportsOfModule` / call signatures, behind the same `SourceInterface`) is the natural **future hardening** for non-conforming or cross-language consumers — not v1.

## 8. Testing strategy, including dogfooding

- **Unit tests mirror source** (§16): `tests/src/core/parsers.test.ts` (guide + manifest extraction, incl. entity-heading surface and multi-dir Source cells), `helpers.test.ts` (`symbolKey`, `findMissing`, `missingSymbols`, `resolveLink`, `firstCode`, `kindIndex`), `Guide.test.ts`; server `tests/src/server/helpers.test.ts` (`joinHead` on wrapped heads, `memberMethods` on every excluded shape, `moduleFiles` exclusions) and `Source.test.ts` (reflection against a fixture module).
- **Fixture guides** (`tests/fixtures/`): one *good* guide + tiny fixture module that passes every check, plus one *broken* fixture per failure mode (undocumented export, wrong Kind, extra class method, broken link, missing test, renamed `## Surface`) — each isolating one check's red path and its non-vacuousness guard. Deterministic, no network.
- **Self-dogfooding** (acceptance criterion): the package ships its own `guides/src/guide.md` documenting `GuideInterface` / `SourceInterface` (with `## Methods`), and its own `tests/guides/src/parity.test.ts` runs the drop-in against this repo — the checker must pass its own checker.

## 9. Adoption plan — `contract` and `markdown`

For **both** repos: add `@orkestrel/guide` as a devDependency, drop in `tests/guides/src/parity.test.ts` (§6), add the `guides` vitest project and the `test:guides` script (into `prepublishOnly` after `test`), then run once and reconcile whatever surfaces (undocumented exports, extra class surface, kind drift, broken links) — docs or code, per §22. Both `## By concept` tables already expose `Spec` / `Source` / `Tests` pointing at the exact dirs the helpers resolve, so no manifest changes are required.

For **markdown** specifically: it has no `## Contract` section in `markdown.md` where `contract.md` does. This is out of v1's mechanical scope (NV does not require it), but the asymmetry should be noted and closed by hand when the guides are next revised.

## 10. Risks & future work

**Risks (priority-ordered):**

1. **Style-coupling of the line scanners** — a source file that violates AGENTS' export/format grammar mis-scans, potentially a false parity failure. *Mitigation:* the target repos' format + lint gates enforce that grammar on every commit; the `memberMethods` / `joinHead` edge cases (wrapped heads, nested generics, every excluded member shape) are unit-tested against fixtures; the TS-compiler `Source` variant is the documented escape hatch if a consumer ever needs it.
2. **Entity-heading kind inference** — a backticked `## Surface` H3 is assumed to document a `class`. *Mitigation:* that matches the anatomy convention and the only current case (`Markdown`); a non-class entity heading would fail SB loudly (visible, not silent), signaling the guide to add a table row instead.
3. **Convention-derived implementer name** (`XInterface → X`) — a class named against convention would skip its no-extra check. *Mitigation:* the interface↔doc bijection still fully covers the documented set; only the *extra-method* guard depends on the name mapping, and a mismatch degrades to a safe no-op rather than a false pass.

**Future work (post-v1):** the TS-compiler-API `Source` for cross-language/non-conforming repos; backtick-prose resolution (every prose backtick resolves to an export, a member, an attributed external, or a language literal); `## Patterns` fence typechecking; a tests-mirror sub-check (every behavioral source file has a linked test).

## 11. Roadmap

- **v0.1 — the port.** Core `Guide` + `parseManifest`; server `Source` line scanners; the pure comparison helpers; checks SB, MB (+ class-no-extra), LI, TE, and the NV guards. Self-dogfooded against this repo's own `guides/`. One runtime dependency (`@orkestrel/markdown`), no compiler.
- **v1.0 — adopted.** `contract` and `markdown` both green on the drop-in; `markdown.md`'s missing `## Contract` reconciled. API stable.
