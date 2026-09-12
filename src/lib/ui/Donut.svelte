<script lang="ts">
	import { formatCents } from '$lib/money';
	import { donutSlices } from './donut';
	/** Spending by category for one range: a ring of the top slices plus Other, with a legend of amount and share. */
	let { rows, total, label }: { rows: { id: number; name: string; amount: number }[]; total: number; label: string } = $props();
	const slices = $derived(donutSlices(rows));
</script>

{#if slices.length}
	<div class="donut">
		<svg viewBox="0 0 220 220" role="img" aria-label="{label}: spending by category">
			{#each slices as s (s.name)}<path d={s.path} fill={s.color}><title>{s.name}: {formatCents(s.amount)} ({(s.share * 100).toFixed(1)}%)</title></path>{/each}
			<text x="110" y="104" text-anchor="middle" font-size="11" fill="var(--muted)">{label}</text>
			<text x="110" y="124" text-anchor="middle" font-size="16" font-weight="600" fill="currentColor">{formatCents(total)}</text>
		</svg>
		<ul class="legend">
			{#each slices as s (s.name)}
				<li><i style="background:{s.color}"></i><span class="name">{s.name}</span><span class="num">{formatCents(s.amount)}</span><span class="muted small">{(s.share * 100).toFixed(1)}%</span></li>
			{/each}
		</ul>
	</div>
{:else}<p class="muted small">Nothing spent in this range.</p>{/if}

<style>
	.donut { display: flex; gap: 1.5rem; align-items: center; flex-wrap: wrap; }
	.donut svg { width: 220px; height: 220px; flex: none; }
	.legend { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: auto 1fr auto auto; gap: 0.25rem 0.6rem; align-items: center; flex: 1; min-width: 240px; }
	.legend li { display: contents; }
	.legend i { display: inline-block; width: 0.7em; height: 0.7em; border-radius: 2px; }
	.legend .num { text-align: right; font-variant-numeric: tabular-nums; }
	@media (max-width: 480px) { .donut svg { width: 160px; height: 160px; } }
</style>
