import { defineCaseType } from '../engine/definition';

/**
 * Legal matter: the court-escalation track. Deliberately thin in v1 (matter, hearings, filings,
 * counsel, judgment, enforcement). Contract lifecycle management, corporate secretarial and IP
 * are out of scope. Matters default to PRIVILEGED: HR/Security/Audit see nothing of them.
 */
export const legalMatter = defineCaseType({
  key: 'legal.matter',
  version: 1,
  domain: 'LEGAL',
  label: { en: 'Legal matter', ar: 'قضية قانونية' },
  defaultConfidentiality: 'PRIVILEGED',
  fields: [
    { key: 'title', label: { en: 'Matter title', ar: 'عنوان القضية' }, type: 'text', required: true },
    {
      key: 'forum',
      label: { en: 'Forum', ar: 'جهة النظر' },
      type: 'enum',
      options: ['LABOUR_COURT', 'CRIMINAL_COURT', 'COMMERCIAL_COURT', 'BOARD_OF_GRIEVANCES', 'OTHER'],
      // Once filed, none of these change by editing a field: they change by a new filing.
      lockedFrom: 'FILED',
    },
    // Comes back from Najiz on filing; it identifies the matter to the court from then on.
    { key: 'courtCaseNumber', label: { en: 'Court case number', ar: 'رقم القضية' }, type: 'text', lockedFrom: 'FILED' },
    // Claims are legitimately amended before judgment, so this stays open until the judgment lands.
    { key: 'claimValueSar', label: { en: 'Claim value (SAR)', ar: 'قيمة المطالبة (ريال)' }, type: 'money', lockedFrom: 'JUDGMENT' },
    { key: 'opposingParty', label: { en: 'Opposing party', ar: 'الطرف الآخر' }, type: 'person', sensitivity: 'PERSONAL', lockedFrom: 'FILED' },
  ],
  states: [
    { key: 'OPENED', label: { en: 'Opened', ar: 'مفتوحة' } },
    { key: 'COUNSEL_ASSIGNED', label: { en: 'Counsel assigned', ar: 'تم تعيين المحامي' } },
    { key: 'PRE_ACTION', label: { en: 'Pre-action', ar: 'ما قبل الدعوى' } },
    { key: 'FILED', label: { en: 'Filed', ar: 'تم رفع الدعوى' } },
    { key: 'HEARINGS', label: { en: 'Hearings', ar: 'الجلسات' } },
    { key: 'JUDGMENT', label: { en: 'Judgment', ar: 'صدور الحكم' } },
    { key: 'APPEAL_WINDOW', label: { en: 'Appeal window', ar: 'مهلة الاستئناف' } },
    { key: 'ENFORCEMENT', label: { en: 'Enforcement', ar: 'التنفيذ' } },
    { key: 'CLOSED', label: { en: 'Closed', ar: 'مغلقة' }, kind: 'CLOSED' },
    { key: 'ARCHIVED', label: { en: 'Archived', ar: 'مؤرشفة' }, kind: 'ARCHIVED' },
  ],
  initialState: 'OPENED',
  transitions: [
    {
      action: 'assign_counsel',
      label: { en: 'Assign counsel', ar: 'تعيين المحامي' },
      from: ['OPENED'],
      to: 'COUNSEL_ASSIGNED',
      guards: [{ kind: 'role', anyOf: ['legal_counsel'] }, { kind: 'assignee_set' }],
    },
    {
      action: 'begin_pre_action',
      label: { en: 'Begin pre-action', ar: 'بدء ما قبل الدعوى' },
      from: ['COUNSEL_ASSIGNED'],
      to: 'PRE_ACTION',
      // Evidence locks before anything is sent to a court or prosecutor.
      guards: [{ kind: 'role', anyOf: ['legal_counsel'] }, { kind: 'legal_hold_active' }, { kind: 'evidence_integrity' }],
    },
    {
      action: 'file',
      label: { en: 'File with the forum', ar: 'رفع الدعوى' },
      from: ['PRE_ACTION'],
      to: 'FILED',
      guards: [
        { kind: 'role', anyOf: ['legal_counsel'] },
        { kind: 'field_present', field: 'forum', message: { en: 'Choose a forum', ar: 'حدد جهة النظر' } },
        {
          kind: 'artifact_present',
          artifactType: 'amicable_settlement_attempt',
          when: { field: 'forum', in: ['LABOUR_COURT'] },
          message: { en: 'A labour claim needs a recorded amicable-settlement attempt first', ar: 'تتطلب الدعوى العمالية تسجيل محاولة تسوية ودية أولاً' },
        },
        { kind: 'artifact_present', artifactType: 'filing', message: { en: 'Attach the filing', ar: 'أرفق صحيفة الدعوى' } },
      ],
    },
    {
      action: 'record_hearing',
      label: { en: 'Record hearing', ar: 'تسجيل جلسة' },
      from: ['FILED', 'HEARINGS'],
      to: 'HEARINGS',
      guards: [
        { kind: 'role', anyOf: ['legal_counsel'] },
        { kind: 'artifact_present', artifactType: 'hearing_record', message: { en: 'Attach the hearing record', ar: 'أرفق محضر الجلسة' } },
      ],
    },
    {
      action: 'record_judgment',
      label: { en: 'Record judgment', ar: 'تسجيل الحكم' },
      from: ['HEARINGS'],
      to: 'JUDGMENT',
      guards: [
        { kind: 'role', anyOf: ['legal_counsel'] },
        { kind: 'artifact_present', artifactType: 'judgment', message: { en: 'Attach the judgment', ar: 'أرفق الحكم' } },
      ],
    },
    {
      action: 'open_appeal_window',
      label: { en: 'Open appeal window', ar: 'فتح مهلة الاستئناف' },
      from: ['JUDGMENT'],
      to: 'APPEAL_WINDOW',
      guards: [{ kind: 'role', anyOf: ['legal_counsel'] }],
    },
    {
      action: 'begin_enforcement',
      label: { en: 'Begin enforcement', ar: 'بدء التنفيذ' },
      from: ['JUDGMENT', 'APPEAL_WINDOW'],
      to: 'ENFORCEMENT',
      guards: [
        { kind: 'role', anyOf: ['legal_counsel'] },
        { kind: 'artifact_present', artifactType: 'enforcement_request', message: { en: 'Attach the enforcement request', ar: 'أرفق طلب التنفيذ' } },
      ],
    },
    {
      action: 'close',
      label: { en: 'Close', ar: 'إغلاق' },
      from: ['JUDGMENT', 'APPEAL_WINDOW', 'ENFORCEMENT'],
      to: 'CLOSED',
      guards: [
        { kind: 'role', anyOf: ['legal_counsel'] },
        { kind: 'approval', approverRole: 'general_counsel' },
        { kind: 'actions_planned' },
      ],
    },
    {
      action: 'archive',
      label: { en: 'Archive', ar: 'أرشفة' },
      from: ['CLOSED'],
      to: 'ARCHIVED',
      // The hold must be released deliberately before a matter can be archived.
      guards: [{ kind: 'role', anyOf: ['records_officer', 'legal_counsel'] }, { kind: 'not_on_legal_hold' }],
    },
  ],
  statutoryClocks: [
    {
      key: 'appeal_window',
      label: { en: 'Appeal window', ar: 'مهلة الاستئناف' },
      legalBasis: 'Applicable procedure law for the forum (to be confirmed per forum)',
      startsOnArtifact: 'judgment',
      days: null,
      counting: 'CALENDAR',
      excludeOfficialHolidays: false,
      status: 'AWAITING_COUNSEL_CONFIRMATION',
    },
  ],
  legalReview: {
    status: 'DRAFT_PENDING_COUNSEL',
    items: [
      'Whether the amicable-settlement attempt is a mandatory precondition for every labour claim, and what evidences it',
      'Appeal and objection periods per forum (Labour Court, Commercial Court, Board of Grievances) and their start events',
      'Prosecution-referral requirements for the criminal route',
    ],
  },
});
