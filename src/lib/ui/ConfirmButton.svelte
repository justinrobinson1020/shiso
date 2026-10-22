<script lang="ts">
	/**
	 * A destructive action that takes a second press within a few seconds. Inline rather than a dialog: the row
	 * stays in view and nothing else is blocked, and a stray tap (the review "clear" sits right above "delete"
	 * on a phone) only arms it.
	 */
	let { label, confirm = `confirm ${label}`, onconfirm, disabled = false, class: cls = '' }: {
		label: string; confirm?: string; onconfirm: () => void; disabled?: boolean; class?: string;
	} = $props();
	let armed = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;
	function press() {
		clearTimeout(timer);
		if (!armed) { armed = true; timer = setTimeout(() => (armed = false), 4000); return; }
		armed = false;
		onconfirm();
	}
	$effect(() => () => clearTimeout(timer));
</script>

<button type="button" class="{cls} danger" class:armed {disabled} onclick={press} onblur={() => (armed = false)}>{armed ? confirm : label}</button>
