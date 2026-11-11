import assert from 'node:assert/strict';
import test from 'node:test';
import { articleDescription, articleTableShapes, markdownFormattingIssues, normalizeArticleMarkdown } from '../lib/article-markdown.mjs';
import { parseSourceMarkdown } from '../lib/source-content.mjs';
import rehypeArticle from '../../scripts/lib/rehype-article.mjs';
import { articleNumberParts } from '../../src/lib/article-numbers.mjs';
import { createMarkdownProcessor } from '@astrojs/markdown-remark';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

function withoutNumberMarkup(html) {
	return html.replace(/<span class="article-number-group[^"]*">([^<]*)<span class="article-number">([^<]*)<\/span><\/span>/g, '$1$2');
}

test('Obsidian 导入修复表格和正文层级，保留表格每一格的内容', () => {
	const source = String.raw`#### 第一章

##### 第一节

解释：| 名相 | 功能 || \------ | \------ || **即非** | 遣除有执 || 是名 | 不坏假有 |`;
	const body = normalizeArticleMarkdown(source);
	assert.match(body, /^## 第一章/);
	assert.match(body, /### 第一节/);
	assert.match(body, /解释：\n\n\| 名相 \| 功能 \|\n\| ------ \| ------ \|\n\| \*\*即非\*\* \| 遣除有执 \|\n\| 是名 \| 不坏假有 \|/);
	assert.deepEqual(markdownFormattingIssues(body), []);
	assert.equal(normalizeArticleMarkdown(body), body);
	assert.deepEqual(articleTableShapes(body), [[2, 2, 2]]);
});

test('代码示例、未闭合围栏、空单元格和转义竖线保持原样', () => {
	const code = String.raw`\*\*literal\*\* | a || \--- || b |`;
	const input = `## 标题\n\n\`\`\`\`markdown\n${code}\n### code heading\n\`\`\`\`\`\n\n\`${code}\`\n\n| A | B |\n| --- | --- |\n| 空 | |\n| a \\| b | c |\n\n~~~markdown\n${code}`;
	assert.equal(normalizeArticleMarkdown(input), input);
	assert.deepEqual(markdownFormattingIssues(input), []);
});

test('歧义表格停止发布前检查，不猜测或丢弃单元格', () => {
	const input = '| A | B || --- | --- || one | two | extra |';
	assert.equal(normalizeArticleMarkdown(input), input);
	assert.equal(markdownFormattingIssues(input).length, 1);
});

test('成对误转义加粗恢复渲染，数学指令保持不变', () => {
	const body = normalizeArticleMarkdown(String.raw`#### 练习

\*\*应无所住\*\*，信 $\rightarrow$ 解。`);
	assert.match(body, /\*\*应无所住\*\*/);
	assert.ok(body.includes(String.raw`$\rightarrow$`));
});

test('原有文字结构图保留全部标签和缩进，不被正文折叠', () => {
	const input = '## 架构\n\n说明：\n信\n  │\n  └── 解\n';
	const body = normalizeArticleMarkdown(input);
	assert.ok(body.includes('说明：\n\n```text\n信\n  │\n  └── 解\n```'));
	assert.equal(normalizeArticleMarkdown(body), body);
});

test('列表末尾与段落末尾不露出换行符，段内换行保持有效', () => {
	const markdown = normalizeArticleMarkdown('## 正文\n\n* 第一项  \n* 第二项  \n\n第一行  \n第二行  \n');
	assert.ok(markdown.includes('* 第一项\n* 第二项\n\n'));
	assert.ok(markdown.includes('第一行\\\n第二行'));
	assert.ok(!markdown.endsWith('\\'));
});

test('摘要取完整句，跳过表格；长导读不留下半个词或逗号', () => {
	const body = `## 目录\n\n| 标题 | 标题 |\n| --- | --- |\n| a | b |\n\n这是完整的第一句。${'后一段的内容很长，'.repeat(30)}`;
	assert.equal(articleDescription(body), '这是完整的第一句。');
	const english = articleDescription('', 'A complete opening sentence. ' + 'More text follows. '.repeat(20), 'en');
	assert.ok(english.startsWith('A complete opening sentence.'));
	assert.ok(english.endsWith('More text follows.'));
	assert.ok(english.length <= 240);
	assert.match(articleDescription('', 'word '.repeat(70), 'en'), /word…$/);
	const parsed = parseSourceMarkdown(`# 我的文章\n\n#### 正文\n\n这是完整的第一句。${'之后很长，'.repeat(30)}`, '文章.md');
	assert.equal(parsed.title, '我的文章');
	assert.equal(parsed.description, '这是完整的第一句。');
	assert.ok(parsed.body.startsWith('## 正文'));
});

test('表格保留语义并提供可键盘聚焦的横向滚动区域', () => {
	const table = { type: 'element', tagName: 'table', properties: {}, children: [] };
	const tree = { type: 'root', children: [table] };
	rehypeArticle()(tree, { path: '/article/zh-hant.md' });
	const wrapper = tree.children[0];
	assert.equal(wrapper.properties.tabIndex, 0);
	assert.equal(wrapper.properties.ariaLabel, '可橫向捲動的表格');
	assert.equal(wrapper.children[0], table);
});

test('数字排版保留原文，小数、百分比、日期和标题连接词形成短词组', () => {
	const samples = ['从1.330到1.420', '涨了3.12%，日期2026-10-24', 'STAR 50 and GPT-4', '12345678901234567890'];
	for (const source of samples) {
		assert.equal(articleNumberParts(source, { heading: true }).map((part) => `${part.leader || ''}${part.text}`).join(''), source);
	}
	const heading = articleNumberParts('从1.330到1.420', { heading: true }).filter((part) => part.number);
	assert.deepEqual(heading.map((part) => [part.leader, part.text]), [['从', '1.330'], ['到', '1.420']]);
	assert.ok(articleNumberParts('12345678901234567890').every((part) => !part.number));
});

test('文章渲染包装数字但保留标题锚点、链接、代码与公式', async () => {
	const processor = await createMarkdownProcessor({ remarkPlugins: [remarkMath], rehypePlugins: [rehypeKatex, rehypeArticle] });
	const { code } = await processor.render('## 以科创 50 为例，从1.330到1.420\n\n涨幅3.12%，日期2026-10-24。[报告50](https://example.com/2026/50) `x=1.330` $1+2=3$');
	assert.match(code, /<h2 id="以科创-50-为例从1330到1420">/);
	assert.match(code, /class="article-number-group has-leader">到<span class="article-number">1\.420<\/span>/);
	assert.match(code, /class="article-number">3\.12%<\/span>/);
	assert.match(code, /class="article-number">2026-10-24<\/span>/);
	assert.match(code, /href="https:\/\/example\.com\/2026\/50"/);
	assert.match(code, /<code>x=1\.330<\/code>/);
	assert.match(code, /class="katex"/);
});

test('真实 Markdown 渲染器正确显示中文标点中的加粗与导出公式', async () => {
	const source = String.raw`#### 练习

在于\*\*“应无所住”\*\*。信 \$\\rightarrow\$ 解。金额 \$50\$。

解释：| 名相 | 功能 || \------ | \------ || 即非 | 遣除有执 || 是名 | 不坏假有 |`;
	const markdown = normalizeArticleMarkdown(source);
	const processor = await createMarkdownProcessor({ remarkPlugins: [remarkMath], rehypePlugins: [rehypeKatex, rehypeArticle] });
	const { code } = await processor.render(markdown);
	assert.ok(code.includes('<strong>“应无所住”</strong>'));
	assert.ok(code.includes('class="katex"'));
	assert.ok(code.includes('class="table-scroll"'));
	assert.ok(!code.includes('**') && !code.includes('$\\rightarrow$'));
	assert.ok(withoutNumberMarkup(code).includes('$50$'));
	assert.equal(normalizeArticleMarkdown(markdown), markdown);
});
