import { breakMarker, emphasisOpen } from './mobile-layout.mjs';
import { articleNumberParts } from '../../src/lib/article-numbers.mjs';

const emphasisClose = '</span>';

export function renderLayoutPreviewHtml(body) {
	return String(body).split(/\n\s*\n/).map((block) => {
		const text = block.trim();
		if (!text) return '';
		const heading = text.match(/^(#{2,3})\s+(.+)$/);
		if (heading) return `<h${heading[1].length}>${renderInline(heading[2], true)}</h${heading[1].length}>`;
		if (/^(?:```|~~~|\||>|[-*+]\s|\d+[.)]\s)/.test(text)) return `<pre>${escapeHtml(text)}</pre>`;
		if (/^!\[/.test(text)) return '<p class="preview-image">［正文图片］</p>';
		return `<p>${renderInline(text).replaceAll('\n', '<br>')}</p>`;
	}).join('\n');
}

function renderInline(text, heading = false) {
	const links = /(?<!!)\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
	let result = '';
	let end = 0;
	for (const match of String(text).matchAll(links)) {
		let url;
		try { url = new URL(match[2]); } catch { continue; }
		result += renderInlineText(text.slice(end, match.index), heading);
		result += `<a class="preview-external-link" href="${escapeHtml(url.href)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(url.hostname)} · 在新标签页打开">${renderInlineText(match[1], heading)}</a>`;
		end = match.index + match[0].length;
	}
	return result + renderInlineText(text.slice(end), heading);
}

function renderInlineText(text, heading = false) {
	const html = escapeHtml(text)
		.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
		.replaceAll(escapeHtml(breakMarker), breakMarker)
		.replaceAll(escapeHtml(emphasisOpen), emphasisOpen)
		.replaceAll(escapeHtml(emphasisClose), emphasisClose);
	return html.split(/(<[^>]*>|&(?:#\d+|#x[\da-f]+|[a-z]+);)/gi).map((chunk) => {
		if (chunk.startsWith('<') || chunk.startsWith('&')) return chunk;
		return articleNumberParts(chunk, { heading }).map((part) => {
			if (!part.number) return part.text;
			const classes = ['article-number-group'];
			if (part.beforeHan) classes.push('before-han');
			if (part.afterHan) classes.push('after-han');
			if (part.leader) classes.push('has-leader');
			return `<span class="${classes.join(' ')}">${part.leader}<span class="article-number">${part.text}</span></span>`;
		}).join('');
	}).join('');
}

function escapeHtml(text) {
	return String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
