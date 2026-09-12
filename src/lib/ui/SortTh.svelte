<script lang="ts">
	import { nextSort, type SortKind, type SortState } from './sort';
	/**
	 * A sortable header cell. With `bind:sort` the page sorts its loaded rows; with `href` the header is a
	 * link (the Ledger sorts on the server through the URL) and `sort` is read-only.
	 */
	/** Pages that keep one sort per table in a keyed record cannot `bind:` an entry that does not exist yet
	 *  (Svelte refuses to bind `undefined` into a prop with a default), so they pass `sort` plainly and take `onsort`. */
	let { key, label, kind = 'text', sort = $bindable(null), href, onsort, class: cls = '' }: {
		key: string; label: string; kind?: SortKind; sort?: SortState; href?: (next: NonNullable<SortState>) => string; onsort?: (next: NonNullable<SortState>) => void; class?: string;
	} = $props();
	const active = $derived(sort?.key === key);
	const next = $derived(nextSort(sort, key, kind));
	const aria = $derived(active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : 'none');
</script>

<th class="sortable {cls}" aria-sort={aria}>
	{#if href}
		<a href={href(next)} class:active>{label}<span class="arrow" aria-hidden="true">{active ? (sort!.dir === 'asc' ? '▲' : '▼') : ''}</span></a>
	{:else}
		<button type="button" class:active onclick={() => { if (onsort) onsort(next); else sort = next; }}>{label}<span class="arrow" aria-hidden="true">{active ? (sort!.dir === 'asc' ? '▲' : '▼') : ''}</span></button>
	{/if}
</th>

<style>
	th.sortable { padding: 0; }
	th.sortable button, th.sortable a { all: unset; cursor: pointer; display: block; width: 100%; box-sizing: border-box; padding: var(--th-pad, 0.4rem 0.5rem); font: inherit; color: inherit; text-align: inherit; }
	th.sortable button:hover, th.sortable a:hover, th.sortable .active { text-decoration: underline; text-underline-offset: 0.2em; }
	th.sortable button:focus-visible, th.sortable a:focus-visible { outline: 2px solid var(--focus, currentColor); outline-offset: -2px; }
	.arrow { display: inline-block; width: 1em; margin-left: 0.15em; font-size: 0.7em; }
</style>
