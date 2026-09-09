import { describe, it, expect } from 'vitest';
import { fixture } from '../server/test/fixture';
import { resolveRange, type RangeKind } from '$lib/server/read/spending';
import { stepBack, stepForward } from './rangeStep';

describe('rangeStep', () => {
	const cases: { desc: string; kind: RangeKind; anchor: string; end?: string }[] = [
		{ desc: 'month', kind: 'month', anchor: '2026-03-10' },
		{ desc: 'quarter', kind: 'quarter', anchor: '2026-07-10' },
		{ desc: 'period', kind: 'period', anchor: '2026-03-08' },
		{ desc: 'custom', kind: 'custom', anchor: '2026-09-01', end: '2026-09-10' }
	];

	for (const c of cases) {
		it(`${c.desc}: back lands on the resolver's previous range, forward's previous range is the current one`, () => {
			const f = fixture();
			const r = resolveRange(f.db, { kind: c.kind, anchor: c.anchor, end: c.end, cadence: 'semi_monthly' });

			const back = stepBack(r);
			const backResolved = resolveRange(f.db, { kind: r.kind, anchor: back.anchor, end: back.end, cadence: 'semi_monthly' });
			expect(backResolved.start).toBe(r.prevStart);

			const fwd = stepForward(r);
			const fwdResolved = resolveRange(f.db, { kind: r.kind, anchor: fwd.anchor, end: fwd.end, cadence: 'semi_monthly' });
			expect(fwdResolved.prevStart).toBe(r.start);
		});
	}
});
