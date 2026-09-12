<script lang="ts">
	import { goto } from '$app/navigation';
	import SortTh from '$lib/ui/SortTh.svelte';
	import { sortRows, type SortState } from '$lib/ui/sort';
	let sortCat = $state<SortState>(null); let sortMerch = $state<SortState>(null); let sortTrend = $state<SortState>(null); let sortOut = $state<SortState>(null);
	const catPick = (c: (typeof v.byCategory)[number], k: string) => (k === 'delta' ? (c.prevAmount == null ? null : c.amount - c.prevAmount) : (c as unknown as Record<string, string | number | null>)[k]);
	import { page } from '$app/state';
	import Money from '$lib/ui/Money.svelte';
	import RangePicker from '$lib/ui/RangePicker.svelte';
	import StackedBars from '$lib/ui/StackedBars.svelte';
	import LineChart from '$lib/ui/LineChart.svelte';
	import Sparkline from '$lib/ui/Sparkline.svelte';
	import { shortDate } from '$lib/dates';
	let { data } = $props();
	const v = $derived(data.view);
	function setParam(k: string, val: string | null) { const u = new URL(page.url); if (val) u.searchParams.set(k, val); else u.searchParams.delete(k); goto(u.pathname + u.search); }
	const delta = (cur: number, prev: number | null) => (prev == null ? '' : prev === 0 ? (cur === 0 ? '' : 'new') : `${cur >= prev ? '+' : ''}${Math.round(((cur - prev) / prev) * 100)}%`);
	const ledgerLink = (categoryId: number) => `/ledger?category=${categoryId}&from=${v.range.start}&to=${v.range.end}${v.filter.accountId ? `&account=${v.filter.accountId}` : ''}`;
	const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	const monthLabel = (ym: string) => `${MONTHS[+ym.slice(5, 7) - 1]} ${ym.slice(2, 4)}`;
	const pctLabel = (x: number | null) => (x == null ? '' : `${x >= 0 ? '+' : ''}${Math.round(x * 100)}%`);
	const scaled = $derived(v.range.kind !== 'month');
</script>

<div class="toolbar"><h1>Spending</h1><a href="/spending/recurring" class="small">Recurring charges →</a></div>
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
<table><thead><tr><SortTh key="name" label="Category" kind="text" bind:sort={sortCat} /><SortTh key="groupName" label="Group" kind="text" class="hide-sm" bind:sort={sortCat} /><SortTh key="amount" label="Amount" kind="number" class="num" bind:sort={sortCat} /><SortTh key="share" label="Share" kind="number" class="num" bind:sort={sortCat} />{#if v.prevTotal != null}<SortTh key="prevAmount" label="Previous" kind="number" class="num" bind:sort={sortCat} /><SortTh key="delta" label="Δ" kind="number" class="num" bind:sort={sortCat} />{/if}<th></th></tr></thead>
<tbody>{#each sortRows(v.byCategory, sortCat, catPick) as c}<tr><td>{c.name}</td><td class="muted hide-sm">{c.groupName}</td><td class="num"><Money cents={c.amount} /></td><td class="num">{(c.share * 100).toFixed(1)}%</td>
	{#if v.prevTotal != null}<td class="num"><Money cents={c.prevAmount ?? 0} /></td><td class="num">{delta(c.amount, c.prevAmount)}</td>{/if}<td><a href={ledgerLink(c.categoryId)}>transactions →</a></td></tr>{:else}<tr><td colspan="7" class="muted">No spending in this range.</td></tr>{/each}</tbody></table>

<h2>By merchant</h2>
<table><thead><tr><SortTh key="payee" label="Merchant" kind="text" bind:sort={sortMerch} /><SortTh key="count" label="Count" kind="number" class="num" bind:sort={sortMerch} /><SortTh key="total" label="Total" kind="number" class="num" bind:sort={sortMerch} />{#if v.prevTotal != null}<SortTh key="prevTotal" label="Previous" kind="number" class="num" bind:sort={sortMerch} />{/if}</tr></thead>
<tbody>{#each sortRows(v.byMerchant, sortMerch) as m}<tr><td><a href="?{(() => { const u = new URL(page.url); u.searchParams.set('merchant', m.payee); return u.searchParams.toString(); })()}">{m.payee}</a></td><td class="num">{m.count}</td><td class="num"><Money cents={m.total} /></td>{#if v.prevTotal != null}<td class="num"><Money cents={m.prevTotal ?? 0} /></td>{/if}</tr>{/each}</tbody></table>

<h2>Trends <span class="muted small">last 12 months</span></h2>
<LineChart points={v.trends.months.map((m, i) => ({ label: monthLabel(m), value: v.trends.totals[i] }))} height={160} />
<table class="block trends">
	<thead><tr><SortTh key="name" label="Category" kind="text" bind:sort={sortTrend} /><SortTh key="currentPerMonth" label={scaled ? 'This range / mo' : 'This month'} kind="number" class="num" bind:sort={sortTrend} /><SortTh key="baseline" label="Usual month" kind="number" class="num hide-sm" bind:sort={sortTrend} /><SortTh key="delta" label="Δ" kind="number" class="num" bind:sort={sortTrend} /><th class="hide-sm">12 months</th></tr></thead>
	<tbody>
	{#each sortRows(v.trends.rows, sortTrend) as r (r.categoryId)}
		<tr>
			<td>{r.name}{#if scaled}<div class="small muted">actual <Money cents={r.current} /></div>{/if}<div class="small muted only-sm">usual {#if r.baseline == null}—{:else}<Money cents={r.baseline} />{/if}</div></td>
			<td class="num"><Money cents={r.currentPerMonth} /></td>
			<td class="num hide-sm">{#if r.baseline == null}<span class="muted">—</span>{:else}<Money cents={r.baseline} />{/if}</td>
			<td class="num">{#if r.delta == null}<span class="muted">—</span>{:else}<Money cents={r.delta} signed />{#if r.deltaPct != null}<div class="small muted">{pctLabel(r.deltaPct)}</div>{/if}{/if}</td>
			<td class="hide-sm spark"><Sparkline points={r.series.map((x, i) => ({ asOf: v.trends.months[i], current: x }))} height={28} /></td>
		</tr>
	{:else}<tr><td colspan="5" class="muted">No spending in the last twelve months.</td></tr>{/each}
	</tbody>
	<tfoot><tr><td>All spending{#if scaled}<div class="small muted">actual <Money cents={v.trends.total.current} /></div>{/if}</td><td class="num"><Money cents={v.trends.total.currentPerMonth} /></td><td class="num hide-sm">{#if v.trends.total.baseline == null}—{:else}<Money cents={v.trends.total.baseline} />{/if}</td><td class="num">{#if v.trends.total.delta == null}—{:else}<Money cents={v.trends.total.delta} signed />{#if v.trends.total.deltaPct != null}<div class="small muted">{pctLabel(v.trends.total.deltaPct)}</div>{/if}{/if}</td><td class="hide-sm"></td></tr></tfoot>
</table>
{#if scaled}<p class="small muted">Amounts are scaled to a 30-day month so a period or quarter compares with the usual month; "actual" is the range's real total.</p>{/if}

<h2>Unusual charges</h2>
<table class="block">
	<thead><tr><SortTh key="date" label="Date" kind="date" bind:sort={sortOut} /><SortTh key="payee" label="Payee" kind="text" bind:sort={sortOut} /><SortTh key="categoryName" label="Category" kind="text" class="hide-sm" bind:sort={sortOut} /><SortTh key="amount" label="Amount" kind="number" class="num" bind:sort={sortOut} /><SortTh key="usual" label="Usual" kind="number" class="num hide-sm" bind:sort={sortOut} /><SortTh key="multiple" label="Multiple" kind="number" class="num" bind:sort={sortOut} /></tr></thead>
	<tbody>
	{#each sortRows(v.outliers, sortOut) as o (o.id)}
		<tr><td class="date">{shortDate(o.date)}</td><td><a href="/ledger?q={encodeURIComponent(o.payee)}&from={o.date}&to={o.date}">{o.payee}</a><div class="small muted only-sm">{o.categoryName} · usual <Money cents={o.usual} /></div></td><td class="hide-sm">{o.categoryName}</td><td class="num"><Money cents={o.amount} /></td><td class="num hide-sm"><Money cents={o.usual} /></td><td class="num">{o.multiple}× <span class="muted small">{o.reason === 'category' ? 'for the category' : 'for this payee'}</span></td></tr>
	{:else}<tr><td colspan="6" class="muted">Nothing in this range stands out against the twelve months before it.</td></tr>{/each}
	</tbody>
</table>
