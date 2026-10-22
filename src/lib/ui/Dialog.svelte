<script lang="ts">
	import type { Snippet } from 'svelte';
	let { open, title, onclose, children }: { open: boolean; title: string; onclose: () => void; children: Snippet } = $props();
	let el: HTMLDialogElement | undefined = $state();
	$effect(() => { if (!el) return; if (open && !el.open) el.showModal(); if (!open && el.open) el.close(); });
	// A click on the backdrop and a click on the dialog's own padding both target the <dialog> element, so the
	// target alone cannot tell them apart; only a point outside the box is the backdrop.
	function backdrop(e: MouseEvent) {
		if (!el?.open || e.target !== el) return;
		const r = el.getBoundingClientRect();
		if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) el.close();
	}
</script>
<dialog bind:this={el} onclose={onclose} onclick={backdrop}>
	<h2>{title}</h2>
	{@render children()}
</dialog>
