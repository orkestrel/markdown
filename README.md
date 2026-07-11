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
import { createMarkdownParser } from '@orkestrel/markdown'

const parser = createMarkdownParser()
const ast = parser.parse('# Hi\n\nRead the [guide](./guide.md) for more, *thanks*.')
parser.render(ast)
// '<h1>Hi</h1>\n<p>Read the <a href="./guide.md">guide</a> for more, <em>thanks</em>.</p>'
```

`parse(markdown)` runs a two-phase parse (block phase, then inline phase) and
returns a render-agnostic `MarkdownDocument`. `parseInline(text)` exposes the
inline phase alone. `render(node)` HTML-escapes all text and attributes and
sanitizes link `href`s (an unsafe scheme like `javascript:` or `data:` is
dropped), so even hostile content cannot inject markup or script. The parser
handle is stateless and event-free, so it is freely reused.

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

- Rendered `href`s are restricted to a safe scheme allowlist (`http`,
  `https`, `mailto`, `tel`, or scheme-less/relative/anchor links) — anything
  else is dropped.
- All rendered text and attributes are HTML-escaped.
- Parsing and rendering are depth-capped (`MAX_DEPTH`); past that depth the
  parser degrades to literal text instead of recursing further or throwing.

## Guide

For the full surface — the AST shape, the two-phase parse, GFM tables, and
the contract-backed leaf shapes — see
[`guides/src/markdown.md`](guides/src/markdown.md).

## Package

Published as a single typed entry point per the `exports` field in
`package.json`.

## License

MIT © [Orkestrel](https://github.com/orkestrel) — see [LICENSE](./LICENSE).
