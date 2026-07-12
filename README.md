# @orkestrel/markdown

A zero-surprise, types-first markdown parser — a hand-written scanner turns
GitHub-Flavored Markdown into a typed AST (a discriminated union keyed by
`element`), and a separate renderer projects that AST to sanitized, XSS-safe
HTML. Total and depth-capped throughout: malformed or pathologically deep
input degrades to literal text instead of throwing. Part of the `@orkestrel`
line.

## Install

```sh
npm install @orkestrel/markdown
```

## Requirements

- Node.js >= 24
- ESM-only (no CommonJS build)

## Usage

```ts
import { createMarkdown, renderHTML } from '@orkestrel/markdown'

const markdown = createMarkdown('# Hi\n\nRead the [guide](./guide.md) for more, *thanks*.')
markdown.document
// { element: 'document', children: [...] } — the typed, render-agnostic AST

renderHTML(markdown.document)
// '<h1>Hi</h1>\n<p>Read the <a href="./guide.md">guide</a> for more, <em>thanks</em>.</p>'
```

`createMarkdown(markdown)` (or `new Markdown(markdown)`) runs a two-phase
parse (block phase, then inline phase) and stores the result as a stateful
workspace's `document` — a render-agnostic `MarkdownDocument`. The workspace
also exposes `find` / `filter` / `map` / `reduce` / `fold` / `stream` /
iteration over the AST. `renderHTML(node)` HTML-escapes all text and
attributes and sanitizes link `href`s (an unsafe scheme like `javascript:` or
`data:` is dropped), so even hostile content cannot inject markup or script.
`renderMarkdown(node)` writes canonical markdown source back out — a
`parseDocument(renderMarkdown(doc))` round-trip always deep-equals `doc`. A
fold projects the AST to any shape (a plain string, a DOM tree, a count)
through one total, per-element handler table, with no writer coupling built
in.

## Validating untrusted ASTs

A parsed or deserialized AST crossing a trust boundary (an RPC payload, a
cached document) can be checked without throwing:

```ts
import { isMarkdownNode } from '@orkestrel/markdown'

isMarkdownNode({ element: 'text', value: 'hi' }) // true
isMarkdownNode({ element: 'bogus' }) // false
```

`isMarkdownNode`, `isMarkdownDocument`, `isBlockNode`, and `isInlineNode` are
total guards — safe to call on cyclic or adversarial input, even deeply
nested structures.

## Contract-backed leaf shapes

The non-recursive leaf nodes (`TextNode`, `CodeSpanNode`, `CodeBlockNode`,
`ThematicBreakNode`) each have a compiled contract — a guard, parser, JSON
Schema, and seeded generator from one shape declaration, built on
`@orkestrel/contract`:

```ts
import { createTextContract } from '@orkestrel/markdown'

const text = createTextContract()
text.schema // the compiled JSON Schema
text.generate() // a seeded, schema-valid TextNode
```

## Safety notes

- `renderHTML`'s `href`s are restricted to a safe scheme allowlist (`http`,
  `https`, `mailto`, `tel`, or scheme-less/relative/anchor links) — anything
  else is dropped.
- All of `renderHTML`'s rendered text and attributes are HTML-escaped.
  `renderMarkdown` is not an HTML boundary — it writes markdown source, not
  markup — so no HTML-escaping applies there.
- Parsing and rendering are depth-capped (`MAX_DEPTH`); past that depth the
  parser/writer degrades to literal text instead of recursing further or
  throwing.

## Guide

For the full surface — the AST shape, the two-phase parse, GFM tables, and
the contract-backed leaf shapes — see
[`guides/src/markdown.md`](guides/src/markdown.md).

## Package

Published as a single typed entry point per the `exports` field in
`package.json`.

## License

MIT © [Orkestrel](https://github.com/orkestrel) — see [LICENSE](./LICENSE).
