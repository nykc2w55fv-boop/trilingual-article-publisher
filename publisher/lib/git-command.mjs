import fs from 'node:fs';
import path from 'node:path';

// GitHub Desktop ships Git without necessarily adding it to the terminal PATH.
// Resolve from this machine's installations; never store a machine-specific path.
export function findGitExecutable(environment = process.env, platform = process.platform) {
	const windows = platform === 'win32';
	const env = (name) => {
		const key = Object.keys(environment).find((candidate) => windows ? candidate.toLowerCase() === name.toLowerCase() : candidate === name);
		return key ? environment[key] : '';
	};
	const executable = windows ? 'git.exe' : 'git';
	for (const directory of String(env('PATH') || '').split(windows ? ';' : ':')) {
		const cleaned = directory.trim().replace(/^"|"$/g, '');
		if (!cleaned || !path.isAbsolute(cleaned)) continue;
		const candidate = path.join(cleaned, executable);
		if (usableFile(candidate, windows)) return candidate;
	}
	if (windows) {
		const localData = env('LOCALAPPDATA');
		const installations = [
			localData && path.join(localData, 'Programs', 'Git', 'cmd', executable),
			env('ProgramFiles') && path.join(env('ProgramFiles'), 'Git', 'cmd', executable),
			env('ProgramFiles(x86)') && path.join(env('ProgramFiles(x86)'), 'Git', 'cmd', executable),
		].filter(Boolean);
		for (const candidate of installations) if (usableFile(candidate, true)) return candidate;
		if (localData) {
			const desktopRoot = path.join(localData, 'GitHubDesktop');
			const versions = directories(desktopRoot)
				.filter((name) => /^app-\d/.test(name))
				.sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
			for (const version of versions) {
				const candidate = path.join(desktopRoot, version, 'resources', 'app', 'git', 'cmd', executable);
				if (usableFile(candidate, true)) return candidate;
			}
		}
	}
	throw new Error(windows
		? '找不到 Git。请安装 GitHub Desktop 或 Git for Windows，然后关闭并重新启动发布器或终端。已保存的模型和 Key 无需重填。'
		: '找不到 Git。请安装 Git 并确认终端可运行 git --version，再重新启动发布器或终端。已保存的模型和 Key 无需重填。');
}

function usableFile(filename, windows) {
	try {
		if (!fs.statSync(filename).isFile()) return false;
		fs.accessSync(filename, windows ? fs.constants.F_OK : fs.constants.X_OK);
		return true;
	} catch { return false; }
}

function directories(root) {
	try { return fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name); }
	catch { return []; }
}
