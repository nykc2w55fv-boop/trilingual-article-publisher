import fs from 'node:fs/promises';
import path from 'node:path';

const articleDir = path.join(process.cwd(), 'src', 'content', 'essays', 'publisher-rehearsal');
for (const relativePath of ['zh.md', 'en.md', 'zh-hant.md', 'images/cover.webp']) await fs.access(path.join(articleDir, relativePath));
if (!['sync', 'check', 'build'].includes(process.argv[2])) throw new Error('Unexpected rehearsal stage.');
console.log(`Rehearsal ${process.argv[2]} stage passed.`);
