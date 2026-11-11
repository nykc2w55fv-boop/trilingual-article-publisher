// Presentation-only tokenization. The original Markdown and visible text stay unchanged.
const numberPattern = /\d+(?:[.,:/-]\d+)*(?:[%％])?/g;
const hanPattern = /\p{Script=Han}/u;
const headingLeaders = new Set(['从', '從', '到', '由', '至']);
const maxUnbrokenLength = 16;

export function articleNumberParts(value, { heading = false } = {}) {
	const source = String(value);
	const parts = [];
	let cursor = 0;
	for (const match of source.matchAll(numberPattern)) {
		const number = match[0];
		const start = match.index;
		if (number.length > maxUnbrokenLength) continue;
		const leader = heading && start > cursor && headingLeaders.has(source[start - 1]) ? source[start - 1] : '';
		const tokenStart = start - leader.length;
		if (tokenStart > cursor) parts.push({ text: source.slice(cursor, tokenStart) });
		parts.push({
			number: true,
			text: number,
			leader,
			beforeHan: tokenStart > 0 && hanPattern.test(source[tokenStart - 1]),
			afterHan: hanPattern.test(source[start + number.length] || ''),
		});
		cursor = start + number.length;
	}
	if (cursor < source.length) parts.push({ text: source.slice(cursor) });
	return parts;
}
