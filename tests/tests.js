// Unit tests for the pure modules. Open tests/index.html (served over http) or
// run `bash tool/test.sh` for headless Chrome.

import { auditAssets, isDeclared, referenceOf, sourceIndex } from '../js/assets.js';
import { auditDeps, importsOf } from '../js/deps.js';
import { parseRepoInput } from '../js/github.js';
import { densityGroups, densityOf, duplicates, estimateSavings, imageFlags, looksPhotographic } from '../js/images.js';
import { dependencies, flutterSection, parseYaml, projectName } from '../js/pubspec.js';
import { counts, score, toMarkdown } from '../js/report.js';
import { dartFiles, dropTopLevel, projectFiles, pubspecDirs, resolvePath } from '../js/scan.js';
import { kindOf, packageOf, parseSizeJson, topContributors } from '../js/sizes.js';
import { squarify } from '../js/treemap.js';
import { camel, fmtBytes } from '../js/util.js';

const results = [];
let chain = Promise.resolve();
function testAsync(name, fn) {
  chain = chain.then(fn).then(() => results.push({ name, ok: true }), (e) => results.push({ name, ok: false, error: e.message }));
}
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
  }
}
function eq(actual, expected, msg = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg} expected ${b}, got ${a}`);
}
function ok(cond, msg = 'expected true') {
  if (!cond) throw new Error(msg);
}

// ---------- util ----------
test('fmtBytes and camel', () => {
  eq(fmtBytes(512), '512 B');
  eq(fmtBytes(1536), '1.5 KB');
  eq(fmtBytes(300 * 1024), '300 KB');
  eq(fmtBytes(5 * 1024 * 1024), '5.00 MB');
  eq(camel('ic_home-page 2'), 'icHomePage2');
  eq(camel('IconHome'), 'iconHome');
  eq(camel('ICON_HOME'), 'iconHome');
});

test('repo input forms', () => {
  eq(parseRepoInput('youssef336/Fruits_Hub'), { owner: 'youssef336', repo: 'Fruits_Hub', ref: null, path: null });
  eq(parseRepoInput('https://github.com/flutter/samples/tree/main/animations'), { owner: 'flutter', repo: 'samples', ref: 'main', path: 'animations' });
  eq(parseRepoInput('https://github.com/a/b/blob/dev/app/pubspec.yaml').path, 'app');
  let threw = false;
  try { parseRepoInput('https://gitlab.com/a/b'); } catch (e) { threw = e.code === 'bad-url'; }
  eq(threw, true);
});

// ---------- pubspec ----------
const PUBSPEC = `name: shop_app # the app
description: "A shop: fruits"
publish_to: 'none'
environment:
  sdk: ^3.5.0

dependencies:
  flutter:
    sdk: flutter
  flutter_localizations:
    sdk: flutter
  cupertino_icons: ^1.0.8
  dio: ^5.4.0   # http
  flutter_svg: ^2.0.10
  lottie: ^3.1.0
  shared_preferences: ^2.2.0
  sqlite3_flutter_libs: ^0.5.0
  my_core:
    path: ../core
  mocktail: ^1.0.0

dev_dependencies:
  flutter_test:
    sdk: flutter
  flutter_lints: ^4.0.0
  build_runner: ^2.4.0
  flutter_gen_runner: ^5.4.0
  flutter_launcher_icons: ^0.13.1
  very_unused_dev: ^1.0.0

flutter_launcher_icons:
  android: true
  image_path: "assets/icon/app_icon.png"

flutter:
  uses-material-design: true
  generate: true
  assets:
    - assets/images/
    - assets/translations/
    - assets/lottie/loading.json
    - path: assets/flavor/
      flavors:
        - staging
    - "assets/data/missing.json"
    # - assets/old/
  fonts:
    - family: Cairo
      fonts:
        - asset: assets/fonts/Cairo-Regular.ttf
        - asset: assets/fonts/Cairo-Bold.ttf
          weight: 700
    - family: Unused Serif
      fonts:
        - asset: assets/fonts/UnusedSerif.ttf
`;

test('yaml: scalars, comments, nested maps, list of maps', () => {
  const doc = parseYaml(PUBSPEC);
  eq(projectName(doc), 'shop_app');
  eq(doc.description, 'A shop: fruits');
  eq(doc.publish_to, 'none');
  eq(doc.environment.sdk, '^3.5.0');
  eq(doc.dependencies.dio, '^5.4.0');
  eq(doc.dependencies.flutter, { sdk: 'flutter' });
  eq(doc.flutter['uses-material-design'], true);
  eq(doc.flutter.fonts[1].family, 'Unused Serif');
  eq(doc.flutter.fonts[0].fonts[1], { asset: 'assets/fonts/Cairo-Bold.ttf', weight: '700' });
  eq(doc.flutter.assets[3], { path: 'assets/flavor/', flavors: ['staging'] });
});
test('yaml: same-indent lists, flow lists, block scalars, tabs-free oddities', () => {
  const doc = parseYaml('flutter:\n  assets:\n  - a/\n  - b.png\nlist: [x, "y", 3]\ntext: |\n  line one\n  line two\nafter: ok\n');
  eq(doc.flutter.assets, ['a/', 'b.png']);
  eq(doc.list, ['x', 'y', '3']);
  eq(doc.text, 'line one\nline two');
  eq(doc.after, 'ok');
  eq(parseYaml(''), {});
});
test('pubspec: dependencies with sources', () => {
  const deps = dependencies(parseYaml(PUBSPEC));
  eq(deps.find((d) => d.name === 'flutter_localizations'), { name: 'flutter_localizations', section: 'main', source: 'sdk' });
  eq(deps.find((d) => d.name === 'my_core').source, 'path');
  eq(deps.filter((d) => d.section === 'dev').map((d) => d.name),
    ['flutter_test', 'flutter_lints', 'build_runner', 'flutter_gen_runner', 'flutter_launcher_icons', 'very_unused_dev']);
});
test('pubspec: flutter assets (files, dirs, path: form) and fonts', () => {
  const f = flutterSection(parseYaml(PUBSPEC));
  eq(f.assets, [
    { path: 'assets/images/', dir: true },
    { path: 'assets/translations/', dir: true },
    { path: 'assets/lottie/loading.json', dir: false },
    { path: 'assets/flavor/', dir: true },
    { path: 'assets/data/missing.json', dir: false },
  ]);
  eq(f.fonts.map((x) => x.family), ['Cairo', 'Unused Serif']);
  eq(f.fonts[0].files, ['assets/fonts/Cairo-Regular.ttf', 'assets/fonts/Cairo-Bold.ttf']);
  eq(f.generate, true);
});
test('dropTopLevel removes only the named block', () => {
  eq(dropTopLevel('name: a\nflutter:\n  assets:\n    - x.png\nflutter_icons:\n  image: y.png\n', 'flutter'),
    'name: a\nflutter_icons:\n  image: y.png\n');
});

// ---------- scan helpers ----------
test('pubspec dirs and project files (nested packages excluded)', () => {
  const paths = ['pubspec.yaml', 'packages/core/pubspec.yaml', 'example/pubspec.yaml', 'build/x/pubspec.yaml'];
  eq(pubspecDirs(paths), ['', 'example', 'packages/core']);
  const entries = [{ path: 'lib/main.dart' }, { path: 'packages/core/lib/a.dart' }, { path: 'assets/a.png' }, { path: 'build/x.png' }];
  eq(projectFiles(entries, '', ['', 'packages/core']).map((e) => e.path), ['lib/main.dart', 'assets/a.png']);
  eq(projectFiles(entries, 'packages/core', ['', 'packages/core']).map((e) => e.path), ['lib/a.dart']);
});
test('resolvePath for analysis_options includes', () => {
  eq(resolvePath('apps/a/analysis_options.yaml', '../analysis_options.yaml'), 'apps/analysis_options.yaml');
  eq(resolvePath('analysis_options.yaml', 'tool/lints.yaml'), 'tool/lints.yaml');
  eq(resolvePath('analysis_options.yaml', '../x.yaml'), null);
});
test('dart files: generated skipped, app before tests', () => {
  const f = dartFiles([{ path: 'lib/a.dart' }, { path: 'lib/a.g.dart' }, { path: 'lib/gen/assets.gen.dart' }, { path: 'test/a_test.dart' }, { path: 'tool/x.dart' }]);
  eq(f.app.map((x) => x.path), ['lib/a.dart', 'lib/gen/assets.gen.dart']);
  eq(f.tests.map((x) => x.path), ['test/a_test.dart']);
});

// ---------- images ----------
test('density variants: base, missing, no base, same-as-base', () => {
  eq(densityOf('assets/images/2.0x/logo.png'), { base: 'assets/images/logo.png', density: 2 });
  eq(densityOf('assets/images/logo.png'), { base: 'assets/images/logo.png', density: 1 });
  const g = densityGroups([
    { path: 'img/logo.png', sha: 'a' }, { path: 'img/2.0x/logo.png', sha: 'b' }, { path: 'img/3.0x/logo.png', sha: 'c' },
    { path: 'img/bg.png', sha: 'd' }, { path: 'img/2.0x/bg.png', sha: 'd' },
    { path: 'img/3.0x/only.png', sha: 'e' },
    { path: 'other/plain.png', sha: 'f' },
  ]);
  eq(g.get('img/logo.png').missing, []);
  eq(g.get('img/bg.png').missing, [3]);
  eq(g.get('img/bg.png').sameAsBase, [2]);
  eq(g.get('img/only.png').noBase, true);
  eq(g.get('img/only.png').missing, [2]);
  eq(g.get('other/plain.png').missing, []);
});
test('duplicates by blob sha, ignoring variant-of-itself', () => {
  const d = duplicates([{ path: 'a/x.png', sha: '1' }, { path: 'b/y.png', sha: '1' }, { path: 'a/2.0x/x.png', sha: '1' }, { path: 'c.png', sha: '2' }]);
  eq(d.get('a/x.png'), ['b/y.png']);
  eq(d.get('b/y.png'), ['a/x.png', 'a/2.0x/x.png']);
  eq(d.has('c.png'), false);
});
test('photo heuristic', () => {
  eq(looksPhotographic({ uniqueRatio: 0.8 }), true);
  eq(looksPhotographic({ uniqueRatio: 0.05, bytes: 9e6, width: 100, height: 100 }), false);
  eq(looksPhotographic({ uniqueRatio: 0.3, bytes: 3e6, width: 1000, height: 1000 }), true);
  eq(looksPhotographic({ uniqueRatio: 0.3, bytes: 3e5, width: 1000, height: 1000 }), false);
});
test('savings estimator', () => {
  eq(estimateSavings({ format: 'png', bytes: 1000000, photo: true }), { after: 250000, saved: 750000, how: 'png-photo->webp', resize: 1 });
  eq(estimateSavings({ format: 'png', bytes: 1000, photo: false }).after, 740);
  eq(estimateSavings({ format: 'jpg', bytes: 1000 }).how, 'jpeg->webp');
  eq(estimateSavings({ format: 'webp', bytes: 1000 }), { after: 1000, saved: 0, how: 'keep', resize: 1 });
  const big = estimateSavings({ format: 'jpeg', bytes: 1000000, width: 3000, height: 2000 }, { maxPx: 1500 });
  eq(big.resize, 0.25);
  eq(big.after, 175000);
});
test('image flags', () => {
  const opts = { thresholdKb: 100, maxPx: 1500 };
  eq(imageFlags({ path: 'a/x.png', size: 300 * 1024 }, { width: 3000, height: 100, uniqueRatio: 0.9 }, null, null, opts), ['heavy', 'png-photo', 'oversized']);
  eq(imageFlags({ path: 'a/x.jpg', size: 10 }, { width: 100, height: 100, uniqueRatio: 0.9 }, null, ['b.jpg'], opts), ['duplicate']);
  const g = densityGroups([{ path: 'i/a.png', sha: '1' }, { path: 'i/2.0x/a.png', sha: '1' }, { path: 'i/3.0x/b.png', sha: '2' }]);
  eq(imageFlags({ path: 'i/a.png', size: 1 }, null, g.get('i/a.png'), null, opts), ['missing-variant']);
  eq(imageFlags({ path: 'i/2.0x/a.png', size: 1 }, null, g.get('i/a.png'), null, opts), ['same-as-base']);
  eq(imageFlags({ path: 'i/3.0x/b.png', size: 1 }, null, g.get('i/b.png'), null, opts), ['missing-variant', 'no-base']);
});

// ---------- assets ----------
test('isDeclared: directories are not recursive, variants ride along', () => {
  const decl = [{ path: 'assets/images/', dir: true }, { path: 'assets/logo.png', dir: false }];
  eq(isDeclared('assets/images/a.png', decl), true);
  eq(isDeclared('assets/images/2.0x/a.png', decl), true);
  eq(isDeclared('assets/images/icons/a.png', decl), false);
  eq(isDeclared('assets/2.0x/logo.png', decl), true);
  eq(isDeclared('assets/other.png', decl), false);
});
test('references: path, filename, constant, flutter_gen, stem, dir, dead constant', () => {
  const idx = sourceIndex([
    "Image.asset('assets/images/a.png');",
    "final b = '${base}b.png';",
    "class Img { static const logo = 'assets/images/logo.png'; static const dead = 'assets/images/dead.png'; }\nfinal w = Img.logo;",
    'Assets.images.icHome.image();',
    "final n = 'assets/icons/$name.svg'; final k = 'arrow';",
    "// Image.asset('assets/images/commented.png');",
  ]);
  eq(referenceOf('assets/images/a.png', idx).why, 'path');
  eq(referenceOf('assets/images/2.0x/a.png', idx).why, 'path');
  eq(referenceOf('assets/images/b.png', idx).why, 'filename');
  eq(referenceOf('assets/images/logo.png', idx).why, 'constant');
  eq(referenceOf('assets/images/dead.png', idx), { status: 'unused', why: 'dead-constant', names: ['dead'] });
  eq(referenceOf('assets/images/ic_home.png', idx).why, 'flutter_gen');
  eq(referenceOf('assets/icons/arrow.svg', idx), { status: 'maybe', why: 'stem' });
  eq(referenceOf('assets/icons/other.svg', idx), { status: 'maybe', why: 'dir' });
  eq(referenceOf('assets/images/commented.png', idx).status, 'unused');
  eq(referenceOf('assets/icon/app_icon.png', idx, 'image_path: "assets/icon/app_icon.png"').status, 'config');
});
test('asset audit: unused, undeclared, missing, fonts', () => {
  const f = flutterSection(parseYaml(PUBSPEC));
  const files = [
    'assets/images/used.png', 'assets/images/unused.png', 'assets/images/2.0x/used.png', 'assets/images/nested/lost.png',
    'assets/translations/en.json', 'assets/translations/ar.json', 'assets/lottie/loading.json', 'assets/flavor/s.json',
    'assets/fonts/Cairo-Regular.ttf', 'assets/fonts/Cairo-Bold.ttf', 'assets/fonts/UnusedSerif.ttf', 'assets/fonts/Stray.ttf',
    'assets/icon/app_icon.png', 'assets/.DS_Store', 'lib/main.dart', 'android/app/src/main/res/x.png',
  ].map((path, i) => ({ path, size: (i + 1) * 100 }));
  const a = auditAssets({
    files, declarations: f.assets, fonts: f.fonts, configText: 'image_path: "assets/icon/app_icon.png"',
    sources: ["Image.asset('assets/images/used.png'); Lottie.asset('assets/lottie/loading.json');",
      "EasyLocalization(path: 'assets/translations'); TextStyle(fontFamily: 'Cairo');"],
  });
  eq(a.unused.map((x) => x.path), ['assets/flavor/s.json', 'assets/images/unused.png']);
  eq(a.maybe.map((x) => x.path).sort(), ['assets/translations/ar.json', 'assets/translations/en.json']);
  eq(a.used.map((x) => x.path).sort(), ['assets/images/2.0x/used.png', 'assets/images/used.png', 'assets/lottie/loading.json']);
  eq(a.undeclared.map((x) => x.path).sort(), ['assets/fonts/Stray.ttf', 'assets/icon/app_icon.png', 'assets/images/nested/lost.png']);
  eq(a.missing.map((x) => x.path), ['assets/data/missing.json']);
  eq(a.unusedFonts.map((x) => x.family), ['Unused Serif']);
  eq(a.fonts[0].bytes, 900 + 1000);
});

test('asset audit: font files under a declared folder are judged by family only', () => {
  const a = auditAssets({
    files: [{ path: 'assets/fonts/A-Regular.ttf', size: 5 }, { path: 'assets/fonts/Loose.ttf', size: 7 }],
    declarations: [{ path: 'assets/fonts/', dir: true }],
    fonts: [{ family: 'A', files: ['assets/fonts/A-Regular.ttf'] }],
    sources: ["TextStyle(fontFamily: 'A')"],
  });
  eq(a.unused.map((x) => x.path), ['assets/fonts/Loose.ttf']);
  eq(a.unusedFonts, []);
});

// ---------- deps ----------
test('imports: import, export, conditional, quotes', () => {
  eq([...importsOf(`import 'package:dio/dio.dart';\nexport "package:a_b/x.dart";\nimport 'stub.dart' if (dart.library.io) 'package:io_x/io.dart';\nimport 'dart:io';`)],
    ['dio', 'a_b', 'io_x']);
});
test('unused deps: allowlists, test-only, cupertino, l10n, config', () => {
  const doc = parseYaml(PUBSPEC);
  const rows = auditDeps({
    deps: dependencies(doc),
    imports: { lib: new Set(['dio', 'flutter_svg', 'my_core']), bin: new Set(), test: new Set(['mocktail', 'flutter_test', 'lottie']) },
    topKeys: Object.keys(doc),
    analysisOptions: 'include: package:flutter_lints/flutter.yaml',
    l10n: true,
    identifiers: new Set(),
  });
  const by = Object.fromEntries(rows.map((r) => [r.name, `${r.status}${r.why ? `:${r.why}` : ''}`]));
  eq(by.dio, 'used');
  eq(by.shared_preferences, 'unused');
  eq(by.cupertino_icons, 'unused:cupertino-font');
  eq(by.flutter_localizations, 'allowed:l10n');
  eq(by.sqlite3_flutter_libs, 'allowed:native');
  eq(by.mocktail, 'test-only:test-only');
  eq(by.lottie, 'test-only:test-only');
  eq(by.flutter_test, 'used');
  eq(by.flutter_lints, 'allowed:config');
  eq(by.build_runner, 'allowed:tool');
  eq(by.flutter_gen_runner, 'allowed:tool');
  eq(by.flutter_launcher_icons, 'allowed:config');
  eq(by.very_unused_dev, 'unused');
  eq('flutter' in by, false);
  eq(rows[0].status, 'unused');
  const fed = auditDeps({ deps: [{ name: 'image_picker_android', section: 'main', source: 'hosted' }, { name: 'cupertino_icons', section: 'main', source: 'hosted' }],
    imports: { lib: new Set(), bin: new Set(), test: new Set() }, identifiers: new Set(['CupertinoIcons']) });
  eq(fed.map((r) => r.status), ['allowed', 'used']);
  const gen = auditDeps({ deps: [{ name: 'json_annotation', section: 'main', source: 'hosted' }, { name: 'json_serializable', section: 'dev', source: 'hosted' }],
    imports: { lib: new Set(), bin: new Set(), test: new Set() } });
  eq(gen.map((r) => `${r.name}:${r.why}`), ['json_serializable:tool', 'json_annotation:codegen']);
});

// ---------- sizes ----------
testAsync('size json: fixture parses into kinds, packages, contributors', async () => {
  const json = await (await fetch('fixtures/apk-code-size-analysis.json')).json();
  const s = parseSizeJson(json);
  eq(s.type, 'apk');
  eq(s.total, 17593400);
  eq(s.byKind.dart, 5400000);
  eq(s.byKind.engine, 4800000);
  eq(s.byKind.native, 620000);
  eq(s.byKind.dex, 2780000);
  ok(s.byKind.assets > 3000000, 'assets bucket');
  eq(Object.values(s.byKind).reduce((a, b) => a + b, 0), s.total, 'buckets add up');
  eq(s.dartPackages[0], { name: 'package:flutter', size: 5570000 });
  const top = topContributors(s, 20);
  eq(top.length, 20);
  eq(top[0].name, 'package:flutter');
  ok(top.some((c) => c.name.endsWith('onboarding_bg.png') && c.kind === 'assets'), 'asset contributor');
  ok(top.every((c, i) => i === 0 || top[i - 1].size >= c.size), 'sorted');
});
test('size json: minimal ios shape, value-less inner nodes, bad input', () => {
  const s = parseSizeJson(JSON.stringify({ n: 'Root', type: 'ios', children: [
    { n: 'Runner.app', children: [
      { n: 'Frameworks', children: [{ n: 'Flutter.framework', children: [{ n: 'Flutter', value: 900 }] },
        { n: 'App.framework', children: [{ n: 'App (Dart AOT)', value: 500, children: [{ n: 'package:a/b', children: [{ n: 'x', value: 70 }] }, { n: 'dart:core', value: 30 }] }] }] },
      { n: 'Assets.car', value: 40 }] }] }));
  eq(s.type, 'ios');
  eq(s.total, 1440);
  eq(s.byKind, { dart: 500, engine: 900, native: 0, assets: 0, dex: 0, resources: 40, other: 0 });
  eq(s.dartPackages, [{ name: 'package:a', size: 70 }, { name: 'dart:core', size: 30 }]);
  let code = '';
  try { parseSizeJson('{nope'); } catch (e) { code = e.code; }
  eq(code, 'bad-json');
  code = '';
  try { parseSizeJson({ hello: 1 }); } catch (e) { code = e.code; }
  eq(code, 'bad-json');
});
test('size kinds and package names', () => {
  eq(kindOf({ path: 'lib/arm64-v8a/libflutter.so (Flutter Engine)' }), 'engine');
  eq(kindOf({ path: 'lib/arm64-v8a/libsqlite3.so' }), 'native');
  eq(kindOf({ path: 'assets/flutter_assets/assets/a.png' }), 'assets');
  eq(kindOf({ path: 'classes2.dex' }), 'dex');
  eq(kindOf({ path: 'res/drawable/x.png' }), 'resources');
  eq(kindOf({ path: 'AndroidManifest.xml' }), 'other');
  eq(packageOf('package:flutter/src/material'), 'package:flutter');
  eq(packageOf('dart:core'), 'dart:core');
  eq(packageOf('@stubs/allocation-stubs'), '@stubs');
});

// ---------- treemap ----------
test('squarify: areas proportional, inside bounds, no overlap, decent aspect', () => {
  const values = [6, 6, 4, 3, 2, 2, 1];
  const rect = { x: 0, y: 0, w: 600, h: 400 };
  const rects = squarify(values, rect);
  eq(rects.length, 7);
  const total = values.reduce((a, b) => a + b, 0);
  for (const r of rects) {
    const want = (values[r.i] / total) * 600 * 400;
    ok(Math.abs(r.w * r.h - want) < 1e-6 * want + 1e-6, `area of ${r.i}`);
    ok(r.x >= -1e-9 && r.y >= -1e-9 && r.x + r.w <= 600 + 1e-6 && r.y + r.h <= 400 + 1e-6, `bounds of ${r.i}`);
  }
  for (const a of rects) for (const b of rects) {
    if (a === b) continue;
    const overlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 1e-6 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 1e-6;
    ok(!overlap, `overlap ${a.i}/${b.i}`);
  }
  const worst = Math.max(...rects.map((r) => Math.max(r.w / r.h, r.h / r.w)));
  ok(worst < 3.5, `aspect ${worst}`);
  // Classic example from the paper: 6,6,4,3,2,2,1 in 6×4 → first row is two 3×2 blocks.
  const paper = squarify(values, { x: 0, y: 0, w: 6, h: 4 });
  eq(paper.slice(0, 2).map((r) => [r.x, r.y, r.w, r.h].map((n) => Math.round(n * 100) / 100)), [[0, 0, 3, 2], [0, 2, 3, 2]]);
});
test('squarify: zeros, empty, single', () => {
  eq(squarify([], { x: 0, y: 0, w: 10, h: 10 }), []);
  eq(squarify([0, 0], { x: 0, y: 0, w: 10, h: 10 }), []);
  eq(squarify([0, 5], { x: 1, y: 2, w: 10, h: 10 }), [{ x: 1, y: 2, w: 10, h: 10, i: 1 }]);
});

// ---------- report ----------
test('score and markdown', () => {
  const r = {
    owner: 'o', repo: 'r', ref: 'main', dir: '', scannedAt: '2026-10-12T00:00:00Z',
    images: [{ path: 'a.png', size: 500000, flags: ['heavy', 'png-photo'], px: { width: 2000, height: 1000 }, est: { after: 125000 } }],
    imageTotals: { bytes: 500000, saved: 375000 },
    assets: { unused: [{ path: 'b.png', size: 10, why: '' }], undeclared: [], missing: [], missingFonts: [], unusedFonts: [] },
    deps: [{ name: 'x', section: 'main', status: 'unused' }, { name: 'y', section: 'main', status: 'used' }],
  };
  eq(counts(r).heavy, 1);
  eq(score(r), Math.round(100 - 3 - 1.5 - 4));
  r.score = score(r);
  const md = toMarkdown(r, { href: 'https://example.test/?repo=o/r' });
  ok(md.includes('**Score 92/100**'), 'score line');
  ok(md.includes('| `a.png` | 488 KB | 2000×1000 | heavy, png-photo | ~122 KB |'), 'image row');
  ok(md.includes('- `x`'), 'unused dep');
  ok(md.includes('### Unused assets'), 'unused section');
  ok(!md.includes('### Not declared'), 'empty sections are skipped');
});

// ---------- report ----------
await chain;
const failed = results.filter((r) => !r.ok);
document.getElementById('out').textContent = results
  .map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : ` — ${r.error}`}`).join('\n');
document.getElementById('summary').textContent = `${results.length - failed.length}/${results.length} passed`;
document.body.dataset.status = failed.length ? 'fail' : 'pass';
