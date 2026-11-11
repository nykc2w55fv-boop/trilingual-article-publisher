import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getPublisherState, prepareLayoutPreview, publishArticle, setupPublishingFolders } from './lib/publisher-service.mjs';
import { renderLayoutPreviewHtml } from './lib/preview-html.mjs';
import { loadSettings, mergeSettings, publicSettings, saveSettings } from './lib/settings.mjs';
import { requestJson } from './lib/translation-client.mjs';
import { ensureRepositoryDependencies } from './lib/dependency-setup.mjs';
import { readCoverImage } from './lib/source-content.mjs';

const publisherDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(publisherDir, 'public');
const sessionToken = crypto.randomBytes(24).toString('hex');
const noOpen = process.argv.includes('--no-open');
let settings = await loadSettings();
let publishing = false;
let publishingMessage = '';
let environmentError = '';
const layoutPreviews = new Map();

if (!settings.repoPath && await exists(path.join(publisherDir, '..', 'src', 'content', 'essays'))) {
	settings.repoPath = path.resolve(publisherDir, '..');
}

if (settings.repoPath) await prepareEnvironment(settings.repoPath);
if (process.argv.includes('--check-only')) {
	if (environmentError) process.exit(1);
	console.log('启动环境检查完成。');
	process.exit(0);
}

const server = http.createServer(async (request, response) => {
	try {
		setSecurityHeaders(response);
		const url = new URL(request.url || '/', 'http://127.0.0.1');
		if (request.method === 'GET' && url.pathname === '/') return serveIndex(response);
		if (request.method === 'GET' && ['/app.js', '/styles.css'].includes(url.pathname)) return serveAsset(response, url.pathname.slice(1));
		if (request.method === 'GET' && url.pathname === '/api/state') {
			const state = await getPublisherState(settings);
			return json(response, 200, { settings: publicSettings(settings), publishing, publishingMessage, environmentError, ...state });
		}
		if (request.method === 'GET' && url.pathname === '/api/cover-image') {
			assertLocalRequest(request);
			assertToken(request);
			const image = await readCoverImage(settings.sourcePath, url.searchParams.get('name'));
			response.writeHead(200, { 'Content-Type': image.contentType, 'Cache-Control': 'no-store' });
			return response.end(image.buffer);
		}
		if (request.method === 'POST') {
			assertLocalRequest(request);
			assertToken(request);
			const body = await readJsonBody(request);
			if (url.pathname === '/api/settings') {
				const next = mergeSettings(settings, body);
				validateSettingsInput(next);
				await setupPublishingFolders(next);
				settings = await saveSettings(next);
				await prepareEnvironment(settings.repoPath);
				const state = await getPublisherState(settings);
				return json(response, 200, { settings: publicSettings(settings), environmentError, ...state });
			}
			if (url.pathname === '/api/test-model') {
				if (!settings.translationApiKey) throw new Error('请先保存 API Key。');
				const result = await requestJson({
					baseUrl: settings.translationApiUrl,
					apiKey: settings.translationApiKey,
					model: settings.translationModel,
				}, {
					prompt: 'Return JSON only: {"ok":true}.',
					maxTokens: 20,
					temperature: 0,
				});
				if (result.ok !== true) throw new Error('模型已响应，但返回格式不符合预期。');
				return json(response, 200, { message: '模型连接成功。' });
			}
			if (url.pathname === '/api/layout-preview') {
				if (publishing) return json(response, 409, { error: '已有文章正在处理，请等待完成。' });
				if (environmentError) throw new Error(environmentError);
				const preview = await prepareLayoutPreview(settings, body.relativePath, body.coverFile);
				const previewToken = crypto.randomBytes(24).toString('hex');
				layoutPreviews.clear();
				layoutPreviews.set(previewToken, { ...preview, relativePath: body.relativePath, coverFile: body.coverFile, createdAt: Date.now() });
				return json(response, 200, { previewToken, originalHtml: renderLayoutPreviewHtml(preview.originalBody), formattedHtml: renderLayoutPreviewHtml(preview.formattedBody), suggestionCount: preview.suggestionCount, skippedCount: preview.skippedCount, skippedReasons: preview.skippedReasons, layoutError: preview.layoutError });
			}
			if (url.pathname === '/api/publish') {
				if (publishing) return json(response, 409, { error: '已有文章正在处理，请等待完成。' });
				if (environmentError) throw new Error(environmentError);
				const review = layoutPreviews.get(body.previewToken);
				if (!review || Date.now() - review.createdAt > 20 * 60 * 1000 || review.relativePath !== body.relativePath || review.coverFile !== body.coverFile) throw new Error('排版预览已失效，请重新预览。');
				if (!['formatted', 'original'].includes(body.layoutMode)) throw new Error('请先确认排版方案。');
				publishing = true;
				publishingMessage = '正在检查文章和仓库…';
				const logs = [];
				try {
					const result = await publishArticle(settings, body.relativePath, body.coverFile, {
						sourceHash: review.sourceHash, sourceRevision: review.sourceRevision, formattedBody: review.formattedBody, mode: body.layoutMode,
					}, (line) => {
						logs.push(line);
						publishingMessage = line;
					});
					layoutPreviews.delete(body.previewToken);
					return json(response, 200, { ...result, logs: logs.slice(-80) });
				} finally {
					publishing = false;
					publishingMessage = '';
				}
			}
		}
		return json(response, 404, { error: '未找到该页面。' });
	} catch (error) {
		return json(response, error.statusCode || 400, { error: error.message || '操作失败。' });
	}
});

const requestedPort = Number(process.env.BLOG_PUBLISHER_PORT || 4322);
const port = await listenWithFallback(server, Number.isInteger(requestedPort) ? requestedPort : 4322);
const url = `http://127.0.0.1:${port}`;
console.log(`认知迭代发布器已启动：${url}`);
console.log('关闭此窗口即可停止发布器。');
if (!noOpen) openBrowser(url);

async function prepareEnvironment(repoPath) {
	console.log(`正在检查网站依赖：${repoPath}`);
	try {
		await ensureRepositoryDependencies(repoPath, { onLine: (line) => console.log(line) });
		environmentError = '';
	} catch (error) {
		environmentError = error.message;
		console.error(environmentError);
	}
}

async function serveIndex(response) {
	const template = await fs.readFile(path.join(publicDir, 'index.html'), 'utf8');
	const html = template.replace('__PUBLISHER_TOKEN__', sessionToken);
	response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
	response.end(html);
}

async function serveAsset(response, filename) {
	const type = filename.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
	response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
	response.end(await fs.readFile(path.join(publicDir, filename)));
}

function validateSettingsInput(value) {
	for (const [key, label] of [['repoPath', '网站仓库路径'], ['sourcePath', 'Obsidian 网站文章目录']]) {
		if (!value[key] || !path.isAbsolute(value[key])) throw new Error(`${label}必须填写绝对路径。`);
	}
	if (value.backupPath && !path.isAbsolute(value.backupPath)) throw new Error('本地备份目录必须是绝对路径，或留空使用网站仓库内的默认备份。');
	if (!/^https?:\/\//i.test(value.translationApiUrl)) throw new Error('大模型 URL 必须以 http:// 或 https:// 开头。');
	if (!value.translationModel) throw new Error('请填写模型名称。');
}

function assertLocalRequest(request) {
	const address = request.socket.remoteAddress || '';
	if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) {
		const error = new Error('发布器只接受本机请求。');
		error.statusCode = 403;
		throw error;
	}
}

function assertToken(request) {
	if (request.headers['x-publisher-token'] !== sessionToken) {
		const error = new Error('本次发布器会话已失效，请刷新页面。');
		error.statusCode = 403;
		throw error;
	}
}

async function readJsonBody(request) {
	let body = '';
	for await (const chunk of request) {
		body += chunk;
		if (body.length > 100000) throw new Error('请求内容过大。');
	}
	if (!body) return {};
	try { return JSON.parse(body); } catch { throw new Error('请求格式无效。'); }
}

function setSecurityHeaders(response) {
	response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
	response.setHeader('X-Content-Type-Options', 'nosniff');
	response.setHeader('Referrer-Policy', 'no-referrer');
	response.setHeader('X-Frame-Options', 'DENY');
}

function json(response, status, payload) {
	response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
	response.end(JSON.stringify(payload));
}

function listenWithFallback(instance, preferredPort) {
	return new Promise((resolve, reject) => {
		const tryListen = (port) => {
			instance.once('error', (error) => {
				if (error.code === 'EADDRINUSE' && port !== 0) tryListen(0);
				else reject(error);
			});
			instance.listen(port, '127.0.0.1', () => resolve(instance.address().port));
		};
		tryListen(preferredPort);
	});
}

function openBrowser(target) {
	let command;
	let args;
	if (process.platform === 'win32') { command = process.env.ComSpec || 'cmd.exe'; args = ['/d', '/s', '/c', 'start', '', target]; }
	else if (process.platform === 'darwin') { command = 'open'; args = [target]; }
	else { command = 'xdg-open'; args = [target]; }
	const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
	child.on('error', () => {});
	child.unref();
}

async function exists(target) { try { await fs.access(target); return true; } catch { return false; } }
