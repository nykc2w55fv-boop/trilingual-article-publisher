import { requestJson } from './translation-client.mjs';

export const emphasisOpen = '<span class="mobile-reading-emphasis">';
export const breakMarker = '<span class="mobile-reading-break" aria-hidden="true"></span>';
const emphasisClose = '</span>';

export function eligibleParagraphs(body) {
	return String(body).split(/\n\s*\n/).flatMap((block, index) => {
		const text = block.trim();
		// Only plain prose is editable. Markdown structures and existing emphasis stay untouched.
		if (!text || text !== block || text.includes('\n') || text.length > 1200 ||
			/^(?:#{1,6}\s|>|[-*+]\s|\d+[.)]\s|\||```|~~~)/.test(text) ||
			/[\[\]`*_<>\\$|!#~&]/.test(text)) return [];
		return [{ index, text }];
	});
}

export function applyMobileLayout(body, proposal) {
	if (!proposal || !Array.isArray(proposal.emphasis) || !Array.isArray(proposal.breaks)) throw new Error('排版建议格式无效。');
	if (proposal.emphasis.length > 24 || proposal.breaks.length > 24) throw new Error('排版建议过多。');
	const source = String(body);
	const eligible = new Map(eligibleParagraphs(source).map((item) => [item.index, item.text]));
	const blocks = source.split(/(\n\s*\n)/);
	const edits = new Map();
	const emphasisParagraphs = new Set();
	const emphasisRanges = new Map();
	const breakParagraphs = new Set();
	const add = (paragraph, position, value) => {
		const key = Number(paragraph);
		if (!Number.isInteger(key) || !eligible.has(key)) throw new Error('排版建议触及受保护的 Markdown 结构。');
		const bucket = edits.get(key) || [];
		bucket.push({ position, value });
		edits.set(key, bucket);
	};
	for (const item of proposal.emphasis) {
		if (emphasisParagraphs.has(item.paragraph)) throw new Error('同一段落只能选择一处加粗。');
		emphasisParagraphs.add(item.paragraph);
		const text = eligible.get(item.paragraph);
		if (!text) throw new Error('排版建议触及受保护的 Markdown 结构。');
		const phrase = item.text;
		if (typeof phrase !== 'string' || phrase.length < 2 || phrase.length > 80 || !text.includes(phrase) || text.indexOf(phrase) !== text.lastIndexOf(phrase)) throw new Error('加粗位置无法唯一对应原文。');
		const start = text.indexOf(phrase);
		emphasisRanges.set(item.paragraph, { start, end: start + phrase.length });
		add(item.paragraph, start, emphasisOpen);
		add(item.paragraph, start + phrase.length, emphasisClose);
	}
	for (const item of proposal.breaks) {
		if (breakParagraphs.has(item.paragraph)) throw new Error('同一段落只能选择一处错行。');
		breakParagraphs.add(item.paragraph);
		const text = eligible.get(item.paragraph);
		if (!text) throw new Error('排版建议触及受保护的 Markdown 结构。');
		const anchor = item.after;
		if (typeof anchor !== 'string' || !text.includes(anchor) || text.indexOf(anchor) !== text.lastIndexOf(anchor)) throw new Error('错行位置无法唯一对应原文。');
		const end = text.indexOf(anchor) + anchor.length;
		if (end >= text.length || !/[。！？.!?；;：:]$/.test(anchor) || /^[”’"')）】」』，,。！？!?；;：:]/.test(text[end])) throw new Error('错行只能插在完整句末之后。');
		const emphasis = emphasisRanges.get(item.paragraph);
		if (emphasis && emphasis.start < end && end < emphasis.end) throw new Error('错行位置与加粗范围冲突。');
		add(item.paragraph, end, breakMarker);
	}
	let paragraphIndex = 0;
	const formatted = blocks.map((block, index) => {
		if (index % 2) return block;
		const paragraph = paragraphIndex++;
		const bucket = edits.get(paragraph);
		if (!bucket) return block;
		let result = block;
		const priority = (value) => value === emphasisOpen ? 0 : value === breakMarker ? 1 : 2;
		for (const edit of bucket.sort((a, b) => b.position - a.position || priority(a.value) - priority(b.value))) result = result.slice(0, edit.position) + edit.value + result.slice(edit.position);
		return result;
	}).join('');
	if (stripMobileLayout(formatted) !== source) throw new Error('排版建议改变了原文字符，已拒绝。');
	mobileLayoutSignature(formatted);
	return formatted;
}

export function stripMobileLayout(body) {
	return String(body).replaceAll(breakMarker, '').replace(/<span class="mobile-reading-emphasis">([^<>]+)<\/span>/g, '$1');
}

export function mobileLayoutSignature(body) {
	const text = String(body);
	const tokens = [...text.matchAll(/<span class="mobile-reading-emphasis">[^<>]+<\/span>|<span class="mobile-reading-break" aria-hidden="true"><\/span>/g)]
		.map((match) => match[0].includes('mobile-reading-emphasis') ? 'E' : 'B');
	const claimed = text.match(/mobile-reading-(?:emphasis|break)/g) || [];
	if (claimed.length !== tokens.length) throw new Error('排版标记损坏或结构不完整。');
	return tokens.join('');
}

export function assertMobileLayoutAgreement(sourceBody, translatedBody, label) {
	const sourceSignature = mobileLayoutSignature(sourceBody);
	let targetSignature;
	try {
		targetSignature = mobileLayoutSignature(translatedBody);
	} catch (error) {
		error.code = 'MOBILE_LAYOUT_MISMATCH';
		throw error;
	}
	if (sourceSignature !== targetSignature) throw layoutMismatch(`${label} 译文改变或遗漏了排版标记。`);
	if (!sourceSignature) return;
	const sourceBlocks = String(sourceBody).split(/\n\s*\n/).map(mobileLayoutSignature);
	const targetBlocks = String(translatedBody).split(/\n\s*\n/).map(mobileLayoutSignature);
	if (JSON.stringify(sourceBlocks) !== JSON.stringify(targetBlocks)) throw layoutMismatch(`${label} 译文移动了排版标记或改变了段落结构。`);
}

function layoutMismatch(message) {
	const error = new Error(message);
	error.code = 'MOBILE_LAYOUT_MISMATCH';
	return error;
}

export async function suggestMobileLayout(body, settings) {
	const paragraphs = eligibleParagraphs(body);
	if (paragraphs.length === 0) return { body, count: 0, skippedCount: 0, skippedReasons: [] };
	const step = Math.ceil(paragraphs.length / 80);
	const candidates = paragraphs.filter((_item, index) => index % step === 0).slice(0, 80);
	const answer = await requestJson(settings, {
		prompt: `You are selecting mobile-only reading layout for a Chinese essay. Return JSON only: {"emphasis":[{"paragraph":0,"text":"exact original phrase"}],"breaks":[{"paragraph":0,"after":"exact original text ending in sentence punctuation"}]}. Choose sparingly: at most one emphasis and one break per paragraph, at most 24 of each overall. Use exact substrings from the numbered paragraphs. Put breaks only between two complete sentences in the same paragraph, never at a paragraph end or before a closing quotation mark. Do not rewrite, translate, correct, or add any article text. Choose no edits when the prose already reads well. The code will reject ambiguous or modified substrings. Paragraphs:\n${JSON.stringify(candidates)}`,
		maxTokens: 1800,
		temperature: 0,
	});
	return applyValidMobileLayout(body, answer);
}

export function applyValidMobileLayout(body, proposal) {
	if (!proposal || !Array.isArray(proposal.emphasis) || !Array.isArray(proposal.breaks)) throw new Error('排版建议格式无效。');
	const accepted = { emphasis: [], breaks: [] };
	const skipped = [];
	for (const kind of ['emphasis', 'breaks']) {
		const limit = 24;
		for (const item of proposal[kind]) {
			if (accepted[kind].length >= limit) { skipped.push('建议数量超过上限'); continue; }
			const candidate = { ...accepted, [kind]: [...accepted[kind], item] };
			try {
				applyMobileLayout(body, candidate);
				accepted[kind].push(item);
			} catch (error) {
				skipped.push(error.message);
			}
		}
	}
	return {
		body: applyMobileLayout(body, accepted),
		count: accepted.emphasis.length + accepted.breaks.length,
		skippedCount: skipped.length,
		skippedReasons: [...new Set(skipped)].slice(0, 3),
	};
}
