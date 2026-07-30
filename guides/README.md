# Guides

A dual-axis index into this repository's guides — by concept, and by directory (AGENTS §22).

## By concept

| Concept  | Spec                                 | Source                    | Tests                                 |
| -------- | ------------------------------------ | ------------------------- | ------------------------------------- |
| Markdown | [`src/markdown.md`](src/markdown.md) | [`src/core`](../src/core) | [`tests/src/core`](../tests/src/core) |

## By directory

| Directory    | Guide                                                                                                                                                            |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core`   | [`src/markdown.md`](src/markdown.md)                                                                                                                             |
| `guides/src` | Dependency mirrors: [`src/contract.md`](src/contract.md), [`src/guide.md`](src/guide.md), [`src/html.md`](src/html.md), and [`src/scaffold.md`](src/scaffold.md) |

## Dependency reference

[`src/html.md`](src/html.md) is a byte-identical mirror of the guide for
`@orkestrel/html` — one of this package's two runtime dependencies. It documents
**that package's** HTML AST, total parser, canonical serializer, sanitize floor,
and `foldNode`, not anything sourced in this repo; it is kept here so a reader of
the two conversion directions can inspect the foundation they compose without
leaving this guide set.

[`src/contract.md`](src/contract.md) is a byte-identical mirror of the guide for
`@orkestrel/contract` — the other runtime dependency. It documents
**that package's** surface (guards, combinators, parsers, and the shape DSL), not
anything sourced in this repo; it is kept here so a reader of the markdown AST
guards, leaf-node shapes, and compiled contracts (`isMarkdownNode`,
`createTextContract`, …) can see the primitives they are built from without
leaving this guide set.

[`src/guide.md`](src/guide.md) is a byte-identical mirror of the guide for
`@orkestrel/guide` — the devDependency powering this repo's guides-parity test
suite (`tests/guides/src/parity.test.ts`). It documents **that package's**
surface (`Guide` / `Source`, the manifest and comparison helpers), not anything
sourced in this repo; it is kept here so a reader of the parity suite can see
the primitives it is built from without leaving this guide set.

[`src/scaffold.md`](src/scaffold.md) is a mirror of the guide for
`@orkestrel/scaffold` — the devDependency that generated this workspace. It
documents **that package's** generator, target selection, and emitted layout,
not anything sourced in this repo; it is kept here so a reader can distinguish
the scaffold contract from this package's own files without leaving this guide
set.

## See also

- [`AGENTS.md`](../AGENTS.md) — the rules; §22 documentation-as-contracts.
