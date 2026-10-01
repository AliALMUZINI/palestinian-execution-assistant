import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { generateText } from 'ai';
import { google } from '@ai-sdk/google';

const ARCHIVE_PATH = fileURLToPath(
  new URL('../data/archive-index.json', import.meta.url)
);
const MAX_SOURCES = 6;
const MAX_CHARS_PER_SOURCE = 2200;

const PALESTINIAN_EXECUTION_INSTRUCTIONS = `
أنت مساعد التنفيذ الفلسطيني في مكتب المحامي علي محمد المزيني.
تلتزم حصراً بقانون التنفيذ الفلسطيني رقم (23) لسنة 2005 وتعديلاته، وبالقواعد الإجرائية الفلسطينية ذات الصلة.

المصادر المرفقة مواد استرجاع مساندة. التشريع الفلسطيني النافذ هو المصدر الأعلى، ثم الأحكام القضائية الفلسطينية الموثقة، ثم الشروح والأبحاث الفقهية.
لا تخترع نصاً قانونياً أو رقماً لمادة أو حكماً قضائياً. إذا لم تتأكد من النص، قل: «يلزم التحقق من النص قبل الإيداع».
لا تقدم نتيجة قطعية ولا تدعي تمثيل المستخدم؛ المخرجات مسودة مهنية للمراجعة من محامٍ مزاول.
لا تستخدم تشريعات أجنبية ولا تعرض بيانات حساسة أو أسماء غير لازمة.

حلل الوقائع ثم اكتب بالعربية القانونية بالترتيب الآتي:
1) الخلاصة العملية.
2) التكييف والمستندات.
3) الإجراء أو الطلب الراجح.
4) المدد والمخاطر إن ظهرت من الوقائع.
5) مسودة أولية قابلة للنسخ.
6) بيانات ناقصة وأسئلة لازمة.

عند الاستفادة من أي مرجع مسترجع، اذكر عنوانه ورقم صفحة PDF في قسم مستقل باسم «مراجع مساندة».
`;

let archivePromise;

function normalize(value = '') {
  return String(value)
    .toLowerCase()
    .replace(/[ًٌٍَُِّْـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ');
}

function keywords(value) {
  const stopWords = new Set([
    'من', 'الى', 'على', 'في', 'عن', 'هذا', 'هذه', 'ذلك',
    'التي', 'الذي', 'مع', 'ثم', 'او', 'ان', 'ما', 'هل',
    'تم', 'بعد', 'قبل'
  ]);

  return [...new Set(
    normalize(value)
      .split(/\s+/)
      .filter((word) => word.length > 2 && !stopWords.has(word))
  )];
}

async function loadArchive() {
  if (!archivePromise) {
    archivePromise = readFile(ARCHIVE_PATH, 'utf8').then(JSON.parse);
  }
  return archivePromise;
}

function retrieve(records, query) {
  const terms = keywords(query);
  if (!terms.length) return [];

  return records
    .map((record) => {
      const haystack = normalize(`${record.sourceTitle} ${record.text}`);
      const score = terms.reduce(
        (total, term) => total + (haystack.includes(term) ? 1 : 0),
        0
      );

      return {
        ...record,
        score: (score * 100) + Number(record.authorityRank || 0)
      };
    })
    .filter((record) => record.score > 0 && record.text.trim())
    .sort((a, b) => b.score - a.score || a.pdfPage - b.pdfPage)
    .slice(0, MAX_SOURCES);
}

async function liveSearch(query, enabled) {
  if (!enabled) return { requested: false, results: [] };

  const key = process.env.GOOGLE_CSE_API_KEY;
  const cx = process.env.GOOGLE_CSE_ID;

  if (!key || !cx) {
    return {
      requested: true,
      results: [],
      error: 'البحث الحي غير مهيأ بعد في إعدادات Vercel.'
    };
  }

  const params = new URLSearchParams({
    key,
    cx,
    q: query.slice(0, 1500),
    num: '5',
    lr: 'lang_ar'
  });

  const response = await fetch(
    `https://www.googleapis.com/customsearch/v1?${params}`
  );

  if (!response.ok) throw new Error('تعذر تنفيذ البحث الحي الآن.');

  const data = await response.json();

  return {
    requested: true,
    results: (data.items || []).map((item) => ({
      title: item.title || '',
      link: item.link || '',
      displayLink: item.displayLink || '',
      snippet: item.snippet || ''
    }))
  };
}

function archiveFallback(sources, requestType, goal) {
  if (!sources.length) {
    return `## نتائج البحث في الأرشيف القانوني

لم يُعثر على مقطع مطابق بشكل كافٍ في الأرشيف المتاح لهذه الوقائع. يُرجى تعديل كلمات البحث أو إضافة تفاصيل عن السند التنفيذي أو الإجراء المطلوب.

> تنبيه: خدمة التحليل الذكي غير متاحة مؤقتًا، لذلك عُرضت نتيجة البحث في الأرشيف فقط.`;
  }

  const heading = goal
    ? `**الخدمة المطلوبة:** ${requestType}\n\n**الهدف الإجرائي:** ${goal}`
    : `**الخدمة المطلوبة:** ${requestType}`;

  const results = sources.map((source, index) => {
    const excerpt = source.text.trim().slice(0, 1600);

    return `### ${index + 1}. ${source.sourceTitle}
**${source.authority || 'مرجع مؤرشف'} — صفحة PDF ${source.pdfPage}**

${excerpt}`;
  }).join('\n\n---\n\n');

  return `## نتائج البحث في الأرشيف القانوني

${heading}

> تعذّر الاتصال بخدمة التحليل الذكي مؤقتًا؛ لذلك يعرض الموقع أدناه المقاطع الأكثر صلة من الأرشيف. يلزم التحقق من النص النافذ قبل الإيداع.

${results}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  const {
    requestType = 'تحليل واقعة تنفيذية',
    facts = '',
    goal = '',
    useWeb = false
  } = req.body || {};

  if (!facts.trim()) {
    return res.status(400).json({ error: 'يرجى إدخال الوقائع أولاً.' });
  }

  const archive = await loadArchive();
  const sources = retrieve(
    archive.records || [],
    `${requestType} ${goal} ${facts}`
  );

  let webSearch = { requested: false, results: [] };

  try {
    webSearch = await liveSearch(
      `${requestType} ${goal} ${facts}`,
      Boolean(useWeb)
    );
  } catch {
    webSearch = {
      requested: Boolean(useWeb),
      results: [],
      error: 'تعذر تنفيذ البحث الحي الآن.'
    };
  }

  try {
    if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
      throw new Error('مفتاح Gemini غير مضبوط.');
    }

    const referenceText = sources.length
      ? sources.map((source, index) =>
          `مرجع ${index + 1}: ${source.sourceTitle} - صفحة PDF ${source.pdfPage}
${source.text.slice(0, MAX_CHARS_PER_SOURCE)}`
        ).join('\n\n')
      : 'لم يُسترجع مقطع محدد من الأرشيف؛ لا تستنتج من ذلك عدم وجود نص قانوني.';

    const webReferenceText = webSearch.results.length
      ? webSearch.results.map((item, index) =>
          `نتيجة حية ${index + 1}: ${item.title}
${item.snippet}
${item.link}`
        ).join('\n\n')
      : 'لا توجد نتائج بحث حي مستخدمة.';

    const { text } = await generateText({
      model: google(process.env.GEMINI_MODEL || 'gemini-3.7-flash'),
      maxOutputTokens: 2200,
      maxRetries: 3,
      system: PALESTINIAN_EXECUTION_INSTRUCTIONS,
      prompt: `نوع الخدمة: ${requestType}
الهدف الإجرائي: ${goal || 'غير محدد'}

الوقائع:
${facts}

المراجع المسترجعة من الأرشيف:
${referenceText}

نتائج البحث الحي:
${webReferenceText}`
    });

    return res.status(200).json({
      text,
      sources: sources.map((source) => ({
        title: source.sourceTitle,
        type: source.type,
        path: `صفحة PDF ${source.pdfPage}`,
        authority: source.authority
      })),
      webSearch
    });
  } catch (error) {
    console.error('Gemini/archive error:', error);

    return res.status(200).json({
      text: archiveFallback(sources, requestType, goal),
      sources: sources.map((source) => ({
        title: source.sourceTitle,
        type: source.type,
        path: `صفحة PDF ${source.pdfPage}`,
        authority: source.authority
      })),
      webSearch,
      fallback: true,
      notice: 'تعذر التحليل الذكي مؤقتًا؛ عُرضت نتائج الأرشيف القانوني بدلاً منه.'
    });
  }
}
