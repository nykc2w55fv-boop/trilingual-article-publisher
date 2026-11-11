import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createMarkdownProcessor } from '@astrojs/markdown-remark';
import {
	applyMobileLayout, applyValidMobileLayout, assertMobileLayoutAgreement, breakMarker, eligibleParagraphs,
	emphasisOpen, mobileLayoutSignature, stripMobileLayout,
} from '../lib/mobile-layout.mjs';
import { renderLayoutPreviewHtml } from '../lib/preview-html.mjs';

function withoutNumberMarkup(html) {
	return html.replace(/<span class="article-number-group[^"]*">([^<]*)<span class="article-number">([^<]*)<\/span><\/span>/g, '$1$2');
}

test('发布器预览采用文章数字样式且保留链接地址和预览文本', () => {
	const html = renderLayoutPreviewHtml('## 从1.330到1.420\n\n涨幅3.12%，[报告50](https://example.com/2026/50)。');
	assert.match(html, /has-leader">到<span class="article-number">1\.420<\/span>/);
	assert.match(html, /class="article-number">3\.12%<\/span>/);
	assert.match(html, /href="https:\/\/example\.com\/2026\/50"/);
	assert.ok(!html.includes('example.com/<span'));
});

test('只在普通正文加入手机标记，原文字词和标点逐字一致', () => {
	const source = '## 标题\n\n这是作者的第一句。第二句保留原样。\n\n已有**作者加粗**。\n\n`代码`、[链接](https://example.com)和表格不应改动。';
	assert.deepEqual(eligibleParagraphs(source).map((item) => item.index), [1]);
	const formatted = applyMobileLayout(source, {
		emphasis: [{ paragraph: 1, text: '第一句' }],
		breaks: [{ paragraph: 1, after: '这是作者的第一句。' }],
	});
	assert.equal(stripMobileLayout(formatted), source);
	assert.equal(mobileLayoutSignature(formatted), 'EB');
	assert.ok(formatted.includes(`${emphasisOpen}第一句</span>。${breakMarker}第二句`));
	assert.ok(formatted.includes('已有**作者加粗**。'));
	const sameBoundary = applyMobileLayout('一句完整的话。后面还有一句。', {
		emphasis: [{ paragraph: 0, text: '一句完整的话。' }],
		breaks: [{ paragraph: 0, after: '一句完整的话。' }],
	});
	assert.ok(sameBoundary.includes('一句完整的话。</span>' + breakMarker + '后面'));
});

test('拒绝改词、歧义锚点和 Markdown 结构中的排版建议', () => {
	const source = '重复。重复。后续。\n\n| 列一 | 列二 |';
	assert.throws(() => applyMobileLayout(source, { emphasis: [{ paragraph: 0, text: '重复' }], breaks: [] }), /唯一/);
	assert.throws(() => applyMobileLayout(source, { emphasis: [{ paragraph: 1, text: '列一' }], breaks: [] }), /受保护/);
	assert.throws(() => applyMobileLayout(source, { emphasis: [], breaks: [{ paragraph: 0, after: '重复' }] }), /唯一/);
	assert.throws(() => applyMobileLayout(source, { emphasis: [], breaks: [{ paragraph: 0, after: '后续。' }] }), /句末/);
	assert.throws(() => applyMobileLayout(source, { emphasis: [{ paragraph: 0, text: '模型新写的字' }], breaks: [] }), /唯一/);
});

test('错行建议无效时保留同批有效加粗，并给出跳过原因', () => {
	const source = '第一句有重点。第二句保留。';
	const result = applyValidMobileLayout(source, {
		emphasis: [{ paragraph: 0, text: '有重点' }],
		breaks: [{ paragraph: 0, after: '第二句保留。' }],
	});
	assert.equal(result.count, 1);
	assert.equal(result.skippedCount, 1);
	assert.match(result.skippedReasons[0], /句末/);
	assert.equal(result.body, `第一句${emphasisOpen}有重点</span>。第二句保留。`);
	assert.equal(stripMobileLayout(result.body), source);
	const rejected = applyValidMobileLayout(source, { emphasis: [], breaks: [{ paragraph: 0, after: '第二句保留。' }] });
	assert.equal(rejected.count, 0);
	assert.equal(rejected.body, source);
});

test('错行落在加粗范围内时预览跳过冲突建议，不生成发布时才报错的嵌套标记', () => {
	const source = '第一句很重要。第二句继续。';
	const proposal = {
		emphasis: [{ paragraph: 0, text: '第一句很重要。第二句' }],
		breaks: [{ paragraph: 0, after: '第一句很重要。' }],
	};
	assert.throws(() => applyMobileLayout(source, proposal), /错行位置与加粗范围冲突/);
	const result = applyValidMobileLayout(source, proposal);
	assert.equal(result.count, 1);
	assert.equal(result.skippedCount, 1);
	assert.match(result.skippedReasons[0], /错行位置与加粗范围冲突/);
	assert.equal(result.body, `${emphasisOpen}第一句很重要。第二句</span>继续。`);
	assert.equal(stripMobileLayout(result.body), source);
	assert.equal(mobileLayoutSignature(result.body), 'E');
});

test('译文必须按顺序保留完整手机标记', () => {
	const source = `原文${emphasisOpen}重点</span>。${breakMarker}下句。`;
	const translated = `Original ${emphasisOpen}point</span>.${breakMarker}Next sentence.`;
	assert.doesNotThrow(() => assertMobileLayoutAgreement(source, translated, 'en'));
	assert.throws(() => assertMobileLayoutAgreement(source, translated.replace(breakMarker, ''), 'en'), /遗漏/);
	assert.throws(() => assertMobileLayoutAgreement(source, translated.replace('mobile-reading-emphasis', 'mobile-reading-other'), 'en'), /遗漏/);
	assert.throws(() => assertMobileLayoutAgreement(source, `${breakMarker}Original ${emphasisOpen}point</span>.`, 'en'), /遗漏/);
	assert.throws(() => assertMobileLayoutAgreement(`第一段。\n\n${source}`, `${translated}\n\nSecond paragraph.`, 'en'), /段落结构/);
});

test('预览对原文 HTML 转义，只渲染固定的手机标记', () => {
	const source = `普通正文。${breakMarker}后续${emphasisOpen}重点</span>。\n\n<img src=x onerror=alert(1)>`;
	const html = renderLayoutPreviewHtml(source);
	assert.ok(html.includes(breakMarker));
	assert.ok(html.includes(`${emphasisOpen}重点</span>`));
	assert.ok(withoutNumberMarkup(html).includes('&lt;img src=x onerror=alert(1)&gt;'));
	assert.ok(!html.includes('<img src=x'));
});

test('发布器预览把普通外链显示为可点击标题，且不执行不安全链接', () => {
	const html = renderLayoutPreviewHtml('**01｜**[**Naval Ravikant**](https://www.youtube.com/@NavalR)\n\n[危险](javascript:alert(1))');
	assert.match(html, /<a class="preview-external-link" href="https:\/\/www\.youtube\.com\/@NavalR" target="_blank" rel="noopener noreferrer"/);
	assert.match(html, /<strong>Naval Ravikant<\/strong><\/a>/);
	assert.ok(!html.includes('<a href="javascript:'));
	assert.ok(withoutNumberMarkup(html).includes('[危险](javascript:alert(1))'));
});

test('网站 Markdown 渲染器保留手机专用标记与可见文字', async () => {
	const body = applyMobileLayout('第一句完整的话。第二句保留原样。', {
		emphasis: [{ paragraph: 0, text: '第一句完整的话' }],
		breaks: [{ paragraph: 0, after: '第一句完整的话。' }],
	});
	const processor = await createMarkdownProcessor();
	const { code } = await processor.render(body);
	assert.ok(code.includes(`${emphasisOpen}第一句完整的话</span>`));
	assert.ok(code.includes(breakMarker));
	assert.equal(stripMobileLayout(body), '第一句完整的话。第二句保留原样。');
});

test('新增标记仅在手机宽度生效，电脑端保持原排版', async () => {
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
	const page = await fs.readFile(path.join(root, 'integrations', 'astro-mobile-reading.css.txt'), 'utf8');
	const preview = await fs.readFile(path.join(root, 'publisher', 'public', 'styles.css'), 'utf8');
	assert.match(page, /\.mobile-reading-break\) \{ display: none;/);
	assert.match(page, /\.mobile-reading-emphasis\) \{ font-weight: inherit;/);
	assert.match(page, /@media \(max-width: 620px\)[^\n]+mobile-reading-break[^\n]+display: block; height: \.8em;[^\n]+mobile-reading-emphasis[^\n]+font-weight: 700;/);
	assert.match(preview, /\.reading-preview \.mobile-reading-break \{ display: none;/);
	assert.match(preview, /\.reading-preview \.mobile-reading-emphasis \{ font-weight: inherit;/);
	assert.match(preview, /\.reading-preview\.mobile \.mobile-reading-break \{ display: block; height: \.8em;/);
	assert.match(preview, /\.reading-preview\.mobile \.mobile-reading-emphasis \{ font-weight: 700;/);
});
