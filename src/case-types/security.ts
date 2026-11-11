import { defineCaseType } from '../engine/definition';

/** Corporate and physical security incidents. Cyber incident response is deliberately out of v1 scope. */
export const securityIncident = defineCaseType({
  key: 'security.incident',
  version: 1,
  domain: 'SECURITY',
  label: { en: 'Security incident', ar: 'حادثة أمنية' },
  defaultConfidentiality: 'RESTRICTED',
  fields: [
    { key: 'narrative', label: { en: 'Incident narrative', ar: 'وصف الحادثة' }, type: 'longtext', required: true },
    {
      key: 'incidentType',
      label: { en: 'Incident type', ar: 'نوع الحادثة' },
      type: 'enum',
      options: ['THEFT', 'ACCESS_VIOLATION', 'ASSAULT', 'VANDALISM', 'INSIDER_THREAT', 'SAFETY_BREACH', 'OTHER'],
      lockedFrom: 'INVESTIGATING',
    },
    // The incident facts are what the evidence was collected against. Editing them after collection
    // breaks the chain-of-custody narrative that ISO 27037 and the Law of Evidence (M/43) rest on.
    { key: 'location', label: { en: 'Location', ar: 'الموقع' }, type: 'text', lockedFrom: 'INVESTIGATING' },
    { key: 'occurredAt', label: { en: 'Occurred on', ar: 'تاريخ الحدوث' }, type: 'date', lockedFrom: 'INVESTIGATING' },
    // Drives referral thresholds and the SLA, so it is fixed once findings are issued.
    { key: 'severity', label: { en: 'Severity', ar: 'الخطورة' }, type: 'enum', options: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'], lockedFrom: 'FINDINGS_ISSUED' },
    // Deliberately NOT locked: loss figures are legitimately revised as an assessment firms up.
    { key: 'estimatedLossSar', label: { en: 'Estimated loss (SAR)', ar: 'الخسارة التقديرية (ريال)' }, type: 'money' },
    { key: 'personsInvolved', label: { en: 'Persons involved', ar: 'الأشخاص المعنيون' }, type: 'person', sensitivity: 'PERSONAL' },
    { key: 'outcome', label: { en: 'Outcome', ar: 'النتيجة' }, type: 'enum', options: ['CONFIRMED', 'NOT_CONFIRMED', 'REFERRED'], lockedFrom: 'FINDINGS_ISSUED' },
  ],
  states: [
    { key: 'NEW', label: { en: 'New', ar: 'جديدة' } },
    { key: 'TRIAGED', label: { en: 'Triaged', ar: 'تم الفرز' } },
    { key: 'ASSIGNED', label: { en: 'Assigned', ar: 'تم الإسناد' } },
    { key: 'INVESTIGATING', label: { en: 'Investigating', ar: 'قيد التحقيق' } },
    { key: 'FINDINGS_ISSUED', label: { en: 'Findings issued', ar: 'صدرت النتائج' } },
    { key: 'CLOSED', label: { en: 'Closed', ar: 'مغلقة' }, kind: 'CLOSED' },
    { key: 'ARCHIVED', label: { en: 'Archived', ar: 'مؤرشفة' }, kind: 'ARCHIVED' },
  ],
  initialState: 'NEW',
  transitions: [
    {
      action: 'triage',
      label: { en: 'Triage', ar: 'فرز' },
      from: ['NEW'],
      to: 'TRIAGED',
      guards: [
        { kind: 'role', anyOf: ['security_intake', 'security_manager'] },
        { kind: 'field_present', field: 'severity', message: { en: 'Set a severity', ar: 'حدد درجة الخطورة' } },
      ],
    },
    {
      action: 'assign',
      label: { en: 'Assign investigator', ar: 'إسناد المحقق' },
      from: ['TRIAGED'],
      to: 'ASSIGNED',
      guards: [{ kind: 'role', anyOf: ['security_manager'] }, { kind: 'assignee_set' }, { kind: 'no_conflict_of_interest' }],
    },
    {
      action: 'start_investigation',
      label: { en: 'Start investigation', ar: 'بدء التحقيق' },
      from: ['ASSIGNED'],
      to: 'INVESTIGATING',
      guards: [{ kind: 'role', anyOf: ['security_investigator'] }, { kind: 'no_conflict_of_interest' }],
    },
    {
      action: 'issue_findings',
      label: { en: 'Issue findings', ar: 'إصدار النتائج' },
      from: ['INVESTIGATING'],
      to: 'FINDINGS_ISSUED',
      guards: [
        { kind: 'role', anyOf: ['security_investigator'] },
        // Admissibility starts here: nothing unhashed reaches a findings report.
        { kind: 'evidence_integrity' },
        { kind: 'artifact_present', artifactType: 'findings_report', message: { en: 'Attach the findings report', ar: 'أرفق تقرير النتائج' } },
      ],
    },
    {
      action: 'close',
      label: { en: 'Close', ar: 'إغلاق' },
      from: ['FINDINGS_ISSUED'],
      to: 'CLOSED',
      guards: [
        { kind: 'role', anyOf: ['security_manager'] },
        { kind: 'approval', approverRole: 'security_director' },
        { kind: 'field_present', field: 'outcome', message: { en: 'Record the outcome', ar: 'سجّل النتيجة' } },
        { kind: 'actions_planned' },
        { kind: 'artifact_present', artifactType: 'closure_memo', message: { en: 'Attach the closure memo', ar: 'أرفق مذكرة الإغلاق' } },
      ],
    },
    {
      action: 'archive',
      label: { en: 'Archive', ar: 'أرشفة' },
      from: ['CLOSED'],
      to: 'ARCHIVED',
      guards: [{ kind: 'role', anyOf: ['records_officer'] }, { kind: 'not_on_legal_hold' }],
    },
  ],
  slaPolicies: [
    { state: 'NEW', businessDays: 1, escalateToRole: 'security_manager' },
    { state: 'TRIAGED', businessDays: 2, escalateToRole: 'security_manager' },
    { state: 'ASSIGNED', businessDays: 2, escalateToRole: 'security_manager' },
    { state: 'INVESTIGATING', businessDays: 15, escalateToRole: 'security_director' },
  ],
});
