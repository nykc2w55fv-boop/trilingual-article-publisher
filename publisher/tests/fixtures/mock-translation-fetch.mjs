import fs from 'node:fs';

globalThis.fetch = async (_url, options) => {
	const prompt = JSON.parse(options.body).messages[0].content;
	let content;
	let truncated = false;
	if (prompt.startsWith('Translate these Chinese article metadata')) {
		content = { title: '测试标题', description: '完整测试导读。', coverAlt: '测试封面。' };
	} else {
		const excerpt = prompt.split('\n\nBODY:\n')[1];
		truncated = excerpt.length > Number(process.env.MOCK_TRANSLATION_MAX_CHARS || 1000);
		let body = excerpt;
		if (!truncated && process.env.MOCK_TRANSLATION_REFLOW_PARAGRAPHS === '1') {
			body = body.replace(/(第\d+段。[^\n]*)\n\n(第\d+段。)/, '$1 $2');
			if (body === excerpt) body = body.replace(/^(第\d+段。)/, '$1\n\n');
		}
		if (!truncated && process.env.MOCK_TRANSLATION_OMIT_BLOCK === '1') {
			body = /\n\n/.test(excerpt) ? excerpt.replace(/\n\n[^\n]+/, '') : /^第\d+段。/.test(excerpt) ? '' : excerpt;
		}
		if (!truncated && process.env.MOCK_TRANSLATION_STRIP_FENCES === '1') {
			body = body.replace(/^```[^\n]*\n/gm, '').replace(/^```[ \t]*$/gm, '');
		}
		if (!truncated && process.env.MOCK_TRANSLATION_EMPTY_FENCE_BODY === '1') {
			body = body.replace(/(^```[^\n]*\n)[\s\S]*?(^```[ \t]*$)/gm, '$1$2');
		}
		content = { body };
		fs.appendFileSync(process.env.MOCK_TRANSLATION_CALLS_FILE, `${JSON.stringify({ length: excerpt.length, truncated })}\n`);
	}
	return {
		ok: true,
		status: 200,
		async json() {
			return { choices: [{ finish_reason: truncated ? 'length' : 'stop', message: { content: JSON.stringify(content) } }], usage: { completion_tokens: truncated ? 24000 : 500 } };
		},
	};
};
