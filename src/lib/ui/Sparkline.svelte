<script lang="ts">
	let { points, height = 60 }: { points: { asOf: string; current: number }[]; height?: number } = $props();
	const w = 320;
	const d = $derived.by(() => {
		if (points.length < 2) return '';
		// Anchored at zero: a min-to-max scale makes a steady $5 category swing as hard as a $500 one.
		const ys = points.map((p) => p.current); const min = Math.min(0, ...ys), max = Math.max(...ys), span = max - min || 1;
		return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${(i / (points.length - 1)) * w},${height - 4 - ((p.current - min) / span) * (height - 8)}`).join(' ');
	});
</script>
{#if points.length >= 2}
	<svg class="chart" viewBox="0 0 {w} {height}" preserveAspectRatio="none"><path d={d} fill="none" stroke="var(--chart-1)" stroke-width="2" vector-effect="non-scaling-stroke" /></svg>
{:else}<p class="muted small">Trend appears once two balance snapshots exist.</p>{/if}
