<script lang="ts">
	let { points, height = 60 }: { points: { asOf: string; current: number }[]; height?: number } = $props();
	const w = 320;
	const d = $derived.by(() => {
		if (points.length < 2) return '';
		const ys = points.map((p) => p.current); const min = Math.min(...ys), max = Math.max(...ys), span = max - min || 1;
		return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${(i / (points.length - 1)) * w},${height - 4 - ((p.current - min) / span) * (height - 8)}`).join(' ');
	});
</script>
{#if points.length >= 2}
	<svg class="chart" viewBox="0 0 {w} {height}" preserveAspectRatio="none"><path d={d} fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke" /></svg>
{:else}<p class="muted small">Trend appears once two balance snapshots exist.</p>{/if}
