import { MarkdownLineIterator } from '../../../src/core/MarkdownLineIterator.js'
import { describe, expect, it } from 'vitest'

describe('MarkdownLineIterator', () => {
	it('retains the next line across block boundaries', () => {
		const indices = new MarkdownLineIterator(['a', 'b', 'c'].keys())
		expect(indices.value).toBe(0)
		expect(indices.next()).toEqual({ value: 0, done: false })
		expect(indices.value).toBe(1)
		expect(indices.toArray()).toEqual([1, 2])
		expect(indices.value).toBeUndefined()
		expect(indices.next().done).toBe(true)
	})
})
