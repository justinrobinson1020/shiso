<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import Money from '$lib/ui/Money.svelte';
	import Dialog from '$lib/ui/Dialog.svelte';
	import SplitEditor from './SplitEditor.svelte';
	import { post } from '$lib/ui/api';
	import { decimalToCents } from '$lib/money';
	let { data } = $props();
	const v = $derived(data.view); const tree = $derived(data.tree);
	let error = $state('');
	let splitting = $state<(typeof v.rows)[number] | null>(null);
	let ruleFor = $state<{ id: number; payeeRaw: string; payee: string; pattern: string; categoryId: number | null } | null>(null);
	let adding = $state(false); let add = $state({ accountId: null as number | null, postedDate: '', amount: '', payee: '', memo: '', categoryId: null as number | null });
	const run = async (fn: () => Promise<unknown>) => { error = ''; try { await fn(); await invalidateAll(); } catch (e) { error = (e as Error).message; } };
	const patch = (id: number, body: unknown) => run(() => post(`/api/transactions/${id}`, body));
	function setParam(k: string, val: string | null) { const u = new URL(page.url); if (val) u.searchParams.set(k, val); else u.searchParams.delete(k); u.searchParams.delete('page'); goto(u.pathname + u.search); }
	async function renamePayee(row: (typeof v.rows)[number], payee: string) {
		if (payee === row.payee) return;
		await patch(row.id, { payee });
		ruleFor = { id: row.id, payeeRaw: row.payeeRaw, payee, pattern: row.payeeRaw, categoryId: row.splits.length === 1 ? row.splits[0].categoryId : null };
	}
	const catName = (id: number) => tree.groups.flatMap((g) => g.categories).find((c) => c.id === id)?.name ?? '';
	const manualAccounts = $derived(v.accounts.filter((a) => !a.closed));
	const pages = $derived(Math.max(1, Math.ceil(v.total / v.limit)));
	const periodLabel = (id: number) => v.periods.find((p) => p.id === id)?.label ?? '';
</script>

<h1>Ledger</h1>
<div class="toolbar">
	<select value={data.filter.accountId ?? ''} onchange={(e) => setParam('account', (e.target as HTMLSelectElement).value || null)}><option value="">All accounts</option>{#each v.accounts as a}<option value={a.id}>{a.name}{a.closed ? ' (closed)' : ''}</option>{/each}</select>
	<select value={data.filter.periodId ?? ''} onchange={(e) => setParam('period', (e.target as HTMLSelectElement).value || null)}><option value="">All periods</option>{#each v.periods as p}<option value={p.id}>{p.label}</option>{/each}</select>
	<select value={data.filter.categoryId ?? ''} onchange={(e) => setParam('category', (e.target as HTMLSelectElement).value || null)}><option value="">All categories</option>{#each tree.groups as g}<optgroup label={g.name}>{#each g.categories as c}<option value={c.id}>{c.name}</option>{/each}</optgroup>{/each}</select>
	<input placeholder="Search payee or memo" value={data.filter.q ?? ''} onchange={(e) => setParam('q', (e.target as HTMLInputElement).value || null)} />
	<label class="small"><input type="checkbox" checked={data.filter.review} onchange={(e) => setParam('review', (e.target as HTMLInputElement).checked ? '1' : null)} /> review queue</label>
	<button onclick={() => (adding = !adding)}>+ Manual transaction</button>
	<span class="muted small">{v.total} rows</span>
</div>
{#if error}<p class="error">{error}</p>{/if}
{#if v.drift.length}<div class="strip">{#each v.drift as d}<span>Drift on {d.accountName}: <Money cents={d.drift} signed /> — <a href="/accounts#account-{d.accountId}">reconcile</a></span>{/each}</div>{/if}

{#if adding}
<form class="card" onsubmit={(e) => { e.preventDefault(); if (add.accountId == null) { error = 'Choose an account'; return; } run(() => post('/api/transactions', { accountId: add.accountId, postedDate: add.postedDate, amount: decimalToCents(add.amount), payee: add.payee, memo: add.memo || null, categoryId: add.categoryId })).then(() => { adding = false; }); }}>
	<div class="toolbar">
		<select bind:value={add.accountId} required><option value={null}>Account…</option>{#each manualAccounts as a}<option value={a.id}>{a.name}</option>{/each}</select>
		<input type="date" bind:value={add.postedDate} required /><input class="num" placeholder="-12.34" bind:value={add.amount} required /><input placeholder="Payee" bind:value={add.payee} required />
		<select bind:value={add.categoryId}><option value={null}>Uncategorized</option>{#each tree.groups as g}<optgroup label={g.name}>{#each g.categories.filter((c) => !c.hidden) as c}<option value={c.id}>{c.name}</option>{/each}</optgroup>{/each}</select>
		<input placeholder="Memo" bind:value={add.memo} /><button class="primary" type="submit">Add</button>
	</div>
	<p class="small muted">Amounts are from the account's point of view: spending is negative, deposits positive.</p>
</form>
{/if}

<table>
	<thead><tr><th>Date</th><th class="hide-sm">Account</th><th>Payee</th><th>Category</th><th class="hide-sm">Memo</th><th class="num hide-sm">Amount</th><th class="hide-sm">Period</th><th></th></tr></thead>
	<tbody>
	{#each v.rows as row (row.id)}
		<tr>
			<td>{row.postedDate}{#if row.pending} <span class="muted small">pending</span>{/if}</td>
			<td class="hide-sm">{row.accountName}</td>
			<td><input class="inline" value={row.payee} title={row.payeeRaw} onchange={(e) => renamePayee(row, (e.target as HTMLInputElement).value)} />
				<div class="only-sm"><Money cents={row.amount} /></div>
				<div class="small muted only-sm">{row.accountName} · {periodLabel(row.periodId)}</div>
				<input class="inline only-sm" placeholder="Memo" value={row.memo ?? ''} onchange={(e) => patch(row.id, { memo: (e.target as HTMLInputElement).value || null })} /></td>
			<td>{#if row.transferPeerId != null}<span class="muted">Transfer · {row.transferPeerAccountName}</span> <button class="small" onclick={() => run(() => post(`/api/transactions/${row.id}/unlink`))}>unlink</button>
				{:else if row.splits.length === 1}<select value={row.splits[0].categoryId} onchange={(e) => patch(row.id, { splits: [{ categoryId: Number((e.target as HTMLSelectElement).value), amount: row.amount }] })}>{#each tree.groups as g}<optgroup label={g.name}>{#each g.categories.filter((c) => !c.hidden || c.id === row.splits[0].categoryId) as c}<option value={c.id}>{c.name}</option>{/each}</optgroup>{/each}</select> <button class="small" onclick={() => (splitting = row)}>split</button>
				{:else}<button class="small" onclick={() => (splitting = row)}>{row.splits.length} splits: {row.splits.map((s) => s.categoryName).join(', ')}</button>{/if}</td>
			<td class="hide-sm"><input class="inline" value={row.memo ?? ''} onchange={(e) => patch(row.id, { memo: (e.target as HTMLInputElement).value || null })} /></td>
			<td class="num hide-sm"><Money cents={row.amount} /></td>
			<td class="hide-sm"><select value={row.periodId} onchange={(e) => patch(row.id, { periodId: Number((e.target as HTMLSelectElement).value) })}>{#each v.periods as p}<option value={p.id}>{p.label}</option>{/each}</select></td>
			<td>{#if row.needsReview}<span class="status overdue" title={row.reviewReason ?? ''}>{row.reviewReason}</span> <button class="small" onclick={() => run(() => post(`/api/transactions/${row.id}/review`))}>clear</button>{/if}
				{#if row.source === 'manual' || row.source === 'import'}<button class="small danger" onclick={() => run(() => post(`/api/transactions/${row.id}/delete`))}>delete</button>{/if}</td>
		</tr>
	{:else}<tr><td colspan="8" class="muted">No transactions match.</td></tr>{/each}
	</tbody>
</table>
<div class="toolbar">
	{#if data.page > 1}<a href={(() => { const u = new URL(page.url); u.searchParams.set('page', String(data.page - 1)); return u.pathname + u.search; })()}>← newer</a>{/if}
	<span class="muted small">page {data.page} of {pages}</span>
	{#if data.page < pages}<a href={(() => { const u = new URL(page.url); u.searchParams.set('page', String(data.page + 1)); return u.pathname + u.search; })()}>older →</a>{/if}
</div>

{#if splitting}<SplitEditor row={splitting} {tree} onclose={() => (splitting = null)} onsave={async (splits) => { const id = splitting!.id; splitting = null; await patch(id, { splits }); }} />{/if}

{#if ruleFor}
<Dialog open={true} title="Create a payee rule?" onclose={() => (ruleFor = null)}>
	<p class="small">Rename every transaction whose raw payee contains the pattern to <strong>{ruleFor.payee}</strong>{#if ruleFor.categoryId} and categorise it as {catName(ruleFor.categoryId)}{/if}.</p>
	<form class="grid" onsubmit={(e) => { e.preventDefault(); const r = ruleFor!; ruleFor = null; run(() => post('/api/payee-rules', { pattern: r.pattern, payee: r.payee, categoryId: r.categoryId, applyToExisting: true })); }}>
		<label for="rule-pattern">Pattern</label><input id="rule-pattern" bind:value={ruleFor.pattern} />
		<div class="actions" style="grid-column: 1 / -1"><button type="button" onclick={() => (ruleFor = null)}>No thanks</button><button class="primary" type="submit">Create rule</button></div>
	</form>
</Dialog>
{/if}
