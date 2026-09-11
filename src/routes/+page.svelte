<script lang="ts">
	import Money from '$lib/ui/Money.svelte';
	import Sparkline from '$lib/ui/Sparkline.svelte';
	let { data } = $props();
	const v = $derived(data.view);
	const day = (iso: string) => String(+iso.slice(8, 10));
</script>

<div class="toolbar month-nav">
	<a href="/?month={v.prev}">← {v.prev}</a>
	<h1>{v.label}</h1>
	<a href="/?month={v.next}">{v.next} →</a>
</div>

<div class="sheet">
	<section class="col">
		<h2>Bills</h2>
		<table class="block">
			<thead><tr><th>Bill</th><th class="num">Due</th><th class="num">Expected</th><th class="num">Paid</th><th>Status</th></tr></thead>
			<tbody>{#each v.bills.occurrences as o}<tr><td>{o.name}</td><td class="num">{day(o.dueDate)}</td><td class="num"><Money cents={o.expected} /></td><td class="num"><Money cents={o.paid} /></td><td><span class="status {o.status}">{o.status}</span></td></tr>{:else}<tr><td colspan="5" class="muted">No bills this month.</td></tr>{/each}</tbody>
			<tfoot><tr><td colspan="2"></td><td class="num"><Money cents={v.bills.paid + v.bills.pending} /></td><td class="num"><Money cents={v.bills.paid} /></td><td></td></tr></tfoot>
		</table>

		<h2>Credit cards</h2>
		<table class="block">
			<thead><tr><th>Card</th><th class="num">Due</th><th class="num">Minimum</th><th class="num hide-sm">Additional</th><th class="num">Paid</th><th>Status</th></tr></thead>
			<tbody>{#each v.cards.occurrences as o}<tr><td>{o.name}{#if o.extra > 0}<div class="small muted only-sm">+ <Money cents={o.extra} /> extra</div>{/if}</td><td class="num">{day(o.dueDate)}</td><td class="num"><Money cents={o.expected} /></td><td class="num hide-sm">{#if o.extra > 0}<Money cents={o.extra} />{/if}</td><td class="num"><Money cents={o.paid} /></td><td><span class="status {o.status}">{o.status}</span></td></tr>{:else}<tr><td colspan="6" class="muted">No card payments this month.</td></tr>{/each}</tbody>
			<tfoot>
				<tr><td colspan="2"></td><td class="num"><Money cents={v.cards.minimum} /></td><td class="num hide-sm"><Money cents={v.cards.extra} /></td><td class="num"><Money cents={v.cards.paid} /></td><td></td></tr>
				<tr class="grand"><td colspan="2">Total</td><td class="num"><Money cents={v.bills.paid + v.bills.pending + v.cards.minimum} /></td><td class="num hide-sm"><Money cents={v.cards.extra} /></td><td class="num"><Money cents={v.bills.paid + v.cards.paid} /></td><td></td></tr>
			</tfoot>
		</table>
	</section>

	<section class="col">
		<h2>Balances</h2>
		<table class="block balances">
			<tbody>
				<tr><td>Expenses <span class="muted small">bills and cards pending</span></td><td class="num"><Money cents={-v.expensesPending} /></td></tr>
				{#each v.cash.accounts as a}<tr><td>{a.name} <span class="muted small">{a.asOf ?? 'no balance'}</span></td><td class="num"><Money cents={a.current} /></td></tr>{/each}
				<tr><td>Income <span class="muted small">expected, not yet received</span></td><td class="num"><Money cents={v.income.remaining} /></td></tr>
			</tbody>
			<tfoot><tr class="grand"><td>Cash left at month end</td><td class="num"><Money cents={v.cashLeft} signed /></td></tr></tfoot>
		</table>

		<h2>Income</h2>
		<table class="block">
			<thead><tr><th>Source</th><th class="num">On</th><th class="num">Expected</th><th class="num">Received</th><th>Status</th></tr></thead>
			<tbody>{#each v.income.occurrences as o}<tr><td>{o.name}</td><td class="num">{day(o.dueDate)}</td><td class="num"><Money cents={o.expected} /></td><td class="num"><Money cents={o.received} /></td><td><span class="status {o.status}">{o.status}</span></td></tr>{:else}<tr><td colspan="5" class="muted">No income this month.</td></tr>{/each}</tbody>
			<tfoot><tr><td colspan="2"></td><td class="num"><Money cents={v.income.expected} /></td><td class="num"><Money cents={v.income.received} /></td><td></td></tr></tfoot>
		</table>
	</section>
</div>

<h2>Checking balance, last 90 days</h2>
<Sparkline points={v.trend} />
