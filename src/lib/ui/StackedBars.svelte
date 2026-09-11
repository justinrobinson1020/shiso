<script lang="ts">
	import { formatCents } from '$lib/money';
	let { buckets, categories, compare }: { buckets: { key: string; label: string; total: number; prevTotal: number | null; byCategory: Record<string, number>; future?: boolean }[]; categories: { id: number; name: string }[]; compare: boolean } = $props();
	const PALETTE = Array.from({ length: 9 }, (_, i) => `var(--chart-${i + 1})`);
	const W = 720, H = 260, PAD = 36, BW = $derived(Math.max(8, (W - PAD * 2) / Math.max(buckets.length, 1) - 8));
	// Only positive segments stack visually, so `max` must track the tallest positive stack —
	// not the net total, which a bucket with refunds can understate or (mixed with positives) overstate.
	const positiveStack = (b: { byCategory: Record<string, number> }) => Object.values(b.byCategory).reduce((s, v) => s + Math.max(0, v), 0);
	const max = $derived(Math.max(1, ...buckets.map((b) => Math.max(positiveStack(b), Math.max(0, b.prevTotal ?? 0)))));
	const y = (v: number) => H - PAD - (v / max) * (H - PAD * 2);
	const yClamped = (v: number) => Math.min(H - PAD, Math.max(PAD, y(v)));
	const x = (i: number) => PAD + i * ((W - PAD * 2) / Math.max(buckets.length, 1)) + 4;
	const keyOf = (c: { id: number }) => (c.id === 0 ? 'other' : String(c.id));
	// The total line stops at the last bucket that has begun; a future bucket has nothing to report yet.
	const linePath = $derived(buckets.filter((b) => !b.future).map((b, i) => `${i ? 'L' : 'M'}${x(i) + BW / 2},${yClamped(b.total)}`).join(' '));
	const prevPath = $derived(buckets.every((b) => b.prevTotal != null) ? buckets.map((b, i) => `${i ? 'L' : 'M'}${x(i) + BW / 2},${yClamped(b.prevTotal!)}`).join(' ') : '');
</script>
<svg class="chart" viewBox="0 0 {W} {H}">
	{#each buckets as b, i}
		{@const segs = categories.map((c) => ({ c, v: b.byCategory[keyOf(c)] ?? 0 }))}
		{@const refunds = segs.filter((s) => s.v < 0)}
		<g>
			{#if refunds.length}<title>{refunds.map((s) => `refunds: ${s.c.name} ${formatCents(s.v)}`).join(', ')}</title>{/if}
			{#each segs as s, j}
				{#if s.v > 0}
					{@const prior = segs.slice(0, j).reduce((a, q) => a + Math.max(0, q.v), 0)}
					<rect x={x(i)} y={y(prior + s.v)} width={BW} height={y(prior) - y(prior + s.v)} fill={PALETTE[j % PALETTE.length]}><title>{b.label} · {s.c.name}: {formatCents(s.v)}</title></rect>
				{/if}
			{/each}
			<text x={x(i) + BW / 2} y={H - PAD + 14} text-anchor="middle" font-size="10" fill="var(--muted)" opacity={b.future ? 0.5 : 1}>{b.label}</text>
		</g>
	{/each}
	{#if compare && prevPath}<path d={prevPath} fill="none" stroke="var(--muted)" stroke-width="1.5" stroke-dasharray="4 3" opacity=".6" />{/if}
	<path d={linePath} fill="none" stroke="var(--fg)" stroke-width="1.5" />
	<text x={PAD} y={PAD - 8} font-size="10" fill="var(--muted)">{formatCents(max)}</text>
</svg>
<div class="legend">{#each categories as c, j}<span><i style="background:{PALETTE[j % PALETTE.length]}"></i>{c.name}</span>{/each}{#if compare}<span><i style="background:var(--muted);opacity:.6"></i>previous range</span>{/if}</div>
