const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_MODEL = 'openai/gpt-4o-mini';

export function normalizeTranslationSettings(settings = {}) {
	const baseUrl = String(settings.baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
	const apiKey = String(settings.apiKey || '').trim();
	const model = String(settings.model || DEFAULT_MODEL).trim();
	if (!/^https?:\/\//i.test(baseUrl)) throw new Error('大模型 URL 必须以 http:// 或 https:// 开头。');
	if (!apiKey) throw new Error('请先在设置中填写大模型 API Key。');
	if (!model) throw new Error('请先在设置中填写模型名称。');
	return { baseUrl, apiKey, model };
}

export function chatCompletionsUrl(baseUrl) {
	const normalized = String(baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
	return /\/chat\/completions$/i.test(normalized) ? normalized : `${normalized}/chat/completions`;
}

export async function requestJson(settings, { prompt, maxTokens = 24000, temperature = 0.1, timeoutMs = 360000 }) {
	const normalized = normalizeTranslationSettings(settings);
	const endpoint = chatCompletionsUrl(normalized.baseUrl);
	const openRouter = new URL(endpoint).hostname.toLowerCase() === 'openrouter.ai';
	const headers = {
		Authorization: `Bearer ${normalized.apiKey}`,
		'Content-Type': 'application/json',
	};
	if (openRouter) {
		headers['HTTP-Referer'] = 'https://cultivationpath.com';
		headers['X-Title'] = 'Cognitive Iteration Publisher';
	}

	const body = {
		model: normalized.model,
		messages: [{ role: 'user', content: prompt }],
		temperature,
		max_tokens: maxTokens,
	};
	// Reasoning shares the completion budget with the translated article.
	// Keep provider-specific settings scoped to models with known support.
	if (openRouter && normalized.model === 'deepseek/deepseek-v4.1-flash') {
		body.reasoning = { enabled: false };
	} else if (openRouter && normalized.model === 'z-ai/glm-5.3-flash') {
		// GLM 5.3 Flash requires reasoning; its default "max" can consume the
		// entire completion budget before any translation is returned.
		body.reasoning = { effort: 'low' };
	}
	if (body.reasoning) {
		// Without this, OpenRouter may route to an endpoint that silently ignores
		// the reasoning setting and spends the whole output budget on thinking.
		body.provider = { require_parameters: true };
	}
	let response = await fetchWithTimeout(endpoint, {
		method: 'POST',
		headers,
		body: JSON.stringify({ ...body, response_format: { type: 'json_object' } }),
	}, timeoutMs);
	if (response.status === 400 || response.status === 422) {
		response = await fetchWithTimeout(endpoint, { method: 'POST', headers, body: JSON.stringify(body) }, timeoutMs);
	}
	if (!response.ok) {
		const detail = response.detail.replace(/\s+/g, ' ').slice(0, 240);
		throw new Error(`大模型请求失败（HTTP ${response.status}）${detail ? `：${detail}` : '。'}`);
	}
	const payload = response.payload;
	// A valid-looking JSON object can still be an incomplete model response.
	// Always reject a truncated completion before parsing or publishing it.
	if (payload?.choices?.[0]?.finish_reason === 'length') {
		const usage = payload.usage || {};
		const details = [`请求输出上限 ${maxTokens} tokens`];
		if (Number.isFinite(usage.completion_tokens)) details.push(`实际输出 ${usage.completion_tokens} tokens`);
		const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens;
		if (Number.isFinite(reasoningTokens)) details.push(`其中推理 ${reasoningTokens} tokens`);
		const ignoredReasoning = body.reasoning?.enabled === false && Number.isFinite(reasoningTokens) && reasoningTokens >= maxTokens * 0.9;
		const advice = ignoredReasoning
			? '本次请求仍把大部分额度用于推理，服务商可能未执行关闭推理设置。请更新并重启发布器后重试；若仍出现，请更换支持关闭推理的模型或服务商。'
			: '请降低推理强度或提高输出额度后重试。';
		const error = new Error(`大模型输出被截断（${details.join('，')}）。这是生成输出额度不足，不是原文字符数超过上下文；已停止处理不完整译文。${advice}`);
		error.code = 'MODEL_OUTPUT_TRUNCATED';
		throw error;
	}
	const raw = payload?.choices?.[0]?.message?.content;
	if (typeof raw !== 'string' || !raw.trim()) throw new Error('大模型没有返回可用内容。');
	const cleaned = raw.trim().replace(/^```json\s*|\s*```$/gi, '').trim();
	const candidates = [cleaned];
	const firstBrace = cleaned.indexOf('{');
	const lastBrace = cleaned.lastIndexOf('}');
	if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(cleaned.slice(firstBrace, lastBrace + 1));
	for (const candidate of candidates) {
		try { return JSON.parse(candidate); } catch { /* Try a JSON object embedded in surrounding text. */ }
	}
	throw new Error('大模型返回的译文格式无效。请换用更可靠的模型后重试。');
}

async function fetchWithTimeout(url, options, timeoutMs) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, { ...options, signal: controller.signal });
		// Keep the deadline active while the provider is generating its body,
		// rather than clearing it as soon as response headers arrive.
		if (!response.ok) {
			return { status: response.status, ok: false, detail: await response.text() };
		}
		return { status: response.status, ok: true, payload: await response.json() };
	} catch (error) {
		if (error.name === 'AbortError') throw new Error(`大模型请求超过 ${Math.round(timeoutMs / 60000)} 分钟，已停止等待。请检查服务状态或更换模型。`);
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

export const translationDefaults = {
	baseUrl: DEFAULT_BASE_URL,
	model: DEFAULT_MODEL,
};
