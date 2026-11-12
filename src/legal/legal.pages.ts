/**
 * The Terms of Use and Privacy Policy pages (App Review needs a URL for each). Plain HTML, English
 * first and Arabic below it, no scripts. The text describes what the app really does: if behaviour
 * changes (what is stored, how long, who sees it), change this text in the same commit.
 */

const UPDATED = '12 November 2026';
const UPDATED_AR = '12 نوفمبر 2026';

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

interface Section {
  heading: string;
  /** Paragraphs, or a bullet list when it is an array of strings inside an array. */
  body: (string | string[])[];
}

function renderSections(sections: Section[]): string {
  return sections
    .map(
      (s) =>
        `<h2>${s.heading}</h2>` +
        s.body
          .map((part) => (Array.isArray(part) ? `<ul>${part.map((li) => `<li>${li}</li>`).join('')}</ul>` : `<p>${part}</p>`))
          .join(''),
    )
    .join('\n');
}

function layout(title: string, titleAr: string, english: Section[], arabic: Section[]): string {
  return `<!doctype html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Stoop</title>
<style>
  :root { --bg: #f7f3e8; --fg: #12233f; --muted: #4a5a75; --accent: #b87a00; --line: #d9d2bd; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #12233f; --fg: #f7f3e8; --muted: #b9c2d3; --accent: #f4b740; --line: #26406b; }
  }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 17px/1.6 -apple-system, system-ui, "Segoe UI", sans-serif; }
  main { max-width: 42rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
  h1 { font-size: 2rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.15rem; margin: 2rem 0 .25rem; }
  p, li { color: var(--fg); }
  .muted { color: var(--muted); font-size: .95rem; }
  a { color: var(--accent); }
  hr { border: 0; border-top: 1px solid var(--line); margin: 3rem 0; }
  section[lang="ar"] { font-family: -apple-system, system-ui, "Segoe UI", "Geeza Pro", sans-serif; }
</style>
</head>
<body>
<main>
<section lang="en" dir="ltr">
<h1>${title}</h1>
<p class="muted">Stoop · Last updated ${UPDATED} · <a href="#ar">العربية</a></p>
${renderSections(english)}
</section>
<hr>
<section id="ar" lang="ar" dir="rtl">
<h1>${titleAr}</h1>
<p class="muted">Stoop · آخر تحديث ${UPDATED_AR}</p>
${renderSections(arabic)}
</section>
</main>
</body>
</html>`;
}

export function privacyPage(supportEmail: string): string {
  const email = escapeHtml(supportEmail);
  const mail = `<a href="mailto:${email}">${email}</a>`;
  return layout(
    'Privacy Policy',
    'سياسة الخصوصية',
    [
      {
        heading: 'Who we are',
        body: [`Stoop is a small app, made and run by an independent developer, where friends see each other on a map and rate places. Questions about this policy: ${mail}.`],
      },
      {
        heading: 'What we collect',
        body: [
          [
            '<strong>Your account:</strong> the identifier Apple or Google gives us when you sign in, your email address if you sign up with email (your password is kept only as a salted hash, never as text), the name Apple shares if you choose to share it, and your username and display name.',
            '<strong>Your character:</strong> the look you chose for your avatar. It is a drawing, not a photo of you.',
            '<strong>What you add:</strong> your ratings and comments, and photos of places and menus. We remove location data from photos before anyone sees them.',
            '<strong>Friends and safety:</strong> friend requests and friendships, people you block, and reports you send.',
            '<strong>Your location:</strong> only while the app is open and you are not in ghost mode, your phone sends your position to our server, which passes it on to your accepted friends. It is kept in the server\'s memory for at most 60 seconds and is never stored in a database. There is no location history.',
            '<strong>Nearby alerts (only if you turn them on):</strong> your phone also sends a rough position (to about 100 metres) when you have moved a few hundred metres, even while Stoop is closed. The server keeps only the latest one, for at most 30 minutes, and uses it only to tell you and a friend that you are within 500 metres of each other. Nobody sees it on the map, and it is never stored in a database.',
            '<strong>Notifications:</strong> if you allow them, the push token Apple gives your phone, used only to send you Stoop notifications (friend requests, accepted requests and, if turned on, nearby friends). It is removed when you sign out or delete your account.',
            '<strong>Technical data:</strong> your IP address and sign-in sessions, used to keep your account secure and to stop abuse. They are short-lived counters and tokens, not a profile of you.',
          ],
        ],
      },
      {
        heading: 'How we use it',
        body: [
          'To run Stoop: show you and your friends on the map, show ratings and photos on places, and keep your account signed in. To keep Stoop safe: review reports, remove content and close accounts that break the rules. We email you only the sign-in codes you ask for. We do not show ads, we do not sell your data, and we do not track you across other apps or websites.',
        ],
      },
      {
        heading: 'Who can see what',
        body: [
          [
            'Only friends you have accepted (and who have not blocked you) can see where you are, and only while you are not in ghost mode.',
            'With nearby alerts on, a friend who also uses them may get a notification that you are nearby. It names you but does not say where you are.',
            'Anyone using Stoop can see your username, character, and the ratings, comments and photos you add to a place.',
            'People you block, and people who block you, cannot see each other anywhere in Stoop.',
          ],
        ],
      },
      {
        heading: 'Services we use',
        body: [
          'Apple (Sign in with Apple, Apple Maps and notifications), Google (optional sign-in), Railway (hosting for our servers, database and photo storage) and Brevo (sends your sign-in codes if you use email). They process data for us only to provide these services.',
        ],
      },
      {
        heading: 'Your choices and deleting your account',
        body: [
          [
            'Turn on ghost mode to hide yourself from friends, or turn off location for Stoop in iOS Settings.',
            'Nearby alerts are off until you turn them on in Stoop\'s settings, and you can turn them off there, or turn off notifications for Stoop in iOS Settings, at any time.',
            'Change your username and character any time in the app.',
            'Delete your account in the app: Profile, then <strong>Delete account</strong>. This removes your ratings, comments, photos, friendships, blocks, sessions and notification tokens, and anonymises your account. Reports you sent, or that were made about you, may be kept so we can keep Stoop safe.',
            `You can also ask us by email: ${mail}.`,
          ],
        ],
      },
      {
        heading: 'Children',
        body: ['Stoop is not meant for children under 13. If you are under 13, please do not use it.'],
      },
      {
        heading: 'Changes',
        body: ['If this policy changes, we will update the date at the top. If a change affects how we use your data in a big way, we will tell you in the app.'],
      },
      { heading: 'Contact', body: [`${mail}`] },
    ],
    [
      {
        heading: 'من نحن',
        body: [`Stoop تطبيق صغير يطوّره ويديره مطوّر مستقل، يرى فيه الأصدقاء بعضهم على الخريطة ويقيّمون الأماكن. للاستفسار عن هذه السياسة: ${mail}.`],
      },
      {
        heading: 'ما الذي نجمعه',
        body: [
          [
            '<strong>حسابك:</strong> المعرّف الذي تعطينا إياه Apple أو Google عند تسجيل الدخول، وبريدك الإلكتروني إن سجّلت بالبريد (وكلمة المرور تُحفظ فقط في صورة مشفّرة ولا تُحفظ نصًا أبدًا)، والاسم الذي تشاركه Apple إن اخترت مشاركته، واسم المستخدم واسم العرض.',
            '<strong>شخصيتك:</strong> الشكل الذي اخترته لصورتك الرمزية. هي رسم وليست صورة لك.',
            '<strong>ما تضيفه:</strong> تقييماتك وتعليقاتك وصور الأماكن والقوائم. نزيل بيانات الموقع من الصور قبل أن يراها أي أحد.',
            '<strong>الأصدقاء والأمان:</strong> طلبات الصداقة والصداقات ومن تحظرهم والبلاغات التي ترسلها.',
            '<strong>موقعك:</strong> فقط أثناء فتح التطبيق وعندما لا تكون في وضع الإخفاء، يرسل هاتفك موقعك إلى خادمنا ليمرّره إلى أصدقائك المقبولين. يبقى في ذاكرة الخادم 60 ثانية كحد أقصى ولا يُحفظ في أي قاعدة بيانات. لا يوجد سجل لمواقعك.',
            '<strong>تنبيهات الأصدقاء القريبين (فقط إن فعّلتها):</strong> يرسل هاتفك أيضًا موقعًا تقريبيًا (بدقة نحو 100 متر) كلما تحرّكت بضع مئات من الأمتار، حتى وStoop مغلق. يحتفظ الخادم بآخر موقع فقط، لمدة 30 دقيقة كحد أقصى، ويستخدمه فقط ليخبرك أنت وصديقك أنكما على بعد 500 متر أو أقل. لا يراه أحد على الخريطة ولا يُحفظ في أي قاعدة بيانات.',
            '<strong>الإشعارات:</strong> إن سمحت بها، رمز الإشعارات الذي تعطيه Apple لهاتفك، ويُستخدم فقط لإرسال إشعارات Stoop إليك (طلبات الصداقة وقبولها، وتنبيهات الأصدقاء القريبين إن فعّلتها). يُحذف عند تسجيل الخروج أو حذف الحساب.',
            '<strong>بيانات تقنية:</strong> عنوان IP وجلسات تسجيل الدخول، لحماية حسابك ومنع إساءة الاستخدام. هي عدّادات ورموز قصيرة العمر وليست ملفًا عنك.',
          ],
        ],
      },
      {
        heading: 'كيف نستخدمها',
        body: [
          'لتشغيل Stoop: إظهارك أنت وأصدقاءك على الخريطة، وعرض التقييمات والصور على الأماكن، وإبقاء حسابك مسجّلًا. ولحماية Stoop: مراجعة البلاغات وإزالة المحتوى وإغلاق الحسابات المخالفة. لا نراسلك إلا برموز الدخول التي تطلبها. لا نعرض إعلانات ولا نبيع بياناتك ولا نتتبعك عبر تطبيقات أو مواقع أخرى.',
        ],
      },
      {
        heading: 'من يرى ماذا',
        body: [
          [
            'لا يرى مكانك إلا الأصدقاء الذين قبلتهم (ولم يحظروك)، وفقط ما دمت خارج وضع الإخفاء.',
            'عند تفعيل تنبيهات الأصدقاء القريبين، قد يصل إلى صديق يستخدمها أيضًا إشعار بأنك قريب. يذكر اسمك ولا يذكر مكانك.',
            'يستطيع أي مستخدم لـ Stoop رؤية اسم المستخدم والشخصية والتقييمات والتعليقات والصور التي تضيفها إلى مكان ما.',
            'من تحظرهم ومن يحظرونك لا يرى أحدهم الآخر في أي مكان في Stoop.',
          ],
        ],
      },
      {
        heading: 'الخدمات التي نستخدمها',
        body: [
          'Apple (تسجيل الدخول بحساب Apple وخرائط Apple والإشعارات)، وGoogle (تسجيل دخول اختياري)، وRailway (استضافة الخوادم وقاعدة البيانات وتخزين الصور)، وBrevo (إرسال رموز الدخول إن استخدمت البريد). تعالج هذه الجهات البيانات لصالحنا فقط لتقديم هذه الخدمات.',
        ],
      },
      {
        heading: 'خياراتك وحذف حسابك',
        body: [
          [
            'فعّل وضع الإخفاء لتختفي عن أصدقائك، أو أوقف الموقع لـ Stoop من إعدادات iOS.',
            'تنبيهات الأصدقاء القريبين معطّلة حتى تفعّلها من إعدادات Stoop، ويمكنك إيقافها من هناك، أو إيقاف إشعارات Stoop من إعدادات iOS، في أي وقت.',
            'يمكنك تغيير اسم المستخدم والشخصية في أي وقت من التطبيق.',
            'احذف حسابك من التطبيق: الملف الشخصي ثم <strong>حذف الحساب</strong>. يزيل ذلك تقييماتك وتعليقاتك وصورك وصداقاتك وحظرك وجلساتك ورموز الإشعارات، ويجعل حسابك مجهول الهوية. قد نحتفظ بالبلاغات التي أرسلتها أو التي قُدّمت ضدك لنحافظ على أمان Stoop.',
            `يمكنك أيضًا طلب ذلك بالبريد: ${mail}.`,
          ],
        ],
      },
      {
        heading: 'الأطفال',
        body: ['Stoop ليس موجّهًا للأطفال دون 13 عامًا. إن كان عمرك أقل من 13 فنرجو ألا تستخدمه.'],
      },
      {
        heading: 'التغييرات',
        body: ['إن تغيّرت هذه السياسة فسنحدّث التاريخ في أعلاها. وإن كان التغيير كبيرًا في طريقة استخدامنا لبياناتك فسنخبرك داخل التطبيق.'],
      },
      { heading: 'التواصل', body: [`${mail}`] },
    ],
  );
}

export function termsPage(supportEmail: string): string {
  const email = escapeHtml(supportEmail);
  const mail = `<a href="mailto:${email}">${email}</a>`;
  return layout(
    'Terms of Use',
    'شروط الاستخدام',
    [
      {
        heading: 'Using Stoop',
        body: [
          'You must be at least 13 years old. Keep your sign-in safe, and use one account. By creating an account or signing in, you agree to these terms and to the <a href="/privacy">Privacy Policy</a>.',
        ],
      },
      {
        heading: 'Your content',
        body: [
          'Your ratings, comments and photos stay yours. You give us permission to store them and show them to other people in Stoop. You promise that you have the right to share what you add (for photos, that you took them or may share them).',
        ],
      },
      {
        heading: 'Rules',
        body: [
          'Stoop has no tolerance for objectionable content or abusive people. Do not post or do any of these:',
          [
            'anything illegal, hateful, threatening, harassing or sexually explicit, or graphic violence',
            'photos that are not of a place or its menu, or private photos of other people',
            'pretending to be someone else, or fake or paid ratings meant to mislead',
            'spam, or trying to break, overload or collect data from Stoop',
          ],
        ],
      },
      {
        heading: 'Reporting, blocking and moderation',
        body: [
          'Every rating, photo and person in Stoop has a Report option, and every person can be blocked. A blocked person and you cannot see each other anywhere in the app. We review reports regularly, aiming for within one day. We may remove content, and suspend or close accounts that break these rules, without notice.',
        ],
      },
      {
        heading: 'Sharing your location',
        body: [
          'While Stoop is open and you are not in ghost mode, your friends can see where you are. Only accept people you trust, and use ghost mode whenever you do not want to be seen. Details are in the <a href="/privacy">Privacy Policy</a>.',
        ],
      },
      {
        heading: 'Places and ratings',
        body: [
          'Ratings, comments and photos are the opinions and uploads of people using Stoop, not ours. Place details come from Apple Maps. We do not promise that any of it is correct or up to date.',
        ],
      },
      {
        heading: 'The service',
        body: [
          'Stoop is provided as it is. We may change it or stop it, and we do not promise it will always work. To the extent the law allows, we are not responsible for losses that come from using Stoop.',
        ],
      },
      {
        heading: 'Ending your account',
        body: [
          'You can delete your account any time in the app (Profile, then Delete account). We may suspend or close accounts that break these terms.',
        ],
      },
      {
        heading: 'Changes',
        body: ['We may update these terms. The date at the top shows the latest version. If you keep using Stoop after a change, you accept it.'],
      },
      { heading: 'Contact', body: [`${mail}`] },
    ],
    [
      {
        heading: 'استخدام Stoop',
        body: [
          'يجب ألا يقل عمرك عن 13 عامًا. حافظ على أمان تسجيل دخولك واستخدم حسابًا واحدًا. بإنشاء حساب أو تسجيل الدخول فأنت توافق على هذه الشروط وعلى <a href="/privacy">سياسة الخصوصية</a>.',
        ],
      },
      {
        heading: 'محتواك',
        body: [
          'تقييماتك وتعليقاتك وصورك تبقى ملكك. وأنت تمنحنا إذنًا بحفظها وعرضها على الآخرين داخل Stoop. وتتعهد بأن لك الحق في مشاركة ما تضيفه (وفي الصور، أنك التقطتها أو يحق لك مشاركتها).',
        ],
      },
      {
        heading: 'القواعد',
        body: [
          'لا يتسامح Stoop مع المحتوى المسيء أو الأشخاص المسيئين. لا تنشر ولا تفعل أيًا مما يلي:',
          [
            'أي شيء غير قانوني أو يحض على الكراهية أو التهديد أو المضايقة أو إباحي، أو عنف مصوّر',
            'صور ليست لمكان أو لقائمته، أو صور خاصة لأشخاص آخرين',
            'انتحال شخصية أحد، أو تقييمات مزيفة أو مدفوعة بهدف التضليل',
            'الرسائل المزعجة، أو محاولة تعطيل Stoop أو إرهاقه أو جمع البيانات منه',
          ],
        ],
      },
      {
        heading: 'الإبلاغ والحظر والإشراف',
        body: [
          'لكل تقييم وصورة وشخص في Stoop خيار إبلاغ، ويمكن حظر أي شخص. ولا يرى المحظور وأنت بعضكما في أي مكان في التطبيق. نراجع البلاغات بانتظام ونسعى لذلك خلال يوم واحد. قد نزيل المحتوى ونوقف الحسابات المخالفة أو نغلقها دون إشعار.',
        ],
      },
      {
        heading: 'مشاركة موقعك',
        body: [
          'ما دام Stoop مفتوحًا وأنت خارج وضع الإخفاء، يستطيع أصدقاؤك رؤية مكانك. اقبل فقط من تثق بهم، واستخدم وضع الإخفاء متى لم ترد أن تُرى. التفاصيل في <a href="/privacy">سياسة الخصوصية</a>.',
        ],
      },
      {
        heading: 'الأماكن والتقييمات',
        body: [
          'التقييمات والتعليقات والصور هي آراء ومشاركات مستخدمي Stoop وليست منّا. وتفاصيل الأماكن مصدرها خرائط Apple. ولا نضمن صحة أي منها أو حداثته.',
        ],
      },
      {
        heading: 'الخدمة',
        body: [
          'يُقدَّم Stoop كما هو. قد نغيّره أو نوقفه، ولا نعد بأنه سيعمل دائمًا. وبالقدر الذي يسمح به القانون لا نتحمل مسؤولية الخسائر الناتجة عن استخدامه.',
        ],
      },
      {
        heading: 'إنهاء حسابك',
        body: [
          'يمكنك حذف حسابك في أي وقت من التطبيق (الملف الشخصي ثم حذف الحساب). وقد نوقف الحسابات المخالفة لهذه الشروط أو نغلقها.',
        ],
      },
      {
        heading: 'التغييرات',
        body: ['قد نحدّث هذه الشروط، والتاريخ في أعلاها يبيّن أحدث نسخة. ومتابعتك استخدام Stoop بعد التغيير تعني قبولك له.'],
      },
      { heading: 'التواصل', body: [`${mail}`] },
    ],
  );
}
