<script lang="ts">
	import { flushSync, type Snippet } from 'svelte';
	/**
	 * A native select that renders only its current option until it is touched. One select per row with every
	 * category or period in it put ~10k <option> nodes on a 100-row Ledger page. Arming on pointerdown or focus
	 * flushes the full list synchronously, so it is in place before the browser opens the picker.
	 *
	 * `quiet` shows the current label as text in the surrounding (small, muted) type and lays the real select over
	 * it, transparent and at 16px: a tap still opens the native picker, and iOS does not zoom as it does for
	 * selects under 16px.
	 */
	let { value, label, onchange, options, quiet = false, class: cls = '', 'aria-label': ariaLabel }: {
		value: string | number | null; label: string; onchange: (value: string) => void; options: Snippet; quiet?: boolean; class?: string; 'aria-label'?: string;
	} = $props();
	let armed = $state(false);
	const arm = () => { if (!armed) flushSync(() => (armed = true)); };
</script>

{#snippet select()}
	<select class={cls} {value} aria-label={ariaLabel} onpointerdown={arm} onfocus={arm} onchange={(e) => onchange(e.currentTarget.value)}>
		{#if armed}{@render options()}{:else}<option {value}>{label}</option>{/if}
	</select>
{/snippet}

{#if quiet}<span class="quiet-select">{label}<span aria-hidden="true"> ▾</span>{@render select()}</span>{:else}{@render select()}{/if}

<style>
	.quiet-select { position: relative; display: inline-block; text-decoration: underline; text-decoration-color: color-mix(in oklch, currentColor, transparent 60%); text-underline-offset: 2px; }
	.quiet-select select { position: absolute; inset: 0; width: 100%; min-height: 0; opacity: 0; font-size: 16px; cursor: pointer; }
	.quiet-select:focus-within { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 2px; }
</style>
