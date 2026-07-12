import type {
	BlockNode,
	MarkdownDocument,
	MarkdownHandlers,
	MarkdownInterface,
	MarkdownNode,
	MarkdownRewriteHandler,
} from './types.js'
import { foldNode, rewriteDocument, walkNodes } from './helpers.js'
import { parseDocument } from './parsers.js'

/**
 * A stateful, parsed markdown document - wraps a typed {@link MarkdownDocument} AST
 * with the query (`find` / `filter` / `reduce` / iteration), rewrite (`map`), fold, and
 * streaming operations {@link MarkdownInterface} declares.
 *
 * @remarks
 * - **Construction.** Given a `string`, the constructor runs {@link parseDocument} (the
 *   block phase then the inline phase) to build the AST. Given a {@link MarkdownDocument},
 *   the document is adopted AS-IS and is NOT re-validated - a caller adopting an
 *   untrusted value should gate it with `isMarkdownDocument` first.
 * - **Immutable.** {@link map} never mutates the stored AST - it returns a NEW `Markdown`
 *   instance; the document root invariant (`element: 'document'`) always holds.
 * - **Traversal order.** `find` / `filter` / `reduce` / the default iterator walk the AST
 *   depth-first, pre-order, root-inclusive (via {@link walkNodes}); `stream` is shallow -
 *   only the document's direct block children.
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

	constructor(input: string | MarkdownDocument) {
		this.#document = typeof input === 'string' ? parseDocument(input) : input
	}

	/** The stored {@link MarkdownDocument} AST root. */
	get document(): MarkdownDocument {
		return this.#document
	}

	// Finds the first node (depth-first, pre-order) narrowed by a type guard.
	find<T extends MarkdownNode>(guard: (node: MarkdownNode) => node is T): T | undefined
	// Finds the first node (depth-first, pre-order) matching a predicate.
	find(predicate: (node: MarkdownNode) => boolean): MarkdownNode | undefined
	find(predicate: (node: MarkdownNode) => boolean): MarkdownNode | undefined {
		for (const node of walkNodes(this.#document)) if (predicate(node)) return node
		return undefined
	}

	// Collects every node (depth-first, pre-order) narrowed by a type guard.
	filter<T extends MarkdownNode>(guard: (node: MarkdownNode) => node is T): readonly T[]
	// Collects every node (depth-first, pre-order) matching a predicate.
	filter(predicate: (node: MarkdownNode) => boolean): readonly MarkdownNode[]
	filter(predicate: (node: MarkdownNode) => boolean): readonly MarkdownNode[] {
		const out: MarkdownNode[] = []
		for (const node of walkNodes(this.#document)) if (predicate(node)) out.push(node)
		return out
	}

	/** Rewrites the AST bottom-up (copy-on-write) and returns a new {@link Markdown}. */
	map(rewrite: MarkdownRewriteHandler): MarkdownInterface {
		return new Markdown(rewriteDocument(this.#document, rewrite))
	}

	/** Folds the AST depth-first, pre-order into an accumulator. */
	reduce<T>(callback: (accumulator: T, node: MarkdownNode) => T, initial: T): T {
		let accumulator = initial
		for (const node of walkNodes(this.#document)) accumulator = callback(accumulator, node)
		return accumulator
	}

	/** Runs a total catamorphism over the document using a {@link MarkdownHandlers} table. */
	fold<T>(handlers: MarkdownHandlers<T>): T {
		return foldNode(this.#document, handlers, 0)
	}

	/** Lazily yields the document's top-level block nodes (shallow, source order). */
	*stream(): Generator<BlockNode> {
		yield* this.#document.children
	}

	/** Iterates every node (depth-first, pre-order, root-inclusive). */
	*[Symbol.iterator](): Iterator<MarkdownNode> {
		yield* walkNodes(this.#document)
	}

	/**
	 * Asynchronously iterates every node (depth-first, pre-order, root-inclusive) -
	 * the same sequence as {@link Symbol.iterator}, one node per microtask.
	 *
	 * @example
	 * ```ts
	 * for await (const node of markdown) {
	 *   // one microtask per node
	 * }
	 * ```
	 */
	async *[Symbol.asyncIterator](): AsyncIterator<MarkdownNode> {
		for (const node of walkNodes(this.#document)) yield await node
	}
}
