<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import Money from '$lib/ui/Money.svelte';
	import LineChart from '$lib/ui/LineChart.svelte';
	import PromoEditor, { type PromoDraft } from './PromoEditor.svelte';
	import { post } from '$lib/ui/api';
	import { decimalToCents } from '$lib/money';
	let { data } = $props();
	const v = $derived(data.view);
	let error = $state(''); let busy = $state<string | null>(null);
	let termsFor = $state<number | null>(null);
	let strategy = $state<'plan' | 'minimums' | 'avalanche' | 'snowball'>('plan');
	let promo = $state<PromoDraft | null>(null);
	const selected = $derived(v.strategies.find((s) => s.strategy === strategy) ?? v.strategies[0]);
	const run = async (key: string, fn: () => Promise<unknown>) => { error = ''; busy = key; try { await fn(); await invalidateAll(); } catch (e) { error = (e as Error).message; } finally { busy = null; } };
	const pct = (bps: number | null) => (bps == null ? '—' : `${(bps / 100).toFixed(2)}%`);
	const dollars = (c: number) => (c / 100).toFixed(2);
	const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	const month = (ym: string | null) => (ym == null ? 'never' : `${MONTHS[+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}`);
	const age = (m: number | null) => (m == null ? '—' : m < 12 ? `${m} mo` : `${(m / 12).toFixed(1)} yr`);
	const share = (x: number | null) => (x == null ? '—' : `${(x * 100).toFixed(0)}%`);
	const saveExtra = (accountId: number, s: string) => run(`x-${accountId}`, () => post('/api/debt/extras', { periodId: v.period.id, accountId, extraAmount: decimalToCents(s || '0') }));
	const openPromo = (p?: (typeof v.promos)[number]) => (promo = p
		? { id: p.id, accountId: p.accountId, description: p.description, original: dollars(p.original), remaining: dollars(p.remaining), apr: (p.aprBps / 100).toFixed(2), expiresOn: p.expiresOn }
		: { id: null, accountId: v.debts[0]?.id ?? null, description: '', original: '', remaining: '', apr: '0', expiresOn: '' });
</script>

<div class="toolbar">
	<h1>Debt</h1>
	<select value={v.period.id} onchange={(e) => goto(`/debt?period=${(e.target as HTMLSelectElement).value}`)}>
		{#each v.periods as p}<option value={p.id}>{p.label}</option>{/each}
	</select>
	{#if v.period.isCurrent}<span class="status paid">current</span>{/if}
</div>
{#if error}<p class="error">{error}</p>{/if}

{#if v.debts.length === 0}
	<p class="muted">No open debt accounts. Link a card or loan on <a href="/accounts">Accounts</a>.</p>
{:else}
	<h2>Debts</h2>
	<table class="block debts">
		<thead><tr><th>Account</th><th class="num">Owed</th><th class="num hide-sm">Accruing</th><th class="num">APR</th><th class="num">Interest / mo</th><th class="num hide-sm">Minimum</th><th class="hide-sm">Due</th><th class="num hide-sm">Fee</th><th class="hide-sm">Opened</th><th></th></tr></thead>
		<tbody>
		{#each v.debts as d (d.id)}
			<tr>
				<td>{d.name} <span class="muted small">{d.type}</span>
					<div class="small muted only-sm">min {#if d.minimum == null}—{:else}<Money cents={d.minimum} />{/if} · due {d.nextDue ?? '—'}{#if d.accruing !== d.owed} · accruing <Money cents={d.accruing} />{/if}</div></td>
				<td class="num"><Money cents={d.owed} />{#if d.asOf}<div class="small muted">{d.asOf}</div>{:else}<div class="small muted">no balance</div>{/if}</td>
				<td class="num hide-sm"><Money cents={d.accruing} /></td>
				<td class="num">{pct(d.aprBps)}{#if d.promoAprBps != null}<div class="small muted">promo {pct(d.promoAprBps)}</div>{/if}</td>
				<td class="num">{#if d.aprBps == null}<span class="muted" title="no APR on file">—</span>{:else}<Money cents={d.interest.monthly} /><div class="small muted hide-sm"><Money cents={d.interest.daily} /> / day · <Money cents={d.interest.yearly} /> / yr</div>{/if}</td>
				<td class="num hide-sm">{#if d.minimum == null}<span class="muted">—</span>{:else}<Money cents={d.minimum} />{/if}</td>
				<td class="hide-sm">{d.nextDue ?? '—'}</td>
				<td class="num hide-sm">{#if d.annualFee}<Money cents={d.annualFee} />{:else}<span class="muted">—</span>{/if}</td>
				<td class="hide-sm">{#if d.openedOn}{d.openedOn} <span class="muted small">{age(d.ageMonths)}</span>{:else}<span class="muted">—</span>{/if}</td>
				<td class="row-actions"><button class="small" onclick={() => (termsFor = termsFor === d.id ? null : d.id)}>{termsFor === d.id ? 'hide' : 'terms'}</button></td>
			</tr>
			{#if termsFor === d.id}
				<tr><td colspan="10" class="expanded">
					{#if d.terms.length === 0}<p class="muted small">No terms recorded. Add them on <a href="/accounts#account-{d.id}">Accounts</a>.</p>{:else}
					<table class="history"><thead><tr><th>As of</th><th class="num">APR</th><th class="num">Promo APR</th><th class="num">Minimum</th><th>Due</th><th class="num">Statement</th><th class="num">Fee</th><th>Source</th></tr></thead>
					<tbody>{#each d.terms as t}<tr><td>{t.asOf}</td><td class="num">{pct(t.aprBps)}</td><td class="num">{pct(t.promoAprBps)}</td><td class="num">{#if t.minPayment != null}<Money cents={t.minPayment} />{:else}—{/if}</td><td>{t.nextDueDate ?? '—'}</td><td class="num">{#if t.lastStatementBalance != null}<Money cents={t.lastStatementBalance} />{:else}—{/if}</td><td class="num">{#if t.annualFee != null}<Money cents={t.annualFee} />{:else}—{/if}</td><td>{t.source}</td></tr>{/each}</tbody></table>{/if}
				</td></tr>
			{/if}
		{/each}
		</tbody>
		<tfoot><tr><td>Total</td><td class="num"><Money cents={v.totals.owed} /></td><td class="num hide-sm"><Money cents={v.totals.accruing} /></td><td></td><td class="num"><Money cents={v.totals.interest.monthly} /><div class="small muted hide-sm"><Money cents={v.totals.interest.daily} /> / day · <Money cents={v.totals.interest.yearly} /> / yr</div></td><td class="num hide-sm"><Money cents={v.totals.minimum} /></td><td colspan="4"></td></tr></tfoot>
	</table>

	<h2>Plan · {v.period.label}</h2>
	<table class="block">
		<thead><tr><th>Account</th><th class="num">Minimum</th><th class="num">Extra</th><th class="num hide-sm">Planned</th><th class="num hide-sm">Envelope</th><th class="num">Shortfall</th><th></th></tr></thead>
		<tbody>
		{#each v.debts as d (d.id)}
			<tr>
				<td>{d.name}{#if d.categoryId == null}<span class="muted small" title="no debt_payment category is linked to this account"> · no envelope</span>{:else}<div class="small muted only-sm">envelope <Money cents={d.available ?? 0} signed /></div>{/if}</td>
				<td class="num">{#if d.minimum == null}<span class="muted" title="no terms minimum and no linked bill">none</span>{:else}<Money cents={d.minimum} />{/if}</td>
				<td class="num"><input class="num" value={dollars(d.extra)} disabled={busy != null} onchange={(e) => saveExtra(d.id, (e.target as HTMLInputElement).value)} /></td>
				<td class="num hide-sm"><Money cents={d.planned} /></td>
				<td class="num hide-sm">{#if d.available == null}<span class="muted">—</span>{:else}<Money cents={d.available} signed />{/if}</td>
				<td class="num">{#if d.categoryId == null}<span class="muted">—</span>{:else if d.shortfall > 0}<Money cents={d.shortfall} />{:else}<span class="status paid">funded</span>{/if}</td>
				<td class="row-actions">{#if d.shortfall > 0}<button class="small" disabled={busy != null} onclick={() => run(`f-${d.id}`, () => post('/api/debt/fund', { periodId: v.period.id, accountId: d.id }))}>Fund</button>{/if}</td>
			</tr>
		{/each}
		</tbody>
		<tfoot>
			<tr><td>Total</td><td class="num"><Money cents={v.totals.minimum} /></td><td class="num"><Money cents={v.totals.extra} /></td><td class="num hide-sm"><Money cents={v.totals.planned} /></td><td class="hide-sm"></td><td class="num"><Money cents={v.totals.shortfall} /></td><td></td></tr>
			<tr><td colspan="7" class="small muted">Ready to assign <Money cents={v.readyToAssign} signed />. Funding moves the shortfall from ready-to-assign into the payment envelope for this period.</td></tr>
		</tfoot>
	</table>

	<h2>Payoff</h2>
	<table class="block strategies">
		<thead><tr><th></th><th>Strategy</th><th>Debt-free</th><th class="num">Total interest</th><th class="num hide-sm">Saved vs minimums</th><th class="hide-sm">First target</th></tr></thead>
		<tbody>
		{#each v.strategies as s (s.strategy)}
			<tr class:active={s.strategy === strategy} onclick={() => (strategy = s.strategy)}>
				<td><input type="radio" name="strategy" value={s.strategy} bind:group={strategy} aria-label={s.label} /></td>
				<td>{s.label}{#if s.strategy === 'plan'}<div class="small muted">this period's extras, every period</div>{:else if s.strategy !== 'minimums'}<div class="small muted">extras pooled: <Money cents={v.totals.extra * v.periodsPerMonth} /> / mo</div>{/if}</td>
				<td>{#if s.capped}<span class="error">never</span>{:else}{month(s.debtFreeMonth)}{/if}</td>
				<td class="num">{#if s.capped}<span class="muted" title="a debt's payment does not cover its interest">—</span>{:else}<Money cents={s.totalInterest} />{/if}</td>
				<td class="num hide-sm">{#if s.interestSaved == null}<span class="muted">—</span>{:else}<Money cents={s.interestSaved} signed />{/if}</td>
				<td class="hide-sm">{s.firstTarget ?? '—'}</td>
			</tr>
		{/each}
		</tbody>
	</table>
	<LineChart points={selected.series.map((p) => ({ label: month(p.month), value: p.owed }))} />
	<p class="small muted">
		{selected.label}: {#each selected.payoffs as p, i}{i ? ' · ' : ''}{p.name} {#if p.stalled}<span class="error">never</span>{:else}{month(p.payoffMonth)}{/if}{/each}.
		Interest is applied monthly at the current APR on the accruing balance; payments stay at minimum plus extra; the minimum reduces promo balances first and the extra reduces the accruing balance first.
		A debt whose payment does not cover its interest is held flat and shown as never paid off.
	</p>

	<h2>Promo balances</h2>
	{#if v.promos.length}
	<table class="block">
		<thead><tr><th>Account</th><th>Description</th><th class="num hide-sm">Original</th><th class="num">Remaining</th><th class="num hide-sm">Promo APR</th><th>Expires</th><th class="num">Monthly target</th><th></th></tr></thead>
		<tbody>
		{#each v.promos as p (p.id)}
			<tr>
				<td>{p.accountName}</td><td>{p.description}<div class="small muted only-sm">of <Money cents={p.original} /> · {pct(p.aprBps)}</div></td>
				<td class="num hide-sm"><Money cents={p.original} /></td><td class="num"><Money cents={p.remaining} /></td><td class="num hide-sm">{pct(p.aprBps)}</td>
				<td>{p.expiresOn} <span class="muted small">{p.monthsLeft} mo</span></td>
				<td class="num"><span class:error={p.underTarget} title={p.underTarget ? `planned ${dollars(p.plannedMonthly)} / mo is below the target` : ''}><Money cents={p.monthlyTarget} /></span>{#if p.underTarget}<div class="small error">planned <Money cents={p.plannedMonthly} /> / mo</div>{/if}</td>
				<td class="row-actions"><button class="small" onclick={() => openPromo(p)}>edit</button> <button class="small" disabled={busy != null} onclick={() => run(`pc-${p.id}`, () => post(`/api/debt/promos/${p.id}/close`))}>close</button></td>
			</tr>
		{/each}
		</tbody>
	</table>
	{:else}<p class="muted small">No promotional balances. Add one when a card carries a 0% or deferred-interest balance with an expiry.</p>{/if}
	<div class="toolbar"><button class="small" onclick={() => openPromo()}>+ Promo balance</button></div>

	<h2>Trend</h2>
	<LineChart points={v.trend.map((r) => ({ label: r.label, value: r.total }))} />
	{#if v.trend.length}
	<table class="block">
		<thead><tr><th>Period</th><th class="num">Owed</th><th class="num">Change</th><th class="num">Paid</th><th class="num hide-sm">Interest</th><th class="num hide-sm">Income</th><th class="num">Paid / income</th></tr></thead>
		<tbody>
		{#each [...v.trend].reverse() as r (r.periodId)}
			<tr><td>{r.label}</td><td class="num"><Money cents={r.total} /></td><td class="num">{#if r.change == null}<span class="muted">—</span>{:else}<Money cents={r.change} signed />{/if}</td>
				<td class="num">{#if r.paid == null}<span class="muted">—</span>{:else}<Money cents={r.paid} />{/if}</td>
				<td class="num hide-sm">{#if r.interest == null}<span class="muted">—</span>{:else}<Money cents={r.interest} />{/if}</td>
				<td class="num hide-sm">{#if r.income == null}<span class="muted">—</span>{:else}<Money cents={r.income} />{/if}</td>
				<td class="num">{share(r.paidShare)}</td></tr>
		{/each}
		</tbody>
	</table>
	{:else}<p class="muted small">The trend appears once a debt account has a balance snapshot.</p>{/if}
{/if}

{#if promo}<PromoEditor draft={promo} accounts={v.debts.map((d) => ({ id: d.id, name: d.name }))} onclose={() => (promo = null)} onsave={async (id, body) => { promo = null; await run('promo', () => post(id == null ? '/api/debt/promos' : `/api/debt/promos/${id}`, body)); }} />{/if}
