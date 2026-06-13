export function resolveTimeWindow({ days = null, hours = null } = {}) {
  const parsedHours = Number(hours);
  if (Number.isFinite(parsedHours) && parsedHours > 0) {
    return {
      unit: 'hours',
      value: parsedHours,
      sinceMs: Date.now() - parsedHours * 3600000,
    };
  }

  const parsedDays = Number(days);
  if (Number.isFinite(parsedDays) && parsedDays > 0) {
    return {
      unit: 'days',
      value: parsedDays,
      sinceMs: Date.now() - parsedDays * 86400000,
    };
  }

  return null;
}

export function resolveTimeWindowSinceIso(options = {}) {
  const window = resolveTimeWindow(options);
  return window ? new Date(window.sinceMs).toISOString() : null;
}
