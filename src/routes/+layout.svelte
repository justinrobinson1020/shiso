<script lang="ts">
	import '@fontsource/ibm-plex-sans/latin-400.css';
	import '@fontsource/ibm-plex-sans/latin-500.css';
	import '@fontsource/ibm-plex-sans/latin-600.css';
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import { page } from '$app/state';
	let { data, children } = $props();
	const links = [
		{ href: '/', label: 'Month' }, { href: '/budget', label: 'Budget' }, { href: '/ledger', label: 'Ledger' },
		{ href: '/spending', label: 'Spending' }, { href: '/accounts', label: 'Accounts' }, { href: '/bills', label: 'Bills' }
	];
	const active = (href: string) => (href === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(href));
</script>

<svelte:head><link rel="icon" href={favicon} /><title>shiso</title></svelte:head>

<nav class="topnav">
	<span class="brand">shiso</span>
	{#each links as l}
		<a href={l.href} class:active={active(l.href)}>
			{l.label}{#if l.href === '/ledger' && data.nav.reviewCount > 0}<span class="badge">{data.nav.reviewCount}</span>{/if}
		</a>
	{/each}
</nav>
<main>{@render children()}</main>
