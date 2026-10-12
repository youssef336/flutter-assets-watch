// Declared vs. present vs. referenced assets. Pure: the caller hands over the
// project's file list (paths relative to the pubspec directory), the parsed
// `flutter:` section and the Dart sources.

import { densityOf } from './images.js';
import { basename, camel, dirname, extname, stem } from './util.js';

const IGNORED_FILE = /(^|\/)(\.DS_Store|\.gitkeep|\.keep|Thumbs\.db|README(\.\w+)?|LICENSE(\.\w+)?)$/i;
const FONT_EXT = new Set(['ttf', 'otf', 'ttc', 'woff', 'woff2']);
const PLATFORM_DIR = /^(android|ios|web|macos|windows|linux|build|test|integration_test|test_driver|\.dart_tool|\.idea|\.vscode|\.github|\.fvm)\//;

/** Is `path` bundled by one of the `assets:` declarations? (Directories are not recursive.) */
export function isDeclared(path, declarations) {
  const { base } = densityOf(path); // 2.0x/foo.png rides along with foo.png
  for (const d of declarations) {
    if (d.dir) {
      if (dirname(path) + '/' === d.path || dirname(base) + '/' === d.path) return true;
    } else if (d.path === path || d.path === base) {
      return true;
    }
  }
  return false;
}

const LIT = /r?'(?:[^'\\\n]|\\.)*'|r?"(?:[^"\\\n]|\\.)*"/g;
// `static const logo = 'assets/images/logo.png';` — a path parked in a constant.
const ALIAS = /([A-Za-z_$][\w$]*)\s*=\s*r?(['"])([^'"\n$]*\/[^'"\n$]*\.\w{2,5})\2/g;

/**
 * Collects what Dart code can "say": string literals, `.member` names,
 * identifier counts, and constants that hold an asset path (so a path only
 * parked in a never-used constant does not count as a reference).
 */
export function sourceIndex(sources) {
  const literals = [];
  const members = new Set();
  const words = new Set();
  const ids = new Map();
  const aliases = new Map(); // literal → constant names
  for (const text of sources) {
    const code = String(text || '').replace(/^\s*\/\/.*$/gm, '');
    const parked = new Set();
    for (const m of code.matchAll(ALIAS)) {
      if (!aliases.has(m[3])) aliases.set(m[3], []);
      aliases.get(m[3]).push(m[1]);
      parked.add(m.index + m[0].length - m[3].length - 2);
    }
    for (const m of code.matchAll(LIT)) {
      const start = m.index + (m[0].startsWith('r') ? 1 : 0);
      if (parked.has(start)) continue;
      const body = m[0].replace(/^r/, '').slice(1, -1);
      literals.push(body);
      for (const w of body.split(/[^\w-]+/)) if (w) words.add(w);
    }
    const bare = code.replace(LIT, "''");
    for (const m of bare.matchAll(/\.\s*([A-Za-z_$][\w$]*)/g)) members.add(m[1]);
    for (const m of bare.matchAll(/[A-Za-z_$][\w$]*/g)) ids.set(m[0], (ids.get(m[0]) || 0) + 1);
  }
  return { text: literals.join('\n'), members, words, ids, aliases };
}

/** A literal that names the folder itself ('assets/translations', 'assets/icons/$name.svg'), not a sibling file. */
function dirMentioned(dir, index) {
  index.dirs ||= new Map();
  if (!index.dirs.has(dir)) {
    const re = new RegExp(`${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?(?:$|\\$)`, 'm');
    index.dirs.set(dir, re.test(index.text));
  }
  return index.dirs.get(dir);
}

/**
 * How (if at all) an asset is referenced.
 * @returns {{status: 'used'|'config'|'maybe'|'unused', why: string}}
 */
export function referenceOf(path, index, configText = '') {
  const file = basename(path);
  const s = stem(path);
  const { base } = densityOf(path);
  if (index.text.includes(base) || index.text.includes(path)) return { status: 'used', why: 'path' };
  if (index.text.includes(file)) return { status: 'used', why: 'filename' };
  const names = [...new Set([...(index.aliases.get(base) || []), ...(index.aliases.get(path) || [])])];
  if (names.some((n) => (index.ids.get(n) || 0) >= 2)) return { status: 'used', why: 'constant' };
  // flutter_gen: assets/images/ic_logo.png → Assets.images.icLogo
  const gen = camel(s);
  if (gen.length > 2 && /[A-Za-z]/.test(gen) && index.members.has(gen)) return { status: 'used', why: 'flutter_gen' };
  if (configText && (configText.includes(base) || configText.includes(file))) return { status: 'config', why: 'config' };
  if (names.length) return { status: 'unused', why: 'dead-constant', names };
  if (s.length > 2 && index.words.has(s)) return { status: 'maybe', why: 'stem' };
  const dir = dirname(base);
  if (dir && dirMentioned(dir, index)) return { status: 'maybe', why: 'dir' };
  return { status: 'unused', why: '' };
}

/**
 * Full asset audit.
 * @param o {{files: {path, size}[], declarations, fonts, sources: string[], configText?: string}}
 */
export function auditAssets({ files, declarations, fonts, sources, configText = '' }) {
  const index = sourceIndex(sources);
  const fontFiles = new Set(fonts.flatMap((f) => f.files));
  const present = new Set(files.map((f) => f.path));

  const declared = [];
  const undeclared = [];
  // Folders that hold assets: declared folders plus any folder of declared files, and assets/ itself.
  const roots = new Set(['assets/']);
  for (const d of declarations) roots.add(d.dir ? d.path.split('/')[0] + '/' : dirname(d.path).split('/')[0] + '/');
  for (const f of fonts.flatMap((x) => x.files)) roots.add(f.split('/')[0] + '/');

  for (const f of files) {
    if (IGNORED_FILE.test(f.path) || PLATFORM_DIR.test(f.path)) continue;
    const inRoot = [...roots].some((r) => r !== '/' && f.path.startsWith(r));
    if (fontFiles.has(f.path)) {
      // fonts are judged by family below (even when their folder is also under assets:)
    } else if (isDeclared(f.path, declarations)) {
      const explicit = declarations.some((d) => !d.dir && (d.path === f.path || d.path === densityOf(f.path).base));
      declared.push({ ...f, explicit });
    } else if (inRoot) {
      undeclared.push({ ...f, font: FONT_EXT.has(extname(f.path)) });
    }
  }

  const rows = declared.map((f) => ({ ...f, ...referenceOf(f.path, index, configText) }));
  const missing = declarations.filter((d) => (d.dir
    ? ![...present].some((p) => p.startsWith(d.path))
    : !present.has(d.path)));
  const missingFonts = [...fontFiles].filter((p) => !present.has(p));

  const fontRows = fonts.map((f) => {
    const gen = camel(f.family);
    const used = index.text.includes(f.family) || (gen.length > 2 && index.members.has(gen));
    const bytes = f.files.reduce((n, p) => n + (files.find((x) => x.path === p)?.size || 0), 0);
    return { family: f.family, files: f.files, bytes, used };
  });

  const by = (status) => rows.filter((r) => r.status === status).sort((a, b) => b.size - a.size);
  return {
    used: by('used'),
    config: by('config'),
    maybe: by('maybe'),
    unused: by('unused'),
    undeclared: undeclared.sort((a, b) => b.size - a.size),
    missing,
    missingFonts,
    fonts: fontRows,
    unusedFonts: fontRows.filter((f) => !f.used),
    declaredCount: rows.length,
  };
}
