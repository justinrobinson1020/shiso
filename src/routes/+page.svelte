<script lang="ts">
	import Money from '$lib/ui/Money.svelte';
	import Sparkline from '$lib/ui/Sparkline.svelte';
	let { data } = $props();
	const v = $derived(data.view);
</script>

<div class="toolbar">
	<a href="/?month={v.prev}">← {v.prev}</a>
	<h1 style="margin:0">{v.label}</h1>
	<a href="/?month={v.next}">{v.next} →</a>
</div>

<div class="cards">
	<div class="card"><div class="label">Cash on hand</div><div class="value"><Money cents={v.cash.total} /></div>
		{#each v.cash.accounts as a}<div class="small">{a.name} <Money cents={a.current} /> <span class="muted">{a.asOf ?? 'no balance'}</span></div>{/each}</div>
	<div class="card"><div class="label">Income received / expected</div><div class="value"><Money cents={v.income.received} /> <span class="muted">/ <Money cents={v.income.expected} /></span></div></div>
	<div class="card"><div class="label">Bills paid / pending</div><div class="value"><Money cents={v.bills.paid} /> <span class="muted">/ <Money cents={v.bills.pending} /></span></div></div>
	<div class="card"><div class="label">Card payments planned</div><div class="value"><Money cents={v.cardPayments.planned} /></div><div class="small">paid <Money cents={v.cardPayments.paid} />, extra <Money cents={v.cardPayments.extra} /></div></div>
	<div class="card"><div class="label">Cash left at month end</div><div class="value"><Money cents={v.cashLeft} signed /></div></div>
</div>

<h2>Checking balance, last 90 days</h2>
<Sparkline points={v.trend} />

<h2>Bills</h2>
<table><thead><tr><th>Bill</th><th>Due</th><th class="num">Expected</th><th class="num">Paid</th><th>Status</th></tr></thead>
<tbody>{#each v.bills.occurrences as o}<tr><td>{o.name}{#if o.isDebt} <span class="muted small">card</span>{/if}</td><td>{o.dueDate}</td><td class="num"><Money cents={o.expected} /></td><td class="num"><Money cents={o.paid} /></td><td><span class="status {o.status}">{o.status}</span></td></tr>{:else}<tr><td colspan="5" class="muted">No bill occurrences this month.</td></tr>{/each}</tbody></table>

<h2>Income</h2>
<table><thead><tr><th>Source</th><th>Expected on</th><th class="num">Expected</th><th class="num">Received</th><th>Status</th></tr></thead>
<tbody>{#each v.income.occurrences as o}<tr><td>{o.name}</td><td>{o.dueDate}</td><td class="num"><Money cents={o.expected} /></td><td class="num"><Money cents={o.received} /></td><td><span class="status {o.status}">{o.status}</span></td></tr>{:else}<tr><td colspan="5" class="muted">No income occurrences this month.</td></tr>{/each}</tbody></table>
