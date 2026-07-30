# Proposal — rebuild `@orkestrel/markdown` on `@orkestrel/html`

Status: **specified, blocked on publish.** Nothing here may be implemented until
`@orkestrel/html@0.0.1` is on the registry and installed here as a real dependency. No `file:`
dependency, no `link:`, no tsconfig path alias, no vendoring — those were all considered and
excluded.

This document is the spec, not a sketch. It exists because the knowledge it carries was recovered
from code that has already been deleted, and would otherwise survive only in git history.

## Direction

The user's instruction, verbatim:

> "markdown should sit on html… html should hold all html logic and markdown should emit sanitized
> HTML and hold renderHTML since html should be roundtrip and is built on AST. Thoroughly think this
> through and strongly consider the best option to make this a clean break for html to make it feel
> like the html package is cleanly native and feels original as if it were made before markdown, and
> markdown cleanly and natively feels original on top of the html package."

and, narrowing it: "markdown logic should remain in markdown."

So `@orkestrel/html` is the HTML foundation and owns every HTML concern: the AST, total parsing,
canonical serialization, the sanitize floor, and distillation. `@orkestrel/markdown` becomes a
markdown-format layer that projects onto that foundation and owns both conversion directions.

html has already been stripped of all markdown vocabulary — `escapeMarkdown` and `renderMarkdown`
are gone from it, along with its `@orkestrel/markdown` devDependency and the `markdown` keyword.
That is deliberate and final: html must read as though it was written first.

## Consequence to accept openly

Between html's publish and this work landing, the fleet has **no HTML→markdown converter**. That gap
is inherent to a clean break, not an oversight. It is why the relocation spec below is written in
full detail rather than left as "port the old function."

## What markdown gains

Two projections and one rewiring. Exact names and signatures are proposals for the implementing
unit to confirm against `.claude/rules/names.md`:

- `markdownToHTML(node: MarkdownNode): HTMLDocument` — markdown AST to html's AST.
- `htmlToMarkdown(node: HTMLNode): MarkdownDocument` — html's AST to markdown AST.
- `renderHTML(node: MarkdownNode): string` — rewired to compose `markdownToHTML`, html's `sanitize`,
  and html's `renderHTML`, replacing today's single linear string pass.

Both directions are markdown-format knowledge, so both live here. html must never import
`MarkdownNode`.

## What markdown deletes

Greenfield, no shims, every consumer updated in the same change:

- `escapeHtml` (`src/core/helpers.ts:601`, 6 call sites) — html's serializer owns escaping.
- `sanitizeUrl` (`src/core/helpers.ts:630`) — html's `sanitizeURL` is the one floor. This also
  retires an acronym-law violation (`Url` should always have been `URL`).
- `SAFE_URL_SCHEMES` (`src/core/constants.ts:7`) — html exports the canonical set.
- The `TableAlign` `'none'` sentinel — absence is `undefined`, never a sentinel.

## Binding requirements

These are not suggestions. Each is a verified fact about behaviour that will be lost silently if the
implementing unit does not carry it across.

### B1 — `htmlToMarkdown` MUST re-apply `sanitizeURL` to destinations

The deleted `renderMarkdown` called `sanitizeURL(value, SAFE_URL_SCHEMES)` on **both** `href` and
`src`, at render time, unconditionally, whether or not the AST had ever been sanitized. It was
html's only renderer that was safe by default on a hand-built hostile AST.

Verified about html's surviving renderers: `renderHTML`'s attribute emission calls `encodeAttribute`
only and never `sanitizeURL` — which was already true before the split, so nothing regressed — and
`renderText` has no URL handling at all. html's `sanitize()` was always the explicit separate pass.

The consequence is still real: that defence now exists nowhere unless `htmlToMarkdown` provides it.
So it must sanitize every destination, and escape `\`, `(`, and `)` in the destination **after**
sanitizing. A refused URL must yield `[text]()` — never a dropped link, which would lose content.

### B2 — `htmlToMarkdown` MUST honour the sanctioned `align` attribute

html now permits `align` on `td`/`th` only, with a closed value set of `center` / `left` / `right`,
normalized to trimmed lowercase and unwidenable by any option (`constants.ts` `TABLE_ALIGNMENTS`,
`TABLE_CELL_ELEMENTS`, narrowed in `sanitizeAttributes`).

That rule earns its keep only if both directions use it:

- `markdownToHTML` emits `align` on `th`/`td`, replacing today's
  `style="text-align:…"` (`src/core/helpers.ts:776-800`) — html strips `style` unconditionally
  before any allowlist check, so the current output would be destroyed by sanitize.
- `htmlToMarkdown` reads `align` and emits the GFM delimiter row: `:---` left, `:---:` center,
  `---:` right, bare `---` when absent.

Note a disagreement in the deleted code worth not repeating: html's old guide claimed
`renderMarkdown` emitted "a GFM table with an alignment delimiter row", but the implementation
always emitted a bare `---` and never read alignment. Code and doc contradicted each other. Pick
honouring alignment, and make the doc match.

### B3 — the escaper consolidation is GATED

markdown's context-sensitive escaper (`src/core/helpers.ts:875-919`) is authoritative; html's
`escapeMarkdown` was ported from it. Consolidating them is only permitted after **proving**
markdown's own `parse(render(x)) === x` roundtrip still holds. If the proof fails, keep two
escapers and document why. Do not consolidate on the assumption that they are identical.

## Relocation spec — the deleted implementation, in full

Recovered from `@orkestrel/html` at commit `62aebcc` before deletion. This is the behaviour
`htmlToMarkdown` must reproduce or consciously improve on.

### `escapeMarkdown` (47 lines)

Single left-to-right pass, no whole-string regex.

- **Unconditional, anywhere** — exactly these seven get a backslash prefix:
  `\` `*` `_` `` ` `` `[` `]` `|`
- **Line-start only** (index 0, or previous character is `\n`):
  - `#` and `>` always escaped;
  - `-` and `+` escaped **only when the next character is a space** — `- x` becomes `\- x`, but
    `-nospace` is untouched;
  - a run of ASCII digits followed by `.` or `)` followed by a space: digits emitted verbatim, the
    marker escaped, cursor jumps past the run — `1. x` becomes `1\. x`, `10) x` becomes `10\) x`.
    No space after the marker means no escape, so `x 1. y` and mid-line `a - b` are unchanged.
- **Deliberately NOT escaped:** `(` `)` `!` `~` `<` `=` `&`, and `#`/`>` away from a line start.
  Parentheses are escaped in link and image destinations only, never in prose.

### `renderMarkdown` (368 lines)

**Engine.** Iterative explicit-stack post-order fold. A `visited` WeakSet terminates cyclic and
shared-graph input. Children are collected only for `document`/`element`, and only while
`depth < MAX_DEPTH` (64), so a node at the cap folds with no children. The whole body sits in
`try/catch` returning `''`. The root returns its value trimmed.

**Three parallel projections per node**, all load-bearing:

| Projection | Meaning | Consumed by |
| --- | --- | --- |
| `value` | the markdown | siblings, root |
| `text` | raw concatenated subtree text — uncollapsed, unescaped | `code`, `pre > code` |
| `plain` | whitespace-collapsed text with `\n` around block elements and `br`, excluding `RAW_ELEMENTS` subtrees | the `pre` fallback |

**Sibling join.** Children with a non-empty `value` are concatenated; `\n\n` is inserted when the
previous child was `block` **or** the current child is `block`. `rows` propagate upward from every
child. A `document` joins non-empty child values with `\n\n`.

**Element mapping.**

| Element | Emitted | Flags |
| --- | --- | --- |
| text node | `escapeMarkdown(value)` | inline |
| `h1`–`h6` (`/^h[1-6]$/`) | `'#'.repeat(level) + ' ' + joined.trim()` | block |
| `p` | `joined.trim()` | block |
| `strong`, `b` | `**joined**`; empty children yield `''` | inline |
| `em`, `i` | `*joined*`; empty children yield `''` | inline |
| `code` | body is raw `text` with `/\s*\n\s*/g` collapsed to one space; fence is `` ` `` × `max(1, longestBacktickRun + 1)`; one space of padding on both sides iff the body starts **or** ends with a backtick | inline |
| `pre` | if `children[0]` is an element named `code`: body is that child's raw `text`, language is the first `class` token starting `language-` **with length > 9**, `.slice(9)`. Otherwise body is `plain`, normalized `[ \t]*\n[ \t]*`→`\n`, `\n+`→`\n`, ` +`→` `, trimmed. Fence is `` ` `` × `max(3, longest + 1)` | block |
| `a` | `[joined](href)`, href sanitized then `\`/`(`/`)` escaped — see B1 | inline |
| `img` | `![alt](src)`, alt escaped, src sanitized and escaped as `a` | inline |
| `br` | `'  \n'` — two spaces then newline | inline, deliberately NOT block |
| `hr` | `'---'` | block |
| `blockquote` | `joined.trim()` split on `\n`, each line prefixed `'> '`, an empty line becoming bare `'>'`, rejoined with `\n` | block |
| `li` | non-empty child values, separator `'\n'` for a nested `list`, `'\n\n'` for a `block`, `''` otherwise; trimmed | item |
| `ul` / `ol` | marker `'- '` or `` `${ordinal}. ` ``; ordinal starts at `parseInt(attributeOf('start') ?? '1', 10)` (non-finite → 1) and increments per item; item value split on `\n` with continuation lines indented `' '.repeat(marker.length)`, so `10. ` indents 4; items joined `\n` | block, list |
| `th` / `td` | `{ value: joined.trim(), header: name === 'th' }` | carries cell |
| `tr` | collects child cells; `header` true if **any** cell was a `th`; emits one row | block |
| `table` | `headerIndex` is the first row whose `header` is true, default 0. Header absent or zero cells degrades to `joined` with rows cleared. Otherwise pipes, then a delimiter row of one entry per **header** cell, then every other row padded with `''` to header width, extra cells truncated | block |
| anything else | `joined`, `block` = any child was block — so an unknown wrapper around two paragraphs still separates them | unwraps |

**Sixteen behaviours a naive rewrite loses.** Fence widening on both paths, `max(1, n+1)` inline and
`max(3, n+1)` fenced. Inline-code space padding when the body touches a backtick. Inline code
flattening newlines to spaces. A `pre` **without** a `code` child falling back to plain-text
normalization rather than raw text. The language token requiring `language-` plus at least one
character, first match wins, other `class` tokens ignored. `pre > code` using **raw** subtree text
so indentation and already-decoded references survive verbatim. `\`, `(`, `)` escaped in
destinations only, after sanitizing. `sanitizeURL` re-applied at render time regardless of prior
sanitization. `br` inline, not block. `ol start` honoured with nested continuation indented to
marker width. `li` distinguishing a tight nested list from a loose block child. Table header
detection scanning for the first `th`-bearing row instead of assuming row 0. A headerless table
degrading to text instead of emitting malformed pipes. The depth cap and cycle detection bounding
hostile input. Blockquote blank lines as bare `>`. And the whole projection being total — `''` on
any throw.

## Composed depth caps

Both packages independently cap at `MAX_DEPTH = 64` (`src/core/constants.ts:18` here;
html's `constants.ts`). A bridge runs markdown's traversal then html's, so deeply nested input can
now truncate twice. The implementing unit must specify the honest composed behaviour and test it,
including whether deeply nested markdown produces a structurally different result than today.

## Cost, accepted

html's built core ESM entry is ~118 KB against markdown's ~78 KB, and `NAMED_ENTITIES` alone is
2,125 entries. Under an AST bridge markdown imports html's AST, sanitizer, and serializer, so
tree-shaking cannot help — `sanitizeURL` reaches `decodeEntities`, which keeps the entity table on
the hot path. The user has accepted this weight at markdown's root, and rejected a concern-axis
subpath: subpaths are environment-only.

markdown's HTML output changes substantially beyond escaping. Sanitized-by-default means anything
outside html's floor disappears. The implementing unit must enumerate concretely what vanishes
before landing, not after.

## Sequencing

1. **html publishes at `0.0.1`.** It has never been published, so there is no bump — the version is
   already correct. Gates and `npm pack --dry-run` are green: 9 files, `dist/src/**` plus
   `README.md`, `package.json`, `LICENSE`, no leaks, all four declared entry points present.
2. `npm install @orkestrel/html@^0.0.1` here. `^0.0.x` is the fleet's deliberate convention.
3. Types first: revise `src/core/types.ts` for both projections before any implementation.
4. Implement, consolidate, test, then rewrite the guide.
5. markdown to `0.0.7`, and update `@orkestrel/scaffold`'s `^0.0.6` pin.

Steps 2 onward are hard-blocked on step 1, which is the user's call.

## Open decisions for the implementing unit

- Does markdown export the intermediate `HTMLDocument` so consumers can sanitize, inspect, or
  serialize themselves, or only the final string? Exporting it is the more honest composition but
  widens the public surface.
- Does `renderHTML` sanitize unconditionally, or is there an opt-out? The user said markdown emits
  sanitized HTML. Unconditional keeps today's one-argument simplicity; check first whether markdown
  emits any attribute html's floor would strip beyond `style` — heading anchor `id`s in particular.
- Disposition of the 33-vector URL-safety corpus. It stays in html as html's own corpus; decide how
  many markdown-side composition vectors are genuinely needed here, and dispose of each of the three
  former divergence claims explicitly rather than deleting them silently.
