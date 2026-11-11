const token = document.querySelector('meta[name="publisher-token"]').content;
const categories = ['1.古典阅读与修身', '2.技术与AI实践', '3.投研与量化'];
const pageSize = 10;
const elements = {
	message: document.querySelector('#message'),
	welcome: document.querySelector('#welcome'),
	articleArea: document.querySelector('#articleArea'),
	categoryTabs: document.querySelector('#categoryTabs'),
	articleGroups: document.querySelector('#articleGroups'),
	articleSearch: document.querySelector('#articleSearch'),
	articleCount: document.querySelector('#articleCount'),
	articlePagination: document.querySelector('#articlePagination'),
	previousPageButton: document.querySelector('#previousPageButton'),
	nextPageButton: document.querySelector('#nextPageButton'),
	pageIndicator: document.querySelector('#pageIndicator'),
	gitState: document.querySelector('#gitState'),
	settingsDialog: document.querySelector('#settingsDialog'),
	settingsForm: document.querySelector('#settingsForm'),
	keyHint: document.querySelector('#keyHint'),
	articleDialog: document.querySelector('#articleDialog'),
	articleTitle: document.querySelector('#articleTitle'),
	articleDetails: document.querySelector('#articleDetails'),
	coverFile: document.querySelector('#coverFile'),
	coverHint: document.querySelector('#coverHint'),
	coverPreview: document.querySelector('#coverPreview'),
	publishButton: document.querySelector('#publishButton'),
	layoutDialog: document.querySelector('#layoutDialog'),
	layoutMessage: document.querySelector('#layoutMessage'),
	desktopLayoutPreview: document.querySelector('#desktopLayoutPreview'),
	mobileLayoutPreview: document.querySelector('#mobileLayoutPreview'),
	showFormattedButton: document.querySelector('#showFormattedButton'),
	showOriginalButton: document.querySelector('#showOriginalButton'),
	publishFormattedButton: document.querySelector('#publishFormattedButton'),
	publishOriginalButton: document.querySelector('#publishOriginalButton'),
};
let currentState = null;
let selectedArticle = null;
let coverPreviewUrl = null;
let coverPreviewRequest = 0;
let layoutPreview = null;
let selectedCategory = categories[0];
let currentPage = 1;

document.querySelector('#settingsButton').addEventListener('click', openSettings);
document.querySelector('#welcomeSettingsButton').addEventListener('click', openSettings);
document.querySelector('#refreshButton').addEventListener('click', refresh);
elements.categoryTabs.addEventListener('keydown', onCategoryKeydown);
elements.articleSearch.addEventListener('input', () => {
	currentPage = 1;
	renderArticleList();
});
elements.previousPageButton.addEventListener('click', () => changePage(-1));
elements.nextPageButton.addEventListener('click', () => changePage(1));
document.querySelector('#closeArticleButton').addEventListener('click', () => elements.articleDialog.close());
elements.articleDialog.addEventListener('close', clearCoverPreview);
elements.coverFile.addEventListener('change', updateCoverSelection);
elements.publishButton.addEventListener('click', publishSelected);
document.querySelector('#closeLayoutButton').addEventListener('click', () => elements.layoutDialog.close());
elements.showFormattedButton.addEventListener('click', () => showLayoutVersion('formatted'));
elements.showOriginalButton.addEventListener('click', () => showLayoutVersion('original'));
elements.publishFormattedButton.addEventListener('click', () => publishReviewed(layoutPreview?.suggestionCount > 0 ? 'formatted' : 'original'));
elements.publishOriginalButton.addEventListener('click', () => publishReviewed('original'));
elements.settingsForm.addEventListener('submit', saveSettings);

refresh();

async function refresh() {
	setMessage('');
	try {
		currentState = await api('/api/state');
		render();
	} catch (error) {
		setMessage(error.message, 'error');
	}
}

function render() {
	const configured = currentState.configured;
	if (currentState.environmentError) setMessage(currentState.environmentError, 'error');
	elements.welcome.hidden = configured;
	elements.articleArea.hidden = !configured;
	if (!configured) {
		if (currentState.configurationError) setMessage(currentState.configurationError, 'error');
		return;
	}
	const git = currentState.git;
	if (!git && !currentState.environmentError) setMessage(currentState.gitError || '暂时无法检查网站仓库，请稍后刷新。', 'error');
	elements.gitState.textContent = currentState.environmentError
		? '网站依赖未就绪，请处理上方提示'
		: !git
		? '设置已保存，等待完成仓库检查'
		: git.dirty
		? 'GitHub Desktop 中有尚未处理的修改'
		: git.behind > 0
			? `本地落后 GitHub ${git.behind} 个提交，请先 Pull`
			: git.ahead > 0
				? `有 ${git.ahead} 个提交尚未 Push`
				: `仓库已就绪 · ${git.branch || '当前分支'}`;
	renderCategoryTabs();
	renderArticleList();
}

function renderCategoryTabs() {
	elements.categoryTabs.replaceChildren(...categories.map((category, index) => {
		const button = document.createElement('button');
		button.type = 'button';
		button.id = `category-tab-${index + 1}`;
		button.className = `category-tab category-tab-${index + 1}`;
		button.setAttribute('role', 'tab');
		button.setAttribute('aria-controls', 'articleGroups');
		const number = document.createElement('span');
		number.className = 'category-number';
		number.textContent = String(index + 1).padStart(2, '0');
		const label = document.createElement('span');
		label.className = 'category-label';
		label.textContent = category.slice(2);
		const count = document.createElement('span');
		count.className = 'category-count';
		count.textContent = `${currentState.articles.filter((article) => article.category === category).length} 篇`;
		button.append(number, label, count);
		button.addEventListener('click', () => selectCategory(category));
		return button;
	}));
	updateCategoryTabs();
}

function updateCategoryTabs() {
	for (const [index, button] of [...elements.categoryTabs.children].entries()) {
		const active = categories[index] === selectedCategory;
		button.setAttribute('aria-selected', String(active));
		button.tabIndex = active ? 0 : -1;
		if (active) elements.articleGroups.setAttribute('aria-labelledby', button.id);
	}
}

function selectCategory(category) {
	if (category === selectedCategory) return;
	selectedCategory = category;
	elements.articleSearch.value = '';
	currentPage = 1;
	updateCategoryTabs();
	renderArticleList();
}

function onCategoryKeydown(event) {
	const buttons = [...elements.categoryTabs.children];
	const index = buttons.indexOf(event.target);
	if (index < 0) return;
	const next = event.key === 'ArrowRight' ? (index + 1) % buttons.length
		: event.key === 'ArrowLeft' ? (index - 1 + buttons.length) % buttons.length
		: event.key === 'Home' ? 0
		: event.key === 'End' ? buttons.length - 1
		: -1;
	if (next < 0) return;
	event.preventDefault();
	selectCategory(categories[next]);
	buttons[next].focus();
}

function renderArticleList() {
	const articles = currentState.articles.filter((article) => article.category === selectedCategory);
	const query = elements.articleSearch.value.trim().toLocaleLowerCase();
	const matches = query
		? articles.filter((article) => `${article.title || ''} ${article.filename || ''}`.toLocaleLowerCase().includes(query))
		: articles;
	const pageCount = Math.max(1, Math.ceil(matches.length / pageSize));
	currentPage = Math.min(currentPage, pageCount);
	elements.articleCount.textContent = query ? `找到 ${matches.length} 篇 · 本类共 ${articles.length} 篇` : `本类共 ${articles.length} 篇`;
	const list = document.createElement('div');
	list.className = 'article-list';
	if (matches.length === 0) {
		const empty = document.createElement('p');
		empty.className = 'article-empty';
		empty.textContent = articles.length === 0
			? '这个分类还没有文章。把 Markdown 文件放进对应目录后，点“刷新”。'
			: '当前分类没有匹配的文章，请换个关键词。';
		list.append(empty);
	} else {
		for (const article of matches.slice((currentPage - 1) * pageSize, currentPage * pageSize)) {
			list.append(createArticleCard(article));
		}
	}
	elements.articleGroups.replaceChildren(list);
	elements.articlePagination.hidden = matches.length === 0;
	elements.previousPageButton.disabled = currentPage === 1;
	elements.nextPageButton.disabled = currentPage === pageCount;
	elements.pageIndicator.textContent = `第 ${currentPage} / ${pageCount} 页`;
}

function changePage(step) {
	currentPage += step;
	renderArticleList();
}

function createArticleCard(article) {
	const button = document.createElement('button');
	button.type = 'button';
	button.className = 'article-card';
	const copy = document.createElement('div');
	const heading = document.createElement('h3');
	heading.textContent = article.title || article.filename;
	const detail = document.createElement('p');
	detail.textContent = article.error || `${article.charCount} 字 · ${article.referencedImageFiles.length} 张原文引用图片`;
	copy.append(heading, detail);
	const status = document.createElement('span');
	status.className = `status ${article.status}`;
	status.textContent = ({ new: '新文章', updated: '有更新', synced: '已同步', error: '有错误' })[article.status];
	button.append(copy, status);
	button.disabled = Boolean(currentState.environmentError);
	if (!button.disabled) button.addEventListener('click', () => openArticle(article));
	return button;
}

function openArticle(article) {
	selectedArticle = article;
	elements.articleTitle.textContent = article.title || article.filename;
	const values = [
		['分类', article.category],
		['状态', article.canChooseCover ? '需要重新选择封面' : ({ new: '新文章', updated: '中文或图片有更新', synced: '已同步，可更换封面', error: '需要修正' })[article.status]],
		['中文长度', article.charCount ? `${article.charCount} 个非空白字符` : '—'],
		['原文引用图片', article.referencedImageFiles ? `${article.referencedImageFiles.length} 张` : '—'],
		['当前封面', article.coverSource || '—'],
		['文件', article.relativePath],
	];
	elements.articleDetails.replaceChildren();
	for (const [label, value] of values) {
		const dt = document.createElement('dt'); dt.textContent = label;
		const dd = document.createElement('dd'); dd.textContent = value;
		elements.articleDetails.append(dt, dd);
	}
	const options = [
		['', '请选择封面'],
		['@default', '使用该分类的默认封面'],
		...(currentState.coverImages || []).map((name) => [name, name]),
	];
	elements.coverFile.replaceChildren(...options.map(([value, label]) => {
		const option = document.createElement('option');
		option.value = value;
		option.textContent = label;
		return option;
	}));
	elements.coverFile.value = article.coverFile || '';
	updateCoverSelection();
	elements.articleDialog.showModal();
}

async function updateCoverSelection() {
	const choice = elements.coverFile.value;
	const referenced = selectedArticle?.referencedImageFiles?.includes(choice);
	const hint = !choice
		? '把封面图片放进 Obsidian 的 _attachments，并在这里明确选择；上方“当前封面”可能来自旧版自动规则。'
		: choice === '@default'
		? '使用该分类的默认图片作为网站封面。'
		: referenced
		? ''
		: '这张图只作为网站封面，不会插入网站正文。';
	elements.coverHint.textContent = hint;
	elements.coverHint.hidden = !hint;
	updatePublishButton();
	clearCoverPreview();
	if (!choice || choice === '@default') return;
	const requestId = ++coverPreviewRequest;
	try {
		const response = await fetch(`/api/cover-image?name=${encodeURIComponent(choice)}`, {
			headers: { 'X-Publisher-Token': token },
		});
		if (!response.ok) throw new Error('封面预览加载失败，请刷新文章列表后重试。');
		const blob = await response.blob();
		if (requestId !== coverPreviewRequest) return;
		coverPreviewUrl = URL.createObjectURL(blob);
		elements.coverPreview.src = coverPreviewUrl;
		elements.coverPreview.hidden = false;
	} catch (error) {
		if (requestId === coverPreviewRequest) {
			elements.coverHint.textContent = error.message;
			elements.coverHint.hidden = false;
		}
	}
}

function clearCoverPreview() {
	coverPreviewRequest++;
	if (coverPreviewUrl) URL.revokeObjectURL(coverPreviewUrl);
	coverPreviewUrl = null;
	elements.coverPreview.removeAttribute('src');
	elements.coverPreview.hidden = true;
}

function updatePublishButton() {
	const choice = elements.coverFile.value;
	const unchanged = selectedArticle?.status === 'synced' && choice === selectedArticle.coverFile;
	elements.publishButton.disabled = !choice || unchanged || (selectedArticle?.status === 'error' && !selectedArticle.canChooseCover) || !currentState.git || Boolean(currentState.environmentError);
	elements.publishButton.textContent = currentState.environmentError
		? '请先处理页面上的依赖准备提示'
		: !currentState.git
		? '请先处理页面上的仓库检查提示'
		: selectedArticle?.status === 'error' && !selectedArticle.canChooseCover ? selectedArticle.error
		: !choice ? '请先选择网站封面'
		: unchanged ? '当前封面已同步' : '生成文章排版预览';
}

function openSettings() {
	const data = currentState?.settings || {};
	for (const name of ['repoPath', 'sourcePath', 'backupPath', 'translationApiUrl', 'translationModel']) {
		elements.settingsForm.elements[name].value = data[name] || '';
	}
	elements.settingsForm.elements.translationApiKey.value = '';
	elements.keyHint.textContent = data.hasApiKey ? '本机已经保存 Key；留空会继续使用原 Key。' : 'Key 只保存在当前电脑，不会写入网站仓库或回显。';
	elements.settingsDialog.showModal();
}

async function saveSettings(event) {
	event.preventDefault();
	if (event.submitter?.value === 'cancel') { elements.settingsDialog.close(); return; }
	const button = document.querySelector('#saveSettingsButton');
	button.disabled = true;
	button.textContent = '正在保存并准备环境…';
	try {
		const form = new FormData(elements.settingsForm);
		currentState = await api('/api/settings', Object.fromEntries(form));
		elements.settingsDialog.close();
		setMessage(currentState.environmentError || '设置已保存在本机，文章目录和网站依赖已经就绪。', currentState.environmentError ? 'error' : 'success');
		render();
	} catch (error) {
		setMessage(error.message, 'error');
	} finally {
		button.disabled = false;
		button.textContent = '保存并初始化';
	}
}

async function publishSelected() {
	if (!selectedArticle) return;
	const coverFile = elements.coverFile.value;
	if (!coverFile) return;
	elements.publishButton.disabled = true;
	elements.publishButton.textContent = '正在生成排版建议…';
	setMessage('正在准备原文与文章排版预览。');
	try {
		const result = await api('/api/layout-preview', { relativePath: selectedArticle.relativePath, coverFile });
		layoutPreview = { ...result, relativePath: selectedArticle.relativePath, coverFile };
		const skipped = result.skippedCount
			? `已跳过 ${result.skippedCount} 处无效建议（${(result.skippedReasons || []).join('；')}）。`
			: '';
		elements.layoutMessage.textContent = result.layoutError
			? `${result.layoutError} 可按原排版发布。`
			: result.suggestionCount
				? `已保留 ${result.suggestionCount} 处手机排版调整。${skipped}电脑端保持原有排版，请检查两种宽度。`
				: result.skippedCount
					? `本次排版建议均未通过校验。${skipped}可按原排版发布。`
					: '没有适合自动调整的普通正文段落，可按原排版发布。';
		updateLayoutDecisionButtons();
		showLayoutVersion(result.suggestionCount ? 'formatted' : 'original');
		elements.layoutDialog.showModal();
		setMessage('');
	} catch (error) {
		setMessage(error.message, 'error');
		elements.coverHint.textContent = error.message;
		elements.coverHint.hidden = false;
	} finally {
		updatePublishButton();
	}
}

function updateLayoutDecisionButtons() {
	if (!layoutPreview) return;
	const hasSuggestions = layoutPreview.suggestionCount > 0;
	elements.showFormattedButton.disabled = !hasSuggestions;
	elements.publishOriginalButton.hidden = !hasSuggestions;
	elements.publishOriginalButton.disabled = false;
	elements.publishFormattedButton.disabled = false;
	elements.publishFormattedButton.textContent = hasSuggestions ? '确认排版并发布' : '按原排版发布';
}

function showLayoutVersion(version) {
	if (!layoutPreview) return;
	const html = version === 'formatted' ? layoutPreview.formattedHtml : layoutPreview.originalHtml;
	elements.desktopLayoutPreview.innerHTML = html;
	elements.mobileLayoutPreview.innerHTML = html;
	elements.showFormattedButton.classList.toggle('active', version === 'formatted');
	elements.showOriginalButton.classList.toggle('active', version === 'original');
}

async function publishReviewed(layoutMode) {
	if (!layoutPreview) return;
	const review = layoutPreview;
	elements.publishFormattedButton.disabled = true;
	elements.publishOriginalButton.disabled = true;
	setMessage('正在翻译、整理和构建。长文可能需要几分钟。');
	const progressTimer = window.setInterval(async () => {
		try {
			const progress = await api('/api/state');
			if (progress.publishingMessage) elements.layoutMessage.textContent = progress.publishingMessage;
		} catch { /* The main request will report any actionable error. */ }
	}, 1500);
	try {
		const result = await api('/api/publish', { relativePath: review.relativePath, coverFile: review.coverFile, previewToken: review.previewToken, layoutMode });
		elements.layoutDialog.close();
		elements.articleDialog.close();
		layoutPreview = null;
		setMessage(result.message, 'success');
		await refreshKeepingMessage();
	} catch (error) {
		setMessage(error.message, 'error');
		elements.layoutMessage.textContent = error.message;
	} finally {
		window.clearInterval(progressTimer);
		updateLayoutDecisionButtons();
		updatePublishButton();
	}
}

async function refreshKeepingMessage() {
	currentState = await api('/api/state');
	render();
}

async function api(url, body) {
	const options = body === undefined ? {} : {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-Publisher-Token': token },
		body: JSON.stringify(body),
	};
	const response = await fetch(url, options);
	const payload = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(payload.error || `请求失败（${response.status}）`);
	return payload;
}

function setMessage(text, type = '') {
	elements.message.hidden = !text;
	elements.message.textContent = text;
	elements.message.className = `message ${type}`.trim();
}
