/** Keeps a block parse's line cursor and its unconsumed lookahead. */
export class MarkdownLineIterator extends Iterator<number> {
	readonly #indices: IteratorObject<number>
	#lookahead: IteratorResult<number>

	constructor(indices: IteratorObject<number>) {
		super()
		this.#indices = indices
		this.#lookahead = indices.next()
	}

	get value(): number | undefined {
		return this.#lookahead.done ? undefined : this.#lookahead.value
	}

	next(): IteratorResult<number> {
		const result = this.#lookahead
		if (!result.done) this.#lookahead = this.#indices.next()
		return result
	}
}
