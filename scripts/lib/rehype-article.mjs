import { articleNumberParts } from '../../src/lib/article-numbers.mjs';

export default function rehypeArticle() {
	return (tree, file) => {
		const filename = String(file.path || '');
		const label = /(?:^|[/\\])en\.mdx?$/.test(filename) ? 'Scrollable table' : /zh-hant\.mdx?$/.test(filename) ? '可橫向捲動的表格' : '可横向滚动的表格';
		function walk(parent, heading = false) {
			if (!parent.children) return;
			parent.children = parent.children.flatMap((node) => {
				if (node.type === 'text') return articleNumberParts(node.value, { heading }).map((part) => {
					if (!part.number) return { type: 'text', value: part.text };
					const classes = ['article-number-group'];
					if (part.beforeHan) classes.push('before-han');
					if (part.afterHan) classes.push('after-han');
					if (part.leader) classes.push('has-leader');
					return { type: 'element', tagName: 'span', properties: { className: classes }, children: [
						...(part.leader ? [{ type: 'text', value: part.leader }] : []),
						{ type: 'element', tagName: 'span', properties: { className: ['article-number'] }, children: [{ type: 'text', value: part.text }] },
					] };
				});
				if (node.type === 'element' && node.tagName === 'table') {
					walk(node, heading);
					return [{ type: 'element', tagName: 'div', properties: { className: ['table-scroll'], tabIndex: 0, role: 'region', ariaLabel: label }, children: [node] }];
				}
				if (node.type === 'element' && !['code', 'pre', 'script', 'style', 'svg', 'math'].includes(node.tagName)
					&& !(node.properties?.className || []).includes('katex')) walk(node, heading || /^h[1-6]$/.test(node.tagName));
				return [node];
			});
		}
		walk(tree);
	};
}
