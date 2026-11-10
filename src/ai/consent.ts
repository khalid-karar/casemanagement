import { createHash } from 'node:crypto';

/** Bump when the wording or what is sent changes: every client must then sign again. */
export const CONSENT_VERSION = '2026-11-v1';

/**
 * DRAFT wording for counsel to finalise before any client signs it. It must be shown to the signer in full,
 * in Arabic and English, and the hash of exactly what was shown is stored with the signature.
 */
export function consentText(p: { providerName: string; region: string; includePersonal: boolean }) {
  const personalEn = p.includePersonal
    ? 'Names and other personal fields of case parties MAY be included in what is sent.'
    : 'Names and other personal fields of case parties are masked before anything is sent.';
  const personalAr = p.includePersonal
    ? 'قد تُرسل أسماء أطراف القضايا وبياناتهم الشخصية ضمن المحتوى.'
    : 'تُحجب أسماء أطراف القضايا وبياناتهم الشخصية قبل إرسال أي محتوى.';
  return {
    version: CONSENT_VERSION,
    en: [
      `We authorise the use of ${p.providerName} (processing region: ${p.region}) to power AI features for our organisation.`,
      'Content from cases our users can already access (for example field values and document types) is sent to that provider to answer a question or draft text.',
      'Never sent: privileged legal matters, sealed reporter identities, and any case the asking user cannot access.',
      personalEn,
      'The provider must process in the Kingdom of Saudi Arabia, must not retain the content, and must not use it to train models.',
      'AI output is a draft; a person approves every decision. We may withdraw this authorisation at any time; AI then stops using the provider immediately.',
    ],
    ar: [
      `نفوّض باستخدام ${p.providerName} (منطقة المعالجة: ${p.region}) لتشغيل خصائص الذكاء الاصطناعي لدى منشأتنا.`,
      'يُرسل إلى المزوّد محتوى من القضايا التي يحق للمستخدم السائل الاطلاع عليها أصلاً (مثل قيم الحقول وأنواع المستندات) للإجابة عن سؤال أو صياغة نص.',
      'لا يُرسل أبداً: القضايا القانونية المشمولة بالامتياز، وهويات المبلّغين المحجوبة، وأي قضية لا يحق للمستخدم السائل الاطلاع عليها.',
      personalAr,
      'يجب أن يعالج المزوّد البيانات داخل المملكة العربية السعودية، وألا يحتفظ بالمحتوى، وألا يستخدمه لتدريب النماذج.',
      'مخرجات الذكاء الاصطناعي مسودة، ويعتمد إنسان كل قرار. يجوز لنا سحب هذا التفويض في أي وقت، ويتوقف الذكاء الاصطناعي عندها فوراً عن استخدام المزوّد.',
    ],
  };
}

export const consentHash = (t: ReturnType<typeof consentText>) => createHash('sha256').update(JSON.stringify(t)).digest('hex');

export interface ConsentRecord {
  version: string;
  textSha256: string;
  signedByUserId: string;
  signedByName: string;
  signedByTitle: string;
  signedAt: string;
  providerName: string;
  region: string;
  includePersonal: boolean;
  revokedAt?: string;
  revokedBy?: string;
}

export interface AiSettings {
  tenantId: string;
  mode: 'SOVEREIGN' | 'IN_KINGDOM_API';
  consent?: ConsentRecord;
}

export const defaultSettings = (tenantId: string): AiSettings => ({ tenantId, mode: 'SOVEREIGN' });

/** Valid only if signed on the current wording, for the provider now configured, and not withdrawn. */
export function consentValid(s: AiSettings, current: { providerName: string; region: string }): boolean {
  const c = s.consent;
  return s.mode === 'IN_KINGDOM_API' && !!c && !c.revokedAt && c.version === CONSENT_VERSION
    && c.providerName === current.providerName && c.region === current.region;
}
