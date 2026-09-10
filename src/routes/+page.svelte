<script lang="ts">
	import Money from '$lib/ui/Money.svelte';
	import Sparkline from '$lib/ui/Sparkline.svelte';
	let { data } = $props();
	const v = $derived(data.view);
</script>

<div class="toolbar month-nav">
	<a href="/?month={v.prev}">← {v.prev}</a>
	<h1>{v.label}</h1>
	<a href="/?month={v.next}">{v.next} →</a>
</div>

<div class="lead">
	<div class="label">Cash left at month end</div>
	<div class="value"><Money cents={v.cashLeft} signed /></div>
</div>

<dl class="facts">
	<div><dt>Cash on hand</dt><dd><Money cents={v.cash.total} />{#each v.cash.accounts as a}<div class="small muted">{a.name} <Money cents={a.current} /> · {a.asOf ?? 'no balance'}</div>{/each}</dd></div>
	<div><dt>Income received / expected</dt><dd><Money cents={v.income.received} /> <span class="muted">/ <Money cents={v.income.expected} /></span></dd></div>
	<div><dt>Bills paid / pending</dt><dd><Money cents={v.bills.paid} /> <span class="muted">/ <Money cents={v.bills.pending} /></span></dd></div>
	<div><dt>Card payments planned</dt><dd><Money cents={v.cardPayments.planned} /><div class="small muted">paid <Money cents={v.cardPayments.paid} />, extra <Money cents={v.cardPayments.extra} /></div></dd></div>
</dl>

<h2>Checking balance, last 90 days</h2>
<Sparkline points={v.trend} />

<h2>Bills</h2>
<table><thead><tr><th>Bill</th><th>Due</th><th class="num">Expected</th><th class="num">Paid</th><th>Status</th></tr></thead>
<tbody>{#each v.bills.occurrences as o}<tr><td>{o.name}{#if o.isDebt} <span class="muted small">card</span>{/if}</td><td>{o.dueDate}</td><td class="num"><Money cents={o.expected} /></td><td class="num"><Money cents={o.paid} /></td><td><span class="status {o.status}">{o.status}</span></td></tr>{:else}<tr><td colspan="5" class="muted">No bill occurrences this month.</td></tr>{/each}</tbody></table>

<h2>Income</h2>
<table><thead><tr><th>Source</th><th>Expected on</th><th class="num">Expected</th><th class="num">Received</th><th>Status</th></tr></thead>
<tbody>{#each v.income.occurrences as o}<tr><td>{o.name}</td><td>{o.dueDate}</td><td class="num"><Money cents={o.expected} /></td><td class="num"><Money cents={o.received} /></td><td><span class="status {o.status}">{o.status}</span></td></tr>{:else}<tr><td colspan="5" class="muted">No income occurrences this month.</td></tr>{/each}</tbody></table>
