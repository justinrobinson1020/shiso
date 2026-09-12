<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import SortTh from '$lib/ui/SortTh.svelte';
	import { sortRows, type SortState } from '$lib/ui/sort';
	let sortBudget = $state<SortState>(null);
	const budgetPick = (c: (typeof allCats)[number], k: string) => (k === 'target' ? (c.target?.needed ?? null) : (c as unknown as Record<string, string | number | null>)[k]);
	import Money from '$lib/ui/Money.svelte';
	import Dialog from '$lib/ui/Dialog.svelte';
	import { post } from '$lib/ui/api';
	import { decimalToCents, formatCents } from '$lib/money';
	import { shortDate } from '$lib/dates';
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
	const fund = (categoryId: number | null) => { error = ''; return post('/api/budget/fund-targets', { periodId: v.period.id, categoryId }).then(() => invalidateAll()).catch((e) => (error = (e as Error).message)); };
	const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	type Target = NonNullable<(typeof allCats)[number]['target']>;
	const rule = (t: Target) => t.kind === 'monthly' ? `${formatCents(t.amount)} / mo` : t.kind === 'refill' ? `keep ${formatCents(t.amount)}` : `${formatCents(t.amount)} by ${MONTHS[+t.targetDate!.slice(5, 7) - 1]} ${t.targetDate!.slice(0, 4)}${t.periodsLeft != null ? ` · ${t.periodsLeft} left` : ''}`;
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
{#if v.historyOnly}
	<p class="muted">Before the budget started on {shortDate(v.budgetStart!)}. History only: the ledger and spending pages cover this period, the envelopes do not.</p>
{:else}
<div class="lead"><div class="label">Ready to assign</div><div class="value"><Money cents={v.readyToAssign} signed /></div></div>
{#if error}<p class="error">{error}</p>{/if}
{#if v.underfunded.length}
	<div class="strip">{#each v.underfunded as u}<span>{u.accountName}: owes <Money cents={u.owed} />, envelope <Money cents={u.available} />, <strong>underfunded <Money cents={u.underfunded} /></strong></span>{/each}</div>
{/if}
{#if v.targetsNeeded > 0}
	<div class="strip"><span>Targets need <strong><Money cents={v.targetsNeeded} /></strong> this period</span><button class="small primary" onclick={() => fund(null)}>Fund all</button></div>
{/if}
<table class="budget">
	<thead><tr><SortTh key="name" label="Category" kind="text" bind:sort={sortBudget} /><SortTh key="target" label="Target" kind="number" class="hide-sm" bind:sort={sortBudget} /><SortTh key="carried" label="Carried" kind="number" class="num hide-sm" bind:sort={sortBudget} /><SortTh key="assigned" label="Assigned" kind="number" class="num hide-sm" bind:sort={sortBudget} /><SortTh key="activity" label="Activity" kind="number" class="num hide-sm" bind:sort={sortBudget} /><SortTh key="available" label="Available" kind="number" class="num hide-sm" bind:sort={sortBudget} /><th></th></tr></thead>
	<tbody>
	{#each v.groups as g}
		<tr class="group"><td colspan="7">{g.name}</td></tr>
		{#each sortRows(g.categories.filter((c) => showHidden || !c.hidden), sortBudget, budgetPick) as c (c.id)}
			<tr>
				<td class="env">
					<div class="env-head"><span>{c.name}{#if c.hidden} <span class="muted small">hidden</span>{/if}{#if c.creditOverspend > 0} <span class="status overdue" title="credit overspend">{formatCents(c.creditOverspend)} on card</span>{/if}</span><span class="only-sm env-avail"><Money cents={c.available} signed /></span></div>
					<div class="only-sm env-sub"><label class="small muted">assign <input class="num" value={dollars(c.assigned)} onchange={(e) => assignTo(c.id, (e.target as HTMLInputElement).value)} /></label><span class="small muted">activity <Money cents={c.activity} neutral /></span></div>
					{#if c.target}<div class="small muted only-sm">{rule(c.target)}{#if c.target.needed > 0} · needs {formatCents(c.target.needed)}{/if}</div>{/if}</td>
				<td class="hide-sm target">{#if c.target}<div class="small">{rule(c.target)}</div><div class="bar"><i style="width:{Math.round(c.target.progress * 100)}%"></i></div>{#if c.target.needed > 0}<div class="small muted">needs <Money cents={c.target.needed} /></div>{:else}<div class="small muted">on target</div>{/if}{:else}<span class="muted">—</span>{/if}</td>
				<td class="num hide-sm"><Money cents={c.carried} /></td>
				<td class="num hide-sm"><input class="num" value={dollars(c.assigned)} onchange={(e) => assignTo(c.id, (e.target as HTMLInputElement).value)} /></td>
				<td class="num hide-sm"><Money cents={c.activity} neutral /></td>
				<td class="num hide-sm"><Money cents={c.available} signed /></td>
				<td class="row-actions">{#if c.target && c.target.needed > 0}<button class="small" onclick={() => fund(c.id)}>Fund</button>{/if} <button class="small" onclick={() => (move = { from: c.id, to: null, amount: '' })}>Move</button></td>
			</tr>
		{/each}
	{/each}
	</tbody>
</table>
{/if}

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
