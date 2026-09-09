<script module lang="ts">
	export type Terms = { aprBps: number | null; promoAprBps: number | null; minPayment: number | null; nextDueDate: string | null; lastStatementBalance: number | null; lastStatementDate: string | null; annualFee: number | null } | null;
</script>

<script lang="ts">
	import Dialog from '$lib/ui/Dialog.svelte';
	import { decimalToCents } from '$lib/money';
	let { account, terms, today, onsave, onclose }: { account: { id: number; name: string }; terms: Terms; today: string; onsave: (body: Record<string, unknown>) => Promise<void>; onclose: () => void } = $props();
	const pct = (bps: number | null) => (bps == null ? '' : (bps / 100).toFixed(2));
	const dollars = (c: number | null) => (c == null ? '' : (c / 100).toFixed(2));
	let f = $state({ asOf: today, apr: pct(terms?.aprBps ?? null), promoApr: pct(terms?.promoAprBps ?? null), minPayment: dollars(terms?.minPayment ?? null), nextDueDate: terms?.nextDueDate ?? '', lastStatementBalance: dollars(terms?.lastStatementBalance ?? null), lastStatementDate: terms?.lastStatementDate ?? '', annualFee: dollars(terms?.annualFee ?? null) });
	let error = $state('');
	const bps = (s: string) => (s.trim() === '' ? null : Math.round(parseFloat(s) * 100));
	const c = (s: string) => (s.trim() === '' ? null : decimalToCents(s));
	const d = (s: string) => (s.trim() === '' ? null : s);
</script>
<Dialog open={true} title="Terms · {account.name}" {onclose}>
	<form class="grid" onsubmit={(e) => {
		e.preventDefault();
		error = '';
		let body: Record<string, unknown>;
		try { body = { asOf: f.asOf, aprBps: bps(f.apr), promoAprBps: bps(f.promoApr), minPayment: c(f.minPayment), nextDueDate: d(f.nextDueDate), lastStatementBalance: c(f.lastStatementBalance), lastStatementDate: d(f.lastStatementDate), annualFee: c(f.annualFee) }; }
		catch (err) { error = (err as Error).message; return; }
		onsave(body);
	}}>
		<label for="t-asof">As of</label><input id="t-asof" type="date" bind:value={f.asOf} required />
		<label for="t-apr">APR %</label><input id="t-apr" class="num" bind:value={f.apr} placeholder="27.49" />
		<label for="t-promo">Promo APR %</label><input id="t-promo" class="num" bind:value={f.promoApr} />
		<label for="t-min">Minimum payment</label><input id="t-min" class="num" bind:value={f.minPayment} />
		<label for="t-due">Next due date</label><input id="t-due" type="date" bind:value={f.nextDueDate} />
		<label for="t-stmt">Last statement balance</label><input id="t-stmt" class="num" bind:value={f.lastStatementBalance} />
		<label for="t-stmtd">Last statement date</label><input id="t-stmtd" type="date" bind:value={f.lastStatementDate} />
		<label for="t-fee">Annual fee</label><input id="t-fee" class="num" bind:value={f.annualFee} />
		{#if error}<p class="error" style="grid-column: 1 / -1">{error}</p>{/if}
		<div class="actions" style="grid-column: 1 / -1"><button type="button" onclick={onclose}>Cancel</button><button class="primary" type="submit">Save terms</button></div>
	</form>
</Dialog>
