<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import Money from '$lib/ui/Money.svelte';
	import DefinitionForm from './DefinitionForm.svelte';
	import type { Def } from './DefinitionForm.svelte';
	import { post } from '$lib/ui/api';
	let { data } = $props();
	const v = $derived(data.view);
	let error = $state(''); let open = $state<Record<string, boolean>>({});
	let editing = $state<{ kind: 'bill' | 'income'; def: Def } | null>(null);
	const run = async (fn: () => Promise<unknown>) => { error = ''; try { await fn(); await invalidateAll(); } catch (e) { error = (e as Error).message; } };
	const blank = (kind: 'bill' | 'income') => ({ kind, def: { name: '', categoryId: null, accountId: null, expectedAmount: '', cadence: 'monthly', dueDay: 1, dueDay2: null, interval: null, anchorDate: null, toleranceAbs: '', tolerancePct: 0, matchPattern: '', autopay: false, linkedDebtAccountId: null, active: true } });
	const fromBill = (b: (typeof v.bills)[number]) => ({ kind: 'bill' as const, def: { id: b.id, name: b.name, categoryId: b.categoryId, accountId: b.payFromAccountId, expectedAmount: (b.expectedAmount / 100).toFixed(2), cadence: b.cadence, dueDay: b.dueDay, dueDay2: b.dueDay2, interval: b.interval, anchorDate: b.anchorDate, toleranceAbs: b.toleranceAbs ? (b.toleranceAbs / 100).toFixed(2) : '', tolerancePct: b.tolerancePct, matchPattern: b.matchPattern ?? '', autopay: b.autopay, linkedDebtAccountId: b.linkedDebtAccountId, active: b.active } });
	const fromIncome = (s: (typeof v.income)[number]) => ({ kind: 'income' as const, def: { id: s.id, name: s.name, categoryId: s.categoryId, accountId: s.depositAccountId, expectedAmount: (s.expectedAmount / 100).toFixed(2), cadence: s.cadence, dueDay: s.dueDay, dueDay2: s.dueDay2, interval: s.interval, anchorDate: s.anchorDate, toleranceAbs: s.toleranceAbs ? (s.toleranceAbs / 100).toFixed(2) : '', tolerancePct: s.tolerancePct, matchPattern: s.matchPattern ?? '', autopay: false, linkedDebtAccountId: null, active: s.active } });
	async function save(body: Record<string, unknown>) {
		const e = editing!; editing = null;
		const base = e.kind === 'bill' ? '/api/bills' : '/api/income';
		await run(() => post(e.def.id != null ? `${base}/${e.def.id}` : base, body));
	}
	const occAction = (kind: 'bill' | 'income', id: number, action: string) => run(() => post(kind === 'bill' ? `/api/occurrences/${id}` : `/api/income-occurrences/${id}`, { action }));
	const schedule = (d: { cadence: string; dueDay: number | null; dueDay2: number | null; interval: number | null; anchorDate: string | null }) =>
		d.cadence === 'monthly' ? `monthly on the ${d.dueDay}` : d.cadence === 'semi_monthly' ? `on the ${d.dueDay} and ${d.dueDay2}` : d.cadence === 'every_n_weeks' ? `every ${d.interval} weeks from ${d.anchorDate}` : `yearly on ${d.anchorDate}`;
</script>

<h1>Bills & income</h1>
{#if error}<p class="error">{error}</p>{/if}

{#snippet history(kind: 'bill' | 'income', rows: (typeof v.bills)[number]['history'])}
	<table class="history"><thead><tr><th>Due</th><th>Period</th><th class="num">Expected</th><th class="num">{kind === 'bill' ? 'Paid' : 'Received'}</th>{#if kind === 'bill'}<th class="num">Extra</th>{/if}<th>Status</th><th></th></tr></thead><tbody>
	{#each rows as o (o.id)}
		<tr><td>{o.dueDate}</td><td class="muted">{o.periodLabel}</td><td class="num"><Money cents={o.expected} /></td><td class="num"><Money cents={o.paid} /></td>{#if kind === 'bill'}<td class="num"><Money cents={o.extra} /></td>{/if}
			<td><span class="status {o.status}">{o.status}</span>{#if o.markedBy === 'manual'} <span class="muted small">manual</span>{/if}{#if o.needsReview} <span class="status overdue">tie</span>{/if}
				{#if o.transactionIds.length}<span class="small muted" title="linked transactions: {o.transactionIds.join(', ')}"> {o.transactionIds.length} linked</span>{/if}</td>
			<td>{#if o.status === 'paid'}<button class="small" onclick={() => occAction(kind, o.id, 'unmark')}>unmark</button>{:else if o.status !== 'skipped'}<button class="small" onclick={() => occAction(kind, o.id, kind === 'bill' ? 'paid' : 'received')}>mark {kind === 'bill' ? 'paid' : 'received'}</button> <button class="small" onclick={() => occAction(kind, o.id, 'skip')}>skip</button>{:else}<button class="small" onclick={() => occAction(kind, o.id, 'unmark')}>unskip</button>{/if}</td></tr>
	{/each}
	</tbody></table>
{/snippet}

<div class="toolbar"><h2>Bills</h2><button class="primary" onclick={() => (editing = blank('bill'))}>+ Bill</button></div>
<table><thead><tr><th>Bill</th><th class="hide-sm">Schedule</th><th>From</th><th class="num">Expected</th><th>Next</th><th></th></tr></thead><tbody>
{#each v.bills as b (b.id)}
	<tr class:muted={!b.active}><td>{b.name}{#if b.linkedDebtAccountId} <span class="muted small">card</span>{/if}{#if b.autopay} <span class="muted small">autopay</span>{/if}{#if !b.active} <span class="status">inactive</span>{/if}
		<div class="small muted only-sm">{schedule(b)}</div></td>
		<td class="small hide-sm">{schedule(b)}</td><td>{b.payFromAccountName}</td><td class="num"><Money cents={b.expectedAmount} /></td>
		<td>{#if b.next}{b.next.dueDate} <span class="status {b.next.status}">{b.next.status}</span>{:else}<span class="muted">—</span>{/if}</td>
		<td><button class="small" onclick={() => (editing = fromBill(b))}>edit</button> <button class="small" onclick={() => (open[`b${b.id}`] = !open[`b${b.id}`])}>{open[`b${b.id}`] ? 'hide' : 'history'}</button></td></tr>
	{#if open[`b${b.id}`]}<tr><td colspan="6" class="expanded">{@render history('bill', b.history)}</td></tr>{/if}
{:else}<tr><td colspan="6" class="muted">No bills yet.</td></tr>{/each}
</tbody></table>

<div class="toolbar"><h2>Income</h2><button class="primary" onclick={() => (editing = blank('income'))}>+ Income</button></div>
<table><thead><tr><th>Source</th><th class="hide-sm">Schedule</th><th>To</th><th class="num">Expected</th><th>Next</th><th></th></tr></thead><tbody>
{#each v.income as s (s.id)}
	<tr class:muted={!s.active}><td>{s.name}<div class="small muted only-sm">{schedule(s)}</div></td><td class="small hide-sm">{schedule(s)}</td><td>{s.depositAccountName}</td><td class="num"><Money cents={s.expectedAmount} /></td>
		<td>{#if s.next}{s.next.dueDate} <span class="status {s.next.status}">{s.next.status}</span>{:else}<span class="muted">—</span>{/if}</td>
		<td><button class="small" onclick={() => (editing = fromIncome(s))}>edit</button> <button class="small" onclick={() => (open[`i${s.id}`] = !open[`i${s.id}`])}>{open[`i${s.id}`] ? 'hide' : 'history'}</button></td></tr>
	{#if open[`i${s.id}`]}<tr><td colspan="6" class="expanded">{@render history('income', s.history)}</td></tr>{/if}
{:else}<tr><td colspan="6" class="muted">No income sources yet.</td></tr>{/each}
</tbody></table>

{#if editing}<DefinitionForm kind={editing.kind} def={editing.def} tree={data.tree} accounts={v.accounts} cadences={v.cadences} onsave={save} onclose={() => (editing = null)} />{/if}
