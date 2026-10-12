// Orchestrates one scan: tree (sizes) → pubspec → Dart sources → images →
// assets audit → deps audit → score.

import { auditAssets } from './assets.js';
import { auditDeps, importsOf } from './deps.js';
import { densityGroups, densityOf, duplicates, estimateSavings, imageFlags, isImage, looksPhotographic } from './images.js';
import { dependencies, flutterSection, parseYaml, projectName, topLevelKeys } from './pubspec.js';
import { score } from './report.js';
import { extname, pool } from './util.js';

const IGNORED_DIRS = /(^|\/)(build|\.dart_tool|\.symlinks|ephemeral|Pods|node_modules)\//;
const GENERATED = /\.(g|freezed|gr|config|mocks)\.dart$/;
const NOT_BUNDLED = /^(android|ios|web|macos|windows|linux|build|test|integration_test|test_driver|\.dart_tool|\.github)\//;

export const DART_CAP = 3000;
export const DEFAULTS = { thresholdKb: 200, maxPx: 1500, inspectN: 12 };

/** The text without one top-level YAML block (e.g. `flutter:`, whose asset list is not a reference). */
export function dropTopLevel(text, key) {
  let skip = false;
  return String(text).replace(/\r/g, '').split('\n').filter((line) => {
    if (/^[^\s#]/.test(line)) skip = line.startsWith(`${key}:`);
    return !skip;
  }).join('\n');
}

/** `a/b/analysis_options.yaml` + `../x.yaml` → `a/x.yaml`; null when it leaves the repo. */
export function resolvePath(from, rel) {
  const parts = from.split('/').slice(0, -1);
  for (const seg of rel.split('/')) {
    if (seg === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else if (seg && seg !== '.') {
      parts.push(seg);
    }
  }
  return parts.join('/');
}

/** Directories ('' = root) holding a pubspec.yaml, root first. */
export function pubspecDirs(paths) {
  return paths
    .filter((p) => /(^|\/)pubspec\.yaml$/.test(p) && !IGNORED_DIRS.test(p))
    .map((p) => p.replace(/\/?pubspec\.yaml$/, ''))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}

/** The project's files (relative to its pubspec dir), without nested packages' files. */
export function projectFiles(entries, dir, allDirs) {
  const prefix = dir ? `${dir}/` : '';
  const nested = allDirs.filter((d) => d !== dir && (dir === '' || d.startsWith(prefix))).map((d) => `${d}/`);
  return entries
    .filter((e) => e.path.startsWith(prefix) && !nested.some((n) => e.path.startsWith(n)) && !IGNORED_DIRS.test(e.path))
    .map((e) => ({ ...e, path: e.path.slice(prefix.length) }));
}

/** Dart files worth reading, app code first: lib/ and bin/, then tests. */
export function dartFiles(files) {
  const dart = files.filter((f) => f.path.endsWith('.dart') && !GENERATED.test(f.path));
  const app = dart.filter((f) => /^(lib|bin)\//.test(f.path));
  const tests = dart.filter((f) => /^(test|integration_test|test_driver)\//.test(f.path));
  return { app, tests };
}

/**
 * @param o {{gh, owner, repo, ref, dir, entries, dirs, settings, onProgress, inspect?: (blob) => Promise}}
 */
export async function scan(o) {
  const { gh, owner, repo, ref, dir, entries, dirs, onProgress = () => {} } = o;
  const settings = { ...DEFAULTS, ...(o.settings || {}) };
  const join = (p) => (dir ? `${dir}/${p}` : p);
  onProgress('pubspec', 0, 1);
  const pubspecText = await gh.file(owner, repo, ref, join('pubspec.yaml'));
  if (pubspecText == null) throw Object.assign(new Error('no-pubspec'), { code: 'no-pubspec' });
  const doc = parseYaml(pubspecText);
  const flutter = flutterSection(doc);
  const files = projectFiles(entries, dir, dirs);
  const has = new Set(files.map((f) => f.path));

  // Small config files: lint includes, launcher icon / splash configs.
  const configNames = ['analysis_options.yaml', 'flutter_launcher_icons.yaml', 'flutter_native_splash.yaml', 'icons_launcher.yaml']
    .filter((n) => has.has(n));
  const configs = Object.fromEntries(await Promise.all(configNames.map(async (n) => [n, await gh.file(owner, repo, ref, join(n)).catch(() => '') || ''])));
  // Follow `include: ../analysis_options.yaml` chains inside the repo (workspaces, monorepos).
  // The analyzer uses the nearest analysis_options.yaml up the tree.
  const allPaths = new Set(entries.map((e) => e.path));
  let at = join('analysis_options.yaml');
  for (let d = dir; !allPaths.has(at) && d; d = d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '') {
    const parent = d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '';
    at = parent ? `${parent}/analysis_options.yaml` : 'analysis_options.yaml';
  }
  if (!configs['analysis_options.yaml'] && allPaths.has(at)) configs['analysis_options.yaml'] = await gh.file(owner, repo, ref, at).catch(() => '') || '';
  let analysis = configs['analysis_options.yaml'] || '';
  for (let hop = 0; hop < 3; hop++) {
    const inc = /^include:\s*['"]?([^'"\s#]+)/m.exec(analysis)?.[1];
    if (!inc || inc.startsWith('package:')) break;
    at = resolvePath(at, inc);
    if (!at || !allPaths.has(at)) break;
    const next = await gh.file(owner, repo, ref, at).catch(() => '') || '';
    configs['analysis_options.yaml'] = (configs['analysis_options.yaml'] || '') + '\n' + next;
    analysis = next;
  }

  // Dart sources.
  const { app, tests } = dartFiles(files);
  const picked = [...app, ...tests].slice(0, DART_CAP);
  const texts = new Map();
  let done = 0;
  await pool(picked, 12, async (f) => {
    texts.set(f.path, await gh.file(owner, repo, ref, join(f.path)).catch(() => null) || '');
    onProgress('dart', ++done, picked.length);
  });

  // Assets.
  const pubspecWithoutAssets = dropTopLevel(pubspecText, 'flutter');
  const configText = [pubspecWithoutAssets, ...Object.entries(configs).filter(([n]) => n !== 'analysis_options.yaml').map(([, t]) => t)].join('\n');
  const appSources = app.filter((f) => !/\.gen\.dart$/.test(f.path)).map((f) => texts.get(f.path) || '');
  const assets = auditAssets({ files, declarations: flutter.assets, fonts: flutter.fonts, sources: appSources, configText });

  // Dependencies.
  const imports = { lib: new Set(), bin: new Set(), test: new Set() };
  const identifiers = new Set();
  for (const [path, text] of texts) {
    const area = path.startsWith('lib/') ? 'lib' : path.startsWith('bin/') ? 'bin' : 'test';
    for (const name of importsOf(text)) imports[area].add(name);
    if (area !== 'test' && text.includes('CupertinoIcons')) identifiers.add('CupertinoIcons');
  }
  const deps = auditDeps({
    deps: dependencies(doc), imports, topKeys: topLevelKeys(doc),
    analysisOptions: configs['analysis_options.yaml'] || '',
    l10n: flutter.generate || has.has('l10n.yaml'), identifiers,
  });

  // Images: every bundled-looking bitmap in the project.
  const images = files.filter((f) => isImage(f.path) && !NOT_BUNDLED.test(f.path));
  const groups = densityGroups(images);
  const dupes = duplicates(images);
  const heaviest = [...images].sort((a, b) => b.size - a.size).slice(0, settings.inspectN);
  const px = new Map();
  const blobs = new Map();
  if (o.inspect && heaviest.length) {
    let n = 0;
    await pool(heaviest, 4, async (f) => {
      try {
        const blob = await gh.blob(owner, repo, ref, join(f.path));
        if (blob) {
          blobs.set(f.path, blob);
          px.set(f.path, await o.inspect(blob));
        }
      } catch { /* undecodable or LFS pointer: keep the byte size only */ }
      onProgress('images', ++n, heaviest.length);
    });
  }
  const assetStatus = new Map([...assets.unused, ...assets.maybe, ...assets.used, ...assets.config].map((a) => [a.path, a.status]));
  const imageRows = images.map((f) => {
    const p = px.get(f.path) || null;
    const format = extname(f.path) === 'jpg' ? 'jpeg' : extname(f.path);
    const photo = format === 'jpeg' || (!!p && format === 'png' && looksPhotographic({ bytes: f.size, ...p }));
    const est = estimateSavings({ format, bytes: f.size, photo, hasAlpha: p?.hasAlpha, width: p?.width, height: p?.height }, settings);
    const flags = imageFlags(f, p, groups.get(densityOf(f.path).base), dupes.get(f.path), settings);
    return { ...f, format, px: p, flags, est, dupes: dupes.get(f.path) || [], density: densityOf(f.path).density,
      missing: groups.get(densityOf(f.path).base)?.missing || [], usage: assetStatus.get(f.path) || 'undeclared' };
  }).sort((a, b) => b.size - a.size);

  const report = {
    owner, repo, ref, dir,
    project: projectName(doc),
    scannedAt: new Date().toISOString(),
    settings,
    images: imageRows,
    blobs,
    imageTotals: {
      count: imageRows.length,
      bytes: imageRows.reduce((n, r) => n + r.size, 0),
      flagged: imageRows.filter((r) => r.flags.length).length,
      saved: imageRows.reduce((n, r) => n + r.est.saved, 0),
      inspected: px.size,
    },
    assets,
    deps,
    dart: { total: app.length + tests.length, read: picked.length, truncated: app.length + tests.length > DART_CAP },
    declaredAssets: flutter.assets.length,
  };
  report.score = score(report);
  return report;
}
