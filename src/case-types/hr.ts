import { defineCaseType } from '../engine/definition';
import type { Guard } from '../engine/types';

const art71Notice: Guard = {
  kind: 'artifact_present',
  artifactType: 'allegation_notice',
  message: {
    en: 'The worker must be notified in writing of the allegation first (Labour Law Art. 71)',
    ar: 'يجب إبلاغ العامل كتابةً بما هو منسوب إليه أولاً (المادة 71 من نظام العمل)',
  },
};

/** Art. 71 procedure, in order: written notice, questioning, investigation of the defence, minute. */
const art71Sequence: Guard = {
  kind: 'artifact_sequence',
  types: ['allegation_notice', 'questioning_record', 'defense_investigation', 'investigation_minute'],
  message: {
    en: 'Notice, questioning, defence investigation and minute must all exist, in that order (Art. 71)',
    ar: 'يجب استكمال الإبلاغ الكتابي ثم الاستجواب ثم تحقيق الدفاع ثم المحضر بهذا الترتيب (المادة 71)',
  },
};

const isPenalty = { field: 'outcome', in: ['SUBSTANTIATED_PENALTY'] };

/**
 * HR misconduct investigation. The Labour Law procedure is enforced by the state machine, not
 * left to the investigator. legalReview stays DRAFT_PENDING_COUNSEL until counsel signs off the
 * items below; statutory periods are null until then so the engine cannot assert unverified law.
 */
export const hrMisconduct = defineCaseType({
  key: 'hr.misconduct',
  version: 1,
  domain: 'HR',
  label: { en: 'HR misconduct investigation', ar: 'تحقيق مخالفة وظيفية' },
  defaultConfidentiality: 'RESTRICTED',
  retentionYears: null,
  fields: [
    // Art. 71: the employee is questioned on a specific allegation and defends it. If the text could
    // still change after findings, the recorded defence would no longer match what was charged.
    { key: 'allegationSummary', label: { en: 'Allegation summary', ar: 'ملخص المخالفة المنسوبة' }, type: 'longtext', required: true, lockedFrom: 'FINDINGS_ISSUED' },
    // Drives the limitation period, so it must be fixed by the time findings are issued.
    { key: 'incidentDate', label: { en: 'Incident date', ar: 'تاريخ الواقعة' }, type: 'date', lockedFrom: 'FINDINGS_ISSUED' },
    // Changing the respondent mid-case is a new case, not an edit: it also defeats the
    // conflict-of-interest check that ran at assignment.
    { key: 'subjectEmployee', label: { en: 'Subject employee', ar: 'الموظف المنسوب إليه' }, type: 'person', sensitivity: 'PERSONAL', lockedFrom: 'ASSIGNED' },
    // Art. 66: severity sets the lawful penalty ceiling. Editable after the decision, it would let the
    // proportionality record be rewritten to fit the penalty already imposed.
    { key: 'severity', label: { en: 'Severity', ar: 'الخطورة' }, type: 'enum', options: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'], lockedFrom: 'DECIDED' },
    {
      key: 'reporterChannel',
      label: { en: 'Intake channel', ar: 'قناة الإبلاغ' },
      type: 'enum',
      options: ['PORTAL', 'ANONYMOUS_PORTAL', 'HOTLINE', 'EMAIL', 'IN_PERSON'],
      // Channel decides whether whistleblower protection (M/48) attaches; changing it later would
      // retrospectively alter the reporter's protection status.
      lockedFrom: 'TRIAGED',
    },
    { key: 'reporterIdentity', label: { en: 'Reporter identity', ar: 'هوية المبلّغ' }, type: 'person', sensitivity: 'SEALED' },
    {
      key: 'outcome',
      label: { en: 'Investigation outcome', ar: 'نتيجة التحقيق' },
      type: 'enum',
      options: ['SUBSTANTIATED_PENALTY', 'SUBSTANTIATED_NO_PENALTY', 'UNSUBSTANTIATED'],
      lockedFrom: 'DECIDED', // a decision, once taken, is not edited: it is superseded by a new case
    },
    {
      key: 'penaltyType',
      label: { en: 'Disciplinary penalty', ar: 'الجزاء التأديبي' },
      type: 'enum',
      options: ['WARNING', 'FINE_UP_TO_ONE_DAY_WAGE', 'FINE', 'SUSPENSION_WITHOUT_PAY', 'BONUS_DEPRIVATION', 'PROMOTION_DEFERRAL', 'DISMISSAL'],
      lockedFrom: 'DECIDED',
    },
    { key: 'decisionRationale', label: { en: 'Decision rationale', ar: 'مبررات القرار' }, type: 'longtext', lockedFrom: 'DECIDED' },
  ],
  states: [
    { key: 'NEW', label: { en: 'New', ar: 'جديدة' } },
    { key: 'TRIAGED', label: { en: 'Triaged', ar: 'تم الفرز' } },
    { key: 'ASSIGNED', label: { en: 'Assigned', ar: 'تم الإسناد' } },
    { key: 'INVESTIGATING', label: { en: 'Investigating', ar: 'قيد التحقيق' } },
    { key: 'FINDINGS_ISSUED', label: { en: 'Findings issued', ar: 'صدرت النتائج' } },
    { key: 'DECIDED', label: { en: 'Decided', ar: 'تم اتخاذ القرار' } },
    { key: 'PENALTY_NOTIFIED', label: { en: 'Penalty notified', ar: 'تم إبلاغ الجزاء' } },
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
        { kind: 'role', anyOf: ['hr_intake', 'hr_manager'] },
        { kind: 'field_present', field: 'severity', message: { en: 'Set a severity', ar: 'حدد درجة الخطورة' } },
      ],
    },
    {
      action: 'assign',
      label: { en: 'Assign investigator', ar: 'إسناد المحقق' },
      from: ['TRIAGED'],
      to: 'ASSIGNED',
      guards: [{ kind: 'role', anyOf: ['hr_manager'] }, { kind: 'assignee_set' }, { kind: 'no_conflict_of_interest' }],
    },
    {
      action: 'start_investigation',
      label: { en: 'Start investigation', ar: 'بدء التحقيق' },
      from: ['ASSIGNED'],
      to: 'INVESTIGATING',
      guards: [
        { kind: 'role', anyOf: ['hr_investigator'] },
        { kind: 'no_conflict_of_interest' },
        { kind: 'artifact_present', artifactType: 'investigation_plan', message: { en: 'Record an investigation plan first', ar: 'سجّل خطة التحقيق أولاً' } },
      ],
    },
    {
      action: 'issue_findings',
      label: { en: 'Issue findings', ar: 'إصدار النتائج' },
      from: ['INVESTIGATING'],
      to: 'FINDINGS_ISSUED',
      guards: [
        { kind: 'role', anyOf: ['hr_investigator'] },
        { kind: 'evidence_integrity' },
        { kind: 'artifact_present', artifactType: 'findings_report', message: { en: 'Attach the findings report', ar: 'أرفق تقرير النتائج' } },
      ],
    },
    {
      action: 'decide_no_penalty',
      label: { en: 'Decide: no penalty', ar: 'قرار: بدون جزاء' },
      from: ['FINDINGS_ISSUED'],
      to: 'DECIDED',
      guards: [
        { kind: 'role', anyOf: ['hr_manager'] },
        { kind: 'approval', approverRole: 'hr_director' },
        { kind: 'field_in', field: 'outcome', values: ['SUBSTANTIATED_NO_PENALTY', 'UNSUBSTANTIATED'], message: { en: 'Outcome must be recorded as no-penalty', ar: 'يجب تسجيل النتيجة بدون جزاء' } },
        { kind: 'field_present', field: 'decisionRationale', message: { en: 'Record the rationale', ar: 'سجّل مبررات القرار' } },
      ],
    },
    {
      action: 'decide_penalty',
      label: { en: 'Decide: impose penalty', ar: 'قرار: توقيع جزاء' },
      from: ['FINDINGS_ISSUED'],
      to: 'DECIDED',
      guards: [
        { kind: 'role', anyOf: ['hr_manager'] },
        { kind: 'approval', approverRole: 'hr_director' },
        { kind: 'field_in', field: 'outcome', values: ['SUBSTANTIATED_PENALTY'], message: { en: 'Outcome must be substantiated with a penalty', ar: 'يجب أن تكون النتيجة ثبوت المخالفة مع جزاء' } },
        { kind: 'field_present', field: 'penaltyType', message: { en: 'Choose a penalty from the permitted list', ar: 'اختر جزاءً من القائمة المسموح بها' } },
        art71Notice,
        art71Sequence,
        {
          // Full path: questioning must not have been oral.
          kind: 'artifact_attr',
          artifactType: 'questioning_record',
          attr: 'mode',
          notIn: ['ORAL'],
          message: {
            en: 'Oral questioning is permitted only for a warning or a deduction of up to one day\'s wage (Art. 71)',
            ar: 'الاستجواب الشفهي مسموح فقط للإنذار أو الخصم بما لا يزيد على يوم واحد من الأجر (المادة 71)',
          },
        },
      ],
    },
    {
      action: 'decide_minor_penalty',
      label: { en: 'Decide: minor penalty (oral questioning allowed)', ar: 'قرار: جزاء بسيط (يجوز الاستجواب شفاهةً)' },
      from: ['FINDINGS_ISSUED'],
      to: 'DECIDED',
      guards: [
        { kind: 'role', anyOf: ['hr_manager'] },
        { kind: 'approval', approverRole: 'hr_director' },
        { kind: 'field_in', field: 'outcome', values: ['SUBSTANTIATED_PENALTY'], message: { en: 'Outcome must be substantiated with a penalty', ar: 'يجب أن تكون النتيجة ثبوت المخالفة مع جزاء' } },
        {
          kind: 'field_in',
          field: 'penaltyType',
          values: ['WARNING', 'FINE_UP_TO_ONE_DAY_WAGE'],
          message: { en: 'The minor path covers only a warning or a deduction of up to one day\'s wage', ar: 'المسار المبسط للإنذار أو الخصم بما لا يزيد على يوم واحد فقط' },
        },
        art71Notice,
        art71Sequence,
      ],
    },
    {
      action: 'notify_penalty',
      label: { en: 'Notify penalty in writing', ar: 'إبلاغ الجزاء كتابةً' },
      from: ['DECIDED'],
      to: 'PENALTY_NOTIFIED',
      guards: [
        { kind: 'role', anyOf: ['hr_manager'] },
        { kind: 'field_in', field: 'outcome', values: ['SUBSTANTIATED_PENALTY'], message: { en: 'Only a penalty decision is notified', ar: 'يُبلَّغ قرار الجزاء فقط' } },
        { kind: 'artifact_present', artifactType: 'penalty_notice', message: { en: 'The worker must be notified of the penalty in writing (Art. 72)', ar: 'يجب إبلاغ العامل كتابةً بقرار توقيع الجزاء (المادة 72)' } },
      ],
    },
    {
      action: 'close_no_penalty',
      label: { en: 'Close', ar: 'إغلاق' },
      from: ['DECIDED'],
      to: 'CLOSED',
      guards: [
        { kind: 'role', anyOf: ['hr_manager'] },
        { kind: 'field_in', field: 'outcome', values: ['SUBSTANTIATED_NO_PENALTY', 'UNSUBSTANTIATED'], message: { en: 'Only a no-penalty outcome closes directly', ar: 'يُغلق مباشرةً فقط عند عدم وجود جزاء' } },
        { kind: 'actions_planned' },
        { kind: 'artifact_present', artifactType: 'closure_memo', message: { en: 'Attach the closure memo', ar: 'أرفق مذكرة الإغلاق' } },
      ],
    },
    {
      action: 'close',
      label: { en: 'Close', ar: 'إغلاق' },
      from: ['PENALTY_NOTIFIED'],
      to: 'CLOSED',
      guards: [
        { kind: 'role', anyOf: ['hr_manager'] },
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
  // Service-level targets: tenant-configurable defaults, not legal claims.
  slaPolicies: [
    { state: 'NEW', businessDays: 2, escalateToRole: 'hr_manager' },
    { state: 'TRIAGED', businessDays: 3, escalateToRole: 'hr_manager' },
    { state: 'ASSIGNED', businessDays: 3, escalateToRole: 'hr_manager' },
    { state: 'INVESTIGATING', businessDays: 20, escalateToRole: 'hr_director' },
    { state: 'FINDINGS_ISSUED', businessDays: 5, escalateToRole: 'hr_director' },
  ],
  statutoryClocks: [
    {
      key: 'employee_grievance_window',
      label: { en: 'Worker grievance window', ar: 'مهلة تظلم العامل' },
      legalBasis: 'Labour Law Art. 72, as amended by Royal Decree M/44',
      startsOnArtifact: 'penalty_notice',
      days: null,
      counting: 'CALENDAR',
      excludeOfficialHolidays: true,
      status: 'AWAITING_COUNSEL_CONFIRMATION',
    },
    {
      key: 'employer_grievance_response_window',
      label: { en: 'Employer response window', ar: 'مهلة رد صاحب العمل' },
      legalBasis: 'Labour Law Art. 72, as amended by Royal Decree M/44',
      startsOnArtifact: 'grievance_submitted',
      days: null,
      counting: 'CALENDAR',
      excludeOfficialHolidays: false,
      status: 'AWAITING_COUNSEL_CONFIRMATION',
    },
  ],
  sealedFieldRoles: { reporterIdentity: ['ethics_officer'] },
  legalReview: {
    status: 'DRAFT_PENDING_COUNSEL',
    items: [
      'Art. 72 grievance and response periods and their start events, as amended by M/44 (sources disagree on day counts)',
      'Art. 66 permitted penalty list and numeric ceilings (fine, deduction and suspension limits)',
      'Whether the Art. 71 oral-questioning exception relaxes only the form of questioning or any other artifact',
      'Retention period for HR investigation files',
    ],
  },
});
