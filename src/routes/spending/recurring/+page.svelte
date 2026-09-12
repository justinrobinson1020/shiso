<script lang="ts">
	import { goto } from '$app/navigation';
	import SortTh from '$lib/ui/SortTh.svelte';
	import { sortRows, type SortState } from '$lib/ui/sort';
	let sortRec = $state<SortState>(null);
	const recPick = (r: (typeof v.rows)[number], k: string) => (k === 'status' ? (r.overdue ? 'overdue' : r.covered ? 'covered' : 'new') : (r as unknown as Record<string, string | number | null>)[k]);
	import { page } from '$app/state';
	import Money from '$lib/ui/Money.svelte';
	import { shortDate } from '$lib/dates';
	let { data } = $props();
	const v = $derived(data.view);
	let newOnly = $state(true);
	const rows = $derived(newOnly ? v.rows.filter((r) => !r.covered) : v.rows);
	function setParam(k: string, val: string | null) { const u = new URL(page.url); if (val) u.searchParams.set(k, val); else u.searchParams.delete(k); goto(u.pathname + u.search); }
	const ledgerLink = (payee: string) => `/ledger?q=${encodeURIComponent(payee)}&from=${v.windowStart}&to=${v.windowEnd}`;
</script>

<div class="toolbar">
	<h1>Recurring charges</h1>
	<a href="/spending" class="small">← Spending</a>
	<label class="small"><input type="checkbox" bind:checked={newOnly} /> new only</label>
	<label class="small"><input type="checkbox" checked={v.includeExcluded} onchange={(e) => setParam('all', (e.target as HTMLInputElement).checked ? '1' : null)} /> include bills, debt payments, transfers, income</label>
</div>

<dl class="facts">
	<div><dt>Recurring per month</dt><dd><Money cents={v.totals.monthly} /><div class="small muted">{v.totals.count} payees</div></dd></div>
	<div><dt>Not yet a bill</dt><dd><Money cents={v.totals.newMonthly} /><div class="small muted">{v.totals.newCount} payees</div></dd></div>
	<div><dt>Overdue</dt><dd>{v.totals.overdue}<div class="small muted">expected and not seen</div></dd></div>
</dl>

<table class="block">
	<thead><tr><SortTh key="payee" label="Payee" kind="text" bind:sort={sortRec} /><SortTh key="cadence" label="Cadence" kind="text" class="hide-sm" bind:sort={sortRec} /><SortTh key="typical" label="Typical" kind="number" class="num" bind:sort={sortRec} /><SortTh key="monthlyCost" label="Per month" kind="number" class="num" bind:sort={sortRec} /><SortTh key="last" label="Last" kind="date" class="hide-sm" bind:sort={sortRec} /><SortTh key="next" label="Next" kind="date" bind:sort={sortRec} /><SortTh key="status" label="Status" kind="text" bind:sort={sortRec} /></tr></thead>
	<tbody>
	{#each sortRows(rows, sortRec, recPick) as r (r.payee)}
		<tr>
			<td><a href={ledgerLink(r.payee)}>{r.payee}</a><div class="small muted only-sm">{r.cadence} · last {shortDate(r.last)} · {r.count} charges</div><div class="small muted hide-sm">{r.count} charges, {r.matched} of {r.intervals} intervals on cadence</div></td>
			<td class="hide-sm">{r.cadence}</td>
			<td class="num"><Money cents={r.typical} /></td>
			<td class="num"><Money cents={r.monthlyCost} /></td>
			<td class="hide-sm date">{shortDate(r.last)}</td>
			<td class="date">{shortDate(r.next)}</td>
			<td>{#if r.overdue}<span class="status overdue">overdue</span>{/if} {#if r.covered}<span class="status paid">bill</span>{:else}<span class="status pending">new</span>{/if}</td>
		</tr>
	{:else}
		<tr><td colspan="7" class="muted">{newOnly && v.rows.length ? 'Every recurring payee already has a bill.' : 'No recurring charges found in the last twelve months.'}</td></tr>
	{/each}
	</tbody>
</table>
<p class="small muted">A payee is recurring when at least three charges (two for yearly) land on a weekly, biweekly, monthly, quarterly, or yearly interval and their amounts stay within 15% of the median. "Bill" means an active bill's name or match pattern covers the payee. Window: {v.windowStart} to {v.windowEnd}.</p>
