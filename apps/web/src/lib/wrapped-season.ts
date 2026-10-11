export function getWrappedSeason(now: number) {
  const date = new Date(now);
  const month = date.getUTCMonth();
  return {
    visible: month === 11 || month === 0 || process.env.REMBRIC_WRAPPED_FORCE === 'true',
    year: date.getUTCFullYear() - (month === 0 ? 1 : 0),
  };
}
