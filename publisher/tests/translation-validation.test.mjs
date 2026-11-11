import assert from 'node:assert/strict';
import test from 'node:test';
import { requestWithLayoutRetry, restoreMissingFencedBlock, splitMarkdownForTranslation, translateBodyInChunks } from '../lib/translation-validation.mjs';
import { assertMobileLayoutAgreement, breakMarker, emphasisOpen } from '../lib/mobile-layout.mjs';

const source = `原文${emphasisOpen}重点</span>。${breakMarker}下句。`;
const valid = `Original ${emphasisOpen}point</span>.${breakMarker}Next sentence.`;

test('排版标记遗漏时只重新生成一次，并校验第二份译文', async () => {
	let calls = 0;
	let retries = 0;
	const result = await requestWithLayoutRetry(
		async () => ++calls === 1 ? valid.replace(breakMarker, '') : valid,
		(body) => { assertMobileLayoutAgreement(source, body, 'en'); return body; },
		() => retries++,
	);
	assert.equal(result, valid);
	assert.equal(calls, 2);
	assert.equal(retries, 1);
});

test('两次译文均遗漏标记时停止发布并给出原排版选项', async () => {
	let calls = 0;
	await assert.rejects(
		requestWithLayoutRetry(
			async () => { calls++; return valid.replace(breakMarker, ''); },
			(body) => assertMobileLayoutAgreement(source, body, 'en'),
		),
		/已自动重新生成一次.*沿用原排版并发布/,
	);
	assert.equal(calls, 2);
});

test('非排版错误不重新请求模型', async () => {
	let calls = 0;
	await assert.rejects(
		requestWithLayoutRetry(
			async () => { calls++; return valid; },
			() => { throw new Error('译文疑似被摘要'); },
		),
		/译文疑似被摘要/,
	);
	assert.equal(calls, 1);
});

test('Markdown 分段不切开代码围栏、表格或手机排版标记', () => {
	const body = `开头${emphasisOpen}重点</span>。${breakMarker}后一句。\n\n\`\`\`text\nline one\n\nline two\n\`\`\`\n\n| 列甲 | 列乙 |\n| --- | --- |\n| 内容 | 数据 |\n\n结尾段落。`;
	const chunks = splitMarkdownForTranslation(body, 65);
	assert.equal(chunks.join('\n\n'), body);
	assert.ok(chunks.some((chunk) => chunk.includes('line one\n\nline two')));
	assert.ok(chunks.some((chunk) => chunk.includes('| --- | --- |\n| 内容 | 数据 |')));
	assert.ok(chunks[0].includes(`${emphasisOpen}重点</span>。${breakMarker}`));
});

test('独立文本围栏被去掉时恢复原围栏并保留译文内容', () => {
	assert.equal(restoreMissingFencedBlock('```text\n原文第一行\n原文第二行\n```', 'Translated first line\nTranslated second line'), '```text\nTranslated first line\nTranslated second line\n```');
	assert.equal(restoreMissingFencedBlock('~~~markdown\n原文\n~~~', 'Translated'), '~~~markdown\nTranslated\n~~~');
});

test('空译文、已有围栏及非独立围栏不会自动包裹', () => {
	const fenced = '```text\n原文\n```';
	assert.equal(restoreMissingFencedBlock(fenced, ''), '');
	assert.equal(restoreMissingFencedBlock(fenced, '```text\nTranslated\n```'), '```text\nTranslated\n```');
	assert.equal(restoreMissingFencedBlock(`开头\n\n${fenced}`, 'Translated'), 'Translated');
	assert.equal(restoreMissingFencedBlock(`${fenced}\n\n结尾`, 'Translated'), 'Translated');
});

test('程序代码被改写时不恢复围栏', () => {
	const sourceCode = '```js\nconsole.log(1);\n```';
	assert.equal(restoreMissingFencedBlock(sourceCode, 'console.log(2);'), 'console.log(2);');
	assert.equal(restoreMissingFencedBlock(sourceCode, 'console.log(1);'), sourceCode);
});

test('分段翻译在输出截断后缩小该段并按原顺序合并', async () => {
	const sourceBody = ['甲段。'.repeat(9), '乙段。'.repeat(9), '丙段。'.repeat(9), '丁段。'.repeat(9), '戊段。'.repeat(9), '己段。'.repeat(9)].join('\n\n');
	const calls = [];
	let splits = 0;
	const result = await translateBodyInChunks(sourceBody, {
		maxChars: 85,
		request: async (chunk) => {
			calls.push(chunk);
			if (chunk.length > 60) {
				const error = new Error('output cap');
				error.code = 'MODEL_OUTPUT_TRUNCATED';
				throw error;
			}
			return { body: chunk };
		},
		validate: (chunk, translated) => {
			assert.equal(translated.body, chunk);
			return translated.body;
		},
		onSplit: () => splits++,
	});
	assert.equal(result, sourceBody);
	assert.equal(splits, 2);
	assert.ok(calls.some((chunk) => chunk.length > 60));
});

test('不可拆的单个 Markdown 块截断时明确停止', async () => {
	const sourceBody = '连续正文'.repeat(800);
	await assert.rejects(
		translateBodyInChunks(sourceBody, {
			request: async () => { const error = new Error('output cap'); error.code = 'MODEL_OUTPUT_TRUNCATED'; throw error; },
			validate: () => { throw new Error('should not validate'); },
		}),
		/单个 Markdown 段落或代码块仍超出模型输出额度/,
	);
});

test('超长纯文本段落可按完整句子缩小分段', async () => {
	const sourceBody = '完整句子。'.repeat(12);
	const result = await translateBodyInChunks(sourceBody, {
		maxChars: 200,
		request: async (chunk) => {
			if (chunk.length > 40) { const error = new Error('output cap'); error.code = 'MODEL_OUTPUT_TRUNCATED'; throw error; }
			return { body: chunk };
		},
		validate: (_chunk, translated) => translated.body,
	});
	assert.equal(result, sourceBody);
});
