<script module lang="ts">
	export type PromoDraft = { id: number | null; accountId: number | null; description: string; original: string; remaining: string; apr: string; expiresOn: string };
</script>

<script lang="ts">
	import Dialog from '$lib/ui/Dialog.svelte';
	import { decimalToCents } from '$lib/money';
	let { draft, accounts, onsave, onclose }: { draft: PromoDraft; accounts: { id: number; name: string }[]; onsave: (id: number | null, body: Record<string, unknown>) => Promise<void>; onclose: () => void } = $props();
	let f = $state({ ...draft });
	let error = $state('');
	const bps = (s: string) => (s.trim() === '' ? 0 : Math.round(parseFloat(s) * 100));
</script>
<Dialog open={true} title={f.id == null ? 'New promo balance' : 'Promo balance'} {onclose}>
	<form class="grid" onsubmit={(e) => {
		e.preventDefault(); error = '';
		let body: Record<string, unknown>;
		try {
			if (f.accountId == null) throw new Error('choose an account');
			body = f.id == null
				? { accountId: f.accountId, description: f.description, originalAmount: decimalToCents(f.original), remainingAmount: f.remaining.trim() === '' ? null : decimalToCents(f.remaining), aprBps: bps(f.apr), expiresOn: f.expiresOn }
				: { description: f.description, remainingAmount: decimalToCents(f.remaining || '0'), aprBps: bps(f.apr), expiresOn: f.expiresOn };
		} catch (err) { error = (err as Error).message; return; }
		onsave(f.id, body);
	}}>
		<label for="pr-acct">Account</label>
		{#if f.id == null}<select id="pr-acct" bind:value={f.accountId} required><option value={null}>choose…</option>{#each accounts as a}<option value={a.id}>{a.name}</option>{/each}</select>
		{:else}<span>{accounts.find((a) => a.id === f.accountId)?.name}</span>{/if}
		<label for="pr-desc">Description</label><input id="pr-desc" bind:value={f.description} placeholder="Balance transfer, deferred-interest purchase…" required />
		<label for="pr-orig">Original amount</label><input id="pr-orig" class="num" bind:value={f.original} placeholder="0.00" required disabled={f.id != null} />
		<label for="pr-rem">Remaining</label><input id="pr-rem" class="num" bind:value={f.remaining} placeholder={f.id == null ? 'same as original' : '0.00'} />
		<label for="pr-apr">Promo APR %</label><input id="pr-apr" class="num" bind:value={f.apr} placeholder="0" />
		<label for="pr-exp">Expires</label><input id="pr-exp" type="date" bind:value={f.expiresOn} required />
		{#if error}<p class="error">{error}</p>{/if}
		<div class="actions"><button type="button" onclick={onclose}>Cancel</button><button class="primary" type="submit">Save</button></div>
	</form>
</Dialog>
