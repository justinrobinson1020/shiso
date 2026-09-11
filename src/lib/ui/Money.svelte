<script lang="ts">
	import { formatCents } from '$lib/money';
	/** `signed`: color positives green. `neutral`: leave negatives uncolored (an outflow or a card balance is not an alarm). */
	let { cents, signed = false, neutral = false }: { cents: number; signed?: boolean; neutral?: boolean } = $props();
</script>
<span class="money" class:neg={!neutral && cents < 0} class:pos={signed && cents > 0}>{formatCents(cents)}</span>
