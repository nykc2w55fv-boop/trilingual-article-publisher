import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { findGitExecutable } from '../lib/git-command.mjs';
import { getPublisherState } from '../lib/publisher-service.mjs';
import { initializeSourceLibrary } from '../lib/source-content.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixtureRoot = path.join(projectRoot, '.local', 'git-discovery-tests');

async function fixture() {
	await fs.mkdir(fixtureRoot, { recursive: true });
	return fs.mkdtemp(path.join(fixtureRoot, 'run-'));
}

async function executable(filename) {
	await fs.mkdir(path.dirname(filename), { recursive: true });
	await fs.writeFile(filename, '', { mode: 0o755 });
	return filename;
}

test('Windows PATH 未提供 Git 时使用最新版 GitHub Desktop 自带 Git', async () => {
	const root = await fixture();
	const older = await executable(path.join(root, 'GitHubDesktop', 'app-3.9.0', 'resources', 'app', 'git', 'cmd', 'git.exe'));
	const newer = await executable(path.join(root, 'GitHubDesktop', 'app-3.10.0', 'resources', 'app', 'git', 'cmd', 'git.exe'));
	await fs.mkdir(path.join(root, 'GitHubDesktop', 'app-3.11.0'), { recursive: true });
	const environment = { Path: root, LOCALAPPDATA: root };
	assert.equal(findGitExecutable(environment, 'win32'), newer);
	await fs.unlink(newer);
	assert.equal(findGitExecutable(environment, 'win32'), older);
});

test('优先使用 PATH 中的 Git，并支持引号、空格和 Windows 变量大小写', async () => {
	const root = await fixture();
	const git = await executable(path.join(root, 'Git With Spaces', 'git.exe'));
	await executable(path.join(root, 'Programs', 'Git', 'cmd', 'git.exe'));
	assert.equal(findGitExecutable({ Path: `"${path.dirname(git)}"`, LocalAppData: root }, 'win32'), git);
});

test('PATH 没有 Git 时也能发现按用户安装的 Git for Windows', async () => {
	const root = await fixture();
	const git = await executable(path.join(root, 'Programs', 'Git', 'cmd', 'git.exe'));
	assert.equal(findGitExecutable({ PATH: '', LOCALAPPDATA: root }, 'win32'), git);
});

test('缺少 Git 时保留已初始化状态和文章列表，不误报设置丢失', async () => {
	const root = await fixture();
	const repoPath = path.join(root, 'repo');
	const sourcePath = path.join(root, 'source');
	await fs.mkdir(path.join(repoPath, 'scripts'), { recursive: true });
	await fs.mkdir(path.join(repoPath, 'src', 'content', 'essays'), { recursive: true });
	await fs.writeFile(path.join(repoPath, 'package.json'), '{}');
	await fs.writeFile(path.join(repoPath, 'scripts', 'publish-content.mjs'), '');
	await initializeSourceLibrary(sourcePath);
	await fs.writeFile(path.join(sourcePath, '2.技术与AI实践', '需要继续写的文章.md'), '# 草稿\n\n尚未写完。');
	const state = await getPublisherState({ repoPath, sourcePath }, {
		env: { PATH: '', LOCALAPPDATA: root, ProgramFiles: root, 'ProgramFiles(x86)': root },
	});
	assert.equal(state.configured, true);
	assert.equal(state.git, null);
	assert.match(state.gitError, /找不到 Git/);
	assert.match(state.gitError, /无需重填/);
	assert.equal(state.configurationError, undefined);
	assert.equal(state.articles.length, 1);
});
