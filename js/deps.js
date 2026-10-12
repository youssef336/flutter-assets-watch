// Unused dependencies: a pubspec entry nobody imports. Pure.
//
// Plenty of packages are legitimately never imported (code generators, lint
// sets, CLI tools, federated platform implementations, native-only libs), so
// each of those is explained instead of flagged.

/** `package:<name>/` imports (and exports / conditional imports) in one Dart file. */
export function importsOf(text) {
  return new Set([...String(text || '').matchAll(/['"]package:([a-z0-9_]+)\//g)].map((m) => m[1]));
}

const TOOLS = new Set([
  'build_runner', 'build_web_compilers', 'json_serializable', 'freezed', 'flutter_launcher_icons',
  'flutter_native_splash', 'icons_launcher', 'change_app_package_name', 'rename', 'rename_app', 'msix',
  'flutter_flavorizr', 'import_sorter', 'intl_utils', 'dart_code_metrics', 'dart_code_linter', 'lints',
  'flutter_lints', 'very_good_analysis', 'pedantic', 'effective_dart', 'custom_lint', 'dependency_validator',
  'drift_dev', 'moor_generator', 'husky', 'lint_staged', 'mason_cli', 'melos', 'flutter_oss_licenses', 'pubspec_dependency_sorter',
]);
const TOOL_PATTERN = /(_generator|_builder|_build_runner|_runner|_lints?|_codegen)$/;
const FEDERATED = /_(platform_interface|android|ios|web|macos|windows|linux|foundation|darwin|ohos)$/;
const NATIVE_ONLY = /_flutter_libs$|^sqlite3_flutter_libs$/;

/**
 * @param o {{deps: {name, section, source}[], imports: {lib: Set, bin: Set, test: Set},
 *   topKeys?: string[], analysisOptions?: string, l10n?: boolean, identifiers?: Set<string>}}
 * @returns {{name, section, status: 'used'|'test-only'|'allowed'|'unused', why: string}[]}
 */
export function auditDeps({ deps, imports, topKeys = [], analysisOptions = '', l10n = false, identifiers = new Set() }) {
  const app = new Set([...imports.lib, ...imports.bin]);
  const any = new Set([...app, ...imports.test]);
  const configured = new Set([...String(analysisOptions).matchAll(/package:([a-z0-9_]+)\//g)].map((m) => m[1]));
  const keys = new Set(topKeys);
  const generators = deps.some((d) => TOOL_PATTERN.test(d.name) || ['json_serializable', 'freezed', 'build_runner'].includes(d.name));
  const out = [];
  for (const d of deps) {
    if (d.name === 'flutter') continue;
    const row = { name: d.name, section: d.section, source: d.source, status: 'unused', why: '' };
    const allow = (why) => Object.assign(row, { status: 'allowed', why });
    if (d.section === 'main' ? app.has(d.name) : any.has(d.name)) {
      row.status = 'used';
    } else if (d.section === 'main' && imports.test.has(d.name)) {
      Object.assign(row, { status: 'test-only', why: 'test-only' });
    } else if (d.name === 'cupertino_icons') {
      if (identifiers.has('CupertinoIcons')) Object.assign(row, { status: 'used', why: 'font' });
      else row.why = 'cupertino-font';
    } else if ((d.name === 'flutter_localizations' || d.name === 'intl') && l10n) {
      allow('l10n');
    } else if (keys.has(d.name) || configured.has(d.name)) {
      allow('config');
    } else if (/_annotations?$/.test(d.name) && generators) {
      allow('codegen');
    } else if (TOOLS.has(d.name) || TOOL_PATTERN.test(d.name)) {
      allow('tool');
    } else if (FEDERATED.test(d.name)) {
      allow('federated');
    } else if (NATIVE_ONLY.test(d.name)) {
      allow('native');
    }
    out.push(row);
  }
  const order = { unused: 0, 'test-only': 1, allowed: 2, used: 3 };
  return out.sort((a, b) => order[a.status] - order[b.status] || a.section.localeCompare(b.section) || a.name.localeCompare(b.name));
}
