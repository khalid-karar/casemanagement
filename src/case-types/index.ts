import type { CaseTypeDefinition } from '../engine/types';
import { auditFinding } from './audit';
import { hrMisconduct } from './hr';
import { legalMatter } from './legal';
import { securityIncident } from './security';

export { auditFinding, hrMisconduct, legalMatter, securityIncident };

export const CASE_TYPES: Record<string, CaseTypeDefinition> = {
  [hrMisconduct.key]: hrMisconduct,
  [securityIncident.key]: securityIncident,
  [auditFinding.key]: auditFinding,
  [legalMatter.key]: legalMatter,
};
