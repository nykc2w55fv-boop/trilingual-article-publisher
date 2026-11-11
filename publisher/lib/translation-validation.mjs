export async function requestWithLayoutRetry(request, validate, onRetry = () => {}) {
	for (let attempt = 0; attempt < 2; attempt++) {
		const result = await request(attempt);
		try {
			return validate(result);
		} catch (error) {
			if (error.code !== 'MOBILE_LAYOUT_MISMATCH') throw error;
			if (attempt === 1) {
				throw new Error(`${error.message} 已自动重新生成一次，仍未通过校验。可返回排版预览，选择“沿用原排版并发布”。`, { cause: error });
			}
			onRetry();
		}
	}
}

export const MAX_TRANSLATION_SOURCE_CHARS = 3000;

export function restoreMissingFencedBlock(sourceChunk, translatedBody) {
	const lines = String(sourceChunk).replace(/\r\n?/g, '\n').trim().split('\n');
	if (lines.length < 3) return translatedBody;
	const opening = lines[0].match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
	const closing = lines.at(-1).match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
	if (!opening || !closing || opening[1][0] !== closing[1][0] || opening[1].length > closing[1].length) return translatedBody;
	const translated = String(translatedBody).trim();
	if (!translated || /^ {0,3}(?:`{3,}|~{3,})/m.test(translated)) return translatedBody;
	const language = opening[2].trim().toLowerCase();
	const plainTextFence = !language || /^(?:text|txt|plain|plaintext|md|markdown)$/.test(language);
	if (!plainTextFence && translated !== lines.slice(1, -1).join('\n').trim()) return translatedBody;
	return `${lines[0]}\n${translated}\n${lines.at(-1)}`;
}

export function splitMarkdownForTranslation(body, maxChars = MAX_TRANSLATION_SOURCE_CHARS) {
	const blocks = [];
	let lines = [];
	let fence = null;
	let math = false;
	for (const line of String(body).replace(/\r\n?/g, '\n').split('\n')) {
		const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
		const closingFence = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
		if (!fence && !math && !line.trim()) {
			if (lines.length) blocks.push(lines.join('\n'));
			lines = [];
			continue;
		}
		lines.push(line);
		if (fence) {
			if (closingFence && closingFence[1][0] === fence[0] && closingFence[1].length >= fence.length) fence = null;
		} else if (marker && !math) {
			fence = marker[1];
		} else if (/^\s*\$\$\s*$/.test(line)) {
			math = !math;
		}
	}
	if (lines.length) blocks.push(lines.join('\n'));
	const chunks = [];
	for (const block of blocks) {
		const previous = chunks.at(-1);
		if (previous && previous.length + 2 + block.length <= maxChars) chunks[chunks.length - 1] = `${previous}\n\n${block}`;
		else chunks.push(block);
	}
	return chunks;
}

function splitPlainParagraphAtSentences(body, maxChars) {
	if (/[\n<>\[\]`*_\\$|#~]/.test(body)) return [];
	const sentences = body.match(/[^。！？；!?;]*[。！？；!?;][”’"'）】」』]*/gu) || [];
	if (sentences.join('') !== body || sentences.length < 2 || sentences.some((sentence) => sentence.length > maxChars)) return [];
	const chunks = [];
	for (const sentence of sentences) {
		const previous = chunks.at(-1);
		if (previous && previous.length + sentence.length <= maxChars) chunks[chunks.length - 1] += sentence;
		else chunks.push(sentence);
	}
	return chunks;
}

export async function translateBodyInChunks(sourceBody, { request, validate, onChunk = () => {}, onSplit = () => {}, maxChars = MAX_TRANSLATION_SOURCE_CHARS, inlineSeparator = '' }) {
	const chunks = splitMarkdownForTranslation(sourceBody, maxChars);
	const results = [];
	async function translateChunk(sourceChunk, depth = 0) {
		try {
			return await requestWithLayoutRetry(
				(attempt) => request(sourceChunk, attempt),
				(result) => validate(sourceChunk, result),
			);
		} catch (error) {
			const structureMismatch = ['TRANSLATION_BLOCK_COUNT_MISMATCH', 'TRANSLATION_FENCE_MISMATCH'].includes(error.code);
			if (error.code !== 'MODEL_OUTPUT_TRUNCATED' && !structureMismatch) throw error;
			const targetSize = Math.max(1, Math.floor(sourceChunk.length / 2));
			const smaller = depth < 4 && splitMarkdownForTranslation(sourceChunk, structureMismatch ? 1 : targetSize);
			const inline = !structureMismatch && smaller && smaller.length < 2;
			const partsToTranslate = inline ? splitPlainParagraphAtSentences(sourceChunk, targetSize) : smaller;
			if (!partsToTranslate || partsToTranslate.length < 2) {
				if (structureMismatch) throw error;
				throw new Error(`单个 Markdown 段落或代码块仍超出模型输出额度，无法安全拆分。请缩短该段落或更换输出额度更高的模型。${error.message}`, { cause: error });
			}
			onSplit(error.code);
			const parts = [];
			for (const part of partsToTranslate) parts.push(await translateChunk(part, depth + 1));
			return parts.join(inline ? inlineSeparator : '\n\n');
		}
	}
	for (let index = 0; index < chunks.length; index++) {
		onChunk(index + 1, chunks.length);
		results.push(await translateChunk(chunks[index]));
	}
	return results.join('\n\n');
}
