<script lang="ts">
	import { formatCents } from '$lib/money';
	let { cents, signed = false }: { cents: number; signed?: boolean } = $props();
</script>
<span class="money" class:neg={cents < 0} class:pos={signed && cents > 0}>{formatCents(cents)}</span>
