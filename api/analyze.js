import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { generateText } from 'ai';
import { google } from '@ai-sdk/google';

const ARCHIVE_PATH = fileURLToPath(new URL('../data/archive-index.json', import.meta.url));
const MAX_SOURCES = 6;
const MAX_CHARS_PER_SOURCE = 2200;

const PALESTINIAN_EXECUTION_INSTRUCTIONS = `
أنت مساعد التنفيذ الفلسطيني في مكتب المحامي علي محمد المزيني.
تلتزم حصراً بقانون التنفيذ الفلسطيني رقم (23) لسنة 2005 وتعديلاته، وبالقواعد الإجرائية الفلسطينية ذات الصلة.

المصادر المرفقة هي مواد استرجاع مساندة. التشريع الفلسطيني النافذ هو المصدر الأعلى، ثم الأحكام القضائية الفلسطينية الموثقة، ثم الشروح والأبحاث الفقهية. لا تعتبر البحث أو الشرح دليلاً قاطعاً على سريان نص أو تعديل.
لا تخترع نصاً قانونياً أو رقماً لمادة أو حكماً قضائياً. إذا لم يتوافر النص الرسمي أو لم تتأكد من سريانه، قل بوضوح: «يلزم التحقق من النص قبل الإيداع».
لا تقدّم نتيجة قطعية ولا تدّعي تمثيل المستخدم؛ المخرجات مسودة مهنية للمراجعة من محامٍ مزاول.
لا تستخدم تشريعات أجنبية، ولا تعرض بيانات حساسة أو أسماء غير لازمة.

حلل الوقائع ثم اكتب بالعربية القانونية، بالترتيب الآتي:
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
  const stopWords = new Set(['من', 'الى', 'على', 'في', 'عن', 'هذا', 'هذه', 'ذلك', 'التي', 'الذي', 'مع', 'ثم', 'او', 'ان', 'ما', 'هل', 'تم', 'بعد', 'قبل']);
  return [...new Set(normalize(value).split(/\s+/).filter((word) => word.length > 2 && !stopWords.has(word)))];
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
      const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
      return { ...record, score: (score * 100) + Number(record.authorityRank || 0) };
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
  const response = await fetch(`https://www.googleapis.com/customsearch/v1?${params}`);
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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    return res.status(503).json({
      error: 'لم يتم ضبط مفتاح Gemini في إعدادات Vercel.'
    });
  }

  const { requestType = 'تحليل واقعة تنفيذية', facts = '', goal = '', useWeb = false } = req.body || {};
  if (!facts.trim()) {
    return res.status(400).json({ error: 'يرجى إدخال الوقائع أولاً.' });
  }

  try {
    const archive = await loadArchive();
    const sources = retrieve(archive.records || [], `${requestType} ${goal} ${facts}`);
    const webSearch = await liveSearch(`${requestType} ${goal} ${facts}`, Boolean(useWeb));
    const referenceText = sources.length
      ? sources.map((source, index) => `مرجع ${index + 1}: ${source.sourceTitle} - صفحة PDF ${source.pdfPage}\n${source.text.slice(0, MAX_CHARS_PER_SOURCE)}`).join('\n\n')
      : 'لم يُسترجع مقطع محدد من الأرشيف؛ لا تستنتج من ذلك عدم وجود نص قانوني.';
    const webReferenceText = webSearch.results.length
      ? webSearch.results.map((item, index) => `نتيجة حية ${index + 1}: ${item.title}\n${item.snippet}\n${item.link}`).join('\n\n')
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

نتائج البحث الحي (إن وجدت، وهي معلومات مساندة يجب التحقق منها):
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
    return res.status(500).json({
      error: 'تعذر توليد المسودة الآن. حاول مجدداً بعد لحظات.'
    });
  }
}
