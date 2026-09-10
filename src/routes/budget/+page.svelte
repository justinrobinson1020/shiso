<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import Money from '$lib/ui/Money.svelte';
	import Dialog from '$lib/ui/Dialog.svelte';
	import { post } from '$lib/ui/api';
	import { decimalToCents, formatCents } from '$lib/money';
	let { data } = $props();
	const v = $derived(data.view);
	let error = $state(''); let showHidden = $state(false);
	let move = $state<{ from: number; to: number | null; amount: string } | null>(null);
	const allCats = $derived(v.groups.flatMap((g) => g.categories));

	async function assignTo(categoryId: number, dollars: string) {
		error = '';
		try { await post('/api/budget/assign', { periodId: v.period.id, categoryId, assigned: decimalToCents(dollars || '0') }); await invalidateAll(); }
		catch (e) { error = (e as Error).message; }
	}
	async function doMove() {
		if (!move || move.to == null) return; error = '';
		try { await post('/api/budget/move', { periodId: v.period.id, fromCategoryId: move.from, toCategoryId: move.to, amount: decimalToCents(move.amount) }); move = null; await invalidateAll(); }
		catch (e) { error = (e as Error).message; }
	}
	const dollars = (c: number) => (c / 100).toFixed(2);
</script>

<div class="toolbar">
	<h1>Budget</h1>
	<select value={v.period.id} onchange={(e) => goto(`/budget?period=${(e.target as HTMLSelectElement).value}`)}>
		{#each v.periods as p}<option value={p.id}>{p.label}</option>{/each}
	</select>
	{#if v.period.isCurrent}<span class="status paid">current</span>{/if}
	<label class="small"><input type="checkbox" bind:checked={showHidden} /> show hidden</label>
	<a href="/budget/categories?period={v.period.id}" class="small">Manage categories</a>
</div>
<div class="lead"><div class="label">Ready to assign</div><div class="value"><Money cents={v.readyToAssign} signed /></div></div>
{#if error}<p class="error">{error}</p>{/if}
{#if v.underfunded.length}
	<div class="strip">{#each v.underfunded as u}<span>{u.accountName}: owes <Money cents={u.owed} />, envelope <Money cents={u.available} />, <strong>underfunded <Money cents={u.underfunded} /></strong></span>{/each}</div>
{/if}
<table>
	<thead><tr><th>Category</th><th class="num hide-sm">Carried</th><th class="num">Assigned</th><th class="num">Activity</th><th class="num">Available</th><th></th></tr></thead>
	<tbody>
	{#each v.groups as g}
		<tr class="group"><td colspan="6">{g.name}</td></tr>
		{#each g.categories.filter((c) => showHidden || !c.hidden) as c (c.id)}
			<tr>
				<td>{c.name}{#if c.hidden} <span class="muted small">hidden</span>{/if}{#if c.creditOverspend > 0} <span class="status overdue" title="credit overspend">{formatCents(c.creditOverspend)} on card</span>{/if}</td>
				<td class="num hide-sm"><Money cents={c.carried} /></td>
				<td class="num"><input class="num" value={dollars(c.assigned)} onchange={(e) => assignTo(c.id, (e.target as HTMLInputElement).value)} /></td>
				<td class="num"><Money cents={c.activity} /></td>
				<td class="num"><Money cents={c.available} signed /></td>
				<td><button onclick={() => (move = { from: c.id, to: null, amount: '' })}>Move</button></td>
			</tr>
		{/each}
	{/each}
	</tbody>
</table>

{#if move}
<Dialog open={true} title="Move money" onclose={() => (move = null)}>
	<form class="grid" onsubmit={(e) => { e.preventDefault(); doMove(); }}>
		<label for="mv-from">From</label><select id="mv-from" bind:value={move.from}>{#each allCats as c}<option value={c.id}>{c.name} ({formatCents(c.available)})</option>{/each}</select>
		<label for="mv-to">To</label><select id="mv-to" bind:value={move.to}><option value={null}>choose…</option>{#each allCats as c}<option value={c.id}>{c.name}</option>{/each}</select>
		<label for="mv-amt">Amount</label><input id="mv-amt" class="num" bind:value={move.amount} placeholder="0.00" />
		<div class="actions"><button type="button" onclick={() => (move = null)}>Cancel</button><button class="primary" type="submit">Move</button></div>
	</form>
</Dialog>
{/if}
