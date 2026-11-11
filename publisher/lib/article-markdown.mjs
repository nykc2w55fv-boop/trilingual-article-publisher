// Shared by Obsidian imports, translated packages, and the article preflight.
// Only repair recognizable formatting; leave code and article wording intact.
export function normalizeArticleMarkdown(value) {
	const protectedParts = [];
	let text = String(value).replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
	const protect = (part) => `\uE000${protectedParts.push(part) - 1}\uE001`;
	text = protectCode(text, protect);
	text = text.replace(/\\\*\\\*([^\n]+?)\\\*\\\*/g, '**$1**');
	// CommonMark needs a boundary when bold text opens/closes with punctuation.
	text = text.replace(/\*\*([^\n*]+?)\*\*/g, (match, content, offset, source) => {
		const before = source[offset - 1] || '';
		const after = source[offset + match.length] || '';
		const left = /\p{P}/u.test(content[0]) && /[\p{L}\p{N}]/u.test(before) ? ' ' : '';
		const right = /\p{P}/u.test(content.at(-1)) && /[\p{L}\p{N}]/u.test(after) ? ' ' : '';
		return `${left}${match}${right}`;
	});
	// Repair exported LaTeX only when an escaped dollar pair contains a command.
	text = text.replace(/\\\$([^\n$]+?)\\\$/g, (match, formula) => /\\[A-Za-z]+/.test(formula) ? `$${formula.replace(/\\\\(?=[A-Za-z])/g, '\\')}$` : match);
	text = text.split('\n').map(repairTableLine).join('\n');
	text = text.split(/\n\s*\n/).map((block) => {
		const lines = block.split('\n');
		const first = lines.findIndex((line) => /[└├│]|─{3}/.test(line));
		if (first < 0 || !/[└├]/.test(block) || /\uE000/.test(block)) return block;
		const start = Math.max(0, first - 1);
		const introduction = lines.slice(0, start).join('\n');
		const diagram = lines.slice(start).map((line) => line.replace(/\s+$/, '')).join('\n').replace(/\n+$/, '');
		return `${introduction ? `${introduction}\n\n` : ''}\`\`\`text\n${diagram}\n\`\`\``;
	}).join('\n\n');
	// A hard break at a list-item/paragraph boundary becomes a literal slash.
	// Preserve actual in-paragraph breaks; trim spaces at block boundaries.
	const lines = text.split('\n');
	text = lines.map((line, index) => {
		if (!/ {2,}$/.test(line)) return line;
		const next = lines[index + 1]?.trim() || '';
		const continues = next && !/^(?:#{1,6}\s|```|~~~|>|[-*+]\s|\d+[.)]\s|\|)/.test(next);
		return line.replace(/ {2,}$/, continues ? '\\' : '');
	}).join('\n');
	const depths = [...text.matchAll(/^ {0,3}(#{1,6})\s+\S/gm)].map((match) => match[1].length);
	const shallowest = depths.length ? Math.min(...depths) : 2;
	// The page owns h1; keep relative subsection levels starting at h2.
	const shift = 2 - shallowest;
	text = text.replace(/^( {0,3})(#{1,6})(\s+.+)$/gm, (_all, indent, hashes, title) => `${indent}${'#'.repeat(Math.min(6, hashes.length + shift))}${title}`);
	text = text.replace(/\uE000(\d+)\uE001/g, (_all, index) => protectedParts[Number(index)]);
	return text.trim();
}

function repairTableLine(line) {
	const firstPipe = line.search(/(?<!\\)\|/);
	if (firstPipe < 0) return line;
	const prefix = line.slice(0, firstPipe).trimEnd();
	const candidate = line.slice(firstPipe).trim();
	if (!candidate.endsWith('|')) return line;
	const rows = candidate.split(/(?<!\\)\|\s*\|/).map(tableCells);
	if (rows.length >= 3 && rows[0].length > 1 && rows[1].every(isDivider)) {
		if (!rows.every((row) => row.length === rows[0].length)) return line;
		rows[1] = rows[1].map((cell) => cell.replaceAll('\\', ''));
		return `${prefix ? `${prefix}\n\n` : ''}${rows.map((cells) => `| ${cells.join(' | ')} |`).join('\n')}\n`;
	}
	// Some rich-text exports escape the dash in an otherwise valid divider.
	const cells = tableCells(candidate);
	if (!prefix && cells.length > 1 && cells.every(isDivider)) return `| ${cells.map((cell) => cell.replaceAll('\\', '')).join(' | ')} |`;
	return line;
}

function tableCells(row) {
	return row.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((cell) => cell.trim());
}

function isDivider(cell) { return /^:?(?:\\?-){3,}:?$/.test(cell.trim()); }

function protectCode(text, protect) {
	const lines = text.split('\n');
	const output = [];
	for (let index = 0; index < lines.length; index += 1) {
		const opening = lines[index].match(/^ {0,3}(`{3,}|~{3,})/);
		if (!opening) { output.push(lines[index]); continue; }
		const code = [lines[index]];
		while (++index < lines.length) {
			code.push(lines[index]);
			const closing = lines[index].match(/^ {0,3}(`+|~+)[ \t]*$/);
			if (closing && closing[1][0] === opening[1][0] && closing[1].length >= opening[1].length) break;
		}
		output.push(protect(code.join('\n')));
	}
	return output.join('\n').replace(/(`+)[^\n]*?\1/g, protect);
}

export function cleanArticleText(value) {
	return String(value || '')
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
		.replace(/\\([*_`#~.])/g, '$1')
		.replace(/[*_`>#~]/g, '')
		.replace(/\s+/g, ' ').trim();
}

export function articleDescription(body, supplied = '', locale = 'zh') {
	if (supplied) return completeExcerpt(cleanArticleText(supplied), locale);
	for (const block of String(body).split(/\n\s*\n/)) {
		const text = block.trim();
		if (!text || /^(?:#{1,6}\s|```|~~~|>|[-*+]\s|\d+\.\s|!\[|\||\uE000)/.test(text) || /[└├│]/.test(text)) continue;
		const excerpt = completeExcerpt(cleanArticleText(text), locale);
		if (excerpt) return excerpt;
	}
	return '';
}

function completeExcerpt(text, locale) {
	const limit = locale === 'en' ? 240 : 100;
	if (text.length <= limit && /[。！？.!?][”’"')）]*$/.test(text)) return text;
	const sentences = text.match(/[^。！？.!?]+[。！？.!?][”’"')）]*/g) || [];
	let result = '';
	for (const sentence of sentences) {
		if ((result + sentence).length > limit) break;
		result += sentence;
	}
	if (result.trim()) return result.trim();
	// Avoid breaking a word or leaving a comma/colon at the end of the deck.
	let excerpt = text.slice(0, limit);
	if (locale === 'en') excerpt = excerpt.replace(/\s+\S*$/, '');
	return `${excerpt.replace(/[，,；;：:\s]+$/, '')}…`;
}

export function markdownFormattingIssues(body) {
	const text = protectCode(String(body), () => '');
	const issues = [];
	if (/\|[^\n]*\|[ \t]*\|[ \t]*\\?-{3,}/.test(text)) issues.push('表格行被挤在同一行，请把表头、分隔线和每行内容分别换行。');
	const headings = [...text.matchAll(/^ {0,3}(#{1,6})\s/gm)].map((match) => match[1].length);
	if (headings.length && Math.min(...headings) !== 2) issues.push('正文标题应从二级（##）开始；页面会显示文章主标题。');
	return issues;
}

export function articleTableShapes(body) {
	const lines = protectCode(String(body), () => '').split('\n');
	const tables = [];
	for (let index = 1; index < lines.length; index += 1) {
		if (!lines[index].includes('|') || !lines[index - 1].includes('|')) continue;
		const divider = tableCells(lines[index]);
		const header = tableCells(lines[index - 1]);
		if (divider.length < 2 || !divider.every(isDivider) || divider.length !== header.length) continue;
		const shape = [header.length];
		while (index + 1 < lines.length && lines[index + 1].trim() && lines[index + 1].includes('|')) shape.push(tableCells(lines[++index]).length);
		tables.push(shape);
	}
	return tables;
}
