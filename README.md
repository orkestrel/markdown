# @orkestrel/markdown

A types-first markdown layer over `@orkestrel/html`: parse GitHub-Flavored Markdown into a typed
AST, project that AST out to sanitized HTML or to canonical markdown source, and project an HTML AST
back in.

- **One AST, several projections.** Nodes are plain readonly data keyed by `element`; parsing,
  querying, rewriting, folding, streaming, and every conversion are operations over it.
- **Both directions live here.** `markdownToHTML` and `htmlToMarkdown` are inverse projections
  across the boundary, because what an HTML subtree means in markdown is markdown's knowledge, not
  html's.
- **Sanitized by default, with no opt-out.** `renderHTML` takes one argument and composes
  `@orkestrel/html`'s sanitize floor, so there is no call shape that emits unsafe HTML.
- **Bounded by design.** Every parse, traversal, and projection is iterative and depth-capped, so
  malformed or hostile input degrades to literal text instead of throwing.

## Install

```sh
npm install @orkestrel/markdown
```

## Requirements

- Node.js >= 22.12
- Ships ES and CommonJS builds with its own `.d.ts` types
- Two runtime dependencies, `@orkestrel/html` and `@orkestrel/contract`

## Usage

```ts
import { createMarkdown, htmlToMarkdown, renderHTML, renderMarkdown } from '@orkestrel/markdown'
import { parseDocument as parseHTML } from '@orkestrel/html'

const markdown = createMarkdown('# Hi\n\nRead the [guide](./guide.md) for more, *thanks*.')

markdown.document
// { element: 'document', children: [...] } — the typed, render-agnostic AST

renderHTML(markdown.document)
// '<h1>Hi</h1><p>Read the <a href="./guide.md">guide</a> for more, <em>thanks</em>.</p>'

// …and back the other way.
renderMarkdown(htmlToMarkdown(parseHTML('<h1>Release notes</h1><p>Ship <b>fast</b>.</p>')))
// '# Release notes\n\nShip **fast**.'
```

`createMarkdown` (or `new Markdown`) runs a two-phase parse — block phase, then inline phase — and
holds the result as a stateful workspace exposing `find` / `filter` / `map` / `reduce` / `fold` /
`stream` / iteration over the AST. `renderHTML` projects that AST onto html's AST, sanitizes it
against a floor no option can lower, and serializes it. `renderMarkdown` writes canonical markdown
source instead. `htmlToMarkdown` folds an HTML AST back down to a `MarkdownDocument`, re-sanitizing
every destination as it goes. Guards (`isMarkdownNode`, `isMarkdownDocument`, `isBlockNode`,
`isInlineNode`) validate an AST that arrives from outside — an RPC payload, a cached document —
without ever throwing, and the non-recursive leaf nodes each compile to a `@orkestrel/contract`
bundle of guard, parser, JSON Schema, and seeded generator.

## Laws

- **Markdown fixpoint** — `parseDocument(renderMarkdown(document))` deep-equals a parser-produced
  `document`, and `renderMarkdown` is idempotent.
- **Projection anchor** — `parseDocument(renderMarkdown(htmlToMarkdown(x)))` deep-equals
  `htmlToMarkdown(x)`: whatever the projection emits, markdown can write it and read it back
  unchanged.
- **Sanitized output** — `renderHTML` refuses `javascript:`, `data:`, `vbscript:`, `file:`, and
  protocol-relative destinations, removes unsafe subtrees whole, and strips every handler and
  styling attribute, whatever the input AST claims.

HTML is richer than markdown, so what survives the inbound trip is the projected AST, not the input
bytes: comments and doctypes vanish, an element with no markdown meaning unwraps to its children,
and block content inside a table cell flattens to one line.

## Guide

For the full surface — the AST shape, the two-phase parse, the sanitization policy, the projection
seam, and the contract-backed leaf shapes — see [`guides/src/markdown.md`](guides/src/markdown.md).

## Package

Published as a single typed entry point per the `exports` field in `package.json`.

## License

MIT © [Orkestrel](https://github.com/orkestrel) — see [LICENSE](./LICENSE).
