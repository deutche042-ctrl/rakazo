# جرد الكود الميت — الموجة الأولى (تنظيف البقايا)

> **حالة هذه الموجة:** جرد فقط. **لم يُحذف ولم يُعدَّل أي ملف** ضمن هذه الموجة.
> لم يُشغَّل `pnpm check` ولا `build` ولا أي اختبار (ممنوع في هذا المسار)؛ كل الاستنتاجات أدناه مبنية على القراءة و`grep`/`node` للقراءة فقط، لا على تشغيل الفحوصات.

جذر المستودع الذي نُفِّذت منه كل الأوامر: `/home/mahmoud/Documents/my-bots-rakazo/rakazo`
(تأكيد: `git rev-parse --show-toplevel`).

---

## ١. المنهجية والأوامر المستخدمة

| الفحص | الأمر | النتيجة |
| --- | --- | --- |
| مراجع كتالوجات الترجمة | `grep -rIn -E 'translations-(de\|es\|hi\|ko\|pt-BR\|tr\|zh-CN)\.json' . --exclude-dir={node_modules,.git,.turbo,.mimosa,.zcode,.v2c}` | `exit=1` (صفر مراجع) |
| `msgids` | `grep -rIn 'msgids' . --exclude-dir=…` | سطران فقط: `.gitignore:51`, `apps/web/.gitignore:1` |
| `apps/web/scripts` | `grep -rIn 'apps/web/scripts' . --exclude-dir=…` | سطر واحد فقط: `.gitignore:51` |
| مسار السكربتات الأصلية | `grep -rIn 'scripts/native' . --exclude-dir=…` | ٢٨ سطرًا لحظة الفحص (صارت ٧٦ بعد تعديلات مسارات متوازية)، ولا سطر منها يشير إلى `health.sh` أو `list-tabs.mts` |
| الوحدات بلا مستوردين | سكربت `node -e` واحد يقرأ ٥١٦٠ ملف مصدر، يستخرج كل `import/from/require`، يحلّ المسارات النسبية و`@rakazo/*` و`@/` (بما فيها استيرادات ESM المنتهية بـ`.js`) ويعدّ الوارد | ٢٦٦ ملفًا بلا وارد، أغلبها نقاط دخول معروفة (e2e، `app/`، `cli/`، `*.config`)، وبعد استبعاد أنماط نقاط الدخول بقي ٥٦ مرشحًا راجعتها يدويًا |
| التصديرات بلا مستهلك | سكربت `node -e` يعدّ كل رمز مُصدَّر ويقارن تكراره على مستوى المستودع | ٣٨ رمزًا بتكرار واحد (التعريف فقط)؛ تحققت من كل منها بـ`grep -F` |
| تماسك الدوكر | `grep -rIl` لكل ملف تحت `infra/compose` + قراءة `run-smokes.sh` | كل الملفات مُشار إليها، والـ`*.smoke.sh` تُشغَّل بـglob |

**قيود على السكربت:** ٥٢ استيرادًا نسبيًا لم يُحَلّ (توليد/مسارات ديناميكية)؛ لذلك لا أعدّ مخرجاته حكمًا نهائيًا، بل بداية تحقّق يدوي.

---

## ٢. ملفات وكتالوجات غير مستخدمة (مؤكَّدة)

### ٢.١ كتالوجات الترجمة السبعة القديمة — `apps/web/scripts/*.json`

هذه أقوى عنصر في الجرد: نصوص مترجمة قديمة لا يقرأها ولا يولّدها أي شيء.

| الملف | المفاتيح | مفاتيح غير موجودة في `.po` الحالي |
| --- | --- | --- |
| `apps/web/scripts/translations-de.json` | ٥٨١ | ١٥٧ |
| `apps/web/scripts/translations-es.json` | ٧٢٢ | ١٩٣ |
| `apps/web/scripts/translations-hi.json` | ٥٨٤ | ١٥٤ |
| `apps/web/scripts/translations-ko.json` | ٥٨١ | ١٥٧ |
| `apps/web/scripts/translations-pt-BR.json` | ٥٨٣ | ١٥٣ |
| `apps/web/scripts/translations-tr.json` | ٥٧٨ | ١٥٤ |
| `apps/web/scripts/translations-zh-CN.json` | ٧٢٧ | ٢٠٨ |

- الحجم الكلي: `du -ch apps/web/scripts/*.json | tail -1` → `268K`.
- آخر commit لمسها: `git log -1 -- apps/web/scripts` → `23ada160f 2026-11-15 Translate the "Create your account" sign-up heading (#4740)`.
- صفر مراجع في المستودع (جدول §١، `exit=1`)، و`git ls-files apps/web/scripts` يُظهر السبعة فقط (كلها متتبَّعة).
- غير مشمولة في فحص الأنواع: `apps/web/tsconfig.json:11` → `"include": ["src", "server"]`.
- البناء الحالي يستخدم Lingui: `apps/web/package.json:8` (`lingui extract-template`) و`lingui.config.ts:28` (`packages/i18n/locales/{locale}/messages`).
- عيّنة مفتاح قديم غير موجود في `.po` ولا في المصدر: `"macOS will not ask for extra permission if you let bots run on this Mac. They run as you."` — موجود في السبعة فقط (`translations-*.json:5`).

**الحكم:** نصوص قديمة ميتة داخل المستودع. الحذف مقترح لموجة لاحقة، مع تحذير: توجد أداة ترجمة خارج المستودع لمست الملفات في 2026-11-15؛ لا يمكن التحقق من وجودها من داخل المستودع.

### ٢.٢ `apps/mobile/components/ui/info-button.tsx`

- الرمز `InfoButton` مُعرَّف في السطر `6`، ويظهر **مرة واحدة فقط** في المستودع كله (`grep -rIn 'InfoButton' apps packages`).
- الملف الوحيد الذي يذكره هو تعليقات أصل مُولَّدة في `packages/i18n/locales/*/messages.po:942` (`#: apps/mobile/components/ui/info-button.tsx`) — أي أنه كان مصدرًا عند آخر استخراج، لا أنه مستورَد الآن.

### ٢.٣ `apps/mobile/lib/appearance/theme.ts`

- الملف يعيد التصدير فقط: `export { botColors, tokens } from "@rakazo/ui-tokens";`.
- صفر استيرادات: `grep -rIn 'appearance/theme'` → لا شيء؛ والوحدة الحيّة المستخدمة فعليًا هي `../../lib/appearance/appearance` (مثال: `apps/mobile/components/ui/load-failure.tsx:3`).
- ملاحظة: مجلد `apps/mobile/lib/appearance/` نفسه حيّ (فيه `appearance.ts`, `color.ts`, `ripple.ts`, `text-scale.ts`)، فالميت هو `theme.ts` وحده.

### ٢.٤ إدخالات ignore لملف لا وجود له — `msgids.json`

- `.gitignore:51` → `apps/web/scripts/msgids.json`
- `apps/web/.gitignore:1` → `scripts/msgids.json` (وهو محتوى الملف بالكامل)
- الملف نفسه غير موجود: `ls apps/web/scripts/msgids.json` → `No such file or directory`.
- لا مولّد ولا قارئ: `grep -rIn 'msgids'` أعاد هذين السطرين فقط، والبناء يكتب إلى `packages/i18n/locales/messages.pot` (`lingui.config.ts:28`).

**الحكم:** سطران ميتان. حذفهما لا يغيّر سلوكًا. (ولن يتعارض مع أي أداة: لو وُجدت أداة قديمة تولّد الملف فستظهر الحاجة عند تشغيلها.)

---

## ٣. سكربتات بلا أي مستهلك آلي — أدوات يدوية (لا تُحذف بلا تأكيد المالك)

هذه ليست «ميتة» بالمعنى القاطع: كل واحد منها يحمل في ترويسته أمر الاستخدام اليدوي، ومعظمها **لا كود ولا CI ولا وثيقة** تستدعيه (الاستثناء المذكور أدناه: `browser-login.sh` تستدعيه الوثائق وتعليمات البوت). أُدرجها لتقرير المالك، لا للحذف.

| السكربت | عدد المراجع الخارجية | الدليل |
| --- | --- | --- |
| `scripts/native/health.sh` | ٠ | `grep -rIn 'health\.sh'` → صفر نتائج؛ يطبع صحة API/web/Postgres/المتصفح |
| `scripts/native/list-tabs.mts` | ٠ | `grep -rIn 'list-tabs'` → صفر؛ يشير إليه `verify-browser.mts` في تعليق فقط |
| `scripts/native/browser-login.sh` | مراجع توثيق وتعليمات | `docs/computer.md:40,67` و`docs/native-browser.md:218-252` وتعليمات البوت في `packages/adapters/src/runs/assembly/run-instructions.prompt.ts` تستدعيه؛ ليس كودًا ميتًا |
| `scripts/native/verify-browser.mts` | ٠ خارجيًا | `:3`–`:4` تعليق استخدام فقط |
| `scripts/native/verify-composio.mts` | ٠ خارجيًا | `:3` تعليق استخدام فقط |
| `scripts/native/verify-desktop.mts` | ٠ خارجيًا | `:7` تعليق استخدام فقط |
| `apps/www/scripts/capture-chat.mjs` | ٠ | `grep -rIn 'capture-chat'` → صفر؛ يلتقط صور واجهة عبر Vite، قد يُستدعى من شجرة التسويق الخاصة غير الموجودة في المستودع |

**للمقارنة (حيّة، لا تلمسها):**

- `scripts/native/start.sh` — مُشار إليه من `scripts/appimage/AppRun:62,64,76` و`scripts/native/supervise.sh:71`.
- `scripts/native/stop.sh` — من `scripts/native/start.sh:5`.
- `scripts/native/browser.sh` / `browser-stop.sh` — من `start.sh:25` و`stop.sh:10-11` و`native-browser.ts:823`.
- `scripts/native/install-service.sh` / `supervise.sh` — من `scripts/appimage/AppRun:83` و`install-service.sh:23`.
- `scripts/native/setup-env.mjs` — من `AppRun:82` و`install-browser.sh:21` و`verify-browser.mts:16`.
- `scripts/native/setup-tailnet.sh` — متتبَّع ومعدَّل في هذه الموجة (`git status --short` → `M`)، ويُستدعى يدويًا كما في ترويسته؛ خارج نطاق هذا الجرد.

---

## ٤. تصديرات (exports) لا يستهلكها أحد

كل ما يلي تحقّقت منه بـ`grep -rIn -F "<name>"` على `apps` + `packages`، والنتيجة **تكرار واحد** (سطر التعريف فقط).

### ٤.١ تطبيق الموبايل

| المسار | الرمز |
| --- | --- |
| `apps/mobile/lib/models/model-backups.ts:32` | `queueMobileBackupSave` |
| `apps/mobile/lib/models/model-backups.ts:62` | `pendingMobileBackupSaves` |
| `apps/mobile/lib/notifications/push.ts:62` | `unregisterPushToken` |
| `apps/mobile/lib/vault/vault.ts:330` | `cardRows` |
| `apps/mobile/components/ui/info-button.tsx:6` | `InfoButton` (الملف كله ميت — §٢.٢) |

### ٤.٢ حزم `packages/`

| المسار | الرمز | ملاحظة |
| --- | --- | --- |
| `packages/adapter-kit/src/model-errors.ts:69` | `isProviderTimeout` | مُعاد تصديره عبر `packages/adapter-kit/src/index.ts:15` (`export *`)، لكن لا مستورد |
| `packages/db/src/database/prisma-errors.ts:11` | `isForeignKeyViolation` | مُعاد عبر `packages/db/src/index.ts:40`، لا مستورد |
| `packages/core/src/deployment/compose-update.ts:28` | `IMAGE_TAG_ENV` | مُعاد عبر `packages/core/src/index.ts:64`، لا مستورد |
| `packages/core/src/deployment/compose-update.ts:29` | `PREVIOUS_IMAGE_TAG_ENV` | نفسه |
| `packages/core/src/deployment/compose-update.ts:113` | `isLocalImageTag` | نفسه |
| `packages/core/src/deployment/self-update.ts:147` | `isGitCommit` | مُعاد عبر `packages/core/src/index.ts:66` |
| `packages/core/src/node/desktop-runtime.ts:712` | `stopScreenTransportsCommand` | غلاف عام غير مستخدم؛ الدالة الداخلية `renderStopScreenTransportsCommand` **حيّة** (`:604`, `:753`) فلا تحذفها |
| `packages/adapters/src/runtime/runtime.prompt.ts:7` | `subagentSystemPrompt` | الملف حيّ (`fallbackSystemPrompt` مستورَد في `pi-runtime.ts:60`)، والتصدير وحده ميت |
| `packages/adapters/src/tasks/background-helpers.prompt.ts:44` | `helperResultLabel` | الملف حيّ (`helperPrompt`, `startedNote`, …)، والتصدير وحده ميت |
| `packages/contracts/src/models/model-connections.ts` | `ModelBackupListSchema` | لا مستورد |
| `packages/contracts/src/models/openai-compatible-ui.ts` | `openAiCompatibleProbeSuccessMessage` | لا مستورد |
| `packages/testkit/src/page-browser-bench/tasks.ts` | `PARTNER_SITE` | لا مستورد |
| `packages/testkit/src/performance/web-chat-fixture.ts` | `withRetry` | لا مستورد |

### ٤.٣ موقع التسويق `apps/www` — مع تحذير مهم

الرموز التالية بتكرار واحد داخل المستودع، لكن **شجرة التسويق الخاصة `apps/www/src/marketing/` مستبعدة من git** (`.gitignore:58-59`، تُنسخ بـ`apps/www/scripts/clone-marketing.sh`)، ولا يمكنني رؤيتها. فلا تُحذف بلا التحقق من الشجرة الخاصة أولًا:

- `apps/www/src/site.ts`: `PLUGIN_SUBMISSIONS_URL`, `INTEGRATION_CLAIMS_URL`, `DOCS_URL`, `SELF_HOST_SECRETS_URL`, `SELF_HOST_RESTRICTED_URL`, `OPENCLAW_ALTERNATIVE_PATH`
- `apps/www/src/brand.ts`: `BRAND_LOGOS`, `BRAND_COLORS`
- `apps/www/src/pricing.ts`: `PRICING_MARKDOWN`
- `apps/www/src/i18n/locales.ts`: `localeHashPath`
- `apps/www/src/structured-data.ts`: `faqPageSchema`, `articleStructuredData`, `pricingStructuredData`, `downloadStructuredData`

> ملاحظة تصحيحية: `CATALOG_URL` (٣ ظهورات) و`getDemoBots` (٥) و`structured-data.ts` كملف — **حيّة** وتُستورَد من ملفات `.astro` (`apps/www/src/components/HomePage.astro:47`, `apps/www/src/layouts/BaseLayout.astro:4`). لا تخلطها بالرموز أعلاه.

---

## ٥. بقايا Docker

**النتيجة: لم أجد أي بقايا Docker ميتة.** الدوكر مسار منتج حيّ بالكامل، وهذه أدلة نفي لا إثبات:

- مقدّمو الكمبيوتر الستة عشر كلهم مُسجَّلون في `packages/adapters/src/computers/computer-providers.ts:23-40`، ومنهم `docker` (`:25`) و`local-vm` (`:37`). لا مزوّد يتيم.
- `docs/self-host-docker-computers.md` حيّ ومُشار إليه من `docs/self-host.md:139`.
- كل ملفات `infra/compose` مُشار إليها؛ و`*.smoke.sh` (١١ ملفًا بدت «بلا مرجع») تُشغَّل بـglob: `infra/compose/run-smokes.sh:6` → `scripts=("$root"/*.smoke.sh)`.
- `Dockerfile.topology` حيّ عبر `docker-compose.topology.yml:27` و`packages/testkit/src/cli/topology.ts:8`.
- `Dockerfile.pitr` حيّ عبر `infra/compose/pitr.sh:117`.
- كود الترحيل من Docker إلى الأصلي (`apps/desktop/src/main/this-computer/docker-move.ts`) **حيّ ومقصود**، وليس بقايا.
- ملفات `infra/railway/*` حيّة عبر `railway.json:3` و`packages/testkit/src/infra/railway-*.test.ts`.
- لا شيء من هذا اختُبر بتشغيل Docker (ممنوع/غير مُشغَّل)؛ الحكم من المراجع فقط.

**عنصر محلي غير متتبَّع (ليس محتوى مستودع):** `infra/sandboxes/computer/__pycache__/page_secrets.cpython-313.pyc` موجود على القرص لكن `git ls-files` لا يُظهره، و`__pycache__/` مستبعد في `.gitignore:3`. أثر تشغيل محلي، لا يُحذف ضمن المستودع ولا يُحتسب كودًا ميتًا.

---

## ٦. بقايا VM

**النتيجة: لا بقايا VM ميتة.** مفهوم الـVM مفهوم حيّ ومقصود:

- مزوّد `local-vm` مُسجَّل: `packages/adapters/src/computers/computer-providers.ts:37` (`appleContainerComputer`).
- يُوصَف للمستخدم في `docs/desktop-mac-without-docker.md:14` (`one lightweight Linux VM each`) و`docs/self-host-sandbox-providers.md:386-406`.
- تعليقات `apps/desktop/src/main/this-computer/native-stack.ts:2-3` تشرح أن قاعدة البيانات تعمل في VM خاص بها وأن كمبيوترات البوتات VMs عبر `local-vm`.
- ظهورات كلمة `VM` في `infra/updater/src/publish-workflow.test.ts:56` (`not.toContain("setup-qemu-action")`) و`infra/compose/install-images.sh:357-359` هي شروط بيئة سليمة، لا بقايا.

---

## ٧. بقايا «مفهوم الكمبيوتر القديم» ونصوص قديمة

### ٧.١ تسمية `Agent computer` القديمة (نص ميت مؤكَّد)

- لا توجد في كود المصدر الحالي: `grep -rIn 'Agent computer' apps/web/src apps/mobile` → صفر.
- ولا في كتالوج `.po` الحالي: `grep -c 'msgid "Agent computer"' packages/i18n/locales/de/messages.po` → `0`.
- لكنها باقية في:
  - `docs/self-host.md:76` → `Open **Agent computer** on a bot, …`
  - `docs/th-TH/self-host.md:48` → ترجمة تايلاندية تحمل نفس العبارة
  - الكتالوجات السبعة القديمة (§٢.١): `translations-*.json` مثل `translations-de.json:57`

الواجهة الحالية تسمّي الشيء **Computer** (انظر `docs/computer.md:8-9`). أي أن «Agent computer» نص قديم متخلّف.

### ٧.٢ الـtombstone المقصود — لا تلمسه

- `apps/api/src/computers/local-settings.ts:86`: `app.all("/api/desktop-settings/rpc/*", … 403)` مع التعليق عند `:85` «Old native clients must fail closed…». هذا **fail-closed مقصود** للعملاء القدامى، وليس كودًا ميتًا. مذكور هنا للتوثيق فقط.

### ٧.٣ هوية المستودع `elie222/rakazo` — ليست بقايا

- `apps/web/src/components/computers/ComputersUnavailableHint.tsx:131` يشير إلى `https://github.com/elie222/rakazo/blob/main/docs/self-host-sandbox-providers.md`.
- تحقّقت: `elie222/rakazo` هي الهوية المتّسقة في المستودع كله (`README.md:5,109,154`, `README.{ja,th-TH,zh-CN}.md`, `SETUP_PROMPT.md:48,83`, `.env.example:218,601,604`, `.github/workflows/build-linux.yml`). ليست بقايا، فلا تُغيَّر ضمن تنظيف.

### ٧.٤ وثائق غير مرتبطة (مرشّحة، لكنها حديثة فليست «قديمة»)

ست وثائق بصفر روابط واردة من بقية الوثائق/README:

| الوثيقة | آخر commit |
| --- | --- |
| `docs/ai-data-sharing-review.md` | `80042856e 2026-11-19` |
| `docs/deployment-voice.md` | `95a3c9386 2026-11-22` |
| `docs/included-action-checks.md` | `35516395f 2026-11-20` |
| `docs/settings-from-chat-tasks.md` | `851991213 2026-11-09` |
| `docs/tool-activity.md` | `4c3111347 2026-11-20` |
| `docs/evals/page-browser-bench.md` | `8552942b2 2026-11-02` |

**الحكم:** غير مرتبطة، لكنها حديثة — تُرجَّح ملاحظات داخلية مقصودة، لا بقايا. لا تُحذف.

### ٧.٥ ما تحقّقت أنه سليم (لتفادي العمل المهدور)

- `docs/zh-CN/self-host-login-gate.md` يبدو بلا مصدر إنجليزي مطابق بالاسم، لكنه **مقصود**: يُعلن مصدره `../self-host-kubernetes.md#add-a-login-gate-without-breaking-the-computer`، والعنوان موجود فعلًا في `docs/self-host-kubernetes.md:179`. مُرتبط من `docs/zh-CN/self-host.md:72` و`README.zh-CN.md:314`.
- لا روابط ماركداون نسبية مكسورة: سكربت فحص على ٩٩ ملف `.md` تحت `docs/` → `BROKEN_TOTAL=0`.
- لا إدخالات `.po` مهملة (`#~`): `grep -c '^#~'` = ٠ في كل الـ١٦ لغة.

---

## ٨. ملخّص قابل للتنفيذ في موجة لاحقة (لا شيء نُفِّذ الآن)

| الأولوية | العنصر | الإجراء المقترح | المخاطرة |
| --- | --- | --- | --- |
| عالية | `apps/web/scripts/translations-{de,es,hi,ko,pt-BR,tr,zh-CN}.json` | حذف السبعة | أداة ترجمة خارجية غير مرئية قد تكتب فيها |
| عالية | `.gitignore:51` و`apps/web/.gitignore:1` | حذف السطرين (والثاني يجعل الملف فارغًا فيُحذف) | لا شيء مُتحقَّق داخل المستودع |
| متوسطة | `apps/mobile/components/ui/info-button.tsx` | حذف | صفر مراجع |
| متوسطة | `apps/mobile/lib/appearance/theme.ts` | حذف | صفر مراجع |
| متوسطة | التصديرات في §٤.١ و§٤.٢ | إزالة التصدير أو الدالة | بعضها مُعاد تصديره من barrels، فتأكّد من عدم كونه API خارجيًا |
| منخفضة | `Agent computer` في `docs/self-host.md:76` و`docs/th-TH/self-host.md:48` | تحديث النص إلى `Computer` | ملفات وثائق، ليست كتلة حرجة |
| **لا تفعل** | سكربتات §٣، وثائق §٧.٤، `local-settings.ts:86`، `elie222` link | إبقاء | أدوات يدوية / ملاحظات / سلوك مقصود / هوية المشروع |

---

## ٩. ملاحظات إعادة التحقق

- **هذا الملف يُلوّث إعادة تشغيل الأوامر:** كل `grep` في §١ سيصطدم الآن بسطور هذا المستند نفسه (هو يذكر أسماء الملفات والرموز). عند إعادة التحقق استثنِ `--exclude-dir=docs` أو أضف `--exclude=dead-code.md`. مثلاً `grep -rIn 'msgids' . --exclude-dir=docs --exclude-dir=node_modules …` يعيد سطري `.gitignore` الأصليين فقط (تحققت: الفرق بين عدّ ٨ وعدّ ٢ هو ستة سطور من هذا الملف).
- **الشجرة تحت تعديل متزامن:** أثناء هذا الجرد كانت مسارات أخرى تكتب في المستودع (`git status --short` أظهر تعديلات مثل `apps/api/src/app.ts`, `scripts/native/browser.sh`, وملفات غير متتبَّعة مثل `scripts/native/tunnel.sh`, `scripts/native/status.sh`). كل أعداد المراجع أعلاه مأخوذة من اللقطة التي رأيتها، وقد تتغيّر إن أضافت مسارات أخرى مستهلكين جددًا. لا شيء منها من صنعي؛ إضافتي الوحيدة هي هذا الملف.

## ١٠. ما لم يُتحقَّق منه في هذه الموجة

- لم يُشغَّل `pnpm check` ولا `build` ولا `vitest` (ممنوع في هذا المسار) — أثر أي حذف على البناء غير مُقاس هنا.
- لم يُشغَّل Docker ولا أي اختبار تكامل، فلا يمكن تأكيد سلوك مسار الدوكر تشغيليًا (فقط مرجعيًا).
- شجرة `apps/www/src/marketing/` الخاصة غير موجودة في المستودع (`gitignored`)، فلا يمكن الجزم بشأن تصديرات `apps/www` في §٤.٣.
- أدوات الترجمة الخارجية (إن وُجدت) غير مرئية، فلا يمكن الجزم بأن حذف الكتالوجات لا يوقفها.
- سكربت الوحدات اليتيمة حلّ ٥١٦٠ ملفًا واستبعد ٥٢ استيرادًا نسبيًا لم يُحَلّ؛ نتائجه إرشادية لا قاطعة.
