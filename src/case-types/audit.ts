import { defineCaseType } from '../engine/definition';

/**
 * Internal audit finding. Condition / criteria / cause / effect follow the standard finding
 * structure. Mapping to specific IIA Global Internal Audit Standards 2024 requirements is the
 * next content task (reuse the EQA platform's authored content); it is not encoded here.
 */
export const auditFinding = defineCaseType({
  key: 'audit.finding',
  version: 1,
  domain: 'AUDIT',
  label: { en: 'Audit finding', ar: 'ملاحظة تدقيق' },
  defaultConfidentiality: 'RESTRICTED',
  fields: [
    { key: 'title', label: { en: 'Title', ar: 'العنوان' }, type: 'text', required: true },
    { key: 'engagementRef', label: { en: 'Engagement reference', ar: 'مرجع المهمة' }, type: 'text' },
    { key: 'condition', label: { en: 'Condition (what was found)', ar: 'الحالة (ما تم رصده)' }, type: 'longtext' },
    { key: 'criteria', label: { en: 'Criteria (what should be)', ar: 'المعيار (ما يجب أن يكون)' }, type: 'longtext' },
    { key: 'cause', label: { en: 'Cause', ar: 'السبب' }, type: 'longtext' },
    { key: 'effect', label: { en: 'Effect', ar: 'الأثر' }, type: 'longtext' },
    { key: 'riskRating', label: { en: 'Risk rating', ar: 'تقييم المخاطر' }, type: 'enum', options: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
    { key: 'fraudIndicators', label: { en: 'Fraud indicators present', ar: 'وجود مؤشرات احتيال' }, type: 'boolean' },
  ],
  states: [
    { key: 'DRAFT', label: { en: 'Draft', ar: 'مسودة' } },
    { key: 'RATED', label: { en: 'Rated', ar: 'تم التقييم' } },
    { key: 'AWAITING_RESPONSE', label: { en: 'Awaiting management response', ar: 'بانتظار رد الإدارة' } },
    { key: 'RESPONSE_RECEIVED', label: { en: 'Response received', ar: 'تم استلام الرد' } },
    { key: 'ACTIONS_AGREED', label: { en: 'Actions agreed', ar: 'تم الاتفاق على الإجراءات' } },
    { key: 'CLOSED', label: { en: 'Closed', ar: 'مغلقة' }, kind: 'CLOSED' },
    { key: 'ARCHIVED', label: { en: 'Archived', ar: 'مؤرشفة' }, kind: 'ARCHIVED' },
  ],
  initialState: 'DRAFT',
  transitions: [
    {
      action: 'rate',
      label: { en: 'Rate finding', ar: 'تقييم الملاحظة' },
      from: ['DRAFT'],
      to: 'RATED',
      guards: [
        { kind: 'role', anyOf: ['auditor'] },
        { kind: 'field_present', field: 'condition', message: { en: 'Describe the condition', ar: 'صف الحالة' } },
        { kind: 'field_present', field: 'criteria', message: { en: 'State the criteria', ar: 'حدد المعيار' } },
        { kind: 'field_present', field: 'cause', message: { en: 'State the cause', ar: 'حدد السبب' } },
        { kind: 'field_present', field: 'effect', message: { en: 'State the effect', ar: 'حدد الأثر' } },
        { kind: 'field_present', field: 'riskRating', message: { en: 'Assign a risk rating', ar: 'حدد تقييم المخاطر' } },
      ],
    },
    {
      action: 'issue_to_management',
      label: { en: 'Issue to management', ar: 'إحالة إلى الإدارة' },
      from: ['RATED'],
      to: 'AWAITING_RESPONSE',
      guards: [{ kind: 'role', anyOf: ['audit_manager'] }, { kind: 'approval', approverRole: 'audit_director' }],
    },
    {
      action: 'record_response',
      label: { en: 'Record management response', ar: 'تسجيل رد الإدارة' },
      from: ['AWAITING_RESPONSE'],
      to: 'RESPONSE_RECEIVED',
      guards: [
        { kind: 'role', anyOf: ['auditor', 'audit_manager'] },
        { kind: 'artifact_present', artifactType: 'management_response', message: { en: 'Attach the management response', ar: 'أرفق رد الإدارة' } },
      ],
    },
    {
      action: 'agree_actions',
      label: { en: 'Agree actions', ar: 'الاتفاق على الإجراءات' },
      from: ['RESPONSE_RECEIVED'],
      to: 'ACTIONS_AGREED',
      guards: [
        { kind: 'role', anyOf: ['audit_manager'] },
        { kind: 'artifact_present', artifactType: 'agreed_action_plan', message: { en: 'Attach the agreed action plan', ar: 'أرفق خطة الإجراءات المتفق عليها' } },
        { kind: 'actions_planned' },
      ],
    },
    {
      action: 'close',
      label: { en: 'Close', ar: 'إغلاق' },
      from: ['ACTIONS_AGREED'],
      to: 'CLOSED',
      guards: [
        { kind: 'role', anyOf: ['audit_manager'] },
        { kind: 'approval', approverRole: 'audit_director' },
        { kind: 'actions_planned' },
        {
          // High and critical findings are not closed on a promise: remediation must be verified.
          kind: 'artifact_present',
          artifactType: 'verification_evidence',
          when: { field: 'riskRating', in: ['HIGH', 'CRITICAL'] },
          message: { en: 'High and critical findings need verification evidence before closure', ar: 'الملاحظات العالية والحرجة تتطلب أدلة تحقق قبل الإغلاق' },
        },
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
    { state: 'AWAITING_RESPONSE', businessDays: 15, escalateToRole: 'audit_director' },
    { state: 'RESPONSE_RECEIVED', businessDays: 5, escalateToRole: 'audit_manager' },
  ],
});
