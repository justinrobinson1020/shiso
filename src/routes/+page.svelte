<script lang="ts">
	import Money from '$lib/ui/Money.svelte';
	import SortTh from '$lib/ui/SortTh.svelte';
	import { sortRows, type SortState } from '$lib/ui/sort';
	let sortBills = $state<SortState>(null); let sortSubs = $state<SortState>(null); let sortCards = $state<SortState>(null); let sortInc = $state<SortState>(null);
	import LineChart from '$lib/ui/LineChart.svelte';
	import { shortDate } from '$lib/dates';
	import { invalidateAll } from '$app/navigation';
	import { post } from '$lib/ui/api';
	import { decimalToCents } from '$lib/money';
	let { data } = $props();
	const v = $derived(data.view);
	const day = (iso: string) => String(+iso.slice(8, 10));
	let error = $state('');
	const mark = async (id: number, action: 'paid' | 'unmark') => { error = ''; try { await post(`/api/occurrences/${id}`, { action }); await invalidateAll(); } catch (e) { error = (e as Error).message; } };
	const rowClass = (o: { status: string; dueNow: boolean }) => (o.status === 'paid' ? 'paid' : o.dueNow ? 'due-now' : '');
	// A variable bill's estimate is editable in place; Enter or leaving the field saves it for this month only.
	const expect = async (id: number, raw: string) => { error = ''; try { await post(`/api/occurrences/${id}`, { action: 'expect', amount: decimalToCents(raw) }); await invalidateAll(); } catch (e) { error = (e as Error).message; } };
	const editable = (o: { variable: boolean; status: string }) => o.variable && (o.status === 'pending' || o.status === 'overdue');
</script>

<div class="toolbar month-nav">
	<a href="/?month={v.prev}" class="small">← {v.prevLabel}</a>
	<h1>{v.label}</h1>
	<a href="/?month={v.next}" class="small">{v.nextLabel} →</a>
</div>

<div class="sheet">
	<section class="col">
		<h2>Bills{#if v.nextPaycheck} <span class="muted small">due before {shortDate(v.nextPaycheck)}</span>{/if}</h2>
		{#if error}<p class="error">{error}</p>{/if}
		<table class="block">
			<thead><tr><SortTh key="name" label="Bill" kind="text" bind:sort={sortBills} /><SortTh key="dueDate" label="Due" kind="date" class="num" bind:sort={sortBills} /><SortTh key="expected" label="Expected" kind="number" class="num" bind:sort={sortBills} /><SortTh key="paid" label="Paid" kind="number" class="num" bind:sort={sortBills} /><SortTh key="status" label="Status" kind="text" bind:sort={sortBills} /></tr></thead>
			<tbody>{#each sortRows(v.bills.occurrences, sortBills) as o}<tr class={rowClass(o)}><td>{o.name}</td><td class="num">{day(o.dueDate)}</td><td class="num">{#if editable(o)}<input class="num estimate" value={(o.expected / 100).toFixed(2)} onchange={(e) => expect(o.id, (e.currentTarget as HTMLInputElement).value)} aria-label="Estimated amount for {o.name}" />{:else}<Money cents={o.expected} />{/if}</td><td class="num"><Money cents={o.paid} /></td><td class="status-cell"><span class="status {o.status}">{o.status}</span>{#if o.status === 'pending' || o.status === 'overdue'}<button class="small link" onclick={() => mark(o.id, 'paid')}>mark paid</button>{:else if o.status === 'paid' && o.markedBy === 'manual'}<button class="small link" onclick={() => mark(o.id, 'unmark')}>undo</button>{/if}</td></tr>{:else}<tr><td colspan="5" class="muted">No bills due this month. Define them on <a href="/bills">Bills</a>.</td></tr>{/each}</tbody>
			<tfoot><tr><td colspan="2"></td><td class="num"><Money cents={v.bills.paid + v.bills.pending} /></td><td class="num"><Money cents={v.bills.paid} /></td><td></td></tr></tfoot>
		</table>

		<h2>Subscriptions</h2>
		<table class="block">
			<thead><tr><SortTh key="name" label="Service" kind="text" bind:sort={sortSubs} /><SortTh key="dueDate" label="Due" kind="date" class="num" bind:sort={sortSubs} /><SortTh key="expected" label="Expected" kind="number" class="num" bind:sort={sortSubs} /><SortTh key="paid" label="Paid" kind="number" class="num" bind:sort={sortSubs} /><SortTh key="status" label="Status" kind="text" bind:sort={sortSubs} /></tr></thead>
			<tbody>{#each sortRows(v.subscriptions.occurrences, sortSubs) as o}<tr class={rowClass(o)}><td>{o.name}</td><td class="num">{day(o.dueDate)}</td><td class="num">{#if editable(o)}<input class="num estimate" value={(o.expected / 100).toFixed(2)} onchange={(e) => expect(o.id, (e.currentTarget as HTMLInputElement).value)} aria-label="Estimated amount for {o.name}" />{:else}<Money cents={o.expected} />{/if}</td><td class="num"><Money cents={o.paid} /></td><td class="status-cell"><span class="status {o.status}">{o.status}</span>{#if o.status === 'pending' || o.status === 'overdue'}<button class="small link" onclick={() => mark(o.id, 'paid')}>mark paid</button>{:else if o.status === 'paid' && o.markedBy === 'manual'}<button class="small link" onclick={() => mark(o.id, 'unmark')}>undo</button>{/if}</td></tr>{:else}<tr><td colspan="5" class="muted">No subscriptions due this month. A bill in the Subscriptions category shows here.</td></tr>{/each}</tbody>
			<tfoot><tr><td colspan="2"></td><td class="num"><Money cents={v.subscriptions.paid + v.subscriptions.pending} /></td><td class="num"><Money cents={v.subscriptions.paid} /></td><td></td></tr></tfoot>
		</table>

		<h2>Credit cards</h2>
		<table class="block">
			<thead><tr><SortTh key="name" label="Card" kind="text" bind:sort={sortCards} /><SortTh key="dueDate" label="Due" kind="date" class="num" bind:sort={sortCards} /><SortTh key="expected" label="Minimum" kind="number" class="num" bind:sort={sortCards} /><SortTh key="extra" label="Additional" kind="number" class="num hide-sm" bind:sort={sortCards} /><SortTh key="paid" label="Paid" kind="number" class="num" bind:sort={sortCards} /><SortTh key="status" label="Status" kind="text" bind:sort={sortCards} /></tr></thead>
			<tbody>{#each sortRows(v.cards.occurrences, sortCards) as o}<tr class={rowClass(o)}><td>{o.name}{#if o.extra > 0}<div class="small muted only-sm">+ <Money cents={o.extra} /> extra</div>{/if}</td><td class="num">{day(o.dueDate)}</td><td class="num"><Money cents={o.expected} /></td><td class="num hide-sm">{#if o.extra > 0}<Money cents={o.extra} />{/if}</td><td class="num"><Money cents={o.paid} /></td><td class="status-cell"><span class="status {o.status}">{o.status}</span>{#if o.status === 'pending' || o.status === 'overdue'}<button class="small link" onclick={() => mark(o.id, 'paid')}>mark paid</button>{:else if o.status === 'paid' && o.markedBy === 'manual'}<button class="small link" onclick={() => mark(o.id, 'unmark')}>undo</button>{/if}</td></tr>{:else}<tr><td colspan="6" class="muted">No card payments this month.</td></tr>{/each}</tbody>
			<tfoot>
				<tr><td colspan="2"></td><td class="num"><Money cents={v.cards.minimum} /></td><td class="num hide-sm"><Money cents={v.cards.extra} /></td><td class="num"><Money cents={v.cards.paid} /></td><td></td></tr>
				<tr class="grand"><td colspan="2">Total</td><td class="num"><Money cents={v.bills.paid + v.bills.pending + v.subscriptions.paid + v.subscriptions.pending + v.cards.minimum} /></td><td class="num hide-sm"><Money cents={v.cards.extra} /></td><td class="num"><Money cents={v.bills.paid + v.subscriptions.paid + v.cards.paid} /></td><td></td></tr>
			</tfoot>
		</table>
	</section>

	<section class="col">
		<h2>Balances</h2>
		<table class="block balances">
			<tbody>
				<tr><td>Expenses <span class="muted small">bills, subscriptions and cards pending</span></td><td class="num"><Money cents={-v.expensesPending} /></td></tr>
				{#each v.cash.accounts as a}<tr><td>{a.name} <span class="muted small">{a.asOf ? `as of ${shortDate(a.asOf)}` : 'no balance'}</span></td><td class="num"><Money cents={a.current} /></td></tr>{/each}
				<tr><td>Income <span class="muted small">expected, not yet received</span></td><td class="num"><Money cents={v.income.remaining} /></td></tr>
			</tbody>
			<tfoot><tr class="grand"><td>Cash left at month end</td><td class="num"><Money cents={v.cashLeft} signed /></td></tr></tfoot>
		</table>

		<h2>Income</h2>
		<table class="block">
			<thead><tr><SortTh key="name" label="Source" kind="text" bind:sort={sortInc} /><SortTh key="dueDate" label="On" kind="date" class="num" bind:sort={sortInc} /><SortTh key="expected" label="Expected" kind="number" class="num" bind:sort={sortInc} /><SortTh key="received" label="Received" kind="number" class="num" bind:sort={sortInc} /><SortTh key="status" label="Status" kind="text" bind:sort={sortInc} /></tr></thead>
			<tbody>{#each sortRows(v.income.occurrences, sortInc) as o}<tr><td>{o.name}</td><td class="num">{day(o.dueDate)}</td><td class="num"><Money cents={o.expected} /></td><td class="num"><Money cents={o.received} /></td><td><span class="status {o.status}">{o.status}</span></td></tr>{:else}<tr><td colspan="5" class="muted">No income expected this month. Add a paycheck on <a href="/bills">Bills</a>.</td></tr>{/each}</tbody>
			<tfoot><tr><td colspan="2"></td><td class="num"><Money cents={v.income.expected} /></td><td class="num"><Money cents={v.income.received} /></td><td></td></tr></tfoot>
		</table>
	</section>
</div>

<div class="chart-caption"><h2>Checking balance, last 90 days</h2>{#if v.trend.length}<span class="muted small">{shortDate(v.trend[v.trend.length - 1].asOf)}: <Money cents={v.trend[v.trend.length - 1].current} /></span>{/if}</div>
<LineChart points={v.trend.map((t) => ({ label: shortDate(t.asOf), value: t.current }))} height={160} ticks={v.trend.map((t) => t.asOf)} />
