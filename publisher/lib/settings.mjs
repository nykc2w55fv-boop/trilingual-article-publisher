import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { translationDefaults } from './translation-client.mjs';

const appFolderName = 'CognitiveGardenPublisher';

export function getConfigDirectory(environment = process.env, platform = process.platform) {
	if (environment.BLOG_PUBLISHER_CONFIG_DIR) return path.resolve(environment.BLOG_PUBLISHER_CONFIG_DIR);
	if (platform === 'win32') return path.join(environment.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), appFolderName);
	if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', appFolderName);
	return path.join(environment.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), appFolderName);
}

export async function loadSettings(options = {}) {
	const configDir = options.configDir || getConfigDirectory();
	const configPath = path.join(configDir, 'settings.json');
	try {
		const parsed = JSON.parse(await fs.readFile(configPath, 'utf8'));
		return normalizeStoredSettings(parsed);
	} catch (error) {
		if (error.code === 'ENOENT') return normalizeStoredSettings({});
		if (error instanceof SyntaxError) throw new Error(`本机设置文件格式损坏：${configPath}`);
		throw error;
	}
}

export async function saveSettings(settings, options = {}) {
	const configDir = options.configDir || getConfigDirectory();
	await fs.mkdir(configDir, { recursive: true });
	const configPath = path.join(configDir, 'settings.json');
	const normalized = normalizeStoredSettings(settings);
	const temporaryPath = path.join(configDir, `settings-${process.pid}.tmp`);
	await fs.writeFile(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
	await fs.rename(temporaryPath, configPath);
	try { await fs.chmod(configPath, 0o600); } catch { /* Windows may not apply POSIX modes. */ }
	return normalized;
}

export function publicSettings(settings) {
	return {
		repoPath: settings.repoPath,
		sourcePath: settings.sourcePath,
		backupPath: settings.backupPath,
		translationApiUrl: settings.translationApiUrl,
		translationModel: settings.translationModel,
		hasApiKey: Boolean(settings.translationApiKey),
	};
}

export function mergeSettings(current, incoming) {
	return normalizeStoredSettings({
		...current,
		repoPath: incoming.repoPath,
		sourcePath: incoming.sourcePath,
		backupPath: incoming.backupPath,
		translationApiUrl: incoming.translationApiUrl,
		translationModel: incoming.translationModel,
		translationApiKey: String(incoming.translationApiKey || '').trim() || current.translationApiKey,
	});
}

function normalizeStoredSettings(value) {
	return {
		repoPath: String(value.repoPath || '').trim(),
		sourcePath: String(value.sourcePath || '').trim(),
		backupPath: String(value.backupPath || '').trim(),
		translationApiUrl: String(value.translationApiUrl || translationDefaults.baseUrl).trim(),
		translationApiKey: String(value.translationApiKey || '').trim(),
		translationModel: String(value.translationModel || translationDefaults.model).trim(),
	};
}
