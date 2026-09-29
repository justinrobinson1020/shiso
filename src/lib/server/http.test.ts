import { describe, it, expect } from 'vitest';
import { handle, readJson, readOptionalJson, intParam, int, str, ValidationError } from './http';
import { InvariantError, NotFoundError } from './ledger/errors';

const call = (fn: Parameters<typeof handle>[0], body?: unknown) =>
	handle(fn)({ request: new Request('http://x', { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json' } }), params: {} } as never);

describe('handle', () => {
	it('returns json 200 for a value', async () => {
		const res = await call(() => ({ ok: 1 }));
		expect(res.status).toBe(200); expect(await res.json()).toEqual({ ok: 1 });
	});
	it('maps ValidationError to 400, InvariantError to 409, not-found to 404', async () => {
		expect((await call(() => { throw new ValidationError('bad'); })).status).toBe(400);
		const inv = await call(() => { throw new InvariantError('SPLITS_DO_NOT_SUM'); });
		expect(inv.status).toBe(409); expect((await inv.json()).code).toBe('SPLITS_DO_NOT_SUM');
		expect((await call(() => { throw new NotFoundError('transaction 9 not found'); })).status).toBe(404);
	});
	it('does not treat a plain error that mentions "not found" as a 404', async () => {
		await expect(call(() => { throw new Error('file not found'); })).rejects.toThrow('file not found');
	});
	it('rethrows unknown errors', async () => {
		await expect(call(() => { throw new Error('boom'); })).rejects.toThrow('boom');
	});
	it('validates ints and strings; readOptionalJson tolerates a missing or non-object body', async () => {
		expect(int(3, 'n')).toBe(3);
		expect(() => int(1.5, 'n')).toThrow(/integer/);
		expect(() => int('3', 'n')).toThrow(ValidationError);
		expect(str('  a ', 's')).toBe('a');
		expect(() => str('  ', 's')).toThrow(ValidationError);
		expect(() => str(5, 's')).toThrow(ValidationError);
		expect(await readOptionalJson(new Request('http://x', { method: 'POST' }))).toEqual({});
		expect(await readOptionalJson(new Request('http://x', { method: 'POST', body: '[1]' }))).toEqual({});
		expect(await readOptionalJson(new Request('http://x', { method: 'POST', body: '{"mode":"balances"}' }))).toEqual({ mode: 'balances' });
	});
	it('readJson rejects a non-JSON body; intParam parses ids', async () => {
		await expect(readJson(new Request('http://x', { method: 'POST', body: 'nope' }))).rejects.toBeInstanceOf(ValidationError);
		expect(intParam('12', 'id')).toBe(12);
		expect(() => intParam('x', 'id')).toThrow(ValidationError);
		expect(() => intParam(undefined, 'id')).toThrow(ValidationError);
	});
});
