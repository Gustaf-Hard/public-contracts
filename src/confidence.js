const UTBILDNING_FAMILY = new Set(['utbildning', 'gymnasie', 'vuxenutbildning']);

export function computeConfidence(contacts) {
  if (!contacts || contacts.length === 0) return 'low';
  const hasCentral = contacts.some((c) => c.role === 'central');
  const hasUtbildning = contacts.some((c) => UTBILDNING_FAMILY.has(c.role));
  if (hasCentral && hasUtbildning) return 'high';
  if (hasCentral || hasUtbildning) return 'medium';
  return 'low';
}
