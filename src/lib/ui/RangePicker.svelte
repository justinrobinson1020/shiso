<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { stepBack, stepForward } from './rangeStep';
	let { range, compare }: { range: { kind: string; start: string; end: string; label: string; prevStart: string; prevEnd: string; prevLabel: string }; compare: boolean } = $props();
	function nav(changes: Record<string, string | null>) {
		const u = new URL(page.url); for (const [k, v] of Object.entries(changes)) { if (v) u.searchParams.set(k, v); else u.searchParams.delete(k); } goto(u.pathname + u.search);
	}
	// forward steps to the day after `end`; back steps to the resolver's own previous range (`prevStart`/`prevEnd`),
	// since ranges (months, quarters, semi-monthly periods) vary in length and a day-count step can skip one.
	const forward = () => nav(stepForward(range));
	const back = () => nav(stepBack(range));
</script>
<div class="toolbar range-toolbar">
	<select value={range.kind} onchange={(e) => nav({ kind: e.currentTarget.value, anchor: range.start, end: e.currentTarget.value === 'custom' ? range.end : null })}>
		{#each ['period', 'month', 'quarter', 'year', 'custom'] as k}<option value={k}>{k}</option>{/each}
	</select>
	<button onclick={back}>←</button><strong>{range.label}</strong><button onclick={forward}>→</button>
	{#if range.kind === 'custom'}<input type="date" value={range.start} onchange={(e) => nav({ anchor: e.currentTarget.value })} /><input type="date" value={range.end} onchange={(e) => nav({ end: e.currentTarget.value })} />{/if}
	<label class="small"><input type="checkbox" checked={compare} onchange={(e) => nav({ compare: e.currentTarget.checked ? '1' : null })} /> compare to {range.prevLabel}</label>
</div>
