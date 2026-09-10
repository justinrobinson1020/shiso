<script lang="ts">
	import type { Snippet } from 'svelte';
	let { open, title, onclose, children }: { open: boolean; title: string; onclose: () => void; children: Snippet } = $props();
	let el: HTMLDialogElement | undefined = $state();
	$effect(() => { if (!el) return; if (open && !el.open) el.showModal(); if (!open && el.open) el.close(); });
</script>
<dialog bind:this={el} onclose={onclose} onclick={(e) => { if (e.target === el && el?.open) el.close(); }}>
	<h2>{title}</h2>
	{@render children()}
</dialog>
