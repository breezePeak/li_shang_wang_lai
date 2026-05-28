export function isReciprocateable(relation) {
  return relation === 'friend' || relation === 'mutual';
}

export function isBlocked(relation) {
  return relation === 'unknown';
}
