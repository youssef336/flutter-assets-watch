// Reads the JSON written by `flutter build apk|appbundle|ios --analyze-size`.
//
// Shape (flutter_tools/lib/src/base/analyze_size.dart): every node is
// `{n: name, value?: bytes, children?: [...]}`; the root also carries `type`
// (apk | aab | ios | macos | windows | linux) and `precompiler-trace`. The Dart
// AOT file (name ending in " (Dart AOT)") has its children replaced by the
// snapshot treemap (`package:flutter/src/…`, `dart:core`, `@stubs`…), whose
// inner nodes carry no `value` — sizes are summed from the leaves, and are
// uncompressed bytes while the rest of the tree is compressed file sizes.

export const SIZE_KINDS = ['dart', 'engine', 'native', 'assets', 'dex', 'resources', 'other'];

const nameOf = (node) => String(node?.n ?? node?.name ?? '');

/** Normalised tree: `{name, size, path, kind, aot, children[]}`. Throws `bad-json` on anything else. */
export function parseSizeJson(input) {
  let raw = input;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      throw Object.assign(new Error('bad-json'), { code: 'bad-json' });
    }
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.children) || !('n' in raw || 'name' in raw)) {
    throw Object.assign(new Error('bad-json'), { code: 'bad-json' });
  }
  const type = typeof raw.type === 'string' ? raw.type : 'apk';
  const root = build(raw, '', false, 0);
  root.name = type;
  return { type, root, total: root.size, ...summarise(root) };
}

function build(node, parentPath, inAot, depth) {
  const name = nameOf(node);
  const path = depth === 0 ? '' : parentPath ? `${parentPath}/${name}` : name;
  const isAot = / \(Dart AOT\)$/.test(name);
  const aot = inAot || isAot;
  const kids = Array.isArray(node.children) && depth < 40
    ? node.children.filter((c) => c && typeof c === 'object').map((c) => build(c, path, aot, depth + 1))
    : [];
  const own = typeof node.value === 'number' ? node.value : typeof node.size === 'number' ? node.size : null;
  const sum = kids.reduce((n, c) => n + c.size, 0);
  const out = { name, path: path || name, size: own ?? sum, aot: inAot, isAot, children: kids };
  out.kind = kindOf(out);
  return out;
}

/** Bucket for one file/node outside the Dart snapshot. */
export function kindOf(node) {
  const p = node.path || node.name || '';
  if (node.isAot || node.aot) return 'dart';
  if (/\(Flutter Engine\)|(^|\/)libflutter\.so$|(^|\/)Flutter\.framework(\/|$)/.test(p)) return 'engine';
  if (/flutter_assets(\/|$)/.test(p)) return 'assets';
  if (/\.so$|\.framework(\/|$)|(^|\/)Frameworks(\/|$)|\.dylib$|\.dll$/.test(p)) return 'native';
  if (/\.dex$/.test(p)) return 'dex';
  if (/(^|\/)res(\/|$)|resources\.arsc$|\.car$|\.nib$|\.storyboardc|\.lproj(\/|$)/.test(p)) return 'resources';
  return 'other';
}

/** Package (or dart: library, or @bucket) a snapshot node belongs to. */
export function packageOf(name) {
  const m = /^(package:[^/]+|dart:[^/]+|@[^/]+)/.exec(name);
  return m ? m[1] : name;
}

const hasAot = (node) => node.isAot || node.children.some(hasAot);

function summarise(root) {
  const byKind = Object.fromEntries(SIZE_KINDS.map((k) => [k, 0]));
  const contributors = [];
  const dartPkgs = new Map();
  const visit = (node) => {
    if (node.isAot) {
      byKind.dart += node.size;
      for (const c of node.children) {
        const pkg = packageOf(c.name);
        dartPkgs.set(pkg, (dartPkgs.get(pkg) || 0) + c.size);
      }
      return;
    }
    // Group a whole .framework (iOS/macOS) into one contributor.
    if (/\.framework$/.test(node.name) && node.children.length && !hasAot(node)) {
      byKind[kindOf(node)] += node.size;
      contributors.push({ name: node.path, size: node.size, kind: kindOf(node) });
      return;
    }
    if (!node.children.length) {
      if (node !== root) {
        byKind[node.kind] += node.size;
        contributors.push({ name: node.path, size: node.size, kind: node.kind });
      }
      return;
    }
    node.children.forEach(visit);
  };
  visit(root);
  for (const [pkg, size] of dartPkgs) contributors.push({ name: pkg, size, kind: 'dart', uncompressed: true });
  contributors.sort((a, b) => b.size - a.size);
  const dartPackages = [...dartPkgs].map(([name, size]) => ({ name, size })).sort((a, b) => b.size - a.size);
  return { byKind, contributors, dartPackages };
}

/** Top-n contributors (dart packages, native libs, assets…). */
export const topContributors = (parsed, n = 20) => parsed.contributors.slice(0, n);
