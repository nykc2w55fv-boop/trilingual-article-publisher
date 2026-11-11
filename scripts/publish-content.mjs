import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { requestJson } from '../publisher/lib/translation-client.mjs';
import { articleDescription, articleTableShapes, markdownFormattingIssues, normalizeArticleMarkdown } from '../publisher/lib/article-markdown.mjs';
import { assertMobileLayoutAgreement } from '../publisher/lib/mobile-layout.mjs';
import { MAX_TRANSLATION_SOURCE_CHARS, requestWithLayoutRetry, restoreMissingFencedBlock, splitMarkdownForTranslation, translateBodyInChunks } from '../publisher/lib/translation-validation.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await loadLocalEnvironment();

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const allowUpdate = args.has('--update');
const initializeInbox = args.has('--init-inbox');
const selectedPackage = [...args].find((arg) => arg.startsWith('--package='))?.slice('--package='.length);
const inboxDir = path.resolve(process.env.BLOG_CONTENT_INBOX || path.join(rootDir, '.local', 'content-inbox'));
const backupRoot = path.resolve(process.env.BLOG_BACKUP_DIR || path.join(rootDir, '.local', 'backups'));
const essaysDir = path.join(rootDir, 'src', 'content', 'essays');
const inboxMarker = path.join(inboxDir, '.blog-publish-inbox');
const requiredLocales = { zh: 'zh.md', en: 'en.md', zhHant: 'zh-hant.md' };
const imageExtensions = new Set(['.avif', '.jpg', '.jpeg', '.png', '.webp']);

if (initializeInbox) {
	await fs.mkdir(inboxDir, { recursive: true });
	await fs.writeFile(inboxMarker, 'This folder is intentionally limited to public blog packages.\n', { flag: 'a' });
	console.log(`公开发布收件箱已初始化：${inboxDir}`);
	process.exit(0);
}

await assertIntentionalInbox();
const candidates = await findPackages();
if (candidates.length === 0) throw new Error('收件箱中没有可发布的文章包。每个文章文件夹至少需要 zh.md 和 images/。');

const preparedPackages = [];
for (const packageName of candidates) preparedPackages.push(await preparePackage(packageName));

console.log(`已在内存中完成 ${preparedPackages.length} 个文章包的三语、图片和 frontmatter 校验。`);
if (dryRun) {
	console.log('这是 dry-run：没有写入文章目录、备份目录，也没有运行构建。');
	process.exit(0);
}

const timestamp = localTimestamp();
for (const prepared of preparedPackages) {
	await createBackup(prepared, timestamp);
	await writePublicPackage(prepared);
}

await runNpm('sync:assets');
await runNpm('check:articles');
await runNpm('build');

console.log('');
console.log('发布整理完成。脚本没有执行 Git commit 或 push。');
console.log(`本地备份：${path.join(backupRoot, timestamp)}`);
console.log('请打开 GitHub Desktop 检查差异，确认后再手动 Commit 和 Push。');

async function assertIntentionalInbox() {
	await fs.mkdir(inboxDir, { recursive: true });
	try {
		await fs.access(inboxMarker);
	} catch {
		throw new Error(`为防止误扫整个 Obsidian 仓库，请先在公开发布文件夹中创建空文件 .blog-publish-inbox：${inboxDir}`);
	}
}

async function findPackages() {
	const entries = await fs.readdir(inboxDir, { withFileTypes: true });
	const directories = entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => entry.name);
	if (directories.length > 100) throw new Error('收件箱一级目录超过 100 个，已停止以避免误把大型资料库当作发布目录。');
	const packageDirectories = [];
	for (const name of directories) if (await exists(path.join(inboxDir, name, 'zh.md'))) packageDirectories.push(name);
	const filtered = selectedPackage ? packageDirectories.filter((name) => name === selectedPackage) : packageDirectories;
	if (selectedPackage && filtered.length === 0) throw new Error(`找不到指定文章包：${selectedPackage}`);
	return filtered.sort();
}

async function preparePackage(packageName) {
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(packageName)) throw new Error(`${packageName}: 文件夹名必须是英文小写 kebab-case。`);
	const sourceDir = path.join(inboxDir, packageName);
	const destinationDir = path.join(essaysDir, packageName);
	const destinationExists = await exists(destinationDir);
	if (destinationExists && !allowUpdate) throw new Error(`${packageName}: 站点中已存在；如确需更新，请在人工确认后加 --update。`);

	const sourceFiles = {};
	for (const [locale, filename] of Object.entries(requiredLocales)) {
		sourceFiles[locale] = await readOptional(path.join(sourceDir, filename));
	}
	if (!sourceFiles.zh) throw new Error(`${packageName}: 缺少 zh.md。中文原文是发布源。`);
	sourceFiles.zh = normalizeDocument(sourceFiles.zh, 'zh');

	const zhParsed = parseMarkdown(sourceFiles.zh, `${packageName}/zh.md`);
	validateMetadata(zhParsed, packageName, 'zh');
	for (const locale of ['en', 'zhHant']) {
		if (!sourceFiles[locale]) {
			const languageName = locale === 'en' ? '英文' : '繁体中文';
			console.log(`${packageName}: 正在生成完整${languageName}译文…`);
			sourceFiles[locale] = await translateMarkdown(zhParsed, locale, packageName);
			console.log(`${packageName}: 完整${languageName}译文已生成。`);
		}
	}

	const documents = {};
	for (const [locale, filename] of Object.entries(requiredLocales)) {
		const text = normalizeDocument(sourceFiles[locale], locale);
		const parsed = parseMarkdown(text, `${packageName}/${filename}`);
		const formattingIssues = markdownFormattingIssues(parsed.body);
		if (formattingIssues.length) throw new Error(`${packageName}/${filename}: ${formattingIssues.join(' ')}`);
		validateMetadata(parsed, packageName, locale);
		validateBody(parsed, zhParsed, packageName, filename, locale !== 'zh');
		documents[filename] = normalizeNewlines(text);
	}
	validateLocaleAgreement(documents, packageName);

	const images = await prepareImages(sourceDir, packageName);
	for (const [filename, text] of Object.entries(documents)) validateImageReferences(text, images, packageName, filename);

	return { packageName, sourceDir, destinationDir, destinationExists, documents, images };
}

async function translateMarkdown(source, targetLocale, packageName) {
	const settings = {
		baseUrl: process.env.BLOG_TRANSLATION_API_URL || process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
		apiKey: process.env.BLOG_TRANSLATION_API_KEY || process.env.OPENROUTER_API_KEY,
		model: process.env.BLOG_TRANSLATION_MODEL || process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini',
	};
	if (!settings.apiKey) throw new Error(`${packageName}: 缺少 ${requiredLocales[targetLocale]}，且本机没有配置大模型 API Key。`);
	const targetName = targetLocale === 'en' ? 'English' : 'Traditional Chinese';
	const prompt = `Translate the complete Chinese Markdown article below into ${targetName}. Return JSON only with title, description, coverAlt, and body. Preserve every section, paragraph, list, quotation, link URL, image URL, emphasis, code block, and heading. Do not summarize, omit, add commentary, or rewrite the argument. Translate visible image alt text but keep every image path unchanged. Keep table rows on separate lines and preserve their columns. Keep math delimiters and LaTeX commands unchanged. Keep fenced text diagrams and all their labels. Preserve every mobile-reading-emphasis and mobile-reading-break HTML span exactly, in the same order; translate only the visible words inside emphasis spans. Do not escape Markdown emphasis markers. Translate description as a short, complete introductory sentence, not a pasted body paragraph. The body must be complete Markdown without frontmatter or a repeated article title.\n\nTITLE:\n${source.data.title}\n\nDESCRIPTION:\n${source.data.description}\n\nCOVER ALT:\n${source.data.coverAlt}\n\nBODY:\n${source.body}`;
	const validateComplete = (translated) => {
		for (const field of ['title', 'description', 'coverAlt', 'body']) {
			if (typeof translated[field] !== 'string' || !translated[field].trim()) throw new Error(`${packageName}: 译文缺少 ${field}。`);
		}
		translated.body = normalizeArticleMarkdown(translated.body);
		translated.description = articleDescription(translated.body, translated.description, targetLocale);
		if (plainTextLength(translated.body) < plainTextLength(source.body) * 0.55) throw new Error(`${packageName}: 译文疑似被摘要或截断，已停止发布。`);
		validateTranslatedStructure(source.body, translated.body, packageName, targetLocale);
		return buildTranslatedDocument(source.data, translated, targetLocale);
	};
	if (source.body.length <= MAX_TRANSLATION_SOURCE_CHARS) {
		try {
			return await requestWithLayoutRetry(
				(attempt) => requestJson(settings, {
					prompt: attempt === 0 ? prompt : `${prompt}\n\nCritical correction for this retry: the previous translation changed or omitted a mobile-reading HTML span. Preserve every complete span, its paragraph, and its order exactly. Do not insert extra spans or alter tag attributes.`,
				}),
				validateComplete,
				() => console.log(`${packageName}: ${targetLocale} 译文排版标记未通过校验，正在自动重新生成一次…`),
			);
		} catch (error) {
			if (error.code !== 'MODEL_OUTPUT_TRUNCATED') throw error;
			console.log(`${packageName}: 单次输出额度不足，改用分段翻译…`);
		}
	} else {
		console.log(`${packageName}: 正文较长，按 Markdown 段落分批翻译，避免耗尽单次输出额度…`);
	}
	const translated = await requestJson(settings, {
		prompt: `Translate these Chinese article metadata fields into ${targetName}. Return JSON only with title, description, and coverAlt. Translate completely and do not add other fields. DESCRIPTION should be a short, complete introductory sentence.\n\nTITLE:\n${source.data.title}\n\nDESCRIPTION:\n${source.data.description}\n\nCOVER ALT:\n${source.data.coverAlt}`,
	});
	for (const field of ['title', 'description', 'coverAlt']) {
		if (typeof translated[field] !== 'string' || !translated[field].trim()) throw new Error(`${packageName}: 译文缺少 ${field}。`);
	}
	translated.body = await translateBodyInChunks(source.body, {
		request: (body, attempt) => requestJson(settings, {
			prompt: `Translate this consecutive excerpt of a Chinese Markdown article into ${targetName}. Return JSON only with a body field containing complete translated Markdown for this excerpt. Preserve every paragraph, list, quotation, link URL, image URL, emphasis, code block, heading, table row and column, math delimiter, LaTeX command, and fenced text diagram. Translate visible image alt text but keep every image path unchanged. Do not escape Markdown emphasis markers. Preserve every mobile-reading-emphasis and mobile-reading-break HTML span exactly, in the same paragraph and order; translate only visible words inside emphasis spans. Do not summarize, omit, add commentary, repeat the title, or add frontmatter. This excerpt may start or end in the middle of the article; translate only the supplied text. Article title for context: ${source.data.title}.\n\nBODY:\n${body}${attempt ? '\n\nCritical correction: the previous translation moved or omitted a mobile-reading span. Preserve all spans exactly.' : ''}`,
		}),
		validate: (sourceChunk, result) => {
			if (typeof result?.body !== 'string' || !result.body.trim()) throw new Error(`${packageName}: 分段译文缺少 body。`);
			const repairedBody = restoreMissingFencedBlock(sourceChunk, result.body);
			const body = normalizeArticleMarkdown(repairedBody);
			const sourceBlocks = splitMarkdownForTranslation(sourceChunk, 1).length;
			if (sourceBlocks > 1 && markdownFenceCount(sourceChunk) !== markdownFenceCount(body)) {
				const error = new Error(`${packageName}: ${targetLocale} 译文的代码围栏丢失，需按原文块逐一翻译。`);
				error.code = 'TRANSLATION_FENCE_MISMATCH';
				throw error;
			}
			if (sourceBlocks > 1 && sourceBlocks !== splitMarkdownForTranslation(body, 1).length) {
				const error = new Error(`${packageName}: ${targetLocale} 译文调整了段落排版，需按原文块逐一翻译。`);
				error.code = 'TRANSLATION_BLOCK_COUNT_MISMATCH';
				throw error;
			}
			if (plainTextLength(body) < plainTextLength(sourceChunk) * 0.55) throw new Error(`${packageName}: 分段译文疑似被摘要或截断，已停止发布。`);
			validateTranslatedStructure(sourceChunk, body, packageName, targetLocale);
			// Normalize the assembled article once so a chunk starting at ### does not become ##.
			return repairedBody.trim();
		},
		onChunk: (part, total) => console.log(`${packageName}: ${targetLocale} 正在翻译第 ${part}/${total} 段…`),
		onSplit: (reason) => console.log(reason === 'TRANSLATION_BLOCK_COUNT_MISMATCH'
			? `${packageName}: 译文段落排版有变化，改为按原文块逐一翻译并校验…`
			: reason === 'TRANSLATION_FENCE_MISMATCH'
				? `${packageName}: 译文代码围栏丢失，改为按原文块逐一翻译并恢复围栏…`
				: `${packageName}: 当前分段仍超出输出额度，正在缩小分段重试…`),
		inlineSeparator: targetLocale === 'en' ? ' ' : '',
	});
	return validateComplete(translated);
}

function buildTranslatedDocument(sourceData, translated, locale) {
	const lines = [
		'---',
		`articleId: ${yamlString(sourceData.articleId)}`,
		`locale: ${locale}`,
		`slug: ${yamlString(sourceData.slug)}`,
		`title: ${yamlString(translated.title)}`,
		`description: ${yamlString(translated.description)}`,
		`pubDate: ${yamlString(sourceData.pubDate)}`,
	];
	if (sourceData.updatedDate) lines.push(`updatedDate: ${yamlString(sourceData.updatedDate)}`);
	if (sourceData.sourceHash) lines.push(`sourceHash: ${yamlString(sourceData.sourceHash)}`);
	lines.push(
		`draft: ${sourceData.draft}`,
		`kind: ${sourceData.kind}`,
		`stage: ${sourceData.stage}`,
		'topics:',
		...sourceData.topics.map((topic) => `  - ${topic}`),
		`featured: ${sourceData.featured}`,
		`coverImage: ${yamlString(sourceData.coverImage)}`,
		`coverAlt: ${yamlString(translated.coverAlt)}`,
		'---',
		'',
		translated.body.trim(),
		'',
	);
	return lines.join('\n');
}

async function prepareImages(sourceDir, packageName) {
	const imagesDir = path.join(sourceDir, 'images');
	const entries = await fs.readdir(imagesDir, { withFileTypes: true }).catch((error) => {
		if (error.code === 'ENOENT') throw new Error(`${packageName}: 缺少 images/ 文件夹。`);
		throw error;
	});
	const images = new Map();
	for (const entry of entries) {
		if (entry.isSymbolicLink() || entry.isDirectory()) throw new Error(`${packageName}/images: v1 只允许直接放图片文件，不允许子目录或符号链接。`);
		const extension = path.extname(entry.name).toLowerCase();
		if (!imageExtensions.has(extension)) throw new Error(`${packageName}/images/${entry.name}: 不支持的图片格式。`);
		const input = await fs.readFile(path.join(imagesDir, entry.name));
		let pipeline = sharp(input).rotate().resize({ width: 2000, withoutEnlargement: true });
		if (extension === '.webp') pipeline = pipeline.webp({ quality: 82 });
		else if (extension === '.avif') pipeline = pipeline.avif({ quality: 52 });
		else if (extension === '.png') pipeline = pipeline.png({ compressionLevel: 9, palette: false });
		else pipeline = pipeline.jpeg({ quality: 84, mozjpeg: true });
		images.set(entry.name, await pipeline.toBuffer());
	}
	if (![...images.keys()].some((name) => /^cover\.(?:avif|jpe?g|png|webp)$/i.test(name))) throw new Error(`${packageName}: images/ 中缺少 cover 图片。`);
	return images;
}

function validateMetadata(parsed, packageName, locale) {
	const data = parsed.data;
	const required = ['articleId', 'locale', 'slug', 'title', 'description', 'pubDate', 'draft', 'kind', 'stage', 'topics', 'featured', 'coverImage', 'coverAlt'];
	for (const field of required) if (data[field] === undefined || data[field] === '') throw new Error(`${packageName}: ${locale} frontmatter 缺少 ${field}。`);
	if (data.articleId !== packageName) throw new Error(`${packageName}: articleId 必须与文章包文件夹同名。`);
	if (data.locale !== locale) throw new Error(`${packageName}: ${requiredLocales[locale]} 的 locale 必须是 ${locale}。`);
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(data.slug)) throw new Error(`${packageName}: slug 必须是英文小写 kebab-case。`);
	if (!['essay', 'note'].includes(data.kind)) throw new Error(`${packageName}: kind 只能是 essay 或 note。`);
	if (!['seed', 'growing', 'evergreen'].includes(data.stage)) throw new Error(`${packageName}: stage 无效。`);
	if (!Array.isArray(data.topics) || data.topics.length === 0) throw new Error(`${packageName}: topics 不能为空。`);
	if (!data.coverImage.startsWith('./images/')) throw new Error(`${packageName}: coverImage 必须使用 ./images/ 相对路径。`);
}

function validateBody(parsed, source, packageName, filename, translated) {
	const length = plainTextLength(parsed.body);
	if (length < 500) throw new Error(`${packageName}/${filename}: 正文过短，不满足完整文章要求。`);
	if (translated && length < plainTextLength(source.body) * 0.55) throw new Error(`${packageName}/${filename}: 译文疑似不完整。`);
	if (translated) validateTranslatedStructure(source.body, parsed.body, packageName, parsed.data.locale);
	if (/blog-placeholder-/i.test(parsed.raw)) throw new Error(`${packageName}/${filename}: 不允许 Astro 示例占位图。`);
}

function validateLocaleAgreement(documents, packageName) {
	const parsed = Object.values(documents).map((text) => parseMarkdown(text, packageName));
	if (new Set(parsed.map((item) => item.data.articleId)).size !== 1) throw new Error(`${packageName}: 三语 articleId 不一致。`);
	if (new Set(parsed.map((item) => item.data.slug)).size !== 1) throw new Error(`${packageName}: 三语 slug 不一致。`);
	const sourceHashes = parsed.map((item) => item.data.sourceHash).filter(Boolean);
	if (sourceHashes.length > 0 && sourceHashes.length !== parsed.length) throw new Error(`${packageName}: sourceHash 必须三语都有或都没有。`);
	if (new Set(sourceHashes).size > 1) throw new Error(`${packageName}: 三语 sourceHash 不一致。`);
}

function markdownFenceCount(body) {
	return [...body.matchAll(/^ {0,3}(?:`{3,}|~{3,})/gm)].length;
}

function fencedBlockBodies(body) {
	const blocks = [];
	let opening = null;
	let lines = [];
	for (const line of String(body).replace(/\r\n?/g, '\n').split('\n')) {
		const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
		if (!opening) {
			if (marker) {
				opening = marker[1];
				lines = [];
			}
			continue;
		}
		if (marker && marker[1][0] === opening[0] && marker[1].length >= opening.length && /^ {0,3}(?:`{3,}|~{3,})[ \t]*$/.test(line)) {
			blocks.push(lines.join('\n'));
			opening = null;
		} else {
			lines.push(line);
		}
	}
	return blocks;
}

function validateTranslatedStructure(sourceBody, translatedBody, packageName, locale) {
	assertMobileLayoutAgreement(sourceBody, translatedBody, `${packageName}: ${locale}`);
	const count = (value, pattern) => [...value.matchAll(pattern)].length;
	const sourceImages = [...sourceBody.matchAll(/!\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g)].map((match) => match[1]);
	const translatedImages = [...translatedBody.matchAll(/!\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g)].map((match) => match[1]);
	const sourceLinks = [...sourceBody.matchAll(/(?<!!)\[[^\]]+\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g)].map((match) => match[1]);
	const translatedLinks = [...translatedBody.matchAll(/(?<!!)\[[^\]]+\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g)].map((match) => match[1]);
	const checks = [
		['标题数量', count(sourceBody, /^#{1,6}\s+/gm), count(translatedBody, /^#{1,6}\s+/gm)],
		['代码围栏数量', markdownFenceCount(sourceBody), markdownFenceCount(translatedBody)],
		['引用块数量', count(sourceBody, /^>\s?/gm), count(translatedBody, /^>\s?/gm)],
	];
	for (const [label, expected, actual] of checks) {
		if (expected !== actual) throw new Error(`${packageName}: ${locale} 译文的${label}与中文不一致（${actual}/${expected}）。`);
	}
	const sourceFences = fencedBlockBodies(sourceBody);
	const translatedFences = fencedBlockBodies(translatedBody);
	if (sourceFences.length !== translatedFences.length || sourceFences.some((content, index) => content.trim() && !translatedFences[index].trim())) {
		throw new Error(`${packageName}: ${locale} 译文的代码围栏正文缺失或围栏未闭合。`);
	}
	if (JSON.stringify(sourceImages) !== JSON.stringify(translatedImages)) throw new Error(`${packageName}: ${locale} 译文改变或遗漏了图片路径。`);
	if (JSON.stringify(sourceLinks) !== JSON.stringify(translatedLinks)) throw new Error(`${packageName}: ${locale} 译文改变或遗漏了链接地址。`);
	if (JSON.stringify(articleTableShapes(sourceBody)) !== JSON.stringify(articleTableShapes(translatedBody))) throw new Error(`${packageName}: ${locale} 译文遗漏了表格，或改变了表格行数、列数。`);
}

function validateImageReferences(text, images, packageName, filename) {
	const parsed = parseMarkdown(text, `${packageName}/${filename}`);
	const references = [parsed.data.coverImage, ...[...parsed.body.matchAll(/!\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g)].map((match) => match[1])];
	for (const reference of references) {
		if (/^(?:https?:|\/)/.test(reference)) continue;
		const normalized = reference.replace(/^\.\/?/, '').replace(/^images\//, '');
		if (!images.has(normalized)) throw new Error(`${packageName}/${filename}: 找不到引用图片 ${reference}。`);
	}
	for (const match of parsed.body.matchAll(/!\[([^\]]*)\]\(/g)) if (!match[1].trim()) throw new Error(`${packageName}/${filename}: 正文图片缺少 alt。`);
}

async function createBackup(prepared, timestamp) {
	const backupDir = path.join(backupRoot, timestamp, prepared.packageName);
	await fs.mkdir(backupDir, { recursive: true });
	if (prepared.destinationExists) await fs.cp(prepared.destinationDir, path.join(backupDir, 'previous'), { recursive: true, errorOnExist: true });
	const preparedDir = path.join(backupDir, 'prepared');
	await fs.mkdir(path.join(preparedDir, 'images'), { recursive: true });
	for (const [filename, text] of Object.entries(prepared.documents)) await fs.writeFile(path.join(preparedDir, filename), text, 'utf8');
	for (const [filename, buffer] of prepared.images) await fs.writeFile(path.join(preparedDir, 'images', filename), buffer);
	const checksums = {};
	for (const [filename, text] of Object.entries(prepared.documents)) checksums[filename] = sha256(Buffer.from(text));
	for (const [filename, buffer] of prepared.images) checksums[`images/${filename}`] = sha256(buffer);
	await fs.writeFile(path.join(backupDir, 'manifest.json'), `${JSON.stringify({ articleId: prepared.packageName, createdAt: new Date().toISOString(), checksums }, null, 2)}\n`, 'utf8');
}

async function writePublicPackage(prepared) {
	await fs.mkdir(path.join(prepared.destinationDir, 'images'), { recursive: true });
	for (const [filename, text] of Object.entries(prepared.documents)) await fs.writeFile(path.join(prepared.destinationDir, filename), text, 'utf8');
	for (const [filename, buffer] of prepared.images) await fs.writeFile(path.join(prepared.destinationDir, 'images', filename), buffer);
}

function parseMarkdown(text, label) {
	const raw = normalizeNewlines(text).replace(/^\uFEFF/, '');
	if (!raw.startsWith('---\n')) throw new Error(`${label}: 缺少 frontmatter。`);
	const closing = raw.indexOf('\n---\n', 4);
	if (closing < 0) throw new Error(`${label}: frontmatter 没有正确结束。`);
	const data = {};
	let listKey = null;
	for (const rawLine of raw.slice(4, closing).split('\n')) {
		const listItem = rawLine.match(/^\s+-\s+(.+)$/);
		if (listItem && listKey) { data[listKey].push(parseScalar(listItem[1])); continue; }
		const field = rawLine.match(/^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/);
		if (!field) continue;
		const [, key, rawValue] = field;
		if (rawValue === '') { data[key] = []; listKey = key; }
		else { data[key] = parseScalar(rawValue); listKey = null; }
	}
	return { raw, data, body: raw.slice(closing + 5).trim() };
}

function normalizeDocument(text, locale) {
	const normalized = normalizeNewlines(text);
	const closing = normalized.indexOf('\n---\n', 4);
	if (!normalized.startsWith('---\n') || closing < 0) return normalized;
	const parsed = parseMarkdown(normalized, locale);
	const body = normalizeArticleMarkdown(parsed.body);
	const description = articleDescription(body, parsed.data.description, locale);
	const metadata = normalized.slice(0, closing + 5).replace(/^description:.*$/m, `description: ${yamlString(description)}`);
	return `${metadata}\n\n${body}\n`;
}

function parseScalar(value) {
	const trimmed = value.trim();
	if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) return trimmed.slice(1, -1);
	if (trimmed === 'true') return true;
	if (trimmed === 'false') return false;
	if (trimmed.startsWith('[') && trimmed.endsWith(']')) return trimmed.slice(1, -1).split(',').map((item) => parseScalar(item)).filter(Boolean);
	return trimmed;
}

function plainTextLength(body) {
	return body.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/<[^>]+>/g, '').replace(/[#>*_`~-]/g, '').replace(/\s+/g, '').length;
}

async function runNpm(script) {
	const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
	const directCli = await exists(npmCli);
	await new Promise((resolve, reject) => {
		const isWindows = process.platform === 'win32';
		const command = directCli ? process.execPath : isWindows ? (process.env.ComSpec || 'cmd.exe') : 'npm';
		const commandArgs = directCli ? [npmCli, 'run', script] : isWindows ? ['/d', '/s', '/c', `npm.cmd run ${script}`] : ['run', script];
		const child = spawn(command, commandArgs, { cwd: rootDir, stdio: 'inherit', shell: false });
		child.on('error', reject);
		child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`npm run ${script} 失败，退出码 ${code}。公开文件已写入但尚未提交；请根据本地备份检查或恢复。`)));
	});
}

async function loadLocalEnvironment() {
	for (const filename of ['.env.local', '.env']) {
		const text = await readOptional(path.join(rootDir, filename));
		if (!text) continue;
		for (const line of text.split(/\r?\n/)) {
			const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
			if (!match || process.env[match[1]] !== undefined) continue;
			process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
		}
	}
}

async function readOptional(filePath) {
	try { return await fs.readFile(filePath, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function exists(target) { try { await fs.access(target); return true; } catch { return false; } }
function normalizeNewlines(value) { return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n*$/, '\n'); }
function yamlString(value) { return `'${String(value).replace(/'/g, "''")}'`; }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function localTimestamp() {
	const now = new Date();
	const part = (value) => String(value).padStart(2, '0');
	return `${now.getFullYear()}${part(now.getMonth() + 1)}${part(now.getDate())}-${part(now.getHours())}${part(now.getMinutes())}${part(now.getSeconds())}`;
}
