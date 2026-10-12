// pubspec.yaml reading. A tiny block-YAML reader covers the subset pubspecs use
// (maps, lists, list-of-maps, quoted / plain scalars, flow lists, comments,
// block scalars), then a few helpers pull out what this tool cares about:
// dependencies, `flutter: assets:` and `flutter: fonts:`.

function stripComment(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") {
      q = c;
    } else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) {
      return s.slice(0, i).trimEnd();
    }
  }
  return s.trimEnd();
}

function scalar(raw) {
  const s = raw.trim();
  if (!s || s === '~' || s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    return inner ? inner.split(',').map((x) => scalar(x)) : [];
  }
  return s;
}

const KEY = /^("[^"]*"|'[^']*'|[^:#'"][^:]*?)\s*:(?:\s+(.*)|\s*)$/;

/** Parses the block-YAML subset used by pubspec.yaml into plain objects/arrays/strings. */
export function parseYaml(text) {
  const lines = [];
  for (const raw of String(text || '').replace(/\r/g, '').replace(/\t/g, '  ').split('\n')) {
    if (/^\s*(#.*)?$/.test(raw) || /^(---|\.\.\.)\s*$/.test(raw)) continue;
    const indent = raw.length - raw.trimStart().length;
    lines.push({ indent, content: stripComment(raw.trim()), raw });
  }
  let i = 0;

  const isItem = (l) => l.content === '-' || l.content.startsWith('- ');

  function block(indent) {
    if (i >= lines.length) return null;
    return isItem(lines[i]) ? list(indent) : map(indent);
  }

  function nested(parentIndent, allowSameIndentList) {
    const next = lines[i];
    if (!next) return null;
    if (next.indent > parentIndent) return block(next.indent);
    if (allowSameIndentList && next.indent === parentIndent && isItem(next)) return list(parentIndent);
    return null;
  }

  function blockScalar(parentIndent) {
    const out = [];
    while (i < lines.length && lines[i].indent > parentIndent) out.push(lines[i++].raw.trim());
    return out.join('\n');
  }

  function list(indent) {
    const out = [];
    while (i < lines.length && lines[i].indent === indent && isItem(lines[i])) {
      const line = lines[i];
      const rest = line.content === '-' ? '' : line.content.slice(2).trim();
      if (!rest) {
        i++;
        out.push(nested(indent, false));
      } else if (KEY.test(rest) && !/^["'[]/.test(rest)) {
        // "- key: value" opens a map whose keys sit where `key` starts.
        const offset = line.raw.indexOf(rest, line.raw.indexOf('-') + 1);
        lines[i] = { indent: offset, content: rest, raw: ' '.repeat(offset) + rest };
        out.push(map(offset));
      } else {
        i++;
        out.push(scalar(rest));
      }
    }
    return out;
  }

  function map(indent) {
    const out = {};
    while (i < lines.length && lines[i].indent >= indent) {
      const line = lines[i];
      if (line.indent > indent || isItem(line)) {
        i++; // stray line we do not understand: skip it rather than loop
        continue;
      }
      const m = KEY.exec(line.content);
      i++;
      if (!m) continue;
      const key = scalar(m[1]);
      const value = m[2] ?? '';
      if (value === '' ) out[key] = nested(indent, true);
      else if (/^[|>][-+]?$/.test(value)) out[key] = blockScalar(indent);
      else out[key] = scalar(value);
    }
    return out;
  }

  const root = lines.length ? block(lines[0].indent) : null;
  return root && typeof root === 'object' && !Array.isArray(root) ? root : {};
}

/** Top-level keys of the pubspec (tools such as flutter_native_splash read their own block). */
export const topLevelKeys = (doc) => Object.keys(doc);

/**
 * @returns {{name, section: 'main'|'dev', source: 'hosted'|'sdk'|'path'|'git'}[]}
 */
export function dependencies(doc) {
  const out = [];
  for (const [key, section] of [['dependencies', 'main'], ['dev_dependencies', 'dev']]) {
    const deps = doc[key];
    if (!deps || typeof deps !== 'object') continue;
    for (const [name, spec] of Object.entries(deps)) {
      let source = 'hosted';
      if (spec && typeof spec === 'object') {
        if ('sdk' in spec) source = 'sdk';
        else if ('path' in spec) source = 'path';
        else if ('git' in spec) source = 'git';
      }
      out.push({ name, section, source });
    }
  }
  return out;
}

const clean = (p) => String(p).trim().replace(/^\.\//, '');

/**
 * `flutter:` section → declared assets and fonts.
 * @returns {{assets: {path: string, dir: boolean}[], fonts: {family: string, files: string[]}[], generate: boolean}}
 */
export function flutterSection(doc) {
  const f = doc.flutter && typeof doc.flutter === 'object' ? doc.flutter : {};
  const assets = [];
  for (const item of Array.isArray(f.assets) ? f.assets : []) {
    const p = typeof item === 'string' ? item : item && typeof item === 'object' ? item.path : null;
    if (!p || typeof p !== 'string') continue;
    const path = clean(p);
    if (path.startsWith('packages/')) continue; // assets of another package
    assets.push({ path, dir: path.endsWith('/') });
  }
  const fonts = [];
  for (const fam of Array.isArray(f.fonts) ? f.fonts : []) {
    if (!fam || typeof fam !== 'object' || !fam.family) continue;
    const files = (Array.isArray(fam.fonts) ? fam.fonts : [])
      .map((x) => (x && typeof x === 'object' ? x.asset : null))
      .filter((x) => typeof x === 'string')
      .map(clean);
    fonts.push({ family: String(fam.family), files });
  }
  return { assets, fonts, generate: f.generate === true };
}

/** The `name:` of the pubspec. */
export const projectName = (doc) => (typeof doc.name === 'string' ? doc.name : null);
