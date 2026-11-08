// 构建时扫描 content/ 下的 Markdown，生成带 front matter 的索引，
// 并以虚拟模块 virtual:content-index 注入正文，保证单文件预览也能读到内容。
import fs from 'node:fs';
import path from 'node:path';

export const COLLECTIONS = ['pages', 'posts', 'works', 'collections', 'guests', 'about'];

export function parseFrontMatter(raw) {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!text.startsWith('---')) return { data: {}, body: text.trim() };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { data: {}, body: text.trim() };
  const head = text.slice(3, end).trim();
  const body = text.slice(end + 4).replace(/^\s*\n/, '').trim();
  const data = {};

  for (const line of head.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const [, key, value] = m;
    let v = value.trim();
    if (/^\[.*\]$/.test(v)) {
      v = v
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
    } else if (/^-?\d+(\.\d+)?$/.test(v)) {
      v = Number(v);
    } else if (v === 'true' || v === 'false') {
      v = v === 'true';
    } else {
      v = v.replace(/^['"]|['"]$/g, '');
    }
    data[key] = v;
  }
  return { data, body };
}

function walk(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) walk(full, out);
    else out.push(full);
  }
}

export function scanContent(root) {
  const base = path.join(root, 'content');
  const index = {};
  for (const name of COLLECTIONS) index[name] = [];
  if (!fs.existsSync(base)) return index;

  const files = [];
  walk(base, files);

  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const rel = path.relative(base, file).split(path.sep).join('/');
    const collection = rel.split('/')[0];
    if (!index[collection]) index[collection] = [];
    const raw = fs.readFileSync(file, 'utf8');
    const { data, body } = parseFrontMatter(raw);
    index[collection].push({
      path: `/content/${rel}`,
      slug: path.basename(file, '.md'),
      data,
      body
    });
  }

  for (const key of Object.keys(index)) {
    index[key].sort((a, b) => {
      const da = String(a.data.date || '');
      const db = String(b.data.date || '');
      return da < db ? 1 : da > db ? -1 : 0;
    });
  }

  return index;
}

export function contentIndexPlugin() {
  const VIRTUAL = 'virtual:content-index';
  const RESOLVED = '\0' + VIRTUAL;
  let root = process.cwd();

  return {
    name: 'content-index',
    enforce: 'pre',
    configResolved(config) {
      root = config.root;
    },
    resolveId(id) {
      return id === VIRTUAL ? RESOLVED : null;
    },
    load(id) {
      if (id !== RESOLVED) return null;
      const index = scanContent(root);
      const files = [];
      walk(path.join(root, 'content'), files);
      files.forEach((f) => this.addWatchFile(f));
      return `const CONTENT = ${JSON.stringify(index)};\nexport default CONTENT;\n`;
    }
  };
}
