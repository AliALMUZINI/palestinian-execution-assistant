import { generateText } from 'ai';
import { google } from '@ai-sdk/google';

const PALESTINIAN_EXECUTION_INSTRUCTIONS = `
أنت مساعد التنفيذ الفلسطيني في مكتب المحامي علي محمد المزيني.
تلتزم حصراً بقانون التنفيذ الفلسطيني رقم (23) لسنة 2005 وتعديلاته، وبالقواعد الإجرائية الفلسطينية ذات الصلة.
لا تخترع نصاً قانونياً أو رقماً لمادة أو حكماً قضائياً. إن لم تتأكد من النص، قل بوضوح: «يلزم التحقق من النص قبل الإيداع».
لا تقدّم نتيجة قطعية ولا تدّعي تمثيل المستخدم؛ المخرجات مسودة مهنية للمراجعة من محامٍ مزاول.
حلل الوقائع ثم اكتب بالعربية القانونية، وبالترتيب الآتي:
1) الخلاصة العملية؛ 2) التكييف والمستندات؛ 3) الإجراء أو الطلب الراجح؛
4) المدد والمخاطر إن ظهرت من الوقائع؛ 5) مسودة أولية قابلة للنسخ؛ 6) بيانات ناقصة وأسئلة لازمة.
لا تستخدم تشريعات أجنبية، ولا تعرض بيانات حساسة أو أسماء غير لازمة.
`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    return res.status(503).json({
      error: 'لم يتم ضبط مفتاح Gemini في إعدادات الموقع.'
    });
  }

  const {
    requestType = 'تحليل واقعة تنفيذية',
    facts = '',
    goal = ''
  } = req.body || {};

  if (!facts.trim()) {
    return res.status(400).json({ error: 'يرجى إدخال الوقائع أولاً.' });
  }

  try {
    const { text } = await generateText({
     model: google('gemini-3.7-flash'),
      system: PALESTINIAN_EXECUTION_INSTRUCTIONS,
      prompt: `نوع الخدمة: ${requestType}
الهدف الإجرائي: ${goal || 'غير محدد'}
الوقائع:
${facts}`
    });

    return res.status(200).json({ text });
  } catch (error) {
    console.error('Gemini error:', error);
    return res.status(500).json({
      error: 'تعذر توليد المسودة الآن. راجع إعدادات Gemini وحاول مجدداً.'
    });
  }
}
