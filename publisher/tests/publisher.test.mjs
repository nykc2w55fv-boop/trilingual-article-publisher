import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { applyReviewedLayout, parseGitStatus, processErrorMessage } from '../lib/publisher-service.mjs';
import { applyMobileLayout } from '../lib/mobile-layout.mjs';
import { publicSettings } from '../lib/settings.mjs';
import {
	categoryDefinitions,
	extractImageReferences,
	initializeSourceLibrary,
	listCoverImages,
	parseSourceMarkdown,
	prepareSourcePackage,
	readCoverImage,
	scanSourceLibrary,
	upsertFrontmatter,
	writeSourceMetadata,
} from '../lib/source-content.mjs';
import { chatCompletionsUrl, requestJson } from '../lib/translation-client.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const testRoot = path.join(projectRoot, '.local', 'publisher-tests', `${Date.now()}-${Math.random().toString(36).slice(2)}`);

test('大模型 URL 同时支持基础地址和完整接口', () => {
	assert.equal(chatCompletionsUrl('https://example.com/v1/'), 'https://example.com/v1/chat/completions');
	assert.equal(chatCompletionsUrl('https://example.com/v1/chat/completions'), 'https://example.com/v1/chat/completions');
});

test('JSON mode 被拒绝时回退到普通请求', async () => {
	const originalFetch = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (_url, options) => {
		calls.push(JSON.parse(options.body));
		if (calls.length === 1) return mockResponse(400, 'unsupported');
		return mockResponse(200, JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), true);
	};
	try {
		const result = await requestJson({ baseUrl: 'https://example.com/v1', apiKey: 'test-only', model: 'demo' }, { prompt: 'test' });
		assert.equal(result.ok, true);
		assert.equal(calls.length, 2);
		assert.ok(calls[0].response_format);
		assert.equal(calls[1].response_format, undefined);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('三个中文分类映射固定且互不重复', () => {
	assert.deepEqual(categoryDefinitions.map((item) => item.folder), ['1.古典阅读与修身', '2.技术与AI实践', '3.投研与量化']);
	assert.equal(new Set(categoryDefinitions.map((item) => item.topic)).size, 3);
});

test('无 frontmatter 时从一级标题取标题并移除重复标题', () => {
	const parsed = parseSourceMarkdown('# 我的文章\n\n这是第一段完整描述。\n\n后续正文。', '未命名.md');
	assert.equal(parsed.title, '我的文章');
	assert.equal(parsed.description, '这是第一段完整描述。');
	assert.ok(!parsed.body.startsWith('# 我的文章'));
});

test('从文件名取标题时去掉 Obsidian 排序序号', () => {
	const parsed = parseSourceMarkdown(`这是文章第一段。\n\n${'完整正文。'.repeat(120)}`, '1.读经典有感.md');
	assert.equal(parsed.title, '读经典有感');
});

test('识别 Obsidian 嵌入和标准 Markdown 图片', () => {
	const references = extractImageReferences('![[山景.png|雨后山景]]\n\n![湖面](../_attachments/湖面.webp)\n\n![[尺寸图.png|600]]');
	assert.equal(references.length, 3);
	assert.deepEqual(references.map((item) => item.source), ['山景.png', '../_attachments/湖面.webp', '尺寸图.png']);
	assert.equal(references[2].alt, null);
});

test('写回发布元数据时保留用户已有 frontmatter', () => {
	const input = '---\ntitle: 我的标题\ncustomField: keep-me\n---\n\n正文\n';
	const output = upsertFrontmatter(input, { articleId: 'my-article', sourceHash: 'a'.repeat(64) });
	assert.match(output, /customField: keep-me/);
	assert.match(output, /articleId: 'my-article'/);
	assert.match(output, /sourceHash: 'a{64}'/);
});

test('中央附件被复制改名，图片变化会改变 sourceHash', async () => {
	const repoRoot = path.join(testRoot, 'repo');
	const sourceRoot = path.join(testRoot, 'source');
	await makeMinimalRepo(repoRoot);
	await initializeSourceLibrary(sourceRoot);
	const articlePath = path.join(sourceRoot, '2.技术与AI实践', '测试文章.md');
	const body = `这是用于自动化测试的完整中文段落。${'测试正文内容保持完整。'.repeat(70)}`;
	await fs.writeFile(articlePath, `---\nslug: local-test-article\n---\n\n# 本地测试文章\n\n${body}\n\n![[测试图片.png|测试图片]]\n`, 'utf8');
	await fs.writeFile(path.join(sourceRoot, '_attachments', '测试图片.png'), Buffer.from('first-image'));

	const first = await prepareSourcePackage({ sourceFile: '2.技术与AI实践/测试文章.md', sourceRoot, repoRoot, translationSettings: {} });
	assert.equal(first.images[0].outputName, 'cover.png');
	assert.match(first.zhDocument, /\.\/images\/cover\.png/);
	const firstHash = first.metadata.sourceHash;

	await fs.writeFile(path.join(sourceRoot, '_attachments', '测试图片.png'), Buffer.from('changed-image'));
	const second = await prepareSourcePackage({ sourceFile: '2.技术与AI实践/测试文章.md', sourceRoot, repoRoot, translationSettings: {} });
	assert.notEqual(second.metadata.sourceHash, firstHash);
	const scanned = await scanSourceLibrary({ sourceRoot, repoRoot });
	assert.equal(scanned.length, 1);
	assert.equal(scanned[0].status, 'new');
});

test('明确选择的封面独立于正文图片，并写回 Obsidian 元数据', async () => {
	const repoRoot = path.join(testRoot, 'separate-cover-repo');
	const sourceRoot = path.join(testRoot, 'separate-cover-source');
	await makeMinimalRepo(repoRoot);
	await initializeSourceLibrary(sourceRoot);
	const articlePath = path.join(sourceRoot, '2.技术与AI实践', '封面测试.md');
	const body = `这是一篇用于检查独立封面的文章。${'正文内容完整且不会丢失。'.repeat(70)}`;
	await fs.writeFile(articlePath, `---\nslug: separate-cover\n---\n\n# 封面测试\n\n${body}\n\n![[正文插图.png|正文插图]]\n`, 'utf8');
	await fs.writeFile(path.join(sourceRoot, '_attachments', '独立封面.png'), Buffer.from('cover-image'));
	await fs.writeFile(path.join(sourceRoot, '_attachments', '正文插图.png'), Buffer.from('body-image'));
	assert.deepEqual(await listCoverImages(sourceRoot), ['独立封面.png', '正文插图.png']);
	assert.equal((await readCoverImage(sourceRoot, '独立封面.png')).contentType, 'image/png');
	const prepared = await prepareSourcePackage({
		sourceFile: '2.技术与AI实践/封面测试.md', sourceRoot, repoRoot,
		translationSettings: {}, coverFile: '独立封面.png',
	});
	assert.deepEqual(prepared.images.map((image) => image.outputName), ['cover.png', 'image-01.png']);
	assert.match(prepared.zhDocument, /coverImage: '\.\/images\/cover\.png'/);
	assert.match(prepared.zhDocument, /!\[正文插图\]\(\.\/images\/image-01\.png\)/);
	assert.doesNotMatch(prepared.zhDocument, /独立封面\.png/);
	await writeSourceMetadata(prepared);
	assert.match(await fs.readFile(articlePath, 'utf8'), /coverFile: '独立封面\.png'/);
	const scanned = await scanSourceLibrary({ sourceRoot, repoRoot });
	assert.equal(scanned[0].coverFile, '独立封面.png');
	assert.equal(scanned[0].imageCount, 1);
	await assert.rejects(() => readCoverImage(sourceRoot, '../独立封面.png'), /封面必须是 _attachments/);
});

test('正文引用所选封面时，网站正文省略它且保留其他插图', async () => {
	const repoRoot = path.join(testRoot, 'overlap-cover-repo');
	const sourceRoot = path.join(testRoot, 'overlap-cover-source');
	await makeMinimalRepo(repoRoot);
	await initializeSourceLibrary(sourceRoot);
	const articlePath = path.join(sourceRoot, '2.技术与AI实践', '重叠测试.md');
	const body = `这是一篇用于检查重复封面的文章。${'正文内容完整且不会丢失。'.repeat(70)}`;
	await fs.writeFile(articlePath, `---\nslug: overlap-cover\n---\n\n# 重叠测试\n\n![[封面.png]]\n\n${body}\n\n![[其他插图.png]]\n`, 'utf8');
	await fs.writeFile(path.join(sourceRoot, '_attachments', '封面.png'), Buffer.from('cover-image'));
	await fs.writeFile(path.join(sourceRoot, '_attachments', '其他插图.png'), Buffer.from('body-image'));
	const prepared = await prepareSourcePackage({
		sourceFile: '2.技术与AI实践/重叠测试.md', sourceRoot, repoRoot,
		translationSettings: {}, coverFile: '封面.png',
	});
	assert.deepEqual(prepared.images.map((image) => image.outputName), ['cover.png', 'image-01.png']);
	assert.doesNotMatch(prepared.zhDocument, /!\[[^\]]*\]\(\.\/images\/cover\.png\)/);
	assert.match(prepared.zhDocument, /!\[[^\]]*\]\(\.\/images\/image-01\.png\)/);
	assert.match(await fs.readFile(articlePath, 'utf8'), /!\[\[封面\.png\]\]/);
	await assert.rejects(() => prepareSourcePackage({
		sourceFile: '2.技术与AI实践/重叠测试.md', sourceRoot, repoRoot,
		translationSettings: {}, coverFile: '../封面.png',
	}), /封面必须是 _attachments/);
	await fs.writeFile(articlePath, (await fs.readFile(articlePath, 'utf8')).replace('slug: overlap-cover', "slug: overlap-cover\ncoverFile: '已更名.png'"));
	const scanned = await scanSourceLibrary({ sourceRoot, repoRoot });
	assert.equal(scanned[0].status, 'error');
	assert.equal(scanned[0].canChooseCover, true);
	const repaired = await prepareSourcePackage({
		sourceFile: '2.技术与AI实践/重叠测试.md', sourceRoot, repoRoot,
		translationSettings: {}, coverFile: '封面.png',
	});
	assert.equal(repaired.coverFile, '封面.png');
});

test('Git 状态解析识别脏工作区与远端差异', () => {
	const parsed = parseGitStatus('# branch.head master\n# branch.upstream origin/master\n# branch.ab +2 -1\n1 .M N... 100644 100644 100644 abc abc file.md\n');
	assert.equal(parsed.branch, 'master');
	assert.equal(parsed.ahead, 2);
	assert.equal(parsed.behind, 1);
	assert.equal(parsed.dirty, true);
});

test('预览后原稿变动会阻止使用旧排版结果', async () => {
	const repoRoot = path.join(testRoot, 'layout-review-repo');
	const sourceRoot = path.join(testRoot, 'layout-review-source');
	await makeMinimalRepo(repoRoot);
	await initializeSourceLibrary(sourceRoot);
	const articlePath = path.join(sourceRoot, '2.技术与AI实践', '排版测试.md');
	const body = `这是完整的第一句。第二句也会保持原样。\n\n${'后续正文保持完整。'.repeat(65)}`;
	await fs.writeFile(articlePath, `---\nslug: layout-review\n---\n\n# 排版测试\n\n${body}\n`, 'utf8');
	const options = { sourceFile: '2.技术与AI实践/排版测试.md', sourceRoot, repoRoot, translationSettings: {} };
	const original = await prepareSourcePackage(options);
	const formattedBody = applyMobileLayout(original.rewrittenBody, { emphasis: [{ paragraph: 0, text: '完整的第一句' }], breaks: [{ paragraph: 0, after: '这是完整的第一句。' }] });
	const sourceRevision = createHash('sha256').update(original.sourceText).digest('hex');
	const reviewed = applyReviewedLayout(original, { sourceHash: original.metadata.sourceHash, sourceRevision, mode: 'formatted', formattedBody });
	assert.ok(reviewed.zhDocument.includes('mobile-reading-emphasis'));
	await fs.writeFile(articlePath, (await fs.readFile(articlePath, 'utf8')).replace('第二句也会保持原样', '第二句内容已经修改'), 'utf8');
	const changed = await prepareSourcePackage(options);
	assert.throws(() => applyReviewedLayout(changed, { sourceHash: original.metadata.sourceHash, sourceRevision, mode: 'formatted', formattedBody }), /重新生成排版预览/);
	assert.throws(() => applyReviewedLayout(original, { sourceHash: original.metadata.sourceHash, sourceRevision, mode: 'formatted', formattedBody: formattedBody.replace('第二句', '新句子') }), /当前原文不一致/);
	await fs.writeFile(articlePath, (await fs.readFile(articlePath, 'utf8')).replace('slug: layout-review', 'slug: layout-review\ncustomNote: changed'), 'utf8');
	const metadataChanged = await prepareSourcePackage(options);
	assert.equal(metadataChanged.metadata.sourceHash, changed.metadata.sourceHash);
	assert.throws(() => applyReviewedLayout(metadataChanged, { sourceHash: changed.metadata.sourceHash, sourceRevision: createHash('sha256').update(changed.sourceText).digest('hex'), mode: 'original' }), /重新生成排版预览/);
});

test('子进程错误优先显示真实原因而不是 Node 堆栈末尾', () => {
	const output = `file:///C:/demo.mjs:10\nthrow new Error('x')\n^\n\nError: 大模型返回的译文格式无效。请换用更可靠的模型后重试。\n    at async preparePackage (file:///C:/demo.mjs:95:51)\nNode.js v24.15.0\n`;
	assert.equal(processErrorMessage(output, 1), '大模型返回的译文格式无效。请换用更可靠的模型后重试。');
});

test('发送给界面的设置绝不包含 API Key', () => {
	const exposed = publicSettings({ repoPath: 'x', sourcePath: 'y', backupPath: '', translationApiUrl: 'https://example.com/v1', translationApiKey: 'secret', translationModel: 'model' });
	assert.equal(exposed.hasApiKey, true);
	assert.equal('translationApiKey' in exposed, false);
});

test('真实三语文章包可完成写入、图片优化、备份和构建阶段', async () => {
	const rehearsalRoot = path.join(testRoot, 'end-to-end');
	const repoRoot = path.join(rehearsalRoot, 'repo');
	const inboxRoot = path.join(rehearsalRoot, 'inbox');
	const backupRoot = path.join(rehearsalRoot, 'backups');
	const articleId = 'publisher-rehearsal';
	await fs.mkdir(path.join(repoRoot, 'scripts'), { recursive: true });
	await fs.mkdir(path.join(repoRoot, 'publisher', 'lib'), { recursive: true });
	await fs.mkdir(path.join(repoRoot, 'src', 'content', 'essays'), { recursive: true });
	await fs.mkdir(path.join(inboxRoot, articleId, 'images'), { recursive: true });
	await fs.copyFile(path.join(projectRoot, 'scripts', 'publish-content.mjs'), path.join(repoRoot, 'scripts', 'publish-content.mjs'));
	await fs.copyFile(path.join(projectRoot, 'publisher', 'lib', 'article-markdown.mjs'), path.join(repoRoot, 'publisher', 'lib', 'article-markdown.mjs'));
	await fs.copyFile(path.join(projectRoot, 'publisher', 'lib', 'translation-client.mjs'), path.join(repoRoot, 'publisher', 'lib', 'translation-client.mjs'));
	await fs.copyFile(path.join(projectRoot, 'publisher', 'lib', 'mobile-layout.mjs'), path.join(repoRoot, 'publisher', 'lib', 'mobile-layout.mjs'));
	await fs.copyFile(path.join(projectRoot, 'publisher', 'lib', 'translation-validation.mjs'), path.join(repoRoot, 'publisher', 'lib', 'translation-validation.mjs'));
	await fs.copyFile(path.join(projectRoot, 'publisher', 'tests', 'fixtures', 'validate-stage.mjs'), path.join(repoRoot, 'validate-stage.mjs'));
	await writeFixtureCover(path.join(inboxRoot, articleId, 'images', 'cover.webp'));
	await fs.writeFile(path.join(inboxRoot, '.blog-publish-inbox'), 'test\n', 'utf8');
	const sourceHash = 'b'.repeat(64);
	for (const locale of ['zh', 'en', 'zhHant']) {
		await fs.writeFile(path.join(inboxRoot, articleId, locale === 'zhHant' ? 'zh-hant.md' : `${locale}.md`), completeArticle(articleId, locale, sourceHash), 'utf8');
	}
	await fs.writeFile(path.join(repoRoot, 'package.json'), `${JSON.stringify({
		name: 'publisher-e2e-rehearsal',
		type: 'module',
		scripts: {
			'sync:assets': 'node validate-stage.mjs sync',
			'check:articles': 'node validate-stage.mjs check',
			build: 'node validate-stage.mjs build',
		},
	}, null, 2)}\n`, 'utf8');

	const result = await runChild(process.execPath, [path.join(repoRoot, 'scripts', 'publish-content.mjs'), `--package=${articleId}`], {
		cwd: repoRoot,
		env: { ...process.env, BLOG_CONTENT_INBOX: inboxRoot, BLOG_BACKUP_DIR: backupRoot },
	});
	assert.equal(result.code, 0, result.output);
	assert.match(result.output, /发布整理完成/);
	for (const filename of ['zh.md', 'en.md', 'zh-hant.md']) await fs.access(path.join(repoRoot, 'src', 'content', 'essays', articleId, filename));
	await fs.access(path.join(repoRoot, 'src', 'content', 'essays', articleId, 'images', 'cover.webp'));
	const backups = await fs.readdir(backupRoot);
	assert.equal(backups.length, 1);
	await fs.access(path.join(backupRoot, backups[0], articleId, 'manifest.json'));
});

test('长文翻译遇到截断或段落重排时继续逐块校验，遗漏正文仍停止', async () => {
	const rehearsalRoot = path.join(testRoot, 'chunked-translation');
	const repoRoot = path.join(rehearsalRoot, 'repo');
	const inboxRoot = path.join(rehearsalRoot, 'inbox');
	const articleId = 'publisher-rehearsal';
	await fs.mkdir(path.join(repoRoot, 'scripts'), { recursive: true });
	await fs.mkdir(path.join(repoRoot, 'publisher', 'lib'), { recursive: true });
	await fs.mkdir(path.join(repoRoot, 'src', 'content', 'essays'), { recursive: true });
	await fs.mkdir(path.join(inboxRoot, articleId, 'images'), { recursive: true });
	for (const filename of ['article-markdown.mjs', 'translation-client.mjs', 'mobile-layout.mjs', 'translation-validation.mjs']) {
		await fs.copyFile(path.join(projectRoot, 'publisher', 'lib', filename), path.join(repoRoot, 'publisher', 'lib', filename));
	}
	await fs.copyFile(path.join(projectRoot, 'scripts', 'publish-content.mjs'), path.join(repoRoot, 'scripts', 'publish-content.mjs'));
	await fs.copyFile(path.join(projectRoot, 'publisher', 'tests', 'fixtures', 'validate-stage.mjs'), path.join(repoRoot, 'validate-stage.mjs'));
	await writeFixtureCover(path.join(inboxRoot, articleId, 'images', 'cover.webp'));
	await fs.writeFile(path.join(repoRoot, 'package.json'), JSON.stringify({ name: 'chunked-translation-test', type: 'module', scripts: { 'sync:assets': 'node validate-stage.mjs sync', 'check:articles': 'node validate-stage.mjs check', build: 'node validate-stage.mjs build' } }), 'utf8');
	await fs.writeFile(path.join(inboxRoot, '.blog-publish-inbox'), 'test\n', 'utf8');
	const base = completeArticle(articleId, 'zh', 'c'.repeat(64));
	const frontmatter = base.slice(0, base.indexOf('\n---\n', 4) + 5);
	const paragraphs = Array.from({ length: 8 }, (_unused, index) => `第${index + 1}段。${'这是必须完整保留的长文内容。'.repeat(43)}`);
	const fencedPrompt = '```text\n请完成正文测试。\n1. 请求 https://example.com/status/123。\n2. 核对结果并保存全文。\n```';
	const body = `## 第一节\n\n${paragraphs.slice(0, 4).join('\n\n')}\n\n${fencedPrompt}\n\n### 三级标题\n\n${paragraphs.slice(4).join('\n\n')}`;
	assert.ok(body.length > 3000);
	await fs.writeFile(path.join(inboxRoot, articleId, 'zh.md'), `${frontmatter}\n\n${body}\n`, 'utf8');
	const callsFile = path.join(rehearsalRoot, 'translation-calls.jsonl');
	const result = await runChild(process.execPath, ['--import', pathToFileURL(path.join(projectRoot, 'publisher', 'tests', 'fixtures', 'mock-translation-fetch.mjs')).href, path.join(repoRoot, 'scripts', 'publish-content.mjs'), `--package=${articleId}`], {
		cwd: repoRoot,
		env: { ...process.env, BLOG_CONTENT_INBOX: inboxRoot, BLOG_TRANSLATION_API_URL: 'https://example.com/v1', BLOG_TRANSLATION_API_KEY: 'test-only', BLOG_TRANSLATION_MODEL: 'mock', MOCK_TRANSLATION_CALLS_FILE: callsFile },
	});
	assert.equal(result.code, 0, result.output);
	assert.match(result.output, /当前分段仍超出输出额度，正在缩小分段重试/);
	assert.match(result.output, /发布整理完成/);
	const requests = (await fs.readFile(callsFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
	assert.ok(requests.some((item) => item.truncated));
	assert.ok(requests.some((item) => !item.truncated));
	assert.ok(requests.every((item) => item.length < body.length));
	const translated = await fs.readFile(path.join(repoRoot, 'src', 'content', 'essays', articleId, 'en.md'), 'utf8');
	assert.match(translated, /^### 三级标题$/m);
	const reflowed = await runChild(process.execPath, ['--import', pathToFileURL(path.join(projectRoot, 'publisher', 'tests', 'fixtures', 'mock-translation-fetch.mjs')).href, path.join(repoRoot, 'scripts', 'publish-content.mjs'), '--update', `--package=${articleId}`], {
		cwd: repoRoot,
		env: { ...process.env, BLOG_CONTENT_INBOX: inboxRoot, BLOG_TRANSLATION_API_URL: 'https://example.com/v1', BLOG_TRANSLATION_API_KEY: 'test-only', BLOG_TRANSLATION_MODEL: 'mock', MOCK_TRANSLATION_CALLS_FILE: callsFile, MOCK_TRANSLATION_MAX_CHARS: '100000', MOCK_TRANSLATION_REFLOW_PARAGRAPHS: '1' },
	});
	assert.equal(reflowed.code, 0, reflowed.output);
	assert.match(reflowed.output, /改为按原文块逐一翻译/);
	const reflowedTranslation = await fs.readFile(path.join(repoRoot, 'src', 'content', 'essays', articleId, 'en.md'), 'utf8');
	const translatedBody = reflowedTranslation.slice(reflowedTranslation.indexOf('\n---\n', 4) + 5).replace(/\s+/g, '');
	assert.equal(translatedBody, body.replace(/\s+/g, ''));
	assert.notEqual(reflowedTranslation, translated);
	const strippedFences = await runChild(process.execPath, ['--import', pathToFileURL(path.join(projectRoot, 'publisher', 'tests', 'fixtures', 'mock-translation-fetch.mjs')).href, path.join(repoRoot, 'scripts', 'publish-content.mjs'), '--update', `--package=${articleId}`], {
		cwd: repoRoot,
		env: { ...process.env, BLOG_CONTENT_INBOX: inboxRoot, BLOG_TRANSLATION_API_URL: 'https://example.com/v1', BLOG_TRANSLATION_API_KEY: 'test-only', BLOG_TRANSLATION_MODEL: 'mock', MOCK_TRANSLATION_CALLS_FILE: callsFile, MOCK_TRANSLATION_MAX_CHARS: '100000', MOCK_TRANSLATION_STRIP_FENCES: '1' },
	});
	assert.equal(strippedFences.code, 0, strippedFences.output);
	assert.match(strippedFences.output, /代码围栏丢失，改为按原文块逐一翻译/);
	const repairedTranslation = await fs.readFile(path.join(repoRoot, 'src', 'content', 'essays', articleId, 'en.md'), 'utf8');
	assert.match(repairedTranslation, /```text\n请完成正文测试。\n1\. 请求 https:\/\/example\.com\/status\/123。\n2\. 核对结果并保存全文。\n```/);
	assert.equal(repairedTranslation.slice(repairedTranslation.indexOf('\n---\n', 4) + 5).replace(/\s+/g, ''), body.replace(/\s+/g, ''));
	const emptyFence = await runChild(process.execPath, ['--import', pathToFileURL(path.join(projectRoot, 'publisher', 'tests', 'fixtures', 'mock-translation-fetch.mjs')).href, path.join(repoRoot, 'scripts', 'publish-content.mjs'), '--dry-run', '--update', `--package=${articleId}`], {
		cwd: repoRoot,
		env: { ...process.env, BLOG_CONTENT_INBOX: inboxRoot, BLOG_TRANSLATION_API_URL: 'https://example.com/v1', BLOG_TRANSLATION_API_KEY: 'test-only', BLOG_TRANSLATION_MODEL: 'mock', MOCK_TRANSLATION_CALLS_FILE: callsFile, MOCK_TRANSLATION_MAX_CHARS: '100000', MOCK_TRANSLATION_EMPTY_FENCE_BODY: '1' },
	});
	assert.notEqual(emptyFence.code, 0);
	assert.match(emptyFence.output, /代码围栏正文缺失/);
	assert.equal(await fs.readFile(path.join(repoRoot, 'src', 'content', 'essays', articleId, 'en.md'), 'utf8'), repairedTranslation);
	const rejected = await runChild(process.execPath, ['--import', pathToFileURL(path.join(projectRoot, 'publisher', 'tests', 'fixtures', 'mock-translation-fetch.mjs')).href, path.join(repoRoot, 'scripts', 'publish-content.mjs'), '--dry-run', '--update', `--package=${articleId}`], {
		cwd: repoRoot,
		env: { ...process.env, BLOG_CONTENT_INBOX: inboxRoot, BLOG_TRANSLATION_API_URL: 'https://example.com/v1', BLOG_TRANSLATION_API_KEY: 'test-only', BLOG_TRANSLATION_MODEL: 'mock', MOCK_TRANSLATION_CALLS_FILE: callsFile, MOCK_TRANSLATION_MAX_CHARS: '100000', MOCK_TRANSLATION_OMIT_BLOCK: '1' },
	});
	assert.notEqual(rejected.code, 0);
	assert.match(rejected.output, /分段译文缺少 body/);
	assert.equal(await fs.readFile(path.join(repoRoot, 'src', 'content', 'essays', articleId, 'en.md'), 'utf8'), repairedTranslation);
});

async function makeMinimalRepo(repoRoot) {
	await fs.mkdir(path.join(repoRoot, 'scripts'), { recursive: true });
	await fs.mkdir(path.join(repoRoot, 'src', 'content', 'essays'), { recursive: true });
	await fs.mkdir(path.join(repoRoot, 'src', 'assets', 'images', 'home'), { recursive: true });
	await fs.writeFile(path.join(repoRoot, 'package.json'), '{"name":"test"}\n', 'utf8');
	await fs.writeFile(path.join(repoRoot, 'scripts', 'publish-content.mjs'), '', 'utf8');
	for (const category of categoryDefinitions) await fs.writeFile(path.join(repoRoot, 'src', 'assets', 'images', 'home', category.cover), Buffer.from(category.topic));
}

async function writeFixtureCover(filename) {
	await sharp({ create: { width: 16, height: 16, channels: 3, background: '#426b74' } }).webp().toFile(filename);
}

function mockResponse(status, body, jsonBody = false) {
	return {
		status,
		ok: status >= 200 && status < 300,
		async text() { return body; },
		async json() { return jsonBody ? JSON.parse(body) : {}; },
	};
}

function completeArticle(articleId, locale, sourceHash) {
	const language = locale === 'en' ? 'English' : locale === 'zhHant' ? '繁體中文' : '简体中文';
	const body = locale === 'en'
		? `This is a complete rehearsal article used to verify the local publishing pipeline without publishing it to the real website. ${'It preserves full paragraphs, stable metadata, image references, backups, and all build stages. '.repeat(28)}`
		: `${language}端到端演练文章用于验证本地发布流程，不会进入真实网站。${'它保留完整段落、稳定元数据、图片引用、本地备份与全部构建阶段。'.repeat(45)}`;
	const decorated = `<span class="mobile-reading-emphasis">${language}</span><span class="mobile-reading-break" aria-hidden="true"></span>${body}`;
	return `---\narticleId: ${articleId}\nlocale: ${locale}\nslug: ${articleId}\ntitle: '${language}发布器演练'\ndescription: '验证完整发布流程的测试文章。'\npubDate: '2026-10-03'\nsourceHash: '${sourceHash}'\ndraft: false\nkind: essay\nstage: growing\ntopics:\n  - technology-ai\nfeatured: false\ncoverImage: './images/cover.webp'\ncoverAlt: '薄雾山水测试封面。'\n---\n\n${decorated}\n`;
}

function runChild(command, args, options) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { ...options, shell: false, windowsHide: true });
		let output = '';
		child.stdout.on('data', (chunk) => { output += chunk.toString(); });
		child.stderr.on('data', (chunk) => { output += chunk.toString(); });
		child.on('error', reject);
		child.on('exit', (code) => resolve({ code, output }));
	});
}
