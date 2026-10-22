<script lang="ts">
	import { formatCents } from '$lib/money';
	/** A labelled money line: y from zero to the series max, first and last x labels, hover titles per point. */
	/** `ticks`: the points' ISO dates; a label is drawn where the month changes, replacing the first/last-only labels. */
	let { points, height = 200, ticks }: { points: { label: string; value: number }[]; height?: number; ticks?: string[] } = $props();
	const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	const monthTicks = $derived(!ticks ? [] : ticks.flatMap((d, i) => (i === 0 || d.slice(0, 7) !== ticks[i - 1].slice(0, 7)) ? [{ i, label: `${MONTHS[+d.slice(5, 7) - 1]} ${d.slice(0, 4)}` }] : []));
	// The viewBox tracks the frame's pixel width, so one unit is one CSS pixel and labels keep the caption size
	// on a phone and on a wide desktop alike. 720 is only the server-rendered first paint, before the frame is measured.
	let frame = $state(0);
	const W = $derived(frame || 720);
	const PAD_X = 8, PAD_T = 18, PAD_B = 22;
	const max = $derived(Math.max(1, ...points.map((p) => p.value)));
	const min = $derived(Math.min(0, ...points.map((p) => p.value)));
	const x = (i: number) => (points.length < 2 ? W / 2 : PAD_X + (i / (points.length - 1)) * (W - PAD_X * 2));
	const y = (v: number) => height - PAD_B - ((v - min) / (max - min)) * (height - PAD_T - PAD_B);
	const d = $derived(points.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.value)}`).join(' '));
</script>
{#if points.length >= 2}
	<div class="chart-frame" bind:clientWidth={frame}>
		<svg class="chart" viewBox="0 0 {W} {height}">
			<line x1={PAD_X} x2={W - PAD_X} y1={y(0)} y2={y(0)} stroke="var(--line)" />
			{#if min < 0}<text x={W - PAD_X} y={y(min) - 3} text-anchor="end">{formatCents(min)}</text>{/if}
			<line x1={PAD_X} x2={W - PAD_X} y1={y(max)} y2={y(max)} stroke="var(--line)" stroke-dasharray="3 3" />
			<text x={PAD_X} y={PAD_T - 6}>{formatCents(max)}</text>
			<path {d} fill="none" stroke="var(--chart-1)" stroke-width="2" vector-effect="non-scaling-stroke" />
			{#each points as p, i}<circle cx={x(i)} cy={y(p.value)} r="6" fill="transparent"><title>{p.label}: {formatCents(p.value)}</title></circle>{/each}
			{#if monthTicks.length}
				{#each monthTicks as t (t.i)}<line x1={x(t.i)} x2={x(t.i)} y1={y(max)} y2={height - PAD_B} stroke="var(--line)" stroke-dasharray="2 4" /><text x={x(t.i) + 3} y={height - 6}>{t.label}</text>{/each}
			{:else}
				<text x={PAD_X} y={height - 6}>{points[0].label}</text>
				<text x={W - PAD_X} y={height - 6} text-anchor="end">{points[points.length - 1].label}</text>
			{/if}
		</svg>
	</div>
{:else}<p class="muted small">Chart appears once there are two points.</p>{/if}
