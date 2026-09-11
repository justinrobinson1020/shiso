<script lang="ts">
	import { formatCents } from '$lib/money';
	/** A labelled money line: y from zero to the series max, first and last x labels, hover titles per point. */
	let { points, height = 200 }: { points: { label: string; value: number }[]; height?: number } = $props();
	const W = 720, PAD_X = 8, PAD_T = 18, PAD_B = 22;
	const max = $derived(Math.max(1, ...points.map((p) => p.value)));
	const x = (i: number) => (points.length < 2 ? W / 2 : PAD_X + (i / (points.length - 1)) * (W - PAD_X * 2));
	const y = (v: number) => height - PAD_B - (v / max) * (height - PAD_T - PAD_B);
	const d = $derived(points.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.value)}`).join(' '));
</script>
{#if points.length >= 2}
	<svg class="chart" viewBox="0 0 {W} {height}">
		<line x1={PAD_X} x2={W - PAD_X} y1={y(0)} y2={y(0)} stroke="var(--line)" />
		<line x1={PAD_X} x2={W - PAD_X} y1={y(max)} y2={y(max)} stroke="var(--line)" stroke-dasharray="3 3" />
		<text x={PAD_X} y={PAD_T - 6} font-size="10" fill="var(--muted)">{formatCents(max)}</text>
		<path {d} fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke" />
		{#each points as p, i}<circle cx={x(i)} cy={y(p.value)} r="6" fill="transparent"><title>{p.label}: {formatCents(p.value)}</title></circle>{/each}
		<text x={PAD_X} y={height - 6} font-size="10" fill="var(--muted)">{points[0].label}</text>
		<text x={W - PAD_X} y={height - 6} font-size="10" fill="var(--muted)" text-anchor="end">{points[points.length - 1].label}</text>
	</svg>
{:else}<p class="muted small">Chart appears once there are two points.</p>{/if}
