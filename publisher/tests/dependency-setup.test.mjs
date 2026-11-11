import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertNodeVersion, ensureRepositoryDependencies } from '../lib/dependency-setup.mjs';

async function repository(t) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'publisher dependencies '));
	// Keep isolated fixtures for manual cleanup; this project never recursively deletes directories.
	assert.ok(path.resolve(root).startsWith(`${path.resolve(os.tmpdir())}${path.sep}publisher dependencies `));
	await fs.mkdir(path.join(root, 'src', 'content', 'essays'), { recursive: true });
	await fs.mkdir(path.join(root, 'scripts'), { recursive: true });
	await fs.writeFile(path.join(root, 'scripts', 'publish-content.mjs'), '');
	await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'dependency-fixture', engines: { node: '>=22.12.0' } }));
	await fs.writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {} }));
	return root;
}

test('现有完整依赖首次只检查，后续启动不下载；锁文件更新才重装', async (t) => {
	const root = await repository(t);
	const commands = [];
	const options = { probe: async () => true, runNpm: async (cwd, args) => { assert.equal(cwd, root); commands.push(args[0]); return { code: 0 }; } };
	assert.deepEqual(await ensureRepositoryDependencies(root, options), { installed: false });
	assert.deepEqual(commands, ['--version', 'ls']);
	assert.deepEqual(await ensureRepositoryDependencies(root, options), { installed: false });
	assert.deepEqual(commands, ['--version', 'ls', '--version']);
	await fs.writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {}, change: 'pulled update' }));
	assert.deepEqual(await ensureRepositoryDependencies(root, options), { installed: true });
	assert.deepEqual(commands, ['--version', 'ls', '--version', '--version', 'ci']);
});

test('首次依赖缺失自动安装，已登记的依赖损坏也会修复', async (t) => {
	const root = await repository(t);
	let healthy = false;
	let installs = 0;
	const options = { probe: async () => healthy, runNpm: async (_cwd, args) => { if (args[0] === 'ci') { installs += 1; healthy = true; } return { code: 0 }; } };
	assert.deepEqual(await ensureRepositoryDependencies(root, options), { installed: true });
	healthy = false;
	assert.deepEqual(await ensureRepositoryDependencies(root, options), { installed: true });
	assert.equal(installs, 2);
});

test('安装失败不给出就绪状态，保留重试能力且释放准备锁', async (t) => {
	const root = await repository(t);
	await assert.rejects(ensureRepositoryDependencies(root, { probe: async () => false, runNpm: async (_cwd, args) => ({ code: args[0] === '--version' ? 0 : 1 }) }), /安装失败/);
	await assert.rejects(fs.access(path.join(root, 'node_modules', '.cognitive-garden-dependencies.json')), { code: 'ENOENT' });
	await assert.rejects(fs.access(path.join(root, '.local', 'dependency-setup.lock')), { code: 'ENOENT' });
	let ready = false;
	assert.deepEqual(await ensureRepositoryDependencies(root, { probe: async () => ready, runNpm: async (_cwd, args) => { if (args[0] === 'ci') ready = true; return { code: 0 }; } }), { installed: true });
});

test('错误仓库、缺失锁文件、旧版 Node 均不触发安装', async (t) => {
	const root = await repository(t);
	let commands = 0;
	const options = { probe: async () => false, runNpm: async () => { commands += 1; return { code: 0 }; } };
	await assert.rejects(ensureRepositoryDependencies(root, { ...options, nodeVersion: '22.11.0' }), /过旧/);
	await fs.unlink(path.join(root, 'package-lock.json'));
	await assert.rejects(ensureRepositoryDependencies(root, options), /缺少 package.json 或 package-lock.json/);
	await assert.rejects(ensureRepositoryDependencies(path.join(root, 'src'), options), /选择目标网站仓库根目录/);
	assert.equal(commands, 0);
	assert.doesNotThrow(() => assertNodeVersion('22.12.0'));
	assert.doesNotThrow(() => assertNodeVersion('24.15.0'));
});

test('同仓库并发准备复用一次安装；其他进程准备时不会同时重装', async (t) => {
	const root = await repository(t);
	let healthy = false;
	let installs = 0;
	const options = { probe: async () => healthy, runNpm: async (_cwd, args) => { if (args[0] === 'ci') { installs += 1; healthy = true; } return { code: 0 }; } };
	const first = ensureRepositoryDependencies(root, options);
	assert.equal(ensureRepositoryDependencies(root, options), first);
	await first;
	assert.equal(installs, 1);
	await fs.writeFile(path.join(root, '.local', 'dependency-setup.lock'), JSON.stringify({ pid: process.pid }));
	await assert.rejects(ensureRepositoryDependencies(root, { ...options, probe: async () => false }), /另一个发布器/);
	assert.equal(installs, 1);
});

test('已登记依赖也会检查 npm 可用性，避免开始翻译后才发现不能构建', async (t) => {
	const root = await repository(t);
	await ensureRepositoryDependencies(root, { probe: async () => true, runNpm: async () => ({ code: 0 }) });
	await assert.rejects(ensureRepositoryDependencies(root, { probe: async () => true, runNpm: async () => ({ code: 1 }) }), /npm 无法运行/);
});
