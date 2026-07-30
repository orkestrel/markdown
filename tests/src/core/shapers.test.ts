import type {
	CodeBlockNode,
	CodeSpanNode,
	ListItemParts,
	TableAlign,
	TextNode,
	ThematicBreakNode,
} from '@src/core'
import type { Infer } from '@orkestrel/contract'
import {
	codeBlockShape,
	codeSpanShape,
	isBlockNode,
	listItemPartsShape,
	tableAlignShape,
	textShape,
	thematicBreakShape,
} from '@src/core'
import { arrayShape, createContract, nullableShape, seededRandom } from '@orkestrel/contract'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { TEST_SEED } from '../../setup.js'

// Each shape here compiles (via createContract) into a guard / parser /
// schema / generator that must agree in lockstep (AGENTS §14 / §16). These
// shapes are the non-recursive slice of the markdown AST (types.ts) — every
// field shapes directly, no lazy/self-referential node.

describe('textShape', () => {
	const contract = createContract(textShape)

	it('is: accepts a valid TextNode', () => {
		expect(contract.is({ element: 'text', value: 'hi' })).toBe(true)
	})

	it('is: rejects wrong element, missing field, wrong type, extra key', () => {
		expect(contract.is({ element: 'codeSpan', value: 'hi' })).toBe(false)
		expect(contract.is({ element: 'text' })).toBe(false)
		expect(contract.is({ element: 'text', value: 1 })).toBe(false)
		expect(contract.is({ element: 'text', value: 'hi', extra: true })).toBe(false)
	})

	it('schema: closed object with element literal and required value', () => {
		expect(contract.schema.type).toBe('object')
		expect(contract.schema.required).toEqual(['element', 'value'])
		expect(contract.schema.additionalProperties).toBe(false)
		expect(contract.schema.properties?.element?.enum).toEqual(['text'])
		expect(contract.schema.properties?.value?.type).toBe('string')
	})

	it('generate: round-trips through is and is deterministic per seed', () => {
		const a = contract.generate(seededRandom(TEST_SEED))
		const b = contract.generate(seededRandom(TEST_SEED))
		const c = contract.generate(seededRandom(TEST_SEED + 1))

		expect(contract.is(a)).toBe(true)
		expect(a).toEqual(b)
		expect(a).not.toEqual(c)
	})

	it('parse: valid value parses to a structurally-equal rebuilt value', () => {
		const input = { element: 'text', value: 'hi' }
		const parsed = contract.parse(input)

		expect(parsed).toEqual(input)
		expect(parsed).not.toBe(input)
	})

	it('parse: garbage input parses to undefined', () => {
		expect(contract.parse(null)).toBeUndefined()
		expect(contract.parse({ element: 'text' })).toBeUndefined()
		expect(contract.parse({ element: 'paragraph', value: 'x' })).toBeUndefined()
	})

	it('type parity: Infer<typeof textShape> matches TextNode both ways', () => {
		expectTypeOf<Infer<typeof textShape>>().toEqualTypeOf<TextNode>()
		expectTypeOf<TextNode>().toEqualTypeOf<Infer<typeof textShape>>()
	})
})

describe('codeSpanShape', () => {
	const contract = createContract(codeSpanShape)

	it('is: accepts a valid CodeSpanNode', () => {
		expect(contract.is({ element: 'codeSpan', value: 'const x = 1' })).toBe(true)
	})

	it('is: rejects wrong element, missing field, wrong type, extra key', () => {
		expect(contract.is({ element: 'text', value: 'x' })).toBe(false)
		expect(contract.is({ element: 'codeSpan' })).toBe(false)
		expect(contract.is({ element: 'codeSpan', value: 42 })).toBe(false)
		expect(contract.is({ element: 'codeSpan', value: 'x', lang: 'ts' })).toBe(false)
	})

	it('schema: closed object with element literal and required value', () => {
		expect(contract.schema.type).toBe('object')
		expect(contract.schema.required).toEqual(['element', 'value'])
		expect(contract.schema.additionalProperties).toBe(false)
		expect(contract.schema.properties?.element?.enum).toEqual(['codeSpan'])
	})

	it('generate: round-trips through is and is deterministic per seed', () => {
		const a = contract.generate(seededRandom(TEST_SEED))
		const b = contract.generate(seededRandom(TEST_SEED))

		expect(contract.is(a)).toBe(true)
		expect(a).toEqual(b)
	})

	it('parse: valid value parses to a structurally-equal rebuilt value; garbage → undefined', () => {
		const input = { element: 'codeSpan', value: 'x' }

		expect(contract.parse(input)).toEqual(input)
		expect(contract.parse(input)).not.toBe(input)
		expect(contract.parse({ element: 'codeSpan' })).toBeUndefined()
		expect(contract.parse('nope')).toBeUndefined()
	})

	it('type parity: Infer<typeof codeSpanShape> matches CodeSpanNode both ways', () => {
		expectTypeOf<Infer<typeof codeSpanShape>>().toEqualTypeOf<CodeSpanNode>()
		expectTypeOf<CodeSpanNode>().toEqualTypeOf<Infer<typeof codeSpanShape>>()
	})
})

describe('codeBlockShape', () => {
	const contract = createContract(codeBlockShape)

	it('is: accepts with and without optional lang', () => {
		expect(contract.is({ element: 'codeBlock', code: 'x' })).toBe(true)
		expect(contract.is({ element: 'codeBlock', code: 'x', lang: 'ts' })).toBe(true)
	})

	it('is: rejects wrong element, missing required field, wrong type, extra key', () => {
		expect(contract.is({ element: 'text', code: 'x' })).toBe(false)
		expect(contract.is({ element: 'codeBlock' })).toBe(false)
		expect(contract.is({ element: 'codeBlock', code: 1 })).toBe(false)
		expect(contract.is({ element: 'codeBlock', code: 'x', lang: 5 })).toBe(false)
		expect(contract.is({ element: 'codeBlock', code: 'x', extra: true })).toBe(false)
	})

	it('schema: lang not in required (optional), code is required', () => {
		expect(contract.schema.type).toBe('object')
		expect(contract.schema.required).toEqual(['element', 'code'])
		expect(contract.schema.required).not.toContain('lang')
		expect(contract.schema.additionalProperties).toBe(false)
	})

	it('generate: round-trips through is and is deterministic per seed', () => {
		const a = contract.generate(seededRandom(TEST_SEED))
		const b = contract.generate(seededRandom(TEST_SEED))

		expect(contract.is(a)).toBe(true)
		expect(a).toEqual(b)
	})

	it('parse: valid value (with and without lang) parses to a structurally-equal rebuilt value; garbage → undefined', () => {
		const withoutLang = { element: 'codeBlock', code: 'x' }
		const withLang = { element: 'codeBlock', code: 'x', lang: 'ts' }

		expect(contract.parse(withoutLang)).toEqual(withoutLang)
		expect(contract.parse(withLang)).toEqual(withLang)
		expect(contract.parse(withLang)).not.toBe(withLang)
		expect(contract.parse({ element: 'codeBlock' })).toBeUndefined()
	})

	it('type parity: Infer<typeof codeBlockShape> matches CodeBlockNode both ways', () => {
		expectTypeOf<Infer<typeof codeBlockShape>>().toEqualTypeOf<CodeBlockNode>()
		expectTypeOf<CodeBlockNode>().toEqualTypeOf<Infer<typeof codeBlockShape>>()
	})
})

describe('thematicBreakShape', () => {
	const contract = createContract(thematicBreakShape)

	it('is: accepts a valid ThematicBreakNode', () => {
		expect(contract.is({ element: 'thematicBreak' })).toBe(true)
	})

	it('is: rejects wrong element, wrong type, extra key', () => {
		expect(contract.is({ element: 'text' })).toBe(false)
		expect(contract.is('thematicBreak')).toBe(false)
		expect(contract.is({ element: 'thematicBreak', extra: true })).toBe(false)
	})

	it('schema: closed object with only the element literal required', () => {
		expect(contract.schema.type).toBe('object')
		expect(contract.schema.required).toEqual(['element'])
		expect(contract.schema.additionalProperties).toBe(false)
		expect(contract.schema.properties?.element?.enum).toEqual(['thematicBreak'])
	})

	it('generate: round-trips through is and is deterministic per seed', () => {
		const a = contract.generate(seededRandom(TEST_SEED))
		const b = contract.generate(seededRandom(TEST_SEED))

		expect(contract.is(a)).toBe(true)
		expect(a).toEqual(b)
		expect(a).toEqual({ element: 'thematicBreak' })
	})

	it('parse: valid value parses to a structurally-equal rebuilt value; garbage → undefined', () => {
		const input = { element: 'thematicBreak' }

		expect(contract.parse(input)).toEqual(input)
		expect(contract.parse(input)).not.toBe(input)
		expect(contract.parse({ element: 'heading' })).toBeUndefined()
		expect(contract.parse(undefined)).toBeUndefined()
	})

	it('type parity: Infer<typeof thematicBreakShape> matches ThematicBreakNode both ways', () => {
		expectTypeOf<Infer<typeof thematicBreakShape>>().toEqualTypeOf<ThematicBreakNode>()
		expectTypeOf<ThematicBreakNode>().toEqualTypeOf<Infer<typeof thematicBreakShape>>()
	})
})

describe('tableAlignShape', () => {
	const contract = createContract(tableAlignShape)

	it('is: accepts each allowed literal, rejects other values', () => {
		expect(contract.is('left')).toBe(true)
		expect(contract.is('right')).toBe(true)
		expect(contract.is('center')).toBe(true)
		expect(contract.is('top')).toBe(false)
		expect(contract.is('')).toBe(false)
		expect(contract.is(1)).toBe(false)
		expect(contract.is(undefined)).toBe(false)
	})

	it('schema: enum of the three alignment literals', () => {
		expect(contract.schema.enum).toEqual(['left', 'right', 'center'])
	})

	it('generate: round-trips through is and is deterministic per seed', () => {
		const a = contract.generate(seededRandom(TEST_SEED))
		const b = contract.generate(seededRandom(TEST_SEED))

		expect(contract.is(a)).toBe(true)
		expect(a).toBe(b)
	})

	it('parse: an allowed literal parses by identity; garbage → undefined', () => {
		expect(contract.parse('left')).toBe('left')
		expect(contract.parse('top')).toBeUndefined()
		expect(contract.parse(1)).toBeUndefined()
	})

	it('type parity: Infer<typeof tableAlignShape> matches TableAlign both ways', () => {
		expectTypeOf<Infer<typeof tableAlignShape>>().toEqualTypeOf<TableAlign>()
		expectTypeOf<TableAlign>().toEqualTypeOf<Infer<typeof tableAlignShape>>()
	})
})

describe('table alignment array contract', () => {
	const contract = createContract(arrayShape(nullableShape(tableAlignShape), { min: 1, max: 1 }))

	it('accepts null entries and rejects undefined entries in the table guard', () => {
		expect(isBlockNode({ element: 'table', header: [], rows: [], align: [null] })).toBe(true)
		expect(isBlockNode({ element: 'table', header: [], rows: [], align: [undefined] })).toBe(false)
	})

	it('generates alignment arrays accepted by the table guard', () => {
		const align = contract.generate(seededRandom(0))
		const table = { element: 'table', header: [], rows: [], align }

		expect(align).toEqual([null])
		expect(contract.is(align)).toBe(true)
		expect(isBlockNode(table)).toBe(true)
	})
})

describe('listItemPartsShape', () => {
	const contract = createContract(listItemPartsShape)
	const valid = { ordered: false, start: 1, content: 'hi', indent: 0, marker: 2 }

	it('is: accepts a valid ListItemParts value', () => {
		expect(contract.is(valid)).toBe(true)
		expect(contract.is({ ...valid, ordered: true, start: 3 })).toBe(true)
	})

	it('is: rejects missing field, wrong type, extra key', () => {
		const { ordered: _ordered, ...missingOrdered } = valid
		expect(contract.is(missingOrdered)).toBe(false)
		expect(contract.is({ ...valid, ordered: 'false' })).toBe(false)
		expect(contract.is({ ...valid, content: 1 })).toBe(false)
		expect(contract.is({ ...valid, extra: true })).toBe(false)
	})

	it('schema: closed object with all five fields required', () => {
		expect(contract.schema.type).toBe('object')
		expect(contract.schema.required).toEqual(['ordered', 'start', 'content', 'indent', 'marker'])
		expect(contract.schema.additionalProperties).toBe(false)
		expect(contract.schema.properties?.start?.type).toBe('integer')
		expect(contract.schema.properties?.indent?.type).toBe('integer')
		expect(contract.schema.properties?.marker?.type).toBe('integer')
		expect(contract.schema.properties?.ordered?.type).toBe('boolean')
		expect(contract.schema.properties?.content?.type).toBe('string')
	})

	it('generate: round-trips through is and is deterministic per seed', () => {
		const a = contract.generate(seededRandom(TEST_SEED))
		const b = contract.generate(seededRandom(TEST_SEED))
		const c = contract.generate(seededRandom(TEST_SEED + 1))

		expect(contract.is(a)).toBe(true)
		expect(a).toEqual(b)
		expect(a).not.toEqual(c)
	})

	it('parse: valid value parses to a structurally-equal rebuilt value; numeric-string integer fields coerce; garbage → undefined', () => {
		expect(contract.parse(valid)).toEqual(valid)
		expect(contract.parse(valid)).not.toBe(valid)
		expect(contract.parse({ ...valid, start: '1', indent: '0', marker: '2' })).toEqual(valid)
		expect(contract.parse({ ...valid, start: '1.5' })).toBeUndefined()
		expect(contract.parse({ ...valid, content: {} })).toBeUndefined()
		expect(contract.parse(null)).toBeUndefined()
	})

	it('type parity: Infer<typeof listItemPartsShape> matches ListItemParts both ways', () => {
		expectTypeOf<Infer<typeof listItemPartsShape>>().toEqualTypeOf<ListItemParts>()
		expectTypeOf<ListItemParts>().toEqualTypeOf<Infer<typeof listItemPartsShape>>()
	})
})
