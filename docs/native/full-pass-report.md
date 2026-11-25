# تقرير الجولة الكاملة — Rakazo native

**الالتزام:** `9525363bf` — «wf: full pass across login, live link, browser panel, browse MCP, google, cleanup»
**التاريخ:** 2026-11-25
**الجهاز:** لينكس، `127.0.0.1:5173` و`127.0.0.1:3100` شغّالين، Postgres على 5433، Chromium مشترك على 9222.
**جذر المستودع:** `/home/mahmoud/Documents/my-bots-rakazo/rakazo` (مؤكد بـ`git rev-parse --show-toplevel`).

> ملاحظة نطاق: شجرة العمل فيها تعديلات غير ملتزمة فوق `9525363bf` (يظهرها `git status --short`). كل ما قرأته أو شغّلته يصف **الشجرة الحالية**، لا الالتزام وحده.

> منهجية هذا التقرير: كل بند «مؤكد حيًا» شغّلتُه في هذه الجلسة والأمر مذكور. وكل بند «مؤكد بالقراءة» مبني على قراءة الملف والسطر المذكورين. أما ما لم أشغّله فمكتوب صراحةً أنه لم يُشغَّل، ولم أحوّله إلى نتيجة ناجحة.

---

## ١. الخلاصة

**نعم، التطبيق صار قابلًا للاستخدام على هذا الجهاز من داخل checkout — لكنه ليس «جاهزًا لأي جهاز من الصفر» بعد.**

الحالة الحية التي قِستها الآن:

```
curl -o /dev/null -w "%{http_code}" http://127.0.0.1:5173/            → 200
curl -o /dev/null -w "%{http_code}" http://127.0.0.1:3100/internal/health → 200
```

والمسار المحلي على لينكس لم يعد يمرّ بـDocker ولا بنص Docker: التطبيق يشغّل أو يتبنّى `scripts/native/start.sh` على `http://localhost:5173` (`apps/desktop/src/main/this-computer/host-stack.ts:22-25`، و`docker-move.ts:40-49`).

### ما كان مكسورًا وأُصلح

1. **«This computer» كان يفرض Docker على لينكس** — صار هناك `HostStackController` يشغّل/يتبنّى `start.sh`، ويُفتح على `localhost:5173` بلا رسالة Docker (`host-stack.ts`).
2. **أول تشغيل كان يذهب إلى Cloud** — صار `resolveStartupTarget` يعيد `{kind:"setup"}` عند غياب `setup.json` (`apps/desktop/src/main/setup/setup-config.ts:145`).
3. **صفحة الدخول كانت فارغة تمامًا** — صارت تعرض `data-rakazo-auth-loading` و«Loading sign-in…» بدل شاشة بيضاء (`apps/web/src/pages/auth/Auth.tsx:306-312`)، وأُضيف لون خلفية مبكر في `index.html`.
4. **زر «Working…» كان يعلّق بلا نهاية** — أُضيفت مهلة 10 ثوانٍ تعيد تفعيل الزر ورسالة `Signed in, but Rakazo did not open. Try again.` (`Auth.tsx:68-77, 241`).
5. **passkeys كانت تُعطَّل صامتًا على 127.0.0.1** — صار الافتراضي الجديد `localhost` (`scripts/native/setup-env.mjs:90-92`، و`.env.example:26-28`)، وأُضيف تلميح صريح يشرح العنوان الصحيح (`apps/web/src/lib/auth/passkeys.ts:82-96`).
6. **الموبايل كان يحوّل أي عنوان محلي بلا scheme إلى https** — صار يجرّب `http` أولًا للعناوين الخاصة/اللووب باك (`apps/mobile/lib/api/endpoint.ts:37-43`).
7. **`registrationOpen` لم يكن يُرسل خارج مسار الديسكتوب المُدار** — صار يُحسب دائمًا (`apps/api/src/auth/auth-capabilities.ts:27`)، والرد الحي يؤكده: `"registrationOpen":true`.
8. **اللينك الحي** — أُضيف `scripts/native/tunnel.sh` + `status.sh` + `stop.sh` + `GET/POST /api/native/runtime` + خانة «Live link» في الويب والموبايل، وصار `dev.mjs` يبدأه بـ`RAKAZO_DEV_TUNNEL=1` ويضيف أصله إلى `RAKAZO_EXTRA_AUTH_ORIGINS`.
9. **Vite كان يرد 403 لمضيف النفق** — صار يضيف `.trycloudflare.com` تلقائيًا في التطوير (`apps/web/server/preview-middleware.ts:38-43`).
10. **المتصفح**: المؤشر `cursor-default`، ومنع سحب الصورة/قائمتها، ولمس ونقر متعدد وكيبورد مخفي وشريط مفاتيح للموبايل.
11. **browse MCP**: الإضافة تُحمَّل تلقائيًا الآن، والاقتران يعمل، والأدوات مفلترة إلى 8، والحالة الحية `connected:true`.
12. **حذف البقايا**: 7 كتالوجات ترجمة قديمة (268KB) + `apps/web/.gitignore`.

### ما زال ناقصًا ولازم يتقال

- **من الصفر على جهاز جديد غير ممكن من المستودع وحده:** `setup-env.mjs` يقرأ `owner.pw` و`app.pw` ويرمي إن غابا (`setup-env.mjs:41-46`)، و`start.sh` يفترض `pgdata` وحزمة `@embedded-postgres` جاهزة (`start.sh:11-19`). لا يوجد `install-postgres.sh`، وREADME نفسه يقول إن الحالة تُجهَّز مرة واحدة على الجهاز (`README.md:104-107`).
- **اختباران فاشلان شغّلتهما بنفسي:** مهلة الدخول في `Auth.test.tsx`، و`server-screen.test.tsx` للموبايل (يفشل قبل أي اختبار بـ`__DEV__ is not defined`).
- **اختبار e2e للديسكتوب ما زال يثبّت سلوك Docker** (`apps/desktop/e2e/local-stack.spec.ts:240-258`) رغم إزالة الزر والنص من الواجهة.
- **اللينك الحي غير قابل للتشغيل الآن على هذا الجهاز:** `cloudflared` و`tailscale` غير مثبتين (`command -v` للاثنين → غير موجود)، وحالة `status.sh` الآن `off`.
- **passkeys على التشغيل الحالي:** `.env` ما زال `BETTER_AUTH_URL=http://127.0.0.1:5173` (`.env:27,37`)، و`setDefault` لا يستبدل قيمة موجودة، فالنسخة الجارية تعرض التلميح بدل تشغيل passkeys حتى تُعدَّل القيمة ويُعاد التشغيل.
- **`status.sh` ينتج JSON غير صالح** إذا حمل `lastError` فاصلة (اختبرته، انظر الجدول).

**الحكم العملي:** الاستخدام اليومي على هذا الجهاز ممكّن. «التشغيل من الصفر» و«الإصدار المحزَّم» و«e2e/فحص كامل» ليست متحققة بعد.

---

## ٢. جدول المشاكل

الحالة: **مؤكدة (حيّة)** = شغّلتُها ورأيت النتيجة. **مؤكدة (قراءة)** = مثبتة بالكود/السطر. **غير مؤكدة** = تحتاج جهازًا أو تشغيلًا لم يتوفر.

| المسار | المشكلة | الحالة | الإصلاح |
|---|---|---|---|
| `apps/desktop/src/main/this-computer/host-stack.ts:22-25` | على لينكس لم يكن هناك مسار محلي بلا Docker؛ كان يظهر زر تنزيل Docker | مؤكدة (قراءة) | `HostStackController` يشغّل/يتبنّى `scripts/native/start.sh` على `localhost:5173`، ويُبنى على لينكس من `main.ts` |
| `apps/desktop/src/main/this-computer/docker-move.ts:40-49` | اختيار الستاك | مؤكدة (قراءة) | `hostStack` أولًا؛ يبقى Docker فقط إن كان هناك ستاك Docker قائم على لينكس (حفاظًا على البيانات) |
| `apps/desktop/src/main/setup/setup-config.ts:145` | أول تشغيل كان يفتح Cloud | مؤكدة (قراءة) | يعيد `{kind:"setup"}` عند غياب `setup.json` |
| `apps/web/src/pages/auth/Auth.tsx:306-312` | شاشة دخول فارغة حتى 8 ثوانٍ | مؤكدة (قراءة) | حالة تحميل مرئية + `aria-busy` + `data-rakazo-auth-loading` |
| `apps/web/src/pages/auth/Auth.tsx:68-77` | «Working…» يعلّق بعد نجاح الدخول | مؤكدة (قراءة) | مهلة 10s تعيد التفعيل وتظهر رسالة إعادة محاولة |
| `apps/web/src/pages/auth/Auth.test.tsx` | اختبار المهلة نفسه فاشل | **مؤكدة (حيّة)** | شغّلت `vitest run apps/web/src/pages/auth/Auth.test.tsx` → **25 ناجح / 1 فاشل**: `TypeError: 'set value' called on an object that is not a valid instance of HTMLInputElement` في اختبار «stops waiting for the app after ten seconds…». يحتاج إصلاح مساعد `enter()` أو ترتيب الحالة |
| `apps/web/src/lib/auth/passkeys.ts:82-96` | passkeys تُعطَّل صامتًا على 127.0.0.1 | مؤكدة (حيّة) | تلميح `Passkeys need http://localhost:<port>`؛ الرد الحي للـcapabilities: `passkeyRpId:"localhost"` |
| `.env:27,37` | العنوان الحالي ما زال 127.0.0.1 و`setDefault` لا يستبدله | مؤكدة (حيّة) | يلزم تعديل `.env` يدويًا إلى `http://localhost:5173` وإعادة التشغيل |
| `apps/mobile/lib/api/endpoint.ts:37-43` | عنوان محلي بلا scheme يتحول https | مؤكدة (قراءة) | يجرّب `http` للعناوين الخاصة/اللووب باك، وhttps للعامة فقط |
| `apps/api/src/auth/auth-capabilities.ts:27` | `registrationOpen` غير مرسل خارج الديسكتوب | مؤكدة (حيّة) | يُحسب دائمًا؛ الرد الحي يحتوي `registrationOpen:true` |
| `README.md:102-123` | التوثيق يفرض Docker أولًا | مؤكدة (قراءة) | قسم «Quick start from a checkout (no Docker)» أولًا |
| `apps/desktop/e2e/local-stack.spec.ts:240-258` | e2e يطلب زر «Install Docker» ونص «Rakazo needs Docker…» بعد إزالتهما | **مؤكدة (قراءة)** — لم أشغّل e2e | يجب تحديث السيناريو لمسار host-stack أو حذفه |
| `apps/mobile/lib/settings/server-screen.test.tsx:31-38` | mock لا يعرّف `useFocusEffect`/`expo-clipboard` بينما `server.tsx` يستوردهما | **مؤكدة (حيّة جزئيًا)** | شغّلت الملف → فشل قبل أي اختبار: `ReferenceError: __DEV__ is not defined`. الفشل حقيقي لكن سببه استيراد Expo، ولا أجزم أنه من تغيير live-link وحده |
| `apps/web/src/pages/shell/computers/computer-panel.tsx:145-155` | «Waiting for the browser…» حالة دائمة بلا خطأ/Retry إذا لا يوجد تبويب مملوك | مؤكدة (قراءة) | لم يُصلح؛ يحتاج تمييز loading/error/empty وزر إجراء |
| `apps/mobile/lib/computers/computer.ts:53-57` | `desktop://` يُرفض فلا يظهر متصفح الديسكتوب في الموبايل | مؤكدة (قراءة) | لم يُصلح؛ يحتاج fallback صورة+إدخال أو URL متوافق |
| `scripts/native/status.sh:19-21,58-62` | يقتطع `lastError` عند أول فاصلة فينتج JSON غير صالح | **مؤكدة (حيّة)** | شغّلت `status.sh` على ملف فيه `"failed to request, reason"` فطبع `"lastError":"cloudflared reported no tunnel URL: failed to request}` (قوس مفقود) |
| `scripts/native/tunnel.sh` / `apps/web/src/pages/settings/LiveLinkSettingsPanel.tsx` | اللينك الحي لا يعمل الآن | مؤكدة (حيّة) | `status.sh` → `{"state":"off"}`، و`cloudflared` غير مثبت؛ يحتاج `install` ثم تشغيل |
| `scripts/dev.mjs:661-667` | تعارض `RAKAZO_DEV_TAILNET` مع `EMAIL_EMULATOR=true` كان يرمي | مؤكدة (قراءة) | صار تحذيرًا لا `throw`، ويستمر الإقلاع |
| `apps/web/server/preview-middleware.ts:38-43` | Vite 403 لمضيف `trycloudflare` | مؤكدة (قراءة) | يضيف `.trycloudflare.com` إلى `allowedHosts` في التطوير |
| `scripts/native/setup-env.mjs:41-46` + `start.sh:11-19` | لا يوجد سكربت ينشئ Postgres المضمّن ولا `owner.pw/app.pw` | مؤكدة (قراءة) | لم يُصلح؛ مذكور كشرط مسبق في README |
| `scripts/native/install-chrome.sh` | الملف غير قابل للتنفيذ (mode 664) ولا يوجد Chrome رسمي على الجهاز | مؤكدة (حيّة) | يُستدعى بـ`bash`؛ `command -v google-chrome` → لا شيء |
| `apps/desktop/src/main/main.ts` وحزمة لينكس | لا تُضمَّن `scripts/native` في `extraResources` | مؤكدة (قراءة) | التطبيق المحزَّم يحتاج checkout أو ستاكًا يعمل ليتبنّاه |
| `docs/native/dead-code.md:1-3` | الوثيقة تقول «لم يُحذف أي ملف» بينما الحذف نُفِّذ | مؤكدة (قراءة) | تحدّث حالتها أو تُوسم «منفَّذ» |
| `.gitignore:51` | حذف سطر `apps/web/scripts/msgids.json` غير مُدرج في الالتزام | مؤكدة (حيّة) | `git show HEAD:.gitignore` ما زال يعرضه؛ `git diff --numstat` = `0 1` |

---

## ٣. اللينك الحي وخانة الحالة

### كيف تشغّله

1. شغّل الستاك أولًا (اللينك يشير إلى الويب المحلي):

   ```bash
   bash scripts/native/start.sh
   ```

2. شغّل النفق في طرفية أخرى:

   ```bash
   bash scripts/native/tunnel.sh
   ```

   أو اجعله يبدأ مع الستاك بوضع `RAKAZO_DEV_TUNNEL=1` في `.env` (`scripts/dev.mjs:678-695`)، فيُنشأ اللينك من أول ثانية وتجده خانة الحالة.

3. اقرأ الحالة من الطرفية:

   ```bash
   bash scripts/native/status.sh
   ```

   المخرجات الحالية على هذا الجهاز (شغّلتها):

   ```json
   {"state":"off","url":null,"since":null,"pid":null,"lastError":null}
   ```

### أين تراها

- **الويب:** Settings → **Live link** (`?settings=live-link` في التطوير). تقرأ `GET /api/native/runtime` وتعرض اللمبة واللينك ووقت التشغيل وزر النسخ وزر Stop وصندوق آخر 100 سطر.
- **الموبايل:** شاشة **Server** → مجموعة «Live link» (نسخ/مشاركة فقط، بلا Stop ولا لوجات).
- **API:** المساران مسجّلان فقط في التطوير أو عند وجود `RAKAZO_NATIVE_STATE_DIR`، ويحتاجان جلسة؛ بدونها يرد 401 (تحققت: `curl http://127.0.0.1:3100/api/native/runtime` → **401**).

### معنى كل لون

| اللون | الحالة | المعنى |
|---|---|---|
| 🟢 أخضر (`bg-success`) | `running` | النفق يعمل، والـpid الحيّ هو `cloudflared` |
| 🔴 أحمر (`bg-destructive`) | `stopped` أو `off` | أُوقف بطلب منك، أو لا يوجد نفق أصلًا |
| 🟠 برتقالي (`bg-warning`) | `error` | الحالة تقول `running` لكن العملية ماتت، أو خطأ في التشغيل |

اللون مصحوب بنص دائمًا (`Running` / `Stopped` / `Off` / `Problem`) حتى لا يعتمد المعنى على اللون وحده. التعيين في `apps/web/src/pages/settings/LiveLinkSettingsPanel.tsx:155-157` وفي `apps/mobile/lib/api/live-link.ts:42-45`.

### كيف توقفه

- من الواجهة: زر **Stop** → `POST /api/native/runtime/stop` (يشترط `content-type: application/json`).
- من الطرفية: `bash scripts/native/stop.sh` — يوقف النفق ثم Chromium ثم Postgres. إن كان مدير النفق ميتًا يكتب `stopped` بنفسه بدل أن يظهر `error`.

### ملاحظتان مهمتان

- **`cloudflared` غير مثبت على هذا الجهاز** (`command -v cloudflared` → لا نتيجة). `tunnel.sh` يطبع أمر التثبيت ويخرج 1، والحالة تبقى `off`. كذلك `tailscale` غير مثبت، فمسار Tailscale ليس بديلًا جاهزًا هنا.
- `status.sh` الحالي يقطع رسائل الخطأ عند أول فاصلة، فأي رسالة من cloudflared فيها فاصلة تُنتج JSON غير صالح. هذا مؤكد بالتشغيل (الجدول أعلاه) ولم يُصلح.

---

## ٤. المتصفح: المؤشر والتحديد والتحكم

### ما تغيّر

| البند | قبل | بعد | الموضع |
|---|---|---|---|
| مؤشر سطح البث | `cursor-crosshair` يغطي الصورة | `cursor-default` | `computer-panel.tsx:666` |
| سحب الصورة | ممكن (سحب أصلي) | `draggable={false}` + `onDragStart` يمنع الافتراضي | `computer-panel.tsx:725-741` |
| قائمة الضغط الطويل (iOS) | تظهر | `[-webkit-touch-callout:none]` و`[-webkit-user-drag:none]` و`select-none` | `computer-panel.tsx:665, 731-742` |
| تحديد النص باللمس | غير مقصود | ضغط طويل 450ms يبدأ سحبًا، وتجاوز 8px يحوّل لتمرير | `computer-panel.tsx` + `live-input.ts:13-20` |
| النقر المتعدد | غير مدعوم | نقرة/دبل/تريبل (400ms، 4px للماوس و16px للمس) | `live-input.ts:13-20` |
| التمرير باللمس | لا يوجد (wheel فقط) | 30px/notch عكس اتجاه الإصبع | `live-input.ts:27-29` |
| كيبورد الموبايل | لا يفتح | `<input>` مخفي + `onCompositionEnd`/`onInput` + شريط مفاتيح `pointer-coarse` | `computer-panel.tsx:688-711` |
| تكرار الضغط | `if (event.repeat) return` يمنع Backspace/الأسهم المستمرة | أُزيل الفحص | `computer-panel.tsx:608-618` |
| PageUp/PageDown/Home/End/Delete | تسقط إلى `rawKeyDown` بلا virtual key code | أُضيفت إلى `SPECIAL_KEYS` | `native-browser.ts:149+` |

### التحكم

- **الماوس/القلم:** `setPointerCapture` على `pointerdown`، حركة مُجمَّعة كل 50ms، ثم `up` و`release` (`computer-panel.tsx:438-545`).
- **العجلة:** مستمع `wheel` غير سلبي مع `preventDefault` ويتحول إلى `scroll`.
- **الكيبورد:** مفاتيح `LIVE_KEYS` والمحارف المطبوعة؛ الحقل المخفي يغطي الكتابة واللصق وIME.
- **اللمس:** نقرة، ضغط طويل = سحب تحديد، تجاوز العتبة = تمرير، `pointercancel` ينظّف بلا إرسال.
- **بعد أي إدخال:** تُبطَل معاينة الصفحة ويصير التحديث 350ms لثانيتين، فترى أثر النقرة بسرعة.

### ما لم يُتحقق

- سلوك اللمس على iPhone/Android حقيقي (فتح كيبورد iOS، اتجاه التمرير، عتبة 8px) **لم يُجرَّب**؛ اختبارات jsdom تحاكي `pointerType` فقط.
- شريط المفاتيح يغطي آخر ~40px من الصفحة البعيدة على الهاتف.
- عند تركيز الحقل المخفي، مفتاح Escape يُستهلك ويُرسل للصفحة بدل إغلاق نافذة الحاسوب.

**الفحوص التي شغّلتها:** `vitest run apps/web/src/pages/shell/computers/computer-panel.test.tsx packages/adapters/src/providers/computer/desktop/native-browser.test.ts` → **2 ملف، 39 اختبارًا ناجحًا**.

---

## ٥. browse MCP وجوجل

### ما يعمل تلقائيًا

1. **الإضافة:** `scripts/native/install-browser.sh` يشغّل `browse-setup.sh`، وهو:
   - يثبّت/يجد `browse` CLI،
   - يتبنّى نسخة إضافة موجودة أو **ينزّلها من Chrome Web Store** (`browse-setup.sh:168-205`)،
   - ينسخها ويشغّل المتصفح ويقترن،
   - يتحقق أن النسخة المحمّلة هي المرحّلة فعلًا ويعيد التشغيل عند اختلافها (`browse-setup.sh:346-420`)،
   - يكتب autostart لسطح المكتب، ويغلق صفحة onboarding.
2. **تحميل الإضافة عند كل إقلاع:** `browser.sh` يمرّر `--load-extension` و`--disable-extensions-except` مع `flock` وpidfile بعد جاهزية المنفذ (`browser.sh:74-78, 116-119`).
3. **سياسة stdio:** `browse-mcp-enable.sh` يكتب `MCP_STDIO_ENABLED=true` و`MCP_STDIO_ALLOWED_COMMANDS=<path>`، ويتحقق أن السيرفر يعرض الأدوات الثماني وأن المتصفح متصل. الحالة الحالية في `.env`:

   ```
   421:MCP_STDIO_ENABLED=true
   423:MCP_STDIO_ALLOWED_COMMANDS=/home/mahmoud/.local/bin/browse
   ```

4. **فلترة الأدوات:** البوت يرى 8 أدوات فقط (`execute/status/session_*/tabs_cleanup`)، لا `secrets_*` ولا `network` ولا `recording` ولا `session_adopt` (`packages/adapters/src/browse/browse-mcp.ts:17-26` و`mcp-connector.ts:571-574`).
5. **الحالة الحية الآن** (`browse status`، مختصرًا):

   ```json
   {"connected":true,"pairingState":"connected","version":"0.1.5",
    "browsers":[{"id":"chromium-mahmoud-2","default":true,"connected":true}]}
   ```

   أي أن الاقتران والإضافة يعملان على هذا الجهاز.

### ما يحتاج تدخلًا بشريًا — خطوة واحدة لكل مسار

> المقصود: لا يوجد «كليك لكل تشغيل». لكل مسار على حدة خطوة واحدة كحد أقصى، وبعدها يعمل تلقائيًا.

| الحالة | الخطوة الواحدة | التفاصيل |
|---|---|---|
| **إضافة سيرفر browse للبوتات (مرة واحدة)** | Admin: **Plugins → + → Manage MCP servers → Add server → STDIO** ثم `Name=browse`، `Command=<المسار الذي يطبعه browse-mcp-enable.sh>`، `Arguments=mcp` | بعدها لا كليك لكل إقلاع؛ autostart يشغّل المتصفح. يجب إعادة تشغيل API/worker أولًا ليقرأ `.env`. الاسم `browse` حرفيًا مهم لأن التعليمات تنادي `mcp__browse__execute` (`docs/native-browser.md:78-96`) |
| **تسجيل جوجل** | إنسان يفتح نافذة Chrome عادية ويسجّل الدخول بنفسه | `bash scripts/native/browser-login.sh` يوقف المتصفح المشترك ويفتح `accounts.google.com` في Chrome عادي بلا CDP ولا headless، ثم يتحقق من كوكيز الجلسة ويطبع عددها فقط، ويعيد تشغيل المشترك. البوت ممنوع من قيادة جوجل، ويُطلب منه التوقف وإحالة المستخدم |
| **إن كان الجهاز offline** | تثبيت الإضافة من Web Store يدويًا في بروفايل المتصفح المشترك | هذا هو الفرع الوحيد الذي يطبع خطوة يدوية بدل التنزيل التلقائي (`install-browser.sh:50-60`) |

### ما لم يُتحقق

- **لم أجرّب تسجيل جوجل فعليًا**: لا يوجد Google Chrome رسمي على الجهاز (`command -v google-chrome-stable` و`google-chrome` → لا شيء)، والموجود Chrome for Testing 158. تشغيل نافذة GUI خارج نطاق هذه الجلسة.
- **`install-chrome.sh` لم يُشغَّل** ولا هو قابل للتنفيذ (mode 664)؛ يُستدعى بـ`bash`.
- **مسار جوجل عبر browse ليس محروسًا**: حارس `accounts.google.com` موجود في helper الـpage-browser فقط؛ إذا نادى البوت جوجل عبر `mcp__browse__execute` فلا يمرّ بالحارس. هذه فجوة معروفة ولم تُغلق.
- **التحقق أن البوت يرى الأدوات فعلًا** يحتاج خطوة إضافة السيرفر + إعادة تشغيل + محادثة بوت، ولم تُنفَّذ.
- في نظام 24/7 عبر systemd قد يشتغل المتصفح headless لغياب `DISPLAY`، وهذا يفشل تسجيل جوجل.

---

## ٦. ما تم حذفه من البقايا

| المحذوف | الحجم/العدد | التحقق |
|---|---|---|
| `apps/web/scripts/translations-{de,es,hi,ko,pt-BR,tr,zh-CN}.json` | 7 ملفات، ~268KB | `ls apps/web/scripts` → `No such file or directory` (exit 2) |
| `apps/web/.gitignore` | سطر واحد `scripts/msgids.json` | الملف غير موجود |
| سطر `.gitignore:51` | إدخال ignore لملف غير موجود | موجود في شجرة العمل، **غير مُدرج في الالتزام** |
| مفاتيح Docker غير المستخدمة في كتالوجات سطح المكتب | 4 مفاتيح × 15 لغة | `grep -rl "Download Docker Desktop" apps/desktop/src/main/locales` → 0؛ واختبار i18n يمر |

**لم يُحذف أي شيء آخر.** الجرد الكامل في `docs/native/dead-code.md`، لكن الوثيقة نفسها لم تُحدَّث بعد تنفيذ الحذف (تقول في سطر 3 إنه لم يُحذف أي ملف)، وسطر `.gitignore` ما زال ملتزمًا (تحققت: `git show HEAD:.gitignore | grep -n msgids` → `51:apps/web/scripts/msgids.json`).

---

## ٧. ما لم يُغطَّ ولماذا

### فحوص لم تُشغَّل

| الفحص | الحالة | السبب |
|---|---|---|
| `pnpm check` / `tsc` / build | **لم يُشغَّل** | ثقيل وخارج نطاق كتابة التقرير؛ حالة «الفحص نظيف» المبلَّغة لم أتحقق منها بنفسي |
| `apps/desktop/e2e/local-stack.spec.ts` | **لم يُشغَّل** | يحتاج Electron + Playwright؛ وبالقراءة هو فاشل أصلًا لأن الواجهة لم تعد تعرض زر Docker |
| تشغيل التطبيق سطح المكتب يدويًا | **لم يُشغَّل** | يحتاج جلسة GUI وبيئة Electron |
| نفق حقيقي (cloudflared) | **لم يُشغَّل** | `cloudflared` غير مثبت |
| تسجيل جوجل حقيقي | **لم يُشغَّل** | لا Chrome رسمي ولا نافذة GUI |
| لمس على جهاز حقيقي | **لم يُشغَّل** | لا iPhone/Android متاح |
| Postgres من الصفر | **لم يُشغَّل** | لا سكربت bootstrap أصلًا؛ الحالة الحالية موجودة مسبقًا |

### فحوص شغّلتها ونتائجها

| الأمر | النتيجة |
|---|---|
| `vitest run apps/web/src/pages/auth/Auth.test.tsx` | **25 ناجح، 1 فاشل** (`set value` على غير `HTMLInputElement` في اختبار المهلة) |
| `vitest run apps/mobile/lib/settings/server-screen.test.tsx` | **فشل قبل أي اختبار**: `ReferenceError: __DEV__ is not defined` |
| `vitest run apps/desktop/src/main/i18n.test.ts` | **52 ناجح** |
| `vitest run apps/web/src/pages/settings/LiveLinkSettingsPanel.test.tsx` | **6 ناجح** (مع تحذير `act` قديم) |
| `vitest run computer-panel.test.tsx native-browser.test.ts` | **39 ناجح** |
| `curl /api/auth/capabilities` | `registrationOpen:true`، `passkeyRpId:"localhost"`، `resetUrl:http://127.0.0.1:5173` |
| `curl /api/native/runtime` | **401** (يحتاج جلسة) |
| `bash scripts/native/status.sh` | `{"state":"off",...}` |
| `status.sh` على `lastError` فيه فاصلة | **JSON غير صالح** (قوس مفقود) |
| `browse status` | `connected:true`، إضافة `0.1.5` |

> تنبيه أمانة: حالة الفحص المبلَّغة في الطلب كانت «نظيف — تستات نظيفة»، لكن تشغيلي المباشر أظهر فشلين. لم أصلحهما؛ مذكوران هنا وفي جدول المشاكل.

### قيود منتج/مسار معروفة

- **التطبيق المحزَّم على لينكس** لا يضم `scripts/native`؛ يحتاج checkout أو ستاكًا يعمل ليتبنّاه.
- **ستاك Docker قائم على لينكس** لا يُنقل تلقائيًا إلى native؛ يبقى Docker حفاظًا على البيانات، ويحتاج المستخدم إزالته يدويًا.
- **مسار ماك** «بلا Docker» ما زال يستخدم Apple container runtime وVM لـPostgres والروبوتات؛ لا ينطبق على لينكس ولا ويندوز.
- **الموبايل** لا يعرض `desktop://` ولا يملك Stop/لوجات للّينك الحي (بسّاطة مقصودة).
- **اللينك الحي** يعتمد على `cloudflared` غير المثبت، وحالته الآن `off`.

---

## ٨. خطوات التشغيل والتحقق من الصفر

### المتطلبات المسبقة (وهي الحد الحقيقي حاليًا)

1. Node وpnpm (README يذكر أن Node 25 غير مدعوم — `README.md:174`).
2. **حالة `~/.local/share/rakazo-native` جاهزة**:
   - `owner.pw` و`app.pw`
   - `pgdata/`
   - `tools/pg/.../@embedded-postgres/linux-x64/native/bin/pg_ctl`

   لا يوجد سكربت في المستودع ينشئ هذه الحالة (`ls scripts/native` لا يضم `install-postgres.sh`؛ و`grep initdb scripts/native` → لا شيء). على جهاز جديد إما تنسخ الحالة من جهاز عامل، أو تجهّزها يدويًا. هذه أكبر فجوة في «من الصفر».

### أ) تشغيل الستاك المحلي

```bash
cd /path/to/rakazo
node scripts/native/setup-env.mjs      # يكتب .env؛ يفشل إن غابت owner.pw/app.pw
bash scripts/native/start.sh           # Postgres 5433 + API 3100 + web 5173
```

افتح **`http://localhost:5173`** لا `127.0.0.1:5173` (passkeys مرتبطة بـlocalhost).

### ب) التحقق

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3100/internal/health   # 200
curl -s http://127.0.0.1:3100/api/auth/capabilities
```

المتوقع في الـcapabilities: `"passwordAuth":true`، `"registrationOpen":true` (إن كان التسجيل مفتوحًا)، و`"passkeyRpId":"localhost"`.
ثم افتح `/sign-in`: يجب أن ترى حالة تحميل ثم النموذج — لا شاشة بيضاء.

### ج) اللينك الحي

```bash
# مرة واحدة
# ثبّت cloudflared بالأمر الذي يطبعه السكربت
bash scripts/native/tunnel.sh

# أو تلقائيًا مع الستاك:
# RAKAZO_DEV_TUNNEL=1 في .env ثم أعد تشغيل start.sh

bash scripts/native/status.sh          # {"state":"running","url":"https://...trycloudflare.com",...}
```

ثم Settings → Live link: لمبة خضراء، لينك قابل للنسخ، وقت تشغيل، وزر Stop.
لإيقافه: زر Stop أو `bash scripts/native/stop.sh`.

### د) المتصفح وbrowse

```bash
bash scripts/native/install-browser.sh          # Chrome for Testing + الإضافة + السياسة
bash scripts/native/browse-setup.sh --wait-seconds 45
bash scripts/native/browse-mcp-enable.sh --check # 8/8 أدوات + connected
```

ثم أعد تشغيل API/worker (`Ctrl+C` ثم `bash scripts/native/start.sh` — لا تستخدم `stop.sh` لأنه يوقف Postgres).
وأخيرًا خطوة الأدمن الواحدة: **Plugins → + → Manage MCP servers → STDIO** بالاسم `browse` والأمر الذي طبعه السكربت و`mcp`.

### هـ) جوجل

```bash
bash scripts/native/install-chrome.sh    # ينزّل Chrome رسميًا إن لم يكن موجودًا
bash scripts/native/browser-login.sh     # يفتح نافذة عادية: سجّل الدخول بنفسك
```

رموز الخروج: `0` نجاح، `2` متطلب ناقص (عرض/Chrome/بروفايل)، `3` لا جلسة بعد التحقق، `4` Chrome خرج.

### و) الإيقاف

```bash
bash scripts/native/stop.sh    # النفق ثم Chromium ثم Postgres
```

---

## ملحق: ما الذي تغيّر في هذه الجولة (ملفات رئيسية)

- **الديسكتوب:** `host-stack.ts` + اختباره، `docker-move.ts`، `setup.js`، `setup.test.ts`، `setup-config.ts`، `main.ts`.
- **الدخول:** `Auth.tsx` + اختباره، `passkeys.ts`، `index.html`، `auth-capabilities.ts` + اختباره.
- **الموبايل:** `endpoint.ts` + اختباره، `live-link.ts` + اختباره، `server.tsx`، `account.tsx`.
- **اللينك الحي:** `tunnel.sh`، `status.sh`، `stop.sh`، `native-runtime.ts`، `app.ts`، `LiveLinkSettingsPanel.tsx`.
- **المتصفح:** `computer-panel.tsx` + اختباره، `live-input.ts`، `browser-tabs-panel.tsx`، `native-browser.ts`.
- **browse:** `browse-setup.sh`، `browse-mcp-enable.sh`، `browser.sh`، `install-browser.sh`، حزمة `packages/adapters/src/browse/*`، `docs/native-browser.md`.
- **جوجل:** `install-chrome.sh`، `browser-login.sh`، `docs/computer.md`، تعليمات البوت، حارس `rakazo-page-browser`.
- **التنظيف:** حذف 7 كتالوجات + `apps/web/.gitignore`، وتحديث `README.md` و`SETUP_PROMPT.md` و`.env.example`.
