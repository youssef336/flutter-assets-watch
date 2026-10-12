// Every user-facing string of the page (Egyptian Arabic; file/package/API names stay English).

export const FLAG = {
  heavy: { label: 'تقيلة', hint: (s) => `أكبر من ${s.thresholdKb}KB` },
  'png-photo': { label: 'صورة فوتوغرافية PNG', hint: () => 'PNG لصورة فيها ألوان كتير — WebP أو JPEG هيطلع أصغر بكتير' },
  oversized: { label: 'أبعاد كبيرة', hint: (s) => `أطول ضلع أكبر من ${s.maxPx}px — شاشة الموبايل مش محتاجة كده` },
  'missing-variant': { label: 'ناقصها كثافة', hint: () => 'صور تانية في نفس الفولدر ليها 2.0x / 3.0x وهي لأ — هتطلع مغبّشة على شاشات كتير' },
  'no-base': { label: 'مفيش نسخة 1x', hint: () => 'فيه نسخ 2.0x / 3.0x بس من غير الأساسية' },
  'same-as-base': { label: 'نفس الـ 1x بالظبط', hint: () => 'نسخة الكثافة دي هي هي الملف الأساسي — بتاخد مساحة على الفاضي' },
  duplicate: { label: 'متكررة', hint: () => 'نفس الملف بالظبط موجود في مكان تاني' },
};

export const USAGE = {
  unused: 'مش مستخدمة',
  maybe: 'يمكن مستخدمة',
  config: 'config بس',
  undeclared: 'مش متعرّفة',
  used: '',
};

export const WHY = {
  path: 'المسار مكتوب في الكود',
  filename: 'اسم الملف مكتوب في الكود',
  constant: 'عن طريق constant مستخدم',
  flutter_gen: 'عن طريق flutter_gen (Assets.…)',
  config: 'مذكورة في config بس (أيقونة التطبيق / السبلاش) — غالبًا مش محتاجة تبقى في الـ bundle',
  stem: 'الاسم من غير امتداد موجود في string — غالبًا المسار بيتركّب',
  dir: 'الفولدر نفسه مذكور في الكود — يمكن بيتحمّل كله',
  'dead-constant': 'متسجّلة في constant محدش بيستخدمه',
};

export const DEP_WHY = {
  'test-only': 'مستخدم في test/ بس — انقله لـ dev_dependencies',
  'cupertino-font': 'مفيش CupertinoIcons في الكود — الباكدج ده خط أيقونات بس',
  l10n: 'بيستخدمه flutter gen-l10n (generate: true أو l10n.yaml)',
  config: 'متظبط في pubspec.yaml أو analysis_options.yaml',
  codegen: 'الكود المتولّد (.g.dart / .freezed.dart) بيحتاجه',
  tool: 'أداة أو مولّد كود — بيشتغل من سطر الأوامر مش import',
  federated: 'implementation لـ plugin — بيتسجّل native من غير import',
  native: 'بيوفّر مكتبات native بس',
  font: 'CupertinoIcons مستخدمة',
};

export const TILE = {
  heavy: { label: 'صور تقيلة', target: 'images-section' },
  variants: { label: 'مشاكل الكثافات والتكرار', target: 'images-section' },
  unusedAssets: { label: 'assets مش مستخدمة', target: 'assets-section' },
  undeclared: { label: 'مش متعرّفة في pubspec', target: 'assets-section' },
  missing: { label: 'متعرّفة ومش موجودة', target: 'assets-section' },
  unusedFonts: { label: 'خطوط مش مستخدمة', target: 'assets-section' },
  unusedDeps: { label: 'باكدجات مش مستخدمة', target: 'deps-section' },
};

export const KIND = {
  dart: 'كود Dart',
  engine: 'Flutter engine',
  native: 'مكتبات native',
  assets: 'assets',
  dex: 'Java / Kotlin (dex)',
  resources: 'resources',
  other: 'تاني',
};

export const HOW = {
  'jpeg->webp': 'JPEG ← WebP',
  'png-photo->webp': 'PNG ← WebP lossy',
  'png-photo-alpha->webp': 'PNG ← WebP lossy بالشفافية',
  'png->webp-lossless': 'PNG ← WebP lossless',
  'gif->webp': 'GIF ← WebP متحرك',
  keep: 'خليها',
};

export const ERROR = {
  'bad-url': 'اللينك ده مش لينك repo على GitHub. جرّب مثلًا https://github.com/owner/repo',
  'not-found': 'الـ repo أو الـ branch مش موجود — أو private ومحتاج token.',
  'rate-limit': 'GitHub وقف الطلبات مؤقتًا (60 طلب في الساعة من غير token). حط token من الإعدادات أو استنى شوية.',
  unauthorized: 'الـ token مش شغال أو ملوش صلاحية على الـ repo ده.',
  network: 'مشكلة في الاتصال. اتأكد من النت وجرّب تاني.',
  'no-pubspec': 'مفيش pubspec.yaml في المكان ده.',
  'no-flutter': 'مفيش أي pubspec.yaml في الـ repo ده — ده مش مشروع Dart/Flutter.',
  'bad-json': 'الملف ده مش JSON بتاع flutter build --analyze-size.',
  unknown: 'حصلت مشكلة غير متوقعة. جرّب تاني.',
};

export const STAGE = {
  locate: 'بقرا الـ repo…',
  pubspec: 'بقرا pubspec.yaml…',
  dart: 'بقرا ملفات Dart',
  images: 'بقيس أتقل الصور',
};
