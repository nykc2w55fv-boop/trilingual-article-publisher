import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { findGitExecutable } from './git-command.mjs';
import { ensureRepositoryDependencies } from './dependency-setup.mjs';
import {
	initializeSourceLibrary,
	listCoverImages,
	prepareSourcePackage,
	buildChineseDocument,
	scanSourceLibrary,
	validateRepository,
	validateSourceLibrary,
	writePreparedInbox,
	writeSourceMetadata,
} from './source-content.mjs';
import { mobileLayoutSignature, stripMobileLayout, suggestMobileLayout } from './mobile-layout.mjs';

export async function setupPublishingFolders(settings) {
	await validateRepository(settings.repoPath);
	await initializeSourceLibrary(settings.sourcePath);
	if (settings.backupPath) await fs.mkdir(settings.backupPath, { recursive: true });
	return scanSourceLibrary({ sourceRoot: settings.sourcePath, repoRoot: settings.repoPath });
}

export async function getPublisherState(settings, options = {}) {
	if (!settings.repoPath || !settings.sourcePath) return { configured: false, articles: [], git: null };
	try {
		await validateRepository(settings.repoPath);
		await validateSourceLibrary(settings.sourcePath);
		const [articles, gitResult] = await Promise.all([
			scanSourceLibrary({ sourceRoot: settings.sourcePath, repoRoot: settings.repoPath }),
			getGitState(settings.repoPath, options).then((git) => ({ git }), (error) => ({ git: null, gitError: error.message })),
		]);
		return { configured: true, articles, coverImages: await listCoverImages(settings.sourcePath), ...gitResult };
	} catch (error) {
		return { configured: false, articles: [], git: null, configurationError: error.message };
	}
}

export async function prepareLayoutPreview(settings, relativePath, coverFile) {
	if (!settings.translationApiKey) throw new Error('请先在设置中填写大模型 API Key。');
	const git = await getGitState(settings.repoPath);
	assertGitReady(git);
	const prepared = await prepareSourcePackage({
		sourceFile: relativePath, coverFile, sourceRoot: settings.sourcePath, repoRoot: settings.repoPath,
		translationSettings: { baseUrl: settings.translationApiUrl, apiKey: settings.translationApiKey, model: settings.translationModel },
	});
	let suggestion = { body: prepared.rewrittenBody, count: 0, skippedCount: 0, skippedReasons: [] };
	let layoutError = '';
	try {
		suggestion = await suggestMobileLayout(prepared.rewrittenBody, {
			baseUrl: settings.translationApiUrl, apiKey: settings.translationApiKey, model: settings.translationModel,
		});
	} catch (error) {
		layoutError = `智能排版建议未通过：${error.message}`;
	}
	return { sourceHash: prepared.metadata.sourceHash, sourceRevision: sourceRevision(prepared.sourceText), originalBody: prepared.rewrittenBody, formattedBody: suggestion.body, suggestionCount: suggestion.count, skippedCount: suggestion.skippedCount, skippedReasons: suggestion.skippedReasons, layoutError };
}

export async function publishArticle(settings, relativePath, coverFile, layoutReview, onLine = () => {}) {
	await validateRepository(settings.repoPath);
	await validateSourceLibrary(settings.sourcePath);
	if (typeof coverFile !== 'string' || !coverFile) throw new Error('请在发布确认窗口明确选择封面。');
	if (!settings.translationApiKey) throw new Error('请先在设置中填写大模型 API Key。');
	const git = await getGitState(settings.repoPath);
	assertGitReady(git);
	await ensureRepositoryDependencies(settings.repoPath, { onLine });
	onLine('正在生成文章网址并准备中文原文…');

	const prepared = await prepareSourcePackage({
		sourceFile: relativePath,
		coverFile,
		sourceRoot: settings.sourcePath,
		repoRoot: settings.repoPath,
		translationSettings: {
			baseUrl: settings.translationApiUrl,
			apiKey: settings.translationApiKey,
			model: settings.translationModel,
		},
	});
	applyReviewedLayout(prepared, layoutReview);
	const runRoot = path.join(settings.repoPath, '.local', 'publisher-inbox', runId());
	await fs.mkdir(runRoot, { recursive: true });
	await writePreparedInbox(prepared, runRoot);
	onLine(`已整理中文原文与 ${prepared.images.length} 张图片。`);

	const environment = {
		...process.env,
		BLOG_CONTENT_INBOX: runRoot,
		BLOG_BACKUP_DIR: settings.backupPath || path.join(settings.repoPath, '.local', 'backups'),
		BLOG_TRANSLATION_API_URL: settings.translationApiUrl,
		BLOG_TRANSLATION_API_KEY: settings.translationApiKey,
		BLOG_TRANSLATION_MODEL: settings.translationModel,
	};
	const args = [path.join(settings.repoPath, 'scripts', 'publish-content.mjs'), `--package=${prepared.articleId}`];
	if (prepared.destinationExists) args.push('--update');
	await runProcess(process.execPath, args, { cwd: settings.repoPath, env: environment, onLine });
	await writeSourceMetadata(prepared);
	return {
		articleId: prepared.articleId,
		slug: prepared.metadata.slug,
		updated: prepared.destinationExists,
		message: '三语文章、图片、备份与网站构建均已完成。请到 GitHub Desktop 检查差异后 Commit 和 Push。',
	};
}

export function applyReviewedLayout(prepared, layoutReview) {
	if (!layoutReview || layoutReview.sourceHash !== prepared.metadata.sourceHash || layoutReview.sourceRevision !== sourceRevision(prepared.sourceText)) throw new Error('预览后原稿或封面发生变化，请重新生成排版预览。');
	if (!['formatted', 'original'].includes(layoutReview.mode)) throw new Error('请先确认排版方案。');
	if (layoutReview.mode === 'formatted') {
		const body = layoutReview.formattedBody;
		if (stripMobileLayout(body) !== prepared.rewrittenBody) throw new Error('排版结果与当前原文不一致，请重新预览。');
		mobileLayoutSignature(body);
		prepared.zhDocument = buildChineseDocument(prepared.metadata, body);
	}
	return prepared;
}

function sourceRevision(text) {
	return createHash('sha256').update(text).digest('hex');
}

export async function getGitState(repoRoot, options = {}) {
	const command = findGitExecutable(options.env || process.env);
	const output = await runProcess(command, ['status', '--porcelain=v2', '--branch'], { ...options, cwd: repoRoot, collectOnly: true });
	return parseGitStatus(output);
}

export function parseGitStatus(output) {
	const lines = String(output).split(/\r?\n/).filter(Boolean);
	const branchLine = lines.find((line) => line.startsWith('# branch.head '));
	const upstreamLine = lines.find((line) => line.startsWith('# branch.upstream '));
	const aheadBehind = lines.find((line) => line.startsWith('# branch.ab '));
	const match = aheadBehind?.match(/\+(\d+)\s+-(\d+)/);
	return {
		branch: branchLine?.slice('# branch.head '.length) || '',
		upstream: upstreamLine?.slice('# branch.upstream '.length) || '',
		ahead: match ? Number(match[1]) : 0,
		behind: match ? Number(match[2]) : 0,
		dirty: lines.some((line) => !line.startsWith('# ')),
	};
}

export function assertGitReady(git) {
	if (git.dirty) throw new Error('网站仓库存在未提交修改。请先在 GitHub Desktop 处理完，再回来发布。');
	if (!git.upstream) throw new Error('当前 Git 分支没有远端同步目标。请先在 GitHub Desktop 完成仓库设置。');
	if (git.behind > 0) throw new Error('网站仓库落后于 GitHub。请先在 GitHub Desktop Fetch/Pull。');
	if (git.ahead > 0) throw new Error('网站仓库还有尚未 Push 的提交。请先在 GitHub Desktop Push。');
}

export async function runProcess(command, args, options = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env || process.env,
			shell: false,
			windowsHide: true,
		});
		let output = '';
		let remainder = '';
		const consume = (chunk) => {
			const text = chunk.toString();
			output += text;
			if (output.length > 100000) output = output.slice(-100000);
			if (options.collectOnly) return;
			const combined = remainder + text;
			const lines = combined.split(/\r?\n/);
			remainder = lines.pop() || '';
			for (const line of lines) if (line.trim()) options.onLine?.(line.trim());
		};
		child.stdout.on('data', consume);
		child.stderr.on('data', consume);
		child.on('error', (error) => {
			if (error.code === 'ENOENT' && /(?:^|[\\/])git(?:\.exe)?$/i.test(command)) {
				reject(new Error('Git 无法启动。请确认网站仓库目录仍然存在，然后关闭并重新启动发布器。已保存的模型和 Key 无需重填。'));
			} else reject(error);
		});
		child.on('exit', (code) => {
			if (remainder.trim() && !options.collectOnly) options.onLine?.(remainder.trim());
			if (code === 0) resolve(output.trim());
			else reject(new Error(processErrorMessage(output, code)));
		});
	});
}

export function processErrorMessage(output, code) {
	const lines = String(output)
		.replace(/\u001b\[[0-9;]*m/g, '')
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	const explicit = lines.find((line) => /^Error:\s+/.test(line));
	if (explicit) return explicit.replace(/^Error:\s+/, '');
	const useful = [...lines].reverse().find((line) =>
		!/^\s*at\s+/.test(line) &&
		!/^Node\.js\s+v/i.test(line) &&
		!/^file:\/\//.test(line) &&
		!/^\^+$/.test(line) &&
		!/^[]{}]+$/.test(line),
	);
	return useful || `命令执行失败，退出码 ${code}。`;
}

function runId() {
	const now = new Date();
	const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
	return `${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}
