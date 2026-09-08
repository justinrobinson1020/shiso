<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { addDays } from '$lib/dates';
	let { range, compare }: { range: { kind: string; start: string; end: string; label: string; prevLabel: string }; compare: boolean } = $props();
	function nav(changes: Record<string, string | null>) {
		const u = new URL(page.url); for (const [k, v] of Object.entries(changes)) { if (v) u.searchParams.set(k, v); else u.searchParams.delete(k); } goto(u.pathname + u.search);
	}
	// Step by the range's own length: anchor moves to the day after `end` (forward) or the day before `start` (back).
	const forward = () => nav({ anchor: addDays(range.end, 1), end: range.kind === 'custom' ? addDays(range.end, 1 + (Date.parse(range.end) - Date.parse(range.start)) / 86400000) : null });
	const back = () => { const len = (Date.parse(range.end) - Date.parse(range.start)) / 86400000; nav({ anchor: addDays(range.start, -(len + 1)), end: range.kind === 'custom' ? addDays(range.start, -1) : null }); };
</script>
<div class="toolbar">
	<select value={range.kind} onchange={(e) => nav({ kind: (e.target as HTMLSelectElement).value, anchor: range.start, end: (e.target as HTMLSelectElement).value === 'custom' ? range.end : null })}>
		{#each ['period', 'month', 'quarter', 'year', 'custom'] as k}<option value={k}>{k}</option>{/each}
	</select>
	<button onclick={back}>←</button><strong>{range.label}</strong><button onclick={forward}>→</button>
	{#if range.kind === 'custom'}<input type="date" value={range.start} onchange={(e) => nav({ anchor: (e.target as HTMLInputElement).value })} /><input type="date" value={range.end} onchange={(e) => nav({ end: (e.target as HTMLInputElement).value })} />{/if}
	<label class="small"><input type="checkbox" checked={compare} onchange={(e) => nav({ compare: (e.target as HTMLInputElement).checked ? '1' : null })} /> compare to {range.prevLabel}</label>
</div>
