import assert from 'node:assert/strict';
import test from 'node:test';
import { requestJson } from '../lib/translation-client.mjs';

const settings = { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'test-only', model: 'deepseek/deepseek-v4.1-flash' };

test('当前 OpenRouter DeepSeek 模型关闭可选推理，并在 JSON mode 回退时保留设置', async () => {
	const originalFetch = globalThis.fetch;
	const bodies = [];
	globalThis.fetch = async (_url, options) => {
		bodies.push(JSON.parse(options.body));
		if (bodies.length === 1) return { ok: false, status: 400, async text() { return 'unsupported response_format'; } };
		return response({ choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] });
	};
	try {
		assert.deepEqual(await requestJson(settings, { prompt: 'Translate completely.' }), { ok: true });
		assert.equal(bodies.length, 2);
		for (const body of bodies) {
			assert.deepEqual(body.reasoning, { enabled: false });
			assert.deepEqual(body.provider, { require_parameters: true });
			assert.equal(body.max_tokens, 24000);
		}
	} finally { globalThis.fetch = originalFetch; }
});

test('其他服务和模型保留原有参数，避免向不兼容模型发送关闭推理参数', async () => {
	const originalFetch = globalThis.fetch;
	const bodies = [];
	globalThis.fetch = async (_url, options) => {
		bodies.push(JSON.parse(options.body));
		return response({ choices: [{ message: { content: '{"ok":true}' } }] });
	};
	try {
		await requestJson({ ...settings, baseUrl: 'https://example.com/v1' }, { prompt: 'test' });
		await requestJson({ ...settings, baseUrl: 'https://example.com/v1', model: 'z-ai/glm-5.3-flash' }, { prompt: 'test' });
		await requestJson({ ...settings, model: 'demo' }, { prompt: 'test' });
		assert.ok(bodies.every((body) => !('reasoning' in body) && !('provider' in body)));
	} finally { globalThis.fetch = originalFetch; }
});

test('finish_reason length 即使返回合法 JSON 也拒绝，并显示推理用量', async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => response({
		choices: [{ finish_reason: 'length', message: { content: '{"body":"Looks valid but incomplete"}' } }],
		usage: { completion_tokens: 24000, completion_tokens_details: { reasoning_tokens: 19000 } },
	});
	try {
		await assert.rejects(requestJson(settings, { prompt: 'Translate fully.' }), (error) => {
			assert.equal(error.code, 'MODEL_OUTPUT_TRUNCATED');
			assert.match(error.message, /推理 19000/);
			assert.match(error.message, /不是原文字符数超过上下文/);
			return true;
		});
	} finally { globalThis.fetch = originalFetch; }
});

test('推理耗尽额度导致 content 为空时仍明确报告输出截断', async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => response({ choices: [{ finish_reason: 'length', message: { content: '' } }] });
	try {
		await assert.rejects(requestJson(settings, { prompt: 'test', maxTokens: 80 }), (error) => error.code === 'MODEL_OUTPUT_TRUNCATED' && /80 tokens/.test(error.message));
	} finally { globalThis.fetch = originalFetch; }
});

test('请求关闭推理却仍耗尽额度时，指出服务商可能忽略了设置', async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => response({
		choices: [{ finish_reason: 'length', message: { content: '' } }],
		usage: { completion_tokens: 24000, completion_tokens_details: { reasoning_tokens: 24000 } },
	});
	try {
		await assert.rejects(requestJson(settings, { prompt: 'Translate fully.' }), (error) => {
			assert.equal(error.code, 'MODEL_OUTPUT_TRUNCATED');
			assert.match(error.message, /服务商可能未执行关闭推理设置/);
			return true;
		});
	} finally { globalThis.fetch = originalFetch; }
});

test('OpenRouter GLM 5.3 Flash 降低强制推理强度，JSON mode 回退仍拒绝截断译文', async () => {
	const originalFetch = globalThis.fetch;
	const bodies = [];
	globalThis.fetch = async (_url, options) => {
		bodies.push(JSON.parse(options.body));
		if (bodies.length === 1) return { ok: false, status: 400, async text() { return 'unsupported response_format'; } };
		return response({ choices: [{ finish_reason: 'length', message: { content: '{"body":"incomplete GLM translation"}' } }] });
	};
	try {
		await assert.rejects(requestJson({ ...settings, model: 'z-ai/glm-5.3-flash' }, { prompt: 'Translate the complete article.' }), { code: 'MODEL_OUTPUT_TRUNCATED' });
		assert.equal(bodies.length, 2);
		for (const body of bodies) {
			assert.equal(body.model, 'z-ai/glm-5.3-flash');
			assert.equal(body.max_tokens, 24000);
			assert.deepEqual(body.reasoning, { effort: 'low' });
			assert.deepEqual(body.provider, { require_parameters: true });
		}
		assert.deepEqual(bodies[0].response_format, { type: 'json_object' });
		assert.equal('response_format' in bodies[1], false);
	} finally { globalThis.fetch = originalFetch; }
});

test('响应头已到达但生成正文一直不结束时，超时仍会中止读取', async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (_url, options) => ({
		ok: true,
		status: 200,
		json() {
			return new Promise((_resolve, reject) => {
				const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
				if (options.signal.aborted) abort();
				else options.signal.addEventListener('abort', abort, { once: true });
			});
		},
	});
	try {
		await assert.rejects(requestJson(settings, { prompt: 'test', timeoutMs: 30 }), /已停止等待/);
	} finally { globalThis.fetch = originalFetch; }
});

function response(payload) {
	return { ok: true, status: 200, async json() { return payload; } };
}
