<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import Money from '$lib/ui/Money.svelte';
	import Dialog from '$lib/ui/Dialog.svelte';
	import TermsEditor, { type Terms } from './TermsEditor.svelte';
	import { post, upload } from '$lib/ui/api';
	import { decimalToCents } from '$lib/money';
	import { shortDate } from '$lib/dates';
	let { data } = $props();
	const v = $derived(data.view);
	let error = $state(''); let busy = $state<string | null>(null);
	let termsFor = $state<{ id: number; name: string; terms: Terms } | null>(null);
	let balanceFor = $state<{ id: number; current: string; asOf: string } | null>(null);
	let editFor = $state<{ id: number; name: string; type: string; onBudget: boolean; closed: boolean; closedAt: string | null } | null>(null);
	let addManual = $state<{ institutionName: string; accounts: { name: string; type: string }[] } | null>(null);
	let simplefin = $state<{ setupToken: string; institutionName: string } | null>(null);
	let plaidName = $state('');
	const run = async (key: string, fn: () => Promise<unknown>) => { error = ''; busy = key; try { await fn(); await invalidateAll(); } catch (e) { error = (e as Error).message; } finally { busy = null; } };
	const fmtTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'never');
	const pct = (bps: number | null) => (bps == null ? '—' : `${(bps / 100).toFixed(2)}%`);

	async function plaidLink(connectionId?: number) {
		if (!window.Plaid) { error = 'Plaid Link script not loaded'; return; }
		error = '';
		try {
			const { linkToken } = await post<{ linkToken: string }>('/api/plaid/link-token', connectionId ? { connectionId } : {});
			window.Plaid.create({ token: linkToken, onSuccess: (publicToken, meta) => {
				if (connectionId) run('relink', () => post(`/api/sync/${connectionId}`, {}));   // update mode: same access token, just sync again
				else run('plaid', () => post('/api/plaid/exchange', { publicToken, institutionName: plaidName || meta.institution?.name || 'Plaid' }));
			} }).open();
		} catch (e) { error = (e as Error).message; }
	}
	async function importCsv(accountId: number, input: HTMLInputElement) {
		const file = input.files?.[0]; if (!file) return;
		const fd = new FormData(); fd.set('file', file);
		await run(`import-${accountId}`, async () => { const r = await upload<{ created: number; duplicates: number }>(`/api/accounts/${accountId}/import`, fd); error = `Imported ${r.created} new, ${r.duplicates} duplicates`; });
		input.value = '';
	}
</script>

<svelte:head>{#if v.plaidConfigured}<script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>{/if}</svelte:head>

<h1>Accounts</h1>
<div class="toolbar">
	<button class="primary" disabled={busy != null} onclick={() => run('all', () => post('/api/sync', { mode: 'full' }))}>Sync all</button>
	<button disabled={busy != null} onclick={() => run('bal', () => post('/api/sync', { mode: 'balances' }))}>Refresh balances</button>
	{#if v.plaidConfigured}<input placeholder="Institution name (optional)" bind:value={plaidName} /><button onclick={() => plaidLink()}>+ Plaid</button>{:else}<span class="muted small">Plaid not configured</span>{/if}
	<button onclick={() => (simplefin = { setupToken: '', institutionName: '' })}>+ SimpleFIN</button>
	<button onclick={() => (addManual = { institutionName: '', accounts: [{ name: '', type: 'checking' }] })}>+ Manual</button>
</div>
{#if error}<p class="error">{error}</p>{/if}

{#each v.connections as c (c.id)}
	<div class="card connection">
		<div class="toolbar">
			<strong>{c.institutionName}</strong><span class="muted small">{c.provider}</span><span class="status {c.status}">{c.status}</span>
			<span class="small muted">last success {fmtTime(c.lastSuccessAt)}</span>
			{#if c.lastRun}<span class="small muted">last run {c.lastRun.status} · {c.lastRun.added} added · {c.lastRun.modified} changed · {c.lastRun.removed} removed{#if c.lastRun.error} · {c.lastRun.error}{/if}</span>{/if}
			{#if c.provider !== 'manual'}<button disabled={busy != null} onclick={() => run(`sync-${c.id}`, () => post(`/api/sync/${c.id}`, {}))}>Sync</button>{/if}
			{#if c.status === 'needs_relink' && c.provider === 'plaid'}<button class="primary" disabled={busy != null} onclick={() => plaidLink(c.id)}>Relink</button>{/if}
			{#if c.status === 'disabled'}<button disabled={busy != null} onclick={() => run('en', () => post(`/api/connections/${c.id}/status`, { status: 'active' }))}>Enable</button>{:else if c.provider !== 'manual'}<button disabled={busy != null} onclick={() => run('dis', () => post(`/api/connections/${c.id}/status`, { status: 'disabled' }))}>Disable</button>{/if}
		</div>
		{#if c.lastError}<p class="error small">{c.lastError}</p>{/if}
		<table class="stack-sm">
			<thead><tr><th>Account</th><th class="hide-sm">Type</th><th class="num">Balance</th><th class="num hide-sm">Ledger</th><th class="num">Drift</th><th class="hide-sm">Terms</th><th></th></tr></thead>
			<tbody>
			{#each c.accounts as a (a.id)}
				<tr id="account-{a.id}">
					<td>{a.name}{#if a.mask} <span class="muted small">····{a.mask}</span>{/if}{#if a.closedAt} <span class="status">closed {shortDate(a.closedAt)}</span>{/if}{#if !a.onBudget} <span class="status">off-budget</span>{/if}
						<div class="small muted only-sm">{a.type} · ledger <Money cents={a.drift.ledgerBalance} neutral={a.isDebt} />{#if a.isDebt && a.terms} · APR {pct(a.terms.aprBps)} · min <Money cents={a.terms.minPayment ?? 0} /> · due {a.terms.nextDueDate ? shortDate(a.terms.nextDueDate) : '—'}{/if}</div></td>
					<td class="hide-sm">{a.type}</td>
					<td class="num">{#if a.balance}<Money cents={a.balance.current} neutral={a.isDebt} /><div class="small muted nowrap">{shortDate(a.balance.asOf)} · {a.balance.source}</div>{:else}<span class="muted">—</span>{/if}</td>
					<td class="num hide-sm"><Money cents={a.drift.ledgerBalance} neutral={a.isDebt} /></td>
					<td class="num">{#if a.drift.drift != null && a.drift.drift !== 0}<Money cents={a.drift.drift} signed />
							<button class="small" disabled={busy != null} onclick={() => run(`adj-${a.id}`, () => post(`/api/accounts/${a.id}/adjust`, { amount: a.drift.drift, date: data.today }))}>adjust</button>
							<div class="small muted">{a.drift.convention === 'exclude_pending' ? 'excluding pending' : 'including pending'} · <button class="small" disabled={busy != null} onclick={() => run('conv', () => post(`/api/accounts/${a.id}/convention`, { convention: a.drift.convention === 'exclude_pending' ? 'include_pending' : 'exclude_pending' }))}>switch</button></div>
						{:else if a.drift.drift === 0}<span class="status paid">reconciled</span>{:else}<span class="muted">no balance</span>{/if}</td>
					<td class="hide-sm terms">{#if a.isDebt}{#if a.terms}<span class="small">APR {pct(a.terms.aprBps)} · min <Money cents={a.terms.minPayment ?? 0} /> · due {a.terms.nextDueDate ? shortDate(a.terms.nextDueDate) : '—'} <span class="muted">({a.terms.source})</span></span>{:else}<span class="muted small">no terms</span>{/if}
							<button class="small" onclick={() => (termsFor = { id: a.id, name: a.name, terms: a.terms })}>edit</button>{/if}</td>
					<td class="row-actions">
						{#if a.isDebt}<button class="small only-sm" onclick={() => (termsFor = { id: a.id, name: a.name, terms: a.terms })}>terms</button>{/if}
						<button class="small" onclick={() => (balanceFor = { id: a.id, current: a.balance ? (a.balance.current / 100).toFixed(2) : '', asOf: data.today })}>balance</button>
						<button class="small" onclick={() => (editFor = { id: a.id, name: a.name, type: a.type, onBudget: a.onBudget, closed: a.closedAt != null, closedAt: a.closedAt })}>edit</button>
						<label class="small">csv <input type="file" accept=".csv,text/csv" hidden onchange={(e) => importCsv(a.id, e.currentTarget)} /></label>
					</td>
				</tr>
			{/each}
			</tbody>
		</table>
	</div>
{:else}<p class="muted">No connections yet. Connect a bank with Plaid, paste a SimpleFIN token, or add a manual account and enter balances by hand.</p>{/each}

{#if termsFor}<TermsEditor account={termsFor} terms={termsFor.terms} today={data.today} onclose={() => (termsFor = null)} onsave={async (body) => { const id = termsFor!.id; termsFor = null; await run('terms', () => post(`/api/accounts/${id}/terms`, body)); }} />{/if}

{#if balanceFor}
<Dialog open={true} title="Record balance" onclose={() => (balanceFor = null)}>
	<form class="grid" onsubmit={(e) => { e.preventDefault(); const b = balanceFor!; balanceFor = null; run('balance', () => post(`/api/accounts/${b.id}/balance`, { current: decimalToCents(b.current), asOf: b.asOf })); }}>
		<label for="b-cur">Current balance</label><input id="b-cur" class="num" bind:value={balanceFor.current} placeholder="-1234.56 for money owed" required />
		<label for="b-asof">As of</label><input id="b-asof" type="date" bind:value={balanceFor.asOf} required />
		<div class="actions"><button type="button" onclick={() => (balanceFor = null)}>Cancel</button><button class="primary" type="submit">Save</button></div>
	</form>
</Dialog>
{/if}

{#if editFor}
<Dialog open={true} title="Edit account" onclose={() => (editFor = null)}>
	<form class="grid" onsubmit={(e) => { e.preventDefault(); const f = editFor!; editFor = null; run('edit', () => post(`/api/accounts/${f.id}`, { name: f.name, type: f.type, onBudget: f.onBudget, closedAt: f.closed ? (f.closedAt ?? data.today) : null })); }}>
		<label for="e-name">Name</label><input id="e-name" bind:value={editFor.name} required />
		<label for="e-type">Type</label><select id="e-type" bind:value={editFor.type}>{#each v.types as t}<option value={t}>{t}</option>{/each}</select>
		<label for="e-ob">On budget</label><input id="e-ob" type="checkbox" bind:checked={editFor.onBudget} />
		<label for="e-cl">Closed</label><input id="e-cl" type="checkbox" bind:checked={editFor.closed} />
		<div class="actions"><button type="button" onclick={() => (editFor = null)}>Cancel</button><button class="primary" type="submit">Save</button></div>
	</form>
</Dialog>
{/if}

{#if addManual}
<Dialog open={true} title="Manual connection" onclose={() => (addManual = null)}>
	<form onsubmit={(e) => { e.preventDefault(); const m = addManual!; addManual = null; run('manual', () => post('/api/connections', m)); }}>
		<div class="grid"><label for="m-inst">Institution</label><input id="m-inst" bind:value={addManual.institutionName} required /></div>
		<table><thead><tr><th>Account</th><th>Type</th><th></th></tr></thead><tbody>
		{#each addManual.accounts as a, i}<tr><td><input bind:value={a.name} required /></td><td><select bind:value={a.type}>{#each v.types as t}<option value={t}>{t}</option>{/each}</select></td><td><button type="button" onclick={() => addManual!.accounts.splice(i, 1)} disabled={addManual.accounts.length === 1}>×</button></td></tr>{/each}
		</tbody></table>
		<div class="actions"><button type="button" onclick={() => addManual!.accounts.push({ name: '', type: 'credit' })}>Add account</button><button type="button" onclick={() => (addManual = null)}>Cancel</button><button class="primary" type="submit">Create</button></div>
	</form>
</Dialog>
{/if}

{#if simplefin}
<Dialog open={true} title="Connect SimpleFIN" onclose={() => (simplefin = null)}>
	<p class="small muted">Paste the setup token from your SimpleFIN Bridge account. It is claimed once and exchanged for an access URL stored encrypted.</p>
	<form class="grid" onsubmit={(e) => { e.preventDefault(); const s = simplefin!; simplefin = null; run('simplefin', () => post('/api/simplefin/claim', s)); }}>
		<label for="s-name">Institution</label><input id="s-name" bind:value={simplefin.institutionName} required />
		<label for="s-tok">Setup token</label><textarea id="s-tok" rows="3" bind:value={simplefin.setupToken} required></textarea>
		<div class="actions"><button type="button" onclick={() => (simplefin = null)}>Cancel</button><button class="primary" type="submit">Connect</button></div>
	</form>
</Dialog>
{/if}
