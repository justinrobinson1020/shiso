import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = process.cwd();

function readDeployFile(name: string): string {
	return readFileSync(resolve(repoRoot, name), 'utf8');
}

describe('deploy/shiso.service', () => {
	const unit = readDeployFile('deploy/shiso.service');

	it('pins the restart policy', () => {
		expect(unit).toMatch(/^Restart=on-failure$/m);
		expect(unit).toMatch(/^RestartSec=30$/m);
		expect(unit).toMatch(/^StartLimitBurst=5$/m);
	});

	it('reads secrets from the env file', () => {
		expect(unit).toMatch(/^EnvironmentFile=\/etc\/shiso\/shiso\.env$/m);
	});

	it('grants write access to the data directory', () => {
		const match = unit.match(/^ReadWritePaths=(.*)$/m);
		expect(match).not.toBeNull();
		const paths = (match?.[1] ?? '').split(/\s+/);
		expect(paths).toContain('/opt/shiso/data');
	});
});

describe('deploy scripts', () => {
	it('scripts/release.sh has valid bash syntax', () => {
		expect(() =>
			execFileSync('bash', ['-n', 'scripts/release.sh'], { cwd: repoRoot })
		).not.toThrow();
	});

	it('deploy/install.sh has valid bash syntax', () => {
		expect(() =>
			execFileSync('bash', ['-n', 'deploy/install.sh'], { cwd: repoRoot })
		).not.toThrow();
	});

	it('scripts/release.sh emits a checksum sidecar for the tarball', () => {
		const script = readDeployFile('scripts/release.sh');
		expect(script).toMatch(/sha256/);
	});

	it('deploy/install.sh verifies the tarball checksum before extracting it', () => {
		const script = readDeployFile('deploy/install.sh');
		const checksumLine = script.indexOf('sha256sum');
		const extractLine = script.indexOf('tar -xzf');
		expect(checksumLine).toBeGreaterThan(-1);
		expect(extractLine).toBeGreaterThan(-1);
		expect(checksumLine).toBeLessThan(extractLine);
	});

	it('deploy/install.sh runs npm ci as the unprivileged shiso user, not root', () => {
		const script = readDeployFile('deploy/install.sh');
		expect(script).not.toMatch(/^\(cd .* npm ci/m);
		expect(script).toMatch(/su -s \/bin\/bash shiso -c ".*npm ci/);
	});

	it('deploy/install.sh always syncs the systemd unit, not just on first install', () => {
		const script = readDeployFile('deploy/install.sh');
		expect(script).toMatch(/cmp -s .*shiso\.service/);
	});
});

describe('deploy/shiso.env.example', () => {
	it('mirrors every SHISO_/PLAID_ key from .env.example', () => {
		const source = readDeployFile('.env.example');
		const target = readDeployFile('deploy/shiso.env.example');
		const keys = [...source.matchAll(/^(SHISO_[A-Z_]+|PLAID_[A-Z_]+)=/gm)].map((m) => m[1]);
		expect(keys.length).toBeGreaterThan(0);
		for (const key of keys) {
			expect(target).toMatch(new RegExp(`^${key}=`, 'm'));
		}
	});
});
