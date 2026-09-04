import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MIT_TEXT = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const dependencies = new Map();

for (const [packagePath, metadata] of Object.entries(lock.packages ?? {})) {
  if (!packagePath.includes('node_modules/') || metadata.dev === true || !metadata.version) continue;
  const name = packagePath.slice(packagePath.lastIndexOf('node_modules/') + 'node_modules/'.length);
  const key = `${name}@${metadata.version}`;
  if (!dependencies.has(key)) {
    dependencies.set(key, {
      name,
      version: metadata.version,
      license: metadata.license ?? 'UNKNOWN',
      packagePath,
    });
  }
}

const sections = [];
for (const dependency of [...dependencies.values()].sort((a, b) =>
  a.name.localeCompare(b.name) || a.version.localeCompare(b.version))) {
  const directory = path.resolve(dependency.packagePath);
  const entries = await readdir(directory, { withFileTypes: true });
  const licenseFiles = entries
    .filter(entry => entry.isFile() && /^(?:licen[cs]e|copying|notice)(?:[-.].+)?$/i.test(entry.name))
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const texts = [];
  for (const file of licenseFiles) {
    const text = (await readFile(path.join(directory, file), 'utf8')).trim();
    if (text) texts.push(`${file}\n\n${text}`);
  }
  if (!texts.length) {
    const packageJson = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    const author = typeof packageJson.author === 'string'
      ? packageJson.author
      : packageJson.author?.name;
    if (dependency.license !== 'MIT') {
      throw new Error(`未找到 ${dependency.name}@${dependency.version} 的许可证文件，且无法为 ${dependency.license} 生成回退文本`);
    }
    texts.push([
      'LICENSE (the published npm package omitted a license file; reconstructed from its MIT declaration and package metadata)',
      '',
      `Copyright (c) ${author || `${dependency.name} contributors`}`,
      '',
      MIT_TEXT,
    ].join('\n'));
  }
  sections.push([
    `${dependency.name} ${dependency.version}`,
    `Declared license: ${dependency.license}`,
    ...texts,
  ].join('\n\n'));
}

const output = [
  'THIRD-PARTY NPM DEPENDENCY LICENSES',
  '',
  'Generated from package-lock.json for production dependencies bundled with Arknights Training Room.',
  'Project assets and copied icon notices are documented separately in THIRD_PARTY_NOTICES.md.',
  '',
  sections.join('\n\n================================================================================\n\n'),
  '',
].join('\n');

await mkdir('dist', { recursive: true });
await writeFile('dist/THIRD_PARTY_LICENSES.txt', output, 'utf8');
