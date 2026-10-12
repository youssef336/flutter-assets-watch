// Page controller: form → locate repo → scan → render. State lives in the URL
// (?repo=owner/name&ref=…&path=…) so every report is a shareable link.

import { GitHub, GitHubError, parseRepoInput } from './github.js';
import { DEP_WHY, ERROR, FLAG, HOW, STAGE, TILE, USAGE, WHY } from './labels.js';
import { inspect, toWebp } from './pixels.js';
import { counts, grade, toMarkdown } from './report.js';
import { DEFAULTS, pubspecDirs, scan } from './scan.js';
import { parseSizeJson } from './sizes.js';
import { renderSize } from './sizeview.js';
import { esc, fmtBytes } from './util.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } },
};

// Token and theme share their keys with Flutter Deps Watch (same origin): set once, works in both.
let sessionToken = store.get('fdw.token') || '';
const settings = (() => {
  try { return { ...DEFAULTS, ...JSON.parse(store.get('faw.settings') || '{}') }; } catch { return { ...DEFAULTS }; }
})();
const state = { report: null, busy: false, allImages: false, size: null, redraw: null, gh: null, urls: [] };
const IMAGE_PAGE = 40;

// ---------- theme ----------
const savedTheme = store.get('fdw.theme');
if (savedTheme) document.documentElement.dataset.theme = savedTheme;
$('theme-btn').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  store.set('fdw.theme', next);
});

// ---------- settings ----------
function renderLimits() {
  $('limits').textContent = `تقيلة فوق ${settings.thresholdKb}KB · أقصى أبعاد ${settings.maxPx}px · بقيس أتقل ${settings.inspectN} صورة`;
}
function openSettings() {
  $('token-input').value = sessionToken;
  $('token-remember').checked = !!store.get('fdw.token');
  $('kb-input').value = settings.thresholdKb;
  $('px-input').value = settings.maxPx;
  $('n-input').value = settings.inspectN;
  $('settings').showModal();
}
$('settings-btn').addEventListener('click', openSettings);
$('limits-btn').addEventListener('click', openSettings);
$('settings').addEventListener('close', () => {
  if ($('settings').returnValue !== 'save') return;
  sessionToken = $('token-input').value.trim();
  store.set('fdw.token', $('token-remember').checked && sessionToken ? sessionToken : null);
  const num = (id, min, max, fallback) => {
    const v = Math.round(Number($(id).value));
    return Number.isFinite(v) && v >= min && v <= max ? v : fallback;
  };
  settings.thresholdKb = num('kb-input', 10, 10000, DEFAULTS.thresholdKb);
  settings.maxPx = num('px-input', 200, 8000, DEFAULTS.maxPx);
  settings.inspectN = num('n-input', 0, 60, DEFAULTS.inspectN);
  store.set('faw.settings', JSON.stringify(settings));
  renderLimits();
  toast(state.report ? 'اتحفظت الإعدادات — افحص تاني عشان تتطبّق' : 'اتحفظت الإعدادات');
});

// ---------- recent ----------
function recent() {
  try { return JSON.parse(store.get('faw.recent') || '[]'); } catch { return []; }
}
function remember(slug) {
  store.set('faw.recent', JSON.stringify([slug, ...recent().filter((s) => s !== slug)].slice(0, 8)));
  renderRecent();
}
function renderRecent() {
  const list = recent();
  $('recent').hidden = !list.length;
  $('recent').innerHTML = '<span class="muted">آخر حاجات:</span>' +
    list.map((s) => `<button type="button" class="chip" data-slug="${esc(s)}">${esc(s)}</button>`).join('');
}
$('recent').addEventListener('click', (e) => {
  const slug = e.target.closest('[data-slug]')?.dataset.slug;
  if (!slug) return;
  $('repo-input').value = slug;
  start(slug);
});

// ---------- flow ----------
$('scan-form').addEventListener('submit', (e) => {
  e.preventDefault();
  start($('repo-input').value);
});

async function start(input, chosenDir) {
  if (state.busy) return;
  hide('error'); hide('picker');
  let target;
  try {
    target = parseRepoInput(input);
  } catch (e) {
    return fail(e);
  }
  setBusy(true);
  progress(STAGE.locate, 0);
  const gh = new GitHub(sessionToken);
  try {
    const info = await gh.repo(target.owner, target.repo);
    const ref = target.ref || info.defaultBranch;
    const { entries, truncated } = await gh.tree(target.owner, target.repo, ref);
    const dirs = pubspecDirs(entries.map((e) => e.path));
    if (!dirs.length) throw Object.assign(new Error(), { code: 'no-flutter' });
    let dir = chosenDir ?? target.path;
    if (dir == null) {
      const apps = dirs.filter((d) => !/(^|\/)example$/.test(d));
      if (apps.length > 1) {
        setBusy(false);
        hide('progress');
        return pick(input, apps);
      }
      dir = apps[0] ?? dirs[0];
    }
    const report = await scan({
      gh, owner: target.owner, repo: target.repo, ref, dir, entries, dirs, settings: { ...settings }, inspect,
      onProgress: (stage, done, total) => progress(
        total > 1 ? `${STAGE[stage]} (${done}/${total})` : STAGE[stage], total ? done / total : 0),
    });
    report.treeTruncated = truncated;
    report.private = info.private;
    report.apiCalls = gh.apiCalls;
    for (const u of state.urls) URL.revokeObjectURL(u);
    state.urls = [];
    state.report = report;
    state.gh = gh;
    state.allImages = $('show-all-images').checked = false;
    const slug = `${target.owner}/${target.repo}`;
    remember(slug);
    const q = new URLSearchParams({ repo: slug });
    if (target.ref) q.set('ref', ref);
    if (dir || dirs.length > 1) q.set('path', dir);
    history.replaceState(null, '', `?${q}`);
    document.title = `${report.project || target.repo} · Flutter Assets Watch`;
    render();
  } catch (e) {
    fail(e);
  } finally {
    setBusy(false);
    hide('progress');
  }
}

function pick(input, dirs) {
  $('picker-list').innerHTML = dirs
    .map((d) => `<button type="button" class="chip" data-dir="${esc(d)}">${esc(d || '/ (الجذر)')}</button>`).join('');
  show('picker');
  $('picker-list').onclick = (e) => {
    const b = e.target.closest('[data-dir]');
    if (b) start(input, b.dataset.dir);
  };
}

function fail(e, box = 'error') {
  const code = e instanceof GitHubError || e?.code ? e.code : 'unknown';
  if (code === 'unknown') console.error(e);
  $(box).textContent = ERROR[code] || ERROR.unknown;
  show(box);
}
function setBusy(on) {
  state.busy = on;
  $('scan-btn').disabled = on;
  $('scan-btn').textContent = on ? 'بيفحص…' : 'افحص';
}
function progress(text, frac) {
  show('progress');
  $('progress-text').textContent = text;
  $('progress-fill').style.width = `${Math.round(Math.min(1, frac) * 100)}%`;
}

// ---------- render ----------
function render() {
  const r = state.report;
  show('report');
  $('hero').hidden = true;
  renderProject(r);
  renderSummary(r);
  renderImages();
  renderAssets(r);
  renderDeps(r);
}

function renderProject(r) {
  const where = `${r.owner}/${r.repo}` + (r.dir ? `/${r.dir}` : '');
  const ghUrl = `https://github.com/${r.owner}/${r.repo}/tree/${encodeURIComponent(r.ref)}${r.dir ? `/${r.dir}` : ''}`;
  $('project').innerHTML = `
    <div>
      <h2>${esc(r.project || r.repo)}</h2>
      <div class="project-meta">
        <span dir="ltr"><a href="${esc(ghUrl)}" target="_blank" rel="noopener">${esc(where)}</a> @ ${esc(r.ref)}</span>
        <span>${r.images.length} صورة (${esc(fmtBytes(r.imageTotals.bytes))}) · ${r.dart.read} ملف Dart · ${r.declaredAssets} سطر assets</span>
        <span>${r.apiCalls} طلب GitHub API · اتفحص ${esc(new Date(r.scannedAt).toLocaleString('ar-EG'))}</span>
        ${r.treeTruncated ? '<span class="warn">الـ repo كبير وGitHub قطع شجرة الملفات — النتايج ناقصة</span>' : ''}
        ${r.dart.truncated ? `<span class="warn">قريت أول ${r.dart.read} ملف Dart بس من ${r.dart.total}</span>` : ''}
      </div>
    </div>
    <div class="project-actions">
      <button type="button" class="btn sm" id="copy-link">انسخ لينك التقرير</button>
      <button type="button" class="btn sm" id="copy-md">انسخ التقرير Markdown</button>
      <button type="button" class="btn sm" id="rescan">افحص تاني</button>
    </div>`;
  $('copy-link').onclick = () => copy(location.href, 'اتنسخ اللينك');
  $('copy-md').onclick = () => copy(toMarkdown(r, { href: location.href, size: state.size }), 'اتنسخ التقرير — حطه في PR أو issue');
  $('rescan').onclick = () => start(`https://github.com/${r.owner}/${r.repo}/tree/${r.ref}`, r.dir);
}

function renderSummary(r) {
  const c = counts(r);
  $('score').className = `score ${grade(r.score)}`;
  $('score').innerHTML = `<b>${r.score}</b><span>من 100</span>`;
  $('strip').innerHTML = Object.entries(TILE).map(([k, t]) => `
    <button type="button" class="tile${c[k] ? '' : ' zero clean'}" data-target="${t.target}">
      <b>${c[k]}</b><span>${esc(t.label)}</span>
    </button>`).join('');
  $('strip').onclick = (e) => {
    const t = e.target.closest('[data-target]')?.dataset.target;
    if (t) $(t).scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
}

$('show-all-images').addEventListener('change', (e) => { state.allImages = e.target.checked; renderImages(); });

function renderImages(limit = IMAGE_PAGE) {
  const r = state.report;
  if (!r) return;
  const t = r.imageTotals;
  $('images-summary').innerHTML = !r.images.length ? 'مفيش صور (png / jpg / webp / gif) في المشروع.' :
    `${r.images.length} صورة، مجموعها <b dir="ltr">${esc(fmtBytes(t.bytes))}</b>. قِسْت أبعاد أتقل ${t.inspected}. ` +
    (t.saved > 1024 ? `لو اتحوّلوا WebP (وصغّرت اللي أكبر من ${r.settings.maxPx}px) هتوفّر حوالي <b dir="ltr">${esc(fmtBytes(t.saved))}</b> — <span class="muted">تقدير تقريبي، جرّب التحويل الحقيقي على أي صورة.</span>` : '');
  const rows = state.allImages ? r.images : r.images.filter((i) => i.flags.length || i.usage === 'unused' || i.usage === 'undeclared');
  $('images').innerHTML = rows.length
    ? rows.slice(0, limit).map(imageCard).join('') +
      (rows.length > limit ? `<div class="more"><button type="button" class="btn sm" id="more-images">اظهر ${Math.min(IMAGE_PAGE, rows.length - limit)} كمان (من ${rows.length - limit})</button></div>` : '')
    : `<div class="empty muted">${r.images.length ? 'مفيش صورة عليها ملاحظات 👌' : 'مفيش صور.'}</div>`;
  const more = $('more-images');
  if (more) more.onclick = () => renderImages(limit + IMAGE_PAGE);
}

function thumbUrl(path) {
  const blob = state.report.blobs.get(path);
  if (!blob) return null;
  const u = URL.createObjectURL(blob);
  state.urls.push(u);
  return u;
}

function imageCard(img) {
  const r = state.report;
  const s = r.settings;
  const url = thumbUrl(img.path);
  const ghBlob = `https://github.com/${r.owner}/${r.repo}/blob/${encodeURIComponent(r.ref)}/${r.dir ? `${r.dir}/` : ''}${img.path}`;
  const flags = img.flags.map((f) => {
    const cls = f === 'heavy' || f === 'oversized' || f === 'png-photo' ? 'warn' : 'info';
    let hint = FLAG[f].hint(s);
    if (f === 'duplicate') hint += `: ${img.dupes.join(', ')}`;
    if (f === 'missing-variant') hint += ` (ناقص ${img.missing.map((d) => `${d.toFixed(1)}x`).join(' و ')})`;
    return `<span class="badge ${cls}" title="${esc(hint)}">${esc(FLAG[f].label)}</span>`;
  });
  if (USAGE[img.usage]) flags.push(`<span class="badge ${img.usage === 'unused' || img.usage === 'undeclared' ? 'bad' : 'neutral'}">${esc(USAGE[img.usage])}</span>`);
  const est = img.est.saved > 512
    ? `<div class="est">${esc(HOW[img.est.how])}${img.est.resize < 1 ? ` + تصغير لـ ${s.maxPx}px` : ''}: حوالي <b dir="ltr">${esc(fmtBytes(img.est.after))}</b> (تقدير)</div>` : '';
  const why = img.flags.map((f) => FLAG[f].hint(s)).join(' · ');
  return `
  <article class="img" data-path="${esc(img.path)}">
    <div class="thumb">${url ? `<img src="${url}" alt="" loading="lazy">` : esc(img.format.toUpperCase())}</div>
    <div>
      <div class="path">${esc(img.path)}</div>
      <div class="meta"><b>${esc(fmtBytes(img.size))}</b>${img.px ? ` · ${img.px.width}×${img.px.height}px` : ''}${img.density !== 1 ? ` · ${img.density.toFixed(1)}x` : ''}${img.px?.hasAlpha ? ' · alpha' : ''}</div>
      ${flags.length ? `<div class="flags" title="${esc(why)}">${flags.join('')}</div>` : ''}
      ${est}
    </div>
    <div class="img-actions">
      ${img.format !== 'gif' ? '<button type="button" class="btn sm" data-act="webp">جرّب WebP</button>' : ''}
      <a class="btn sm" href="${esc(ghBlob)}" target="_blank" rel="noopener">GitHub</a>
    </div>
  </article>`;
}

$('images').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act="webp"], [data-act="reconvert"]');
  if (!btn) return;
  const card = btn.closest('.img');
  const path = card.dataset.path;
  let panel = card.querySelector('.convert');
  if (btn.dataset.act === 'webp' && panel) {
    panel.remove();
    return;
  }
  if (!panel) {
    panel = document.createElement('div');
    panel.className = 'convert';
    panel.innerHTML = `
      <div class="convert-opts">
        <label class="select-label">الجودة <select data-q>
          <option value="0.6">60</option><option value="0.75">75</option><option value="0.8" selected>80</option><option value="0.9">90</option><option value="1">lossless-ish 100</option>
        </select></label>
        <label class="check"><input type="checkbox" data-resize checked> صغّر لـ ${state.report.settings.maxPx}px لو أكبر</label>
        <button type="button" class="btn sm" data-act="reconvert">حوّل</button>
      </div>
      <div data-out class="muted small">بحمّل الصورة…</div>`;
    card.append(panel);
  }
  const out = panel.querySelector('[data-out]');
  out.textContent = 'بحوّل…';
  try {
    const r = state.report;
    let blob = r.blobs.get(path);
    if (!blob) {
      blob = await state.gh.blob(r.owner, r.repo, r.ref, r.dir ? `${r.dir}/${path}` : path);
      if (!blob) throw new Error('missing');
      r.blobs.set(path, blob);
    }
    const quality = Number(panel.querySelector('[data-q]').value);
    const maxPx = panel.querySelector('[data-resize]').checked ? r.settings.maxPx : 0;
    const res = await toWebp(blob, { quality, maxPx });
    const before = URL.createObjectURL(blob);
    const after = URL.createObjectURL(res.blob);
    state.urls.push(before, after);
    const delta = blob.size ? Math.round((1 - res.blob.size / blob.size) * 100) : 0;
    const name = path.split('/').pop().replace(/\.\w+$/, '') + (res.webp ? '.webp' : '.png');
    out.className = '';
    out.innerHTML = `
      ${res.webp ? '' : '<p class="warn small">المتصفح ده مبيعرفش يعمل WebP (Safari قديم؟) — طلّع PNG بدلها. جرّب Chrome أو Firefox.</p>'}
      <div class="compare">
        <figure><img src="${before}" alt="قبل"><figcaption>قبل: <b>${esc(fmtBytes(blob.size))}</b></figcaption></figure>
        <figure><img src="${after}" alt="بعد"><figcaption>بعد: <b>${esc(fmtBytes(res.blob.size))}</b> · ${res.width}×${res.height}px ·
          ${delta >= 0 ? `أصغر بـ ${delta}%` : `أكبر بـ ${-delta}% — خليها زي ما هي`}</figcaption></figure>
      </div>
      <p class="small"><a class="btn sm" href="${after}" download="${esc(name)}">نزّل ${esc(name)}</a>
        <span class="muted">الحجم ده حقيقي من المتصفح بتاعك. اعملها بـ <code dir="ltr">cwebp -q ${Math.round(quality * 100)}</code> لو عايز نفس النتيجة من سطر الأوامر.</span></p>`;
  } catch (err) {
    console.warn(err);
    out.textContent = 'مقدرتش أحوّل الصورة دي (يمكن متخزّنة بـ Git LFS أو الصيغة مش مدعومة).';
  }
});

function rowsList(rows, fmt) {
  return `<ul class="rows">${rows.map(fmt).join('')}</ul>`;
}
function fileRow(a, why = '') {
  return `<li><span class="name">${esc(a.path)}</span><span class="size">${esc(fmtBytes(a.size))}</span>${why ? `<span class="why">${esc(why)}</span>` : ''}</li>`;
}
function group(title, rows, body, hint = '', open = true) {
  if (!rows.length) return '';
  const size = rows.reduce((n, x) => n + (x.size || x.bytes || 0), 0);
  return `<h3>${esc(title)} <span class="count">${rows.length}${size ? ` · ${esc(fmtBytes(size))}` : ''}</span></h3>
    ${hint ? `<p class="muted small">${hint}</p>` : ''}${open ? body : `<details class="fold"><summary>اعرضهم</summary>${body}</details>`}`;
}

function renderAssets(r) {
  const a = r.assets;
  const deadWhy = (x) => (x.why === 'dead-constant' ? `${WHY['dead-constant']}: ${x.names.join(', ')}` : x.explicit ? 'متعرّفة باسمها في pubspec' : 'جوه فولدر متعرّف');
  const html = [
    group('مش مستخدمة', a.unused, rowsList(a.unused, (x) => fileRow(x, deadWhy(x))),
      'متعرّفة في pubspec وبتتشحن مع التطبيق، ومفيش لا مسارها ولا اسم ملفها ولا اسمها في flutter_gen في أي string في <code>lib/</code>.'),
    group('متعرّفة ومش موجودة', [...a.missing.map((m) => ({ path: m.path })), ...a.missingFonts.map((p) => ({ path: p }))],
      rowsList([...a.missing.map((m) => ({ path: m.path })), ...a.missingFonts.map((p) => ({ path: p }))],
        (x) => `<li><span class="name">${esc(x.path)}</span><span class="size">—</span></li>`),
      'السطر ده في pubspec بيشاور على حاجة مش في الـ repo — <code>flutter build</code> هيفشل أو الفولدر فاضي.'),
    group('خطوط مش مستخدمة', a.unusedFonts,
      rowsList(a.unusedFonts, (f) => `<li><span class="name">${esc(f.family)}</span><span class="size">${esc(fmtBytes(f.bytes))}</span><span class="why" dir="ltr">${esc(f.files.join(', '))}</span></li>`),
      'الـ family دي متعرّفة في <code>fonts:</code> ومحدش بيكتب اسمها في <code>fontFamily</code> ولا <code>FontFamily.…</code>.'),
    group('موجودة ومش متعرّفة في pubspec', a.undeclared, rowsList(a.undeclared, (x) => fileRow(x, x.font ? 'ملف خط مش في fonts:' : '')),
      'ملفات جوه فولدرات الـ assets بس مش داخلة في أي سطر في pubspec (خلي بالك: تعريف فولدر مش بيدخّل الفولدرات اللي جواه). يا إما تمسحها، يا إما تعرّفها لو محتاجها.', a.undeclared.length <= 15),
    group('في config بس', a.config, rowsList(a.config, (x) => fileRow(x, WHY.config)), '', a.config.length <= 10),
    group('يمكن مستخدمة', a.maybe, rowsList(a.maybe, (x) => fileRow(x, WHY[x.why])),
      'مش لاقي المسار كامل، بس فيه دليل إنه بيتركّب في الكود. راجعها بإيدك.', false),
  ].join('');
  $('assets').innerHTML = html || `<div class="empty muted">${r.declaredAssets || a.fonts.length ? 'كل الـ assets مستخدمة ومتعرّفة صح 👌' : 'المشروع مفيهوش assets متعرّفة في pubspec.'}</div>`;
  if (a.used.length) $('assets').insertAdjacentHTML('beforeend', `<p class="muted small">${a.used.length} asset مستخدمة.</p>`);
}

function renderDeps(r) {
  const of = (s) => r.deps.filter((d) => d.status === s);
  const row = (d) => `<li><span class="name">${esc(d.name)}</span><span class="size">${d.section === 'dev' ? 'dev' : ''}${d.source !== 'hosted' ? ` ${esc(d.source)}` : ''}</span>${d.why ? `<span class="why">${esc(DEP_WHY[d.why] || d.why)}</span>` : ''}</li>`;
  const unusedMain = of('unused').filter((d) => d.section === 'main');
  const unusedDev = of('unused').filter((d) => d.section === 'dev');
  const removeCmd = unusedMain.length + unusedDev.length
    ? `<div class="cmd"><code>flutter pub remove ${esc([...unusedMain, ...unusedDev].map((d) => d.name).join(' '))}</code><button type="button" class="btn sm" data-copy="flutter pub remove ${esc([...unusedMain, ...unusedDev].map((d) => d.name).join(' '))}">انسخ</button></div>` : '';
  const html = [
    group('dependencies مش مستخدمة', unusedMain, rowsList(unusedMain, row), 'بتتبني مع التطبيق (ولو plugin بتزوّد الـ native كمان) ومحدش بيعملها import.'),
    group('مستخدمة في التستات بس', of('test-only'), rowsList(of('test-only'), row)),
    group('dev_dependencies مش مستخدمة', unusedDev, rowsList(unusedDev, row)),
    removeCmd ? `<p class="muted small">اتأكد الأول إنها مش مستخدمة من native أو من script، وبعدين:</p>${removeCmd}` : '',
    group('مش متعمل لها import بس ليها سبب', of('allowed'), rowsList(of('allowed'), row), '', false),
  ].join('');
  $('deps').innerHTML = html.trim() ? html : '<div class="empty muted">كل الباكدجات مستخدمة 👌</div>';
  const used = of('used').length;
  if (used) $('deps').insertAdjacentHTML('beforeend', `<p class="muted small">${used} باكدج مستخدمة.</p>`);
}

// ---------- size panel ----------
async function loadSize(textOrObject) {
  hide('size-error');
  try {
    state.size = parseSizeJson(textOrObject);
    state.redraw = renderSize($('size'), state.size);
    $('size').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    state.size = null;
    $('size').innerHTML = '';
    fail(e.code ? e : { code: 'bad-json' }, 'size-error');
  }
}
$('size-file').addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  if (f) loadSize(await f.text());
  e.target.value = '';
});
const drop = $('drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', async (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const f = e.dataTransfer?.files?.[0];
  if (f) loadSize(await f.text());
});
$('size-sample').addEventListener('click', async () => {
  try {
    loadSize(await (await fetch('tests/fixtures/apk-code-size-analysis.json')).text());
  } catch {
    fail({ code: 'network' }, 'size-error');
  }
});
let resizeTimer;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => state.redraw?.(), 120);
}).observe($('size'));

// ---------- copy buttons anywhere ----------
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-copy]');
  if (b) copy(b.dataset.copy, 'اتنسخ الأمر');
});

// ---------- helpers ----------
function show(id) { $(id).hidden = false; }
function hide(id) { $(id).hidden = true; }
async function copy(text, done) {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    toast('مقدرتش أنسخ — انسخه بإيدك');
  }
}
let toastTimer;
function toast(text) {
  $('toast').textContent = text;
  show('toast');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => hide('toast'), 2200);
}

// ---------- boot ----------
renderLimits();
renderRecent();
const params = new URLSearchParams(location.search);
if (params.get('repo')) {
  const ref = params.get('ref');
  const path = params.get('path');
  const input = `https://github.com/${params.get('repo')}${ref ? `/tree/${ref}${path ? `/${path}` : ''}` : ''}`;
  $('repo-input').value = params.get('repo');
  start(input, path ?? undefined);
}
