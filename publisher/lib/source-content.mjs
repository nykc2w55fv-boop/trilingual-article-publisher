import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { requestJson } from './translation-client.mjs';
import { articleDescription, normalizeArticleMarkdown } from './article-markdown.mjs';

export const categoryDefinitions = [
	{
		folder: '1.古典阅读与修身',
		topic: 'classics-cultivation',
		cover: 'visual-reading.webp',
		coverAlt: '安静庭院中的阅读意象，象征古典阅读与内在修习。',
	},
	{
		folder: '2.技术与AI实践',
		topic: 'technology-ai',
		cover: 'digital-garden-hero.webp',
		coverAlt: '薄雾中的山水庭园，象征技术实践与持续生长的数字花园。',
	},
	{
		folder: '3.投研与量化',
		topic: 'investment-quant',
		cover: 'visual-landscape.webp',
		coverAlt: '层叠山水与开阔远景，象征理性观察、研究与长期判断。',
	},
];

const imageExtensions = new Set(['.avif', '.jpg', '.jpeg', '.png', '.webp']);
const scalarFields = new Set([
	'articleId', 'slug', 'title', 'description', 'pubDate', 'updatedDate',
	'kind', 'stage', 'featured', 'coverFile', 'coverAlt', 'draft', 'sourceHash',
]);

export async function initializeSourceLibrary(sourceRoot) {
	assertAbsolutePath(sourceRoot, 'Obsidian 发布目录');
	await fs.mkdir(sourceRoot, { recursive: true });
	await rejectSymbolicLink(sourceRoot, 'Obsidian 发布目录');
	for (const category of categoryDefinitions) await fs.mkdir(path.join(sourceRoot, category.folder), { recursive: true });
	await fs.mkdir(path.join(sourceRoot, '_attachments'), { recursive: true });
	await fs.writeFile(
		path.join(sourceRoot, '.blog-publisher-source'),
		'Only Markdown files inside the three named category folders are public publishing sources.\n',
		{ flag: 'a' },
	);
}

export async function validateRepository(repoRoot) {
	assertAbsolutePath(repoRoot, '网站仓库路径');
	for (const relativePath of ['package.json', 'scripts/publish-content.mjs', 'src/content/essays']) {
		if (!(await exists(path.join(repoRoot, relativePath)))) throw new Error(`网站仓库缺少 ${relativePath}。`);
	}
	return path.resolve(repoRoot);
}

export async function validateSourceLibrary(sourceRoot) {
	assertAbsolutePath(sourceRoot, 'Obsidian 发布目录');
	if (!(await exists(path.join(sourceRoot, '.blog-publisher-source')))) {
		throw new Error('这不是已初始化的网站文章目录。请先在设置中保存并初始化。');
	}
	await rejectSymbolicLink(sourceRoot, 'Obsidian 发布目录');
	for (const category of categoryDefinitions) {
		const categoryPath = path.join(sourceRoot, category.folder);
		if (!(await exists(categoryPath))) throw new Error(`缺少分类文件夹：${category.folder}`);
		await rejectSymbolicLink(categoryPath, `分类文件夹 ${category.folder}`);
	}
	const attachmentsPath = path.join(sourceRoot, '_attachments');
	if (!(await exists(attachmentsPath))) throw new Error('缺少公共图片文件夹：_attachments');
	await rejectSymbolicLink(attachmentsPath, '_attachments');
	return path.resolve(sourceRoot);
}

export async function scanSourceLibrary({ sourceRoot, repoRoot }) {
	await validateSourceLibrary(sourceRoot);
	await validateRepository(repoRoot);
	const articles = [];
	for (const category of categoryDefinitions) {
		const categoryDir = path.join(sourceRoot, category.folder);
		const entries = await fs.readdir(categoryDir, { withFileTypes: true });
		for (const entry of entries.filter((item) => item.isFile() && path.extname(item.name).toLowerCase() === '.md')) {
			const sourceFile = path.join(categoryDir, entry.name);
			try {
				await rejectSymbolicLink(sourceFile, entry.name);
				const prepared = await inspectSource({ sourceFile, sourceRoot, repoRoot, category });
				articles.push({ ...prepared, relativePath: path.relative(sourceRoot, sourceFile).split(path.sep).join('/') });
			} catch (error) {
				articles.push({
					relativePath: path.relative(sourceRoot, sourceFile).split(path.sep).join('/'),
					filename: entry.name,
					category: category.folder,
					topic: category.topic,
					status: 'error',
					error: error.message,
					canChooseCover: error.code === 'INVALID_COVER',
				});
			}
		}
	}
	return articles.sort((a, b) => a.category.localeCompare(b.category, 'zh-CN') || (a.title || a.filename).localeCompare(b.title || b.filename, 'zh-CN'));
}

export async function listCoverImages(sourceRoot) {
	await validateSourceLibrary(sourceRoot);
	const entries = await fs.readdir(path.join(sourceRoot, '_attachments'), { withFileTypes: true });
	return entries.filter((entry) => entry.isFile() && imageExtensions.has(path.extname(entry.name).toLowerCase()))
		.map((entry) => entry.name)
		.sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

export async function prepareSourcePackage({ sourceFile, sourceRoot, repoRoot, translationSettings, coverFile }) {
	await validateSourceLibrary(sourceRoot);
	await validateRepository(repoRoot);
	const { category, absoluteSource } = await locateSourceFile(sourceFile, sourceRoot);
	const inspected = await inspectSource({ sourceFile: absoluteSource, sourceRoot, repoRoot, category, selectedCoverFile: coverFile });
	if (inspected.status === 'synced') throw new Error('这篇文章已经与网站同步，没有需要发布的变化。');
	if (inspected.charCount < 500) throw new Error('中文正文少于 500 个非空白字符，请先完成文章再发布。');

	let slug = inspected.data.slug || inspected.data.articleId;
	if (!isSlug(slug)) slug = await createSlug(inspected.title, inspected.fallbackSlug, translationSettings);
	const articleId = isSlug(inspected.data.articleId) ? inspected.data.articleId : slug;
	const destinationDir = path.join(repoRoot, 'src', 'content', 'essays', articleId);
	const destinationExists = await exists(destinationDir);
	const published = destinationExists ? await readPublishedMetadata(destinationDir) : null;
	if (published && inspected.data.articleId && published.articleId !== articleId) throw new Error('Obsidian 元数据与网站文章编号不一致。');

	const today = isoDate(new Date());
	const pubDate = normalizeDate(inspected.data.pubDate) || normalizeDate(published?.pubDate) || today;
	const updatedDate = destinationExists ? today : undefined;
	const kind = ['essay', 'note'].includes(inspected.data.kind) ? inspected.data.kind : 'essay';
	const stage = ['seed', 'growing', 'evergreen'].includes(inspected.data.stage) ? inspected.data.stage : 'growing';
	const featured = inspected.data.featured === true;
	const draft = inspected.data.draft === true;
	const coverAlt = String(inspected.data.coverAlt || inspected.coverAlt).trim();
	const metadata = {
		articleId,
		slug,
		title: inspected.title,
		description: inspected.description,
		pubDate,
		updatedDate,
		draft,
		kind,
		stage,
		topic: category.topic,
		featured,
		coverImage: `./images/${inspected.coverName}`,
		coverAlt,
		sourceHash: inspected.sourceHash,
	};

	return {
		articleId,
		destinationExists,
		sourceFile: absoluteSource,
		sourceText: inspected.sourceText,
		metadata,
		coverFile: inspected.coverFile,
		zhDocument: buildChineseDocument(metadata, inspected.rewrittenBody),
		rewrittenBody: inspected.rewrittenBody,
		images: inspected.images,
	};
}

export async function writePreparedInbox(prepared, inboxRoot) {
	const packageDir = path.join(inboxRoot, prepared.articleId);
	await fs.mkdir(path.join(packageDir, 'images'), { recursive: true });
	await fs.writeFile(path.join(inboxRoot, '.blog-publish-inbox'), 'Created by Cognitive Iteration Publisher.\n', 'utf8');
	await fs.writeFile(path.join(packageDir, 'zh.md'), prepared.zhDocument, 'utf8');
	for (const image of prepared.images) await fs.writeFile(path.join(packageDir, 'images', image.outputName), image.buffer);
	return packageDir;
}

export async function writeSourceMetadata(prepared) {
	const updates = {
		articleId: prepared.metadata.articleId,
		slug: prepared.metadata.slug,
		pubDate: prepared.metadata.pubDate,
		sourceHash: prepared.metadata.sourceHash,
	};
	if (prepared.coverFile) updates.coverFile = prepared.coverFile;
	if (prepared.metadata.updatedDate) updates.updatedDate = prepared.metadata.updatedDate;
	const updated = upsertFrontmatter(prepared.sourceText, updates);
	const temporaryPath = `${prepared.sourceFile}.blog-publisher-${process.pid}.tmp`;
	await fs.writeFile(temporaryPath, updated, 'utf8');
	await fs.rename(temporaryPath, prepared.sourceFile);
}

export function parseSourceMarkdown(text, filename = '文章.md') {
	const normalized = normalizeNewlines(String(text)).replace(/^\uFEFF/, '');
	const parsed = parseFrontmatter(normalized);
	let body = parsed.body.trim();
	const firstHeading = body.match(/^#\s+(.+)\s*$/m);
	const filenameTitle = path.basename(filename, path.extname(filename)).replace(/^\d+[.、．]\s*/, '');
	const title = cleanInlineText(parsed.data.title || firstHeading?.[1] || filenameTitle);
	if (!title) throw new Error('文章缺少标题。请填写 title、一级标题或有意义的文件名。');
	if (firstHeading && cleanInlineText(firstHeading[1]) === title) {
		body = `${body.slice(0, firstHeading.index)}${body.slice(firstHeading.index + firstHeading[0].length)}`.trim();
	}
	if (!body) throw new Error('文章正文为空。');
	body = normalizeArticleMarkdown(body);
	const description = articleDescription(body, parsed.data.description);
	if (!description) throw new Error('无法生成文章描述，请在正文开头写一个完整段落。');
	return { data: parsed.data, body, title, description, sourceText: normalized };
}

export function extractImageReferences(body) {
	const references = [];
	const pattern = /!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
	for (const match of body.matchAll(pattern)) {
		if (match[1]) references.push({ raw: match[0], source: match[1].trim(), alt: obsidianAlt(match[2]), wiki: true });
		else references.push({ raw: match[0], source: match[4].trim(), alt: cleanInlineText(match[3] || '') || null, wiki: false });
	}
	return references;
}

export function upsertFrontmatter(text, updates) {
	const normalized = normalizeNewlines(String(text)).replace(/^\uFEFF/, '');
	const parsed = parseFrontmatter(normalized);
	const lines = parsed.hasFrontmatter ? parsed.rawFrontmatter.split('\n') : [];
	for (const [key, value] of Object.entries(updates)) {
		const rendered = `${key}: ${yamlString(value)}`;
		const index = lines.findIndex((line) => new RegExp(`^${escapeRegex(key)}\\s*:`).test(line));
		if (index >= 0) lines[index] = rendered;
		else lines.push(rendered);
	}
	return `---\n${lines.join('\n')}\n---\n\n${parsed.body.trim()}\n`;
}

async function inspectSource({ sourceFile, sourceRoot, repoRoot, category, selectedCoverFile }) {
	const sourceText = await fs.readFile(sourceFile, 'utf8');
	const parsed = parseSourceMarkdown(sourceText, sourceFile);
	const coverFile = selectedCoverFile === undefined ? parsed.data.coverFile : selectedCoverFile;
	if (selectedCoverFile === '') throw new Error('请先选择文章封面。');
	let coverImage = null;
	let coverAlt = null;
	if (coverFile) {
		if (typeof coverFile !== 'string') throw invalidCover('封面文件名无效。');
		if (coverFile === '@default') {
			const defaultCover = path.join(repoRoot, 'src', 'assets', 'images', 'home', category.cover);
			if (!(await exists(defaultCover))) throw invalidCover(`网站缺少默认封面：${category.cover}`);
			coverImage = { sourcePath: defaultCover, outputName: 'cover.webp', buffer: await fs.readFile(defaultCover), isDefault: true };
			coverAlt = category.coverAlt;
		} else {
			const coverPath = await resolveCoverFile(coverFile, sourceRoot);
			const extension = path.extname(coverPath).toLowerCase();
			coverImage = { sourcePath: coverPath, outputName: `cover${extension}`, buffer: await fs.readFile(coverPath) };
			coverAlt = `《${parsed.title}》的文章封面。`;
		}
	}
	const references = extractImageReferences(parsed.body);
	const resolved = [];
	const uniqueImages = new Map();
	for (const reference of references) {
		if (/^(?:https?:)?\/\//i.test(reference.source)) {
			resolved.push({ ...reference, external: true });
			continue;
		}
		const imagePath = await resolveAttachment(reference.source, sourceFile, sourceRoot);
		const imageKey = path.resolve(imagePath);
		if (coverImage && imageKey === path.resolve(coverImage.sourcePath)) {
			resolved.push({ ...reference, sourcePath: imagePath, omitFromBody: true });
			continue;
		}
		let image = uniqueImages.get(imageKey);
		if (!image) {
			const extension = path.extname(imagePath).toLowerCase();
			const outputName = coverImage ? `image-${String(uniqueImages.size + 1).padStart(2, '0')}${extension}` :
				uniqueImages.size === 0 ? `cover${extension}` : `image-${String(uniqueImages.size).padStart(2, '0')}${extension}`;
			image = { sourcePath: imagePath, outputName, buffer: await fs.readFile(imagePath) };
			uniqueImages.set(imageKey, image);
		}
		resolved.push({ ...reference, image });
	}

	const images = coverImage ? [coverImage, ...uniqueImages.values()] : [...uniqueImages.values()];
	let coverName;
	if (coverImage) {
		coverName = coverImage.outputName;
	} else if (images.length === 0) {
		const defaultCover = path.join(repoRoot, 'src', 'assets', 'images', 'home', category.cover);
		if (!(await exists(defaultCover))) throw new Error(`网站缺少默认封面：${category.cover}`);
		coverName = 'cover.webp';
		coverAlt = category.coverAlt;
		images.push({ sourcePath: defaultCover, outputName: coverName, buffer: await fs.readFile(defaultCover), isDefault: true });
	} else {
		coverName = images[0].outputName;
		coverAlt = resolved.find((item) => item.image === images[0])?.alt || `《${parsed.title}》的文章封面。`;
	}

	let referenceIndex = 0;
	const rewrittenBody = parsed.body.replace(/!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g, (raw) => {
		const reference = resolved[referenceIndex++];
		if (reference.omitFromBody) return '';
		const alt = reference.alt || `《${parsed.title}》的文章插图。`;
		if (reference.external) return `![${escapeMarkdownAlt(alt)}](${reference.source})`;
		return `![${escapeMarkdownAlt(alt)}](./images/${reference.image.outputName})`;
	});

	const hash = crypto.createHash('sha256');
	hash.update(JSON.stringify({
		title: parsed.title,
		description: parsed.description,
		body: rewrittenBody,
		kind: parsed.data.kind || 'essay',
		stage: parsed.data.stage || 'growing',
		featured: parsed.data.featured === true,
		topic: category.topic,
		...(coverFile ? { coverFile } : {}),
	}));
	for (const image of images) hash.update(image.buffer);
	const sourceHash = hash.digest('hex');
	const fallbackSlug = fallbackArticleId(parsed.title, normalizeDate(parsed.data.pubDate) || isoDate(new Date()));
	const articleId = isSlug(parsed.data.articleId) ? parsed.data.articleId : (isSlug(parsed.data.slug) ? parsed.data.slug : fallbackSlug);
	const publishedPath = path.join(repoRoot, 'src', 'content', 'essays', articleId, 'zh.md');
	const publishedText = await readOptional(publishedPath);
	const publishedData = publishedText ? parseFrontmatter(normalizeNewlines(publishedText)).data : null;
	const status = !publishedText ? 'new' : publishedData?.sourceHash === sourceHash ? 'synced' : 'updated';

	return {
		filename: path.basename(sourceFile),
		category: category.folder,
		topic: category.topic,
		title: parsed.title,
		description: parsed.description,
		charCount: plainTextLength(parsed.body),
		imageCount: uniqueImages.size,
		coverSource: coverImage ? (coverFile === '@default' ? `默认封面：${category.cover}` : coverFile) :
			uniqueImages.size ? path.basename(images[0].sourcePath) : `默认封面：${category.cover}`,
		coverFile: coverFile || null,
		coverInBody: coverImage ? resolved.some((item) => item.omitFromBody) : uniqueImages.size > 0,
		referencedImageFiles: [...new Set(resolved.filter((item) => !item.external)
			.map((item) => path.basename(item.sourcePath || item.image.sourcePath)))],
		coverName,
		coverAlt,
		status,
		sourceHash,
		fallbackSlug,
		data: parsed.data,
		sourceText: parsed.sourceText,
		rewrittenBody,
		images,
	};
}

async function locateSourceFile(relativePath, sourceRoot) {
	if (typeof relativePath !== 'string' || !relativePath.toLowerCase().endsWith('.md')) throw new Error('无效的文章路径。');
	const absoluteSource = path.resolve(sourceRoot, ...relativePath.split('/'));
	assertInside(sourceRoot, absoluteSource, '文章路径');
	const relative = path.relative(sourceRoot, absoluteSource).split(path.sep);
	const category = categoryDefinitions.find((item) => item.folder === relative[0]);
	if (!category || relative.length !== 2) throw new Error('只能发布三个分类文件夹第一层中的 Markdown 文件。');
	await rejectSymbolicLink(absoluteSource, '文章文件');
	return { category, absoluteSource };
}

async function resolveAttachment(source, sourceFile, sourceRoot) {
	let decoded;
	try { decoded = decodeURIComponent(source.replace(/^<|>$/g, '')); } catch { decoded = source; }
	const attachmentsRoot = path.join(sourceRoot, '_attachments');
	const candidates = [path.resolve(path.dirname(sourceFile), decoded), path.resolve(attachmentsRoot, path.basename(decoded))];
	const imagePath = candidates.find((candidate) => isInside(attachmentsRoot, candidate));
	if (!imagePath || !(await exists(imagePath))) throw new Error(`找不到引用图片：${source}`);
	if (path.dirname(imagePath).toLowerCase() !== path.resolve(attachmentsRoot).toLowerCase()) throw new Error(`图片必须直接放在 _attachments：${source}`);
	const extension = path.extname(imagePath).toLowerCase();
	if (!imageExtensions.has(extension)) throw new Error(`不支持的图片格式：${source}`);
	await rejectSymbolicLink(imagePath, `图片 ${source}`);
	return imagePath;
}

async function resolveCoverFile(filename, sourceRoot) {
	if (typeof filename !== 'string' || !filename || filename === '.' || filename === '..' ||
		filename.includes('/') || filename.includes('\\') || !imageExtensions.has(path.extname(filename).toLowerCase())) {
		throw invalidCover('封面必须是 _attachments 中的图片文件名。');
	}
	const imagePath = path.join(sourceRoot, '_attachments', filename);
	if (!(await exists(imagePath))) throw invalidCover(`找不到封面图片：${filename}`);
	const stat = await fs.lstat(imagePath);
	if (!stat.isFile() || stat.isSymbolicLink()) throw invalidCover(`封面必须是普通图片文件：${filename}`);
	return imagePath;
}

function invalidCover(message) {
	const error = new Error(message);
	error.code = 'INVALID_COVER';
	return error;
}

export async function readCoverImage(sourceRoot, filename) {
	await validateSourceLibrary(sourceRoot);
	const imagePath = await resolveCoverFile(filename, sourceRoot);
	const contentType = {
		'.avif': 'image/avif', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
		'.png': 'image/png', '.webp': 'image/webp',
	}[path.extname(imagePath).toLowerCase()];
	return { contentType, buffer: await fs.readFile(imagePath) };
}

async function createSlug(title, fallback, translationSettings) {
	const filenameCandidate = slugifyAscii(title);
	if (isSlug(filenameCandidate) && filenameCandidate.length >= 5) return filenameCandidate;
	try {
		const answer = await requestJson(translationSettings, {
			prompt: `Create a concise English URL slug for this Chinese article title. Return JSON only: {"slug":"lowercase-kebab-case"}. Use 3 to 8 meaningful words, ASCII letters and digits only. Title: ${title}`,
			maxTokens: 80,
			temperature: 0,
		});
		if (isSlug(answer.slug)) return answer.slug;
	} catch {
		// Full translation will surface provider or credential errors. A stable fallback keeps the path portable.
	}
	return fallback;
}

async function readPublishedMetadata(destinationDir) {
	const text = await readOptional(path.join(destinationDir, 'zh.md'));
	if (!text) return null;
	return parseFrontmatter(normalizeNewlines(text)).data;
}

export function buildChineseDocument(data, body) {
	const lines = [
		'---',
		`articleId: ${yamlString(data.articleId)}`,
		'locale: zh',
		`slug: ${yamlString(data.slug)}`,
		`title: ${yamlString(data.title)}`,
		`description: ${yamlString(data.description)}`,
		`pubDate: ${yamlString(data.pubDate)}`,
	];
	if (data.updatedDate) lines.push(`updatedDate: ${yamlString(data.updatedDate)}`);
	lines.push(
		`sourceHash: ${yamlString(data.sourceHash)}`,
		`draft: ${data.draft}`,
		`kind: ${data.kind}`,
		`stage: ${data.stage}`,
		'topics:',
		`  - ${data.topic}`,
		`featured: ${data.featured}`,
		`coverImage: ${yamlString(data.coverImage)}`,
		`coverAlt: ${yamlString(data.coverAlt)}`,
		'---',
		'',
		body.trim(),
		'',
	);
	return lines.join('\n');
}

function parseFrontmatter(text) {
	if (!text.startsWith('---\n')) return { data: {}, body: text, hasFrontmatter: false, rawFrontmatter: '' };
	const closing = text.indexOf('\n---\n', 4);
	if (closing < 0) throw new Error('frontmatter 没有正确结束。');
	const rawFrontmatter = text.slice(4, closing);
	const data = {};
	for (const line of rawFrontmatter.split('\n')) {
		const match = line.match(/^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/);
		if (!match || !scalarFields.has(match[1])) continue;
		data[match[1]] = parseScalar(match[2]);
	}
	return { data, body: text.slice(closing + 5), hasFrontmatter: true, rawFrontmatter };
}

function parseScalar(value) {
	const trimmed = value.trim();
	if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) return trimmed.slice(1, -1).replace(/''/g, "'");
	if (trimmed === 'true') return true;
	if (trimmed === 'false') return false;
	return trimmed;
}

function cleanInlineText(value) {
	return String(value || '')
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
		.replace(/[*_`>#~]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

function obsidianAlt(value) {
	const parts = String(value || '').split('|').map((item) => cleanInlineText(item)).filter(Boolean);
	return parts.find((item) => !/^\d+(?:x\d+)?$/i.test(item)) || null;
}

function plainTextLength(value) {
	return cleanInlineText(value).replace(/\s+/g, '').length;
}

function fallbackArticleId(title, date) {
	return `essay-${date.replaceAll('-', '')}-${crypto.createHash('sha256').update(title).digest('hex').slice(0, 8)}`;
}

function slugifyAscii(value) {
	return String(value).normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

function normalizeDate(value) {
	const match = String(value || '').match(/^(\d{4}-\d{2}-\d{2})/);
	return match?.[1] || null;
}

function isoDate(date) {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

function isSlug(value) { return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(value || '')); }
function yamlString(value) { return `'${String(value).replace(/'/g, "''")}'`; }
function normalizeNewlines(value) { return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n*$/, '\n'); }
function escapeMarkdownAlt(value) { return String(value).replace(/\]/g, '\\]'); }
function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function assertAbsolutePath(value, label) { if (!value || !path.isAbsolute(value)) throw new Error(`${label}必须填写绝对路径。`); }
function isInside(parent, child) { const relative = path.relative(path.resolve(parent), path.resolve(child)); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); }
function assertInside(parent, child, label) { if (!isInside(parent, child)) throw new Error(`${label}超出允许目录。`); }
async function rejectSymbolicLink(target, label) { const stat = await fs.lstat(target); if (stat.isSymbolicLink()) throw new Error(`${label}不能是符号链接。`); }
async function readOptional(target) { try { return await fs.readFile(target, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function exists(target) { try { await fs.access(target); return true; } catch { return false; } }
