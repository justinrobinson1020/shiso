<script module lang="ts">
	export type Def = { id?: number; name: string; categoryId: number | null; accountId: number | null; expectedAmount: string; cadence: string; dueDay: number | null; dueDay2: number | null; interval: number | null; anchorDate: string | null; toleranceAbs: string; tolerancePct: number; matchPattern: string; autopay: boolean; linkedDebtAccountId: number | null; active: boolean };
</script>

<script lang="ts">
	import Dialog from '$lib/ui/Dialog.svelte';
	import { decimalToCents } from '$lib/money';
	import type { CategoryTree } from '$lib/server/read/categories';
	let { kind, def, tree, accounts, cadences, onsave, onclose }: { kind: 'bill' | 'income'; def: Def; tree: CategoryTree; accounts: { id: number; name: string; type: string; isDebt: boolean }[]; cadences: readonly string[]; onsave: (body: Record<string, unknown>) => Promise<void>; onclose: () => void } = $props();
	let f = $state({ ...def });
	let error = $state('');
	function body(): Record<string, unknown> {
		const b: Record<string, unknown> = { name: f.name, categoryId: f.categoryId, expectedAmount: decimalToCents(f.expectedAmount), cadence: f.cadence, dueDay: f.dueDay, dueDay2: f.dueDay2, interval: f.interval, anchorDate: f.anchorDate, toleranceAbs: f.toleranceAbs ? decimalToCents(f.toleranceAbs) : 0, tolerancePct: f.tolerancePct, matchPattern: f.matchPattern || null };
		if (kind === 'bill') { b.payFromAccountId = f.accountId; b.autopay = f.autopay; b.linkedDebtAccountId = f.linkedDebtAccountId; } else b.depositAccountId = f.accountId;
		if (f.id != null) b.active = f.active;
		return b;
	}
	const cashAccounts = $derived(accounts.filter((a) => !a.isDebt)); const debtAccounts = $derived(accounts.filter((a) => a.isDebt));
</script>
<Dialog open={true} title={(f.id != null ? 'Edit ' : 'New ') + kind} {onclose}>
	<form class="grid" onsubmit={(e) => {
		e.preventDefault();
		error = '';
		let b: Record<string, unknown>;
		try { b = body(); } catch (err) { error = (err as Error).message; return; }
		onsave(b);
	}}>
		<label for="d-name">Name</label><input id="d-name" bind:value={f.name} required />
		<label for="d-cat">Category</label><select id="d-cat" bind:value={f.categoryId} required><option value={null}>choose…</option>{#each tree.groups as g}<optgroup label={g.name}>{#each g.categories as c}<option value={c.id}>{c.name}</option>{/each}</optgroup>{/each}</select>
		<label for="d-acct">{kind === 'bill' ? 'Paid from' : 'Deposited to'}</label><select id="d-acct" bind:value={f.accountId} required><option value={null}>choose…</option>{#each cashAccounts as a}<option value={a.id}>{a.name}</option>{/each}</select>
		<label for="d-amt">Expected amount</label><input id="d-amt" class="num" bind:value={f.expectedAmount} required />
		<label for="d-cad">Cadence</label><select id="d-cad" bind:value={f.cadence}>{#each cadences as c}<option value={c}>{c}</option>{/each}</select>
		{#if f.cadence === 'monthly' || f.cadence === 'semi_monthly'}<label for="d-day">Due day</label><input id="d-day" type="number" min="1" max="31" bind:value={f.dueDay} required />{/if}
		{#if f.cadence === 'semi_monthly'}<label for="d-day2">Second due day</label><input id="d-day2" type="number" min="1" max="31" bind:value={f.dueDay2} required />{/if}
		{#if f.cadence === 'every_n_weeks'}<label for="d-int">Every N weeks</label><input id="d-int" type="number" min="1" bind:value={f.interval} required />{/if}
		{#if f.cadence === 'every_n_weeks' || f.cadence === 'yearly'}<label for="d-anchor">Anchor date</label><input id="d-anchor" type="date" bind:value={f.anchorDate} required />{/if}
		<label for="d-tol">Tolerance ($ / %)</label><span><input class="num w5" bind:value={f.toleranceAbs} placeholder="0.00" /> <input type="number" min="0" max="100" class="w4" bind:value={f.tolerancePct} /></span>
		<label for="d-pat">Match pattern</label><input id="d-pat" bind:value={f.matchPattern} placeholder="substring of the payee, optional" />
		{#if kind === 'bill'}
			<label for="d-auto">Autopay</label><input id="d-auto" type="checkbox" bind:checked={f.autopay} />
			<label for="d-debt">Card / loan paid</label><select id="d-debt" bind:value={f.linkedDebtAccountId}><option value={null}>not a debt payment</option>{#each debtAccounts as a}<option value={a.id}>{a.name}</option>{/each}</select>
		{/if}
		{#if f.id != null}<label for="d-active">Active</label><input id="d-active" type="checkbox" bind:checked={f.active} />{/if}
		{#if error}<p class="error">{error}</p>{/if}
		<div class="actions"><button type="button" onclick={onclose}>Cancel</button><button class="primary" type="submit">Save</button></div>
	</form>
</Dialog>
