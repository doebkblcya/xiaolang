/** CNY public list prices checked on 2026-10-23. Estimates are not provider bills. */
export const pricing = {
  version: 'deepseek-cny-2026-10-23', currency: 'CNY', checked: '2026-10-23',
  source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
  calendarSource: 'https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm',
  calendarYears: [2026],
  models: [
    { model: 'deepseek-flash', hit: 0.04, miss: 2, output: 8 },
    { model: 'deepseek-v4-pro', hit: 0.30, miss: 9, output: 27 },
  ],
};
const holidays = ['01-01/01-03', '02-15/02-23', '04-04/04-06', '05-01/05-05', '06-19/06-21', '09-25/09-27', '10-01/10-07'];
export function pricePeriod(started: number): 'peak' | 'offPeak' {
  const local = new Date(started + 8 * 3600000), day = local.getUTCDay(), hour = local.getUTCHours();
  const date = local.toISOString().slice(5, 10);
  const holiday = local.getUTCFullYear() === 2026 && holidays.some(range => {
    const [from, to] = range.split('/'); return date >= from! && date <= to!;
  });
  return !holiday && day >= 1 && day <= 5 && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)) ? 'peak' : 'offPeak';
}
export function estimateCost(provider: unknown, model: unknown, kind: unknown, input: unknown, output: unknown, cached: unknown, started: unknown): number | null {
  if (provider !== 'deepseek' || kind !== 'chat') return null;
  const name = model === 'deepseek-v4-flash' || model === 'deepseek-v4-flash-vision-exp' ? 'deepseek-flash' : model;
  const rate = pricing.models.find(item => item.model === name);
  if (!rate || typeof input !== 'number' || typeof output !== 'number' || typeof cached !== 'number' || typeof started !== 'number'
    || ![input, output, cached, started].every(Number.isSafeInteger) || input < 0 || output < 0 || cached < 0 || cached > input || started < 0) return null;
  // Reasoning tokens are already included in output. Never add them a second time.
  return (cached * rate.hit + (input - cached) * rate.miss + output * rate.output) / 1_000_000 * (pricePeriod(started) === 'peak' ? 1 : 0.5);
}
