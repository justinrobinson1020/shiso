<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import Money from '$lib/ui/Money.svelte';
	import RangePicker from '$lib/ui/RangePicker.svelte';
	import StackedBars from '$lib/ui/StackedBars.svelte';
	let { data } = $props();
	const v = $derived(data.view);
	function setParam(k: string, val: string | null) { const u = new URL(page.url); if (val) u.searchParams.set(k, val); else u.searchParams.delete(k); goto(u.pathname + u.search); }
	const delta = (cur: number, prev: number | null) => (prev == null ? '' : prev === 0 ? (cur === 0 ? '' : 'new') : `${cur >= prev ? '+' : ''}${Math.round(((cur - prev) / prev) * 100)}%`);
	const ledgerLink = (categoryId: number) => `/ledger?category=${categoryId}&from=${v.range.start}&to=${v.range.end}${v.filter.accountId ? `&account=${v.filter.accountId}` : ''}`;
</script>

<h1>Spending</h1>
<RangePicker range={v.range} compare={v.filter.compare ?? false} />
<div class="toolbar">
	<select value={v.filter.accountId ?? ''} onchange={(e) => setParam('account', (e.target as HTMLSelectElement).value || null)}><option value="">All accounts</option>{#each v.accounts as a}<option value={a.id}>{a.name}</option>{/each}</select>
	<select value={v.filter.groupId ?? ''} onchange={(e) => setParam('group', (e.target as HTMLSelectElement).value || null)}><option value="">All groups</option>{#each v.groups as g}<option value={g.id}>{g.name}</option>{/each}</select>
	{#if v.filter.merchant}<span class="status">merchant: {v.filter.merchant} <button class="small" onclick={() => setParam('merchant', null)}>×</button></span>{/if}
	<label class="small"><input type="checkbox" checked={v.filter.includeExcluded} onchange={(e) => setParam('all', (e.target as HTMLInputElement).checked ? '1' : null)} /> include bills, debt payments, transfers, income</label>
</div>
<div class="lead"><div class="label">Total spending · {v.range.label}</div><div class="value"><Money cents={v.total} /></div>{#if v.prevTotal != null}<div class="sub">{v.range.prevLabel}: <Money cents={v.prevTotal} /> ({delta(v.total, v.prevTotal)})</div>{/if}</div>

<h2>Over time</h2>
<StackedBars buckets={v.overTime.buckets} categories={v.overTime.categories} compare={v.filter.compare ?? false} />

<h2>By category</h2>
<table><thead><tr><th>Category</th><th class="hide-sm">Group</th><th class="num">Amount</th><th class="num">Share</th>{#if v.prevTotal != null}<th class="num">Previous</th><th class="num">Δ</th>{/if}<th></th></tr></thead>
<tbody>{#each v.byCategory as c}<tr><td>{c.name}</td><td class="muted hide-sm">{c.groupName}</td><td class="num"><Money cents={c.amount} /></td><td class="num">{(c.share * 100).toFixed(1)}%</td>
	{#if v.prevTotal != null}<td class="num"><Money cents={c.prevAmount ?? 0} /></td><td class="num">{delta(c.amount, c.prevAmount)}</td>{/if}<td><a href={ledgerLink(c.categoryId)}>transactions →</a></td></tr>{:else}<tr><td colspan="7" class="muted">No spending in this range.</td></tr>{/each}</tbody></table>

<h2>By merchant</h2>
<table><thead><tr><th>Merchant</th><th class="num">Count</th><th class="num">Total</th>{#if v.prevTotal != null}<th class="num">Previous</th>{/if}</tr></thead>
<tbody>{#each v.byMerchant as m}<tr><td><a href="?{(() => { const u = new URL(page.url); u.searchParams.set('merchant', m.payee); return u.searchParams.toString(); })()}">{m.payee}</a></td><td class="num">{m.count}</td><td class="num"><Money cents={m.total} /></td>{#if v.prevTotal != null}<td class="num"><Money cents={m.prevTotal ?? 0} /></td>{/if}</tr>{/each}</tbody></table>
