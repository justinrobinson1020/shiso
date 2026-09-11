<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { post } from '$lib/ui/api';
	import { decimalToCents } from '$lib/money';
	let { data } = $props();
	const t = $derived(data.tree);
	let error = $state(''); let newGroup = $state('');
	let draft = $state<Record<number, { name: string; kind: string; accountId: number | null }>>({});
	const run = async (fn: () => Promise<unknown>) => { error = ''; try { await fn(); await invalidateAll(); } catch (e) { error = (e as Error).message; } };
	function startNew(groupId: number) { draft[groupId] = { name: '', kind: 'spending', accountId: null }; }
	async function create(groupId: number) {
		const d = draft[groupId]; await run(() => post('/api/categories', { groupId, name: d.name, kind: d.kind, accountId: d.kind === 'debt_payment' ? d.accountId : null })); delete draft[groupId];
	}
	const patch = (id: number, body: unknown) => run(() => post(`/api/categories/${id}`, body));

	// Targets (P4): one draft per category, saved by the button; a blank amount clears.
	type TargetDraft = { kind: string; amount: string; targetDate: string };
	let targets = $state<Record<number, TargetDraft>>({});
	const targetDraft = (c: { id: number; target: { kind: string; amount: number; targetDate: string | null } | null }): TargetDraft =>
		targets[c.id] ?? { kind: c.target?.kind ?? 'monthly', amount: c.target ? (c.target.amount / 100).toFixed(2) : '', targetDate: c.target?.targetDate ?? '' };
	function editTarget(c: { id: number; target: { kind: string; amount: number; targetDate: string | null } | null }, patchDraft: Partial<TargetDraft>) { targets[c.id] = { ...targetDraft(c), ...patchDraft }; }
	async function saveTarget(id: number) {
		const d = targets[id]; if (!d) return;
		if (d.amount.trim() === '') { await run(() => post(`/api/budget/targets/${id}/clear`)); delete targets[id]; return; }
		await run(() => post('/api/budget/targets', { categoryId: id, kind: d.kind, amount: decimalToCents(d.amount), targetDate: d.kind === 'by_date' ? d.targetDate || null : null }));
		delete targets[id];
	}

	let pcmDraft = $state<Record<string, number>>({});
	let pcmMessage = $state('');
	const pcmValue = (key: string) => pcmDraft[key] ?? data.pcm.map[key] ?? 0;
	async function savePcm() {
		pcmMessage = '';
		await run(async () => {
			const map: Record<string, number> = {};
			for (const p of data.pcm.providerCategories) { const v = pcmValue(p.key); if (v) map[p.key] = v; }
			const res = await post<{ categorized: number }>('/api/provider-category-map', { map, applyToExisting: true });
			pcmMessage = `Categorized ${res.categorized} existing rows`;
		});
	}
</script>

<h1>Categories</h1>
<p class="small"><a href="/budget">← Budget</a></p>
{#if error}<p class="error">{error}</p>{/if}
<form class="toolbar" onsubmit={(e) => { e.preventDefault(); run(() => post('/api/category-groups', { name: newGroup })).then(() => (newGroup = '')); }}>
	<input placeholder="New group name" bind:value={newGroup} /><button class="primary" type="submit">Add group</button>
</form>
{#each t.groups as g}
	<h2>{g.name} <button class="small" onclick={() => startNew(g.id)}>+ category</button></h2>
	<table>
		<thead><tr><th>Name</th><th>Kind</th><th>Linked account</th><th>Group</th><th>Hidden</th><th>Target</th></tr></thead>
		<tbody>
		{#each g.categories as c (c.id)}
			<tr>
				<td><input class="inline" value={c.name} onchange={(e) => patch(c.id, { name: (e.target as HTMLInputElement).value })} /></td>
				<td>{#if c.isSystem}<span class="muted">{c.kind}</span>{:else}
					<select value={c.kind} onchange={(e) => patch(c.id, { kind: (e.target as HTMLSelectElement).value, accountId: c.accountId })}>{#each t.kinds as k}<option value={k}>{k}</option>{/each}</select>{/if}</td>
				<td>{#if c.kind === 'debt_payment'}
					<select value={c.accountId} onchange={(e) => patch(c.id, { accountId: Number((e.target as HTMLSelectElement).value) })}>{#each t.debtAccounts as a}<option value={a.id}>{a.name}</option>{/each}</select>{:else}<span class="muted">—</span>{/if}</td>
				<td><select value={c.groupId ?? g.id} onchange={(e) => patch(c.id, { groupId: Number((e.target as HTMLSelectElement).value) })}>{#each t.groups as og}<option value={og.id}>{og.name}</option>{/each}</select></td>
				<td><input type="checkbox" checked={c.hidden} onchange={(e) => patch(c.id, { hidden: (e.target as HTMLInputElement).checked })} /></td>
				<td class="target-editor">{#if !['income', 'transfer', 'reconciliation'].includes(c.kind)}
					{@const d = targetDraft(c)}
					<select value={d.kind} onchange={(e) => editTarget(c, { kind: (e.target as HTMLSelectElement).value })}><option value="monthly">per month</option><option value="refill">keep available</option><option value="by_date">by date</option></select>
					<input class="num w5" placeholder="0.00" value={d.amount} onchange={(e) => editTarget(c, { amount: (e.target as HTMLInputElement).value })} />
					{#if d.kind === 'by_date'}<input type="date" value={d.targetDate} onchange={(e) => editTarget(c, { targetDate: (e.target as HTMLInputElement).value })} />{/if}
					{#if targets[c.id]}<button class="small primary" onclick={() => saveTarget(c.id)}>Save</button>{:else if c.target}<span class="status paid">set</span>{/if}
				{:else}<span class="muted">—</span>{/if}</td>
			</tr>
		{/each}
		{#if draft[g.id]}
			<tr>
				<td><input placeholder="Name" bind:value={draft[g.id].name} /></td>
				<td><select bind:value={draft[g.id].kind}>{#each t.kinds as k}<option value={k}>{k}</option>{/each}</select></td>
				<td>{#if draft[g.id].kind === 'debt_payment'}<select bind:value={draft[g.id].accountId}><option value={null}>choose…</option>{#each t.debtAccounts as a}<option value={a.id}>{a.name}</option>{/each}</select>{/if}</td>
				<td colspan="2"><button class="primary" onclick={() => create(g.id)}>Create</button> <button onclick={() => delete draft[g.id]}>Cancel</button></td>
			</tr>
		{/if}
		</tbody>
	</table>
{/each}

<h2>Provider categories</h2>
{#if data.pcm.providerCategories.length === 0}
	<p class="small muted">No provider categories seen yet.</p>
{:else}
	<table>
		<thead><tr><th>Provider category</th><th>Count</th><th>Category</th></tr></thead>
		<tbody>
		{#each data.pcm.providerCategories as p (p.key)}
			<tr>
				<td>{p.key}</td>
				<td class="num">{p.count}</td>
				<td>
					<select value={pcmValue(p.key)} onchange={(e) => (pcmDraft[p.key] = Number((e.target as HTMLSelectElement).value))}>
						<option value={0}>Unmapped</option>
						{#each t.groups as g}
							<optgroup label={g.name}>
								{#each g.categories.filter((c) => !c.hidden || c.id === pcmValue(p.key)) as c}
									<option value={c.id}>{c.name}</option>
								{/each}
							</optgroup>
						{/each}
					</select>
				</td>
			</tr>
		{/each}
		</tbody>
	</table>
	<button class="primary" onclick={savePcm}>Save mapping</button>
	{#if pcmMessage}<p class="small">{pcmMessage}</p>{/if}
{/if}
