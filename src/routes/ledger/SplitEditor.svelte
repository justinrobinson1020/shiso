<script lang="ts">
	import Dialog from '$lib/ui/Dialog.svelte';
	import { decimalToCents, formatCents } from '$lib/money';
	import type { CategoryTree } from '$lib/server/read/categories';
	let { row, tree, onsave, onclose }: { row: { id: number; amount: number; splits: { categoryId: number; amount: number; memo: string | null }[] }; tree: CategoryTree; onsave: (splits: { categoryId: number; amount: number; memo: string | null }[]) => Promise<void>; onclose: () => void } = $props();
	let lines = $state(row.splits.map((s) => ({ categoryId: s.categoryId, amount: (s.amount / 100).toFixed(2), memo: s.memo ?? '' })));
	let error = $state('');
	const parsedLines = $derived(lines.map((l) => { try { return decimalToCents(l.amount); } catch { return null; } }));
	const valid = $derived(parsedLines.every((p) => p != null));
	const sum = $derived(parsedLines.reduce((s: number, p) => s + (p ?? 0), 0));
	const remaining = $derived(row.amount - sum);
</script>
<Dialog open={true} title="Split transaction" {onclose}>
	<table><thead><tr><th>Category</th><th class="num">Amount</th><th>Memo</th><th></th></tr></thead><tbody>
	{#each lines as l, i}
		<tr><td><select bind:value={l.categoryId}>{#each tree.groups as g}<optgroup label={g.name}>{#each g.categories.filter((c) => !c.hidden || c.id === l.categoryId) as c}<option value={c.id}>{c.name}</option>{/each}</optgroup>{/each}</select></td>
		<td><input class="num" bind:value={l.amount} /></td><td><input bind:value={l.memo} /></td>
		<td><button type="button" onclick={() => lines.splice(i, 1)} disabled={lines.length === 1}>×</button></td></tr>
	{/each}
	</tbody></table>
	<p class="small">Total {formatCents(row.amount)} · remaining <span class:error={remaining !== 0}>{formatCents(remaining)}</span></p>
	{#if error}<p class="error">{error}</p>{/if}
	<div class="actions">
		<button type="button" onclick={() => lines.push({ categoryId: lines[0].categoryId, amount: (remaining / 100).toFixed(2), memo: '' })}>Add line</button>
		<button type="button" onclick={onclose}>Cancel</button>
		<button class="primary" disabled={remaining !== 0 || !valid} onclick={() => {
			error = '';
			let splits: { categoryId: number; amount: number; memo: string | null }[];
			try { splits = lines.map((l) => ({ categoryId: l.categoryId, amount: decimalToCents(l.amount), memo: l.memo || null })); }
			catch (e) { error = (e as Error).message; return; }
			onsave(splits);
		}}>Save</button>
	</div>
</Dialog>
