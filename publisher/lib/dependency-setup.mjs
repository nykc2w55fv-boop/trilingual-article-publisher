import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const activePreparations = new Map();
const stampName = '.cognitive-garden-dependencies.json';

export function ensureRepositoryDependencies(repoPath, options = {}) {
	const repoRoot = path.resolve(repoPath);
	if (activePreparations.has(repoRoot)) return activePreparations.get(repoRoot);
	const preparation = prepare(repoRoot, options).finally(() => activePreparations.delete(repoRoot));
	activePreparations.set(repoRoot, preparation);
	return preparation;
}

async function prepare(repoRoot, { onLine = () => {}, runNpm = runNpmCommand, probe = probeDependencies, nodeVersion = process.versions.node } = {}) {
	const project = await readProject(repoRoot, nodeVersion);
	if ((await runNpm(repoRoot, ['--version'])).code !== 0) throw new Error('npm 无法运行。请修复或更新包含 npm 的 Node.js，再重新启动发布器。');
	const stampPath = path.join(repoRoot, 'node_modules', stampName);
	const stamp = await readJson(stampPath);
	const healthy = await probe(repoRoot, project.data);
	if (healthy && stamp?.fingerprint === project.fingerprint) {
		onLine('网站依赖已就绪，无需重新安装。');
		return { installed: false };
	}
	const localDir = path.join(repoRoot, '.local');
	await fs.mkdir(localDir, { recursive: true });
	const release = await acquirePreparationLock(path.join(localDir, 'dependency-setup.lock'));
	try {
		// Adopt an existing healthy installation on the first launch. npm checks
		// the full tree before we record it, without downloading any packages.
		let installed = false;
		const existing = !stamp && healthy ? await runNpm(repoRoot, ['ls', '--all', '--json']) : null;
		if (!existing || existing.code !== 0) {
			onLine('正在按锁文件安装网站依赖，首次启动或拉取依赖更新后可能需要几分钟…');
			const result = await runNpm(repoRoot, ['ci', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org'], onLine);
			if (result.code !== 0) {
				throw new Error('网站依赖安装失败。请检查网络和 npm 的提示，然后重新双击 start.cmd；已保存的路径、模型和 Key 会保留。');
			}
			installed = true;
		}
		if (!await probe(repoRoot, project.data)) throw new Error('依赖安装后仍无法加载网站组件，请查看命令窗口的提示并重新启动发布器。');
		const latest = await readProject(repoRoot, nodeVersion);
		if (latest.fingerprint !== project.fingerprint) throw new Error('安装期间依赖配置发生变化。请等 GitHub Desktop 拉取完成后重新启动发布器。');
		await fs.mkdir(path.dirname(stampPath), { recursive: true });
		await fs.writeFile(stampPath, `${JSON.stringify({ fingerprint: project.fingerprint })}\n`, 'utf8');
		onLine(installed ? '网站依赖安装及检查完成。' : '已确认现有网站依赖完整，无需下载。');
		return { installed };
	} finally { await release(); }
}

async function readProject(repoRoot, nodeVersion) {
	for (const relative of ['scripts/publish-content.mjs', 'src/content/essays']) {
		if (!await exists(path.join(repoRoot, relative))) throw new Error(`网站仓库缺少 ${relative}。请在设置中选择目标网站仓库根目录。`);
	}
	let manifest;
	let lock;
	try {
		[manifest, lock] = await Promise.all([
			fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'),
			fs.readFile(path.join(repoRoot, 'package-lock.json'), 'utf8'),
		]);
	} catch (error) {
		if (error.code === 'ENOENT') throw new Error('网站仓库缺少 package.json 或 package-lock.json。请在设置中选择完整的网站仓库，或先用 GitHub Desktop Pull。');
		throw error;
	}
	const data = JSON.parse(manifest);
	const lockVersion = JSON.parse(lock).lockfileVersion;
	if (!Number.isInteger(lockVersion) || lockVersion < 1) throw new Error('网站依赖锁文件无效，请先用 GitHub Desktop 恢复 package-lock.json。');
	assertNodeVersion(nodeVersion, data.engines?.node || '>=22.12.0');
	const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ manifest, lock, abi: process.versions.modules, platform: process.platform, arch: process.arch })).digest('hex');
	return { data, fingerprint };
}

export function assertNodeVersion(actual, required = '>=22.12.0') {
	const minimum = required.match(/^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
	if (!minimum) throw new Error(`网站 Node.js 版本要求无法自动识别：${required}`);
	const currentParts = actual.replace(/^v/, '').split('.').map(Number);
	const minimumParts = minimum.slice(1).map((part) => Number(part || 0));
	for (let index = 0; index < 3; index += 1) {
		if (currentParts[index] > minimumParts[index]) return;
		if (currentParts[index] < minimumParts[index]) throw new Error(`当前 Node.js ${actual} 过旧，网站需要 ${required}。请更新 Node.js 后再双击 start.cmd。`);
	}
}

async function probeDependencies(repoRoot, manifest) {
	const names = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
	// Run in the target repository, including when publisher/ was copied alone.
	// Importing direct dependencies also exercises sharp's native module.
	const script = "const {createRequire}=await import('node:module');const {pathToFileURL}=await import('node:url');const require=createRequire(process.cwd()+'/package.json');for(const name of JSON.parse(process.argv[1])){await import(pathToFileURL(require.resolve(name)).href);}";
	const result = await runCommand(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(names)], { cwd: repoRoot });
	return result.code === 0;
}

async function runNpmCommand(repoRoot, args, onLine) {
	const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
	if (await exists(cli)) return runCommand(process.execPath, [cli, ...args], { cwd: repoRoot, onLine });
	// cmd is needed only for npm.cmd, with fixed arguments; the repository path
	// is supplied as cwd and is never interpolated into a shell command.
	const windows = process.platform === 'win32';
	const command = windows ? process.env.ComSpec || 'cmd.exe' : 'npm';
	const commandArgs = windows ? ['/d', '/s', '/c', `npm.cmd ${args.join(' ')}`] : args;
	return runCommand(command, commandArgs, { cwd: repoRoot, onLine });
}

function runCommand(command, args, { cwd, onLine } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' }, shell: false, windowsHide: true });
		let remainder = '';
		const consume = (chunk) => {
			if (!onLine) return;
			const lines = (remainder + chunk.toString()).split(/\r?\n/);
			remainder = lines.pop() || '';
			for (const line of lines) if (line.trim()) onLine(line.trim());
		};
		child.stdout.on('data', consume);
		child.stderr.on('data', consume);
		child.on('error', (error) => reject(error.code === 'ENOENT' ? new Error('找不到 npm。请安装包含 npm 的 Node.js，再重新启动发布器。') : error));
		child.on('close', (code) => {
			if (remainder.trim()) onLine?.(remainder.trim());
			resolve({ code });
		});
	});
}

async function acquirePreparationLock(filename) {
	let handle;
	try { handle = await fs.open(filename, 'wx'); } catch (error) {
		if (error.code !== 'EEXIST') throw error;
		const owner = await readJson(filename);
		let stale = !owner?.pid && Date.now() - (await fs.stat(filename)).mtimeMs > 60000;
		if (Number.isInteger(owner?.pid) && owner.pid > 0) {
			try { process.kill(owner.pid, 0); } catch (error) { stale = error.code === 'ESRCH'; }
		}
		if (!stale) throw new Error('另一个发布器正在准备网站依赖，请等它完成后再启动。');
		await fs.unlink(filename);
		handle = await fs.open(filename, 'wx');
	}
	try { await handle.writeFile(JSON.stringify({ pid: process.pid })); } catch (error) {
		await handle.close();
		await fs.unlink(filename);
		throw error;
	}
	return async () => { await handle.close(); await fs.unlink(filename).catch((error) => { if (error.code !== 'ENOENT') throw error; }); };
}

async function readJson(filename) {
	try { return JSON.parse(await fs.readFile(filename, 'utf8')); } catch (error) {
		if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
		throw error;
	}
}

async function exists(filename) { try { await fs.access(filename); return true; } catch { return false; } }
