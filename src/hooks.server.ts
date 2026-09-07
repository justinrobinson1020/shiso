import type { ServerInit } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { loadConfig, setConfig } from '$lib/server/config';
import { startup } from '$lib/server/startup';
import { todayIso } from '$lib/dates';

export const init: ServerInit = async () => {
	const config = loadConfig(env);
	setConfig(config);
	const report = startup(config, todayIso(config.timeZone));
	console.log(`[shiso] database ready; periods created: ${report.periodsCreated}; snapshot: ${report.snapshot ?? 'none'}`);
};
