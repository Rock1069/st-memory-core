import { clone, requireThat } from './util.js';

export const GREGORIAN = { id: 'gregorian', months: Array.from({ length: 12 }, (_, i) => ({ name: `${i + 1}月`, days: [31,28,31,30,31,30,31,31,30,31,30,31][i] })), leap: true };
export function validateCalendar(raw) {
  const calendar = clone(raw);
  requireThat(typeof calendar.id === 'string' && calendar.id && Array.isArray(calendar.months) && calendar.months.length > 0 && calendar.months.length <= 40, 'INVALID_CALENDAR', '历法需要 ID 和月份');
  requireThat(calendar.months.every(month => typeof month.name === 'string' && month.name && Number.isInteger(month.days) && month.days > 0 && month.days <= 500) && new Set(calendar.months.map(m => m.name)).size === calendar.months.length, 'INVALID_CALENDAR', '月份名称不能重复，月长须为 1–500 天');
  requireThat(typeof calendar.leap === 'boolean' && (!calendar.leap || calendar.months.length >= 2), 'INVALID_CALENDAR', 'leap 须为布尔值；公历闰日规则需要至少两个月');
  return calendar;
}
function monthDays(calendar, year, month) { return calendar.months[month - 1].days + (calendar.leap && month === 2 && year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 1 : 0); }
export function validateStoryTime(value, calendar = GREGORIAN) {
  if (value == null) return { calendarId: calendar.id, raw: '', precision: 'unknown', year: null, month: null, day: null, hour: null, minute: null, period: null, sequence: 'current' };
  const result = { ...validateStoryTime(null, calendar), ...clone(value) };
  requireThat(result.calendarId === calendar.id && ['unknown','year','month','day','hour','minute','period'].includes(result.precision) && ['current','flashback','jump'].includes(result.sequence), 'INVALID_STORY_TIME', '时间历法、精度或顺序无效');
  for (const key of ['year','month','day','hour','minute']) requireThat(result[key] === null || Number.isInteger(result[key]), 'INVALID_STORY_TIME', '时间数值必须为整数或未知');
  requireThat(result.year === null || result.year >= 1 && result.year <= 100000, 'INVALID_STORY_TIME', '年份无效');
  requireThat(result.month === null || result.month >= 1 && result.month <= calendar.months.length, 'INVALID_STORY_TIME', '月份无效');
  requireThat(result.day === null || result.month !== null && result.year !== null && result.day >= 1 && result.day <= monthDays(calendar, result.year, result.month), 'INVALID_STORY_TIME', '日期无效');
  requireThat(result.hour === null || result.hour >= 0 && result.hour <= 23, 'INVALID_STORY_TIME', '时刻无效');
  requireThat(result.minute === null || result.hour !== null && result.minute >= 0 && result.minute <= 59, 'INVALID_STORY_TIME', '分钟无效');
  return result;
}
export function ordinal(time, calendar = GREGORIAN) {
  if (!time || time.year == null || time.month == null || time.day == null || time.calendarId !== calendar.id) return null;
  const years = time.year - 1;
  const base = calendar.months.reduce((sum, month) => sum + month.days, 0);
  return years * base + (calendar.leap ? Math.floor(years / 4) - Math.floor(years / 100) + Math.floor(years / 400) : 0) + calendar.months.slice(0, time.month - 1).reduce((sum, _, index) => sum + monthDays(calendar, time.year, index + 1), 0) + time.day - 1;
}
export function shiftDays(time, days, calendar = GREGORIAN) {
  requireThat(Number.isInteger(days) && Math.abs(days) <= 100000, 'INVALID_DURATION', '日期偏移无效');
  const day = ordinal(time, calendar);
  if (day === null || day + days < 0) return null;
  let remaining = day + days; let year = 1;
  while (true) { const length = calendar.months.reduce((sum, _, index) => sum + monthDays(calendar, year, index + 1), 0); if (remaining < length) break; remaining -= length; year++; }
  let month = 1; while (remaining >= monthDays(calendar, year, month)) { remaining -= monthDays(calendar, year, month); month++; }
  return { ...time, year, month, day: remaining + 1 };
}
export function parseStoryTime(raw, current = null, calendar = GREGORIAN) {
  raw = String(raw ?? '').trim();
  const tagged = raw.match(/<(?:story_time|time)\b[^>]*>([^<]+)<\/(?:story_time|time)>/i);
  if (tagged) raw = tagged[1].trim();
  const sequence = /^(倒叙|回忆)[：:]/.test(raw) ? 'flashback' : /^(跳跃|时间跳跃)[：:]/.test(raw) ? 'jump' : null;
  if (sequence) return {...parseStoryTime(raw.replace(/^[^：:]+[：:]\s*/,''),current,calendar),raw,sequence};
  const unknown = validateStoryTime(null, calendar); unknown.raw = raw;
  const relative = { 昨天: -1, 前天: -2, 明天: 1, 后天: 2, 上周: -7, 下周: 7, 今天: 0 };
  const offset = Object.keys(relative).find(key => raw.startsWith(key));
  if (offset) { const date = shiftDays(current, relative[offset], calendar); return date ? { ...date, raw, precision: 'day', hour: null, minute: null } : unknown; }
  const elapsed = raw.match(/^(?:经过|过了|后)?\s*(\d+)\s*(天|日|小时|分钟)(?:后)?$/);
  if (elapsed && current) {
    const count = Number(elapsed[1]);
    if (['天','日'].includes(elapsed[2])) { const date = shiftDays(current, count, calendar); return date ? { ...date, raw, sequence: 'jump' } : unknown; }
    if (current.hour != null) { const minutes = (current.hour * 60 + (current.minute ?? 0)) + count * (elapsed[2] === '小时' ? 60 : 1); const date = shiftDays(current, Math.floor(minutes / 1440), calendar); return date ? { ...date, raw, hour: Math.floor(minutes % 1440 / 60), minute: minutes % 60, precision: 'minute', sequence: 'jump' } : unknown; }
  }
  const match = raw.match(/^(\d{1,6})(?:年|[-/])(\d{1,2})(?:月|[-/])(\d{1,2})(?:日)?(?:\s+(\d{1,2})[:时](\d{1,2})(?:分)?)?$/);
  if (match) return validateStoryTime({ ...unknown, year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), hour: match[4] ? Number(match[4]) : null, minute: match[5] ? Number(match[5]) : null, precision: match[4] ? 'minute' : 'day' }, calendar);
  const partial = raw.match(/^(\d{1,6})年(?:\s*(\d{1,2})月)?$/);
  if (partial) return validateStoryTime({...unknown,year:Number(partial[1]),month:partial[2] ? Number(partial[2]) : null,precision:partial[2] ? 'month' : 'year'},calendar);
  const hour = raw.match(/^(\d{1,2})(?:时|:)(?:(\d{1,2})(?:分)?)?$/);
  if (hour) return validateStoryTime({...current,...unknown,year:current?.year ?? null,month:current?.month ?? null,day:current?.day ?? null,hour:Number(hour[1]),minute:hour[2] ? Number(hour[2]) : null,precision:hour[2] ? 'minute' : 'hour'},calendar);
  for (let i = 0; i < calendar.months.length; i++) {
    const name = calendar.months[i].name; const position = raw.indexOf(name); if (position < 0) continue;
    const year = raw.slice(0, position).match(/(\d+)年?\s*$/); const day = raw.slice(position + name.length).match(/^\s*(\d+)(?:日)?/);
    if (year && day) return validateStoryTime({ ...unknown, year: Number(year[1]), month: i + 1, day: Number(day[1]), precision: 'day' }, calendar);
  }
  if (['清晨','上午','中午','下午','傍晚','夜晚','深夜'].includes(raw)) return { ...(current ?? unknown), raw, period: raw, hour: null, minute: null, precision: 'period' };
  return unknown;
}
export function elapsedDays(before, after, calendar = GREGORIAN) { const a = ordinal(before, calendar); const b = ordinal(after, calendar); return a === null || b === null ? null : b - a; }
export function ageAt(birth, current) { if (!birth || !current || birth.calendarId !== current.calendarId || [birth.year,birth.month,birth.day,current.year,current.month,current.day].some(x => x == null)) return null; const age = current.year - birth.year - (current.month < birth.month || current.month === birth.month && current.day < birth.day ? 1 : 0); return age >= 0 ? age : null; }
