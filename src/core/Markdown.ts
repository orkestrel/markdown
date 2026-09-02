import type {
	BlockNode,
	MarkdownDocument,
	MarkdownHandlers,
	MarkdownInterface,
	MarkdownNode,
	MarkdownRewriteHandler,
	MarkdownSpan,
} from './types.js'
import { foldNode, rewriteDocument, walkNodes } from './helpers.js'
import { parseProvenance } from './parsers.js'

/**
 * Wraps a typed {@link MarkdownDocument} AST as a stateful, parsed markdown document
 * with the query (`find` / `filter` / `reduce` / iteration), rewrite (`map`), fold, and
 * streaming operations {@link MarkdownInterface} declares.
 *
 * @remarks
 * - **Construction.** Given a `string`, the constructor runs {@link parseProvenance} (the
 *   block phase then the inline phase) once, keeping the AST and a COPY of the span map
 *   that parse recorded. Given a {@link MarkdownDocument}, the document is adopted AS-IS
 *   and is NOT re-validated - gate an untrusted value with `isMarkdownDocument` first.
 * - **Provenance.** {@link span} reads the region of the ORIGINAL constructor string a
 *   node was produced from, and it is handle-relative: a string-constructed handle exposes
 *   the regions of the nodes it parsed, an adopted document exposes none, and a node from
 *   another handle reports `undefined` here whatever that handle reports. Each call
 *   returns a fresh value. A node reports the region THIS handle holds for its identity,
 *   else the region of the direct input a rewrite named for it, else `undefined`: a text
 *   run the parse joined from adjacent scanner output reports the region enclosing its
 *   parts, and only a rewrite output that holds no region of its own and was assembled
 *   from separate source nodes reports `undefined`.
 *   {@link map} carries provenance across the rewrite: an unchanged node keeps its
 *   region, a one-source replacement takes the region of the node it replaced, and a
 *   rebuilt parent takes its original's.
 * - **Immutable.** {@link map} never mutates the stored AST - it returns a NEW `Markdown`
 *   instance; the document root invariant (`element: 'document'`) always holds. An
 *   identity rewrite still returns a new handle, over the same document tree.
 * - **Traversal order.** {@link walk} and the `find` / `filter` / `reduce` queries built
 *   on it walk the AST depth-first, pre-order, root-inclusive (through {@link walkNodes});
 *   `stream` is shallow - only the document's direct block children.
 *
 * @example
 * ```ts
 * import { Markdown, isHeadingNode, renderMarkdown } from '@src/core'
 *
 * const markdown = new Markdown('# Title\n\nA **bold** [link](https://x.dev).')
 * const heading = markdown.find(isHeadingNode) // the HeadingNode, or undefined
 * const shouted = markdown.map((node) =>
 *   node.element === 'text' ? { element: 'text', value: node.value.toUpperCase() } : node,
 * )
 * renderMarkdown(shouted.document) // '# TITLE\n\nA **BOLD** [LINK](https://x.dev).'
 * ```
 */
export class Markdown implements MarkdownInterface {
	readonly #document: MarkdownDocument
	readonly #spans: Map<MarkdownNode, MarkdownSpan>

	constructor(input: string | MarkdownDocument) {
		if (typeof input === 'string') {
			const [document, spans] = parseProvenance(input)
			this.#document = document
			this.#spans = new Map(spans)
		} else {
			this.#document = input
			this.#spans = new Map()
		}
	}

	/** Holds the stored {@link MarkdownDocument} AST root. */
	get document(): MarkdownDocument {
		return this.#document
	}

	/**
	 * Reads the region of the original markdown string a node of this handle's tree was
	 * produced from.
	 *
	 * @param node - The node whose provenance to read
	 * @returns A fresh {@link MarkdownSpan}, or `undefined` when this handle holds no
	 * region for the node
	 *
	 * @example
	 * ```ts
	 * const source = '# Title\n\npara'
	 * const markdown = new Markdown(source)
	 * const heading = markdown.find(isHeadingNode)
	 * const span = heading && markdown.span(heading)
	 * span && source.slice(span.start, span.end) // '# Title'
	 * ```
	 */
	span(node: MarkdownNode): MarkdownSpan | undefined {
		const span = this.#spans.get(node)
		return span === undefined ? undefined : { start: span.start, end: span.end }
	}

	/**
	 * Returns THE deep traversal - a lazy, depth-first, pre-order, root-inclusive generator
	 * over every {@link MarkdownNode} in the document. `find` / `filter` / `reduce`
	 * all iterate this single traversal.
	 *
	 * @example
	 * ```ts
	 * for (const node of markdown.walk()) {
	 *   // every node, depth-first, pre-order, root-inclusive
	 * }
	 *
	 * // also consumable by for-await - JS accepts a sync iterable in for-await
	 * for await (const node of markdown.walk()) {
	 *   // same sequence, no separate async iterator needed
	 * }
	 * ```
	 */
	*walk(): Generator<MarkdownNode> {
		yield* walkNodes(this.#document)
	}

	// Finds the first node (depth-first, pre-order) narrowed by a type guard.
	find<T extends MarkdownNode>(guard: (node: MarkdownNode) => node is T): T | undefined
	// Finds the first node (depth-first, pre-order) matching a predicate.
	find(predicate: (node: MarkdownNode) => boolean): MarkdownNode | undefined
	find(predicate: (node: MarkdownNode) => boolean): MarkdownNode | undefined {
		for (const node of this.walk()) if (predicate(node)) return node
		return undefined
	}

	// Collects every node (depth-first, pre-order) narrowed by a type guard.
	filter<T extends MarkdownNode>(guard: (node: MarkdownNode) => node is T): readonly T[]
	// Collects every node (depth-first, pre-order) matching a predicate.
	filter(predicate: (node: MarkdownNode) => boolean): readonly MarkdownNode[]
	filter(predicate: (node: MarkdownNode) => boolean): readonly MarkdownNode[] {
		const out: MarkdownNode[] = []
		for (const node of this.walk()) if (predicate(node)) out.push(node)
		return out
	}

	/**
	 * Rewrites the AST bottom-up (copy-on-write) and returns a new {@link Markdown},
	 * carrying each output node's provenance across the rewrite. A rewrite that returns
	 * its node unchanged shares that subtree instead of copying it, so an identity
	 * rewrite copies no node and still returns a new handle.
	 *
	 * @param rewrite - The bottom-up node rewrite
	 * @returns A new handle over the rewritten document
	 */
	map(rewrite: MarkdownRewriteHandler): MarkdownInterface {
		const [document, derivations] = rewriteDocument(this.#document, rewrite)
		return this.#derive(document, derivations)
	}

	/** Folds the AST depth-first, pre-order into an accumulator. */
	reduce<T>(callback: (accumulator: T, node: MarkdownNode) => T, initial: T): T {
		let accumulator = initial
		for (const node of this.walk()) accumulator = callback(accumulator, node)
		return accumulator
	}

	/** Runs a total catamorphism over the document using a {@link MarkdownHandlers} table. */
	fold<T>(handlers: MarkdownHandlers<T>): T {
		return foldNode(this.#document, handlers, 0)
	}

	/**
	 * Returns a web-standard {@link ReadableStream} over the document's top-level block nodes
	 * (shallow, source order) - a fresh, pull-based source per call: one block is
	 * enqueued per `pull`, so a slow reader's backpressure is respected. Cancellable,
	 * async-iterable wherever the platform supports it (Node, Deno), and pipeable
	 * through any {@link TransformStream} / {@link WritableStream}.
	 *
	 * @example
	 * ```ts
	 * // universal - works in every ReadableStream-supporting environment
	 * const reader = markdown.stream().getReader()
	 * for (let result = await reader.read(); !result.done; result = await reader.read()) {
	 *   console.log(result.value) // one BlockNode
	 * }
	 *
	 * // Node / Deno / Firefox support async iteration of ReadableStream natively;
	 * // other environments use the reader loop shown earlier.
	 * for await (const block of markdown.stream()) {
	 *   console.log(block)
	 * }
	 * ```
	 */
	stream(): ReadableStream<BlockNode> {
		const blocks = this.#document.children
		let index = 0
		return new ReadableStream<BlockNode>({
			pull(controller) {
				if (index < blocks.length) {
					const block = blocks[index]
					if (block === undefined) {
						controller.close()
						return
					}
					controller.enqueue(block)
					index += 1
				} else {
					controller.close()
				}
			},
		})
	}

	// Creates the operation's new handle and resolves each output against its own prior
	// span before its direct input's prior span. The source handle already resolved every
	// earlier rewrite, so following the input's separate output entry from this operation
	// would conflate two roles held by one identity.
	#derive(
		document: MarkdownDocument,
		derivations: ReadonlyMap<MarkdownNode, MarkdownNode | undefined>,
	): Markdown {
		const derived = new Markdown(document)
		for (const node of walkNodes(document)) {
			const own = this.#spans.get(node)
			if (own !== undefined) {
				derived.#spans.set(node, own)
				continue
			}
			const source = derivations.get(node)
			if (source === undefined) continue
			const span = this.#spans.get(source)
			if (span !== undefined) derived.#spans.set(node, span)
		}
		return derived
	}
}
