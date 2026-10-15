import { dayWarsaw } from './dates.js';

// Ważność oferty liczymy w DNIACH kalendarzowych strefy Europe/Warsaw, nie w godzinach —
// „ważność 30 dni" ma znaczyć całe dni, niezależnie od pory wysyłki.
const DAY_MS = 86400000;

function dayToUTC(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day ?? ''));
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function utcToDay(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// Zwraca { remainingDays, expired, expiresOn } albo null gdy brak/niepoprawna data wysyłki.
// remainingDays nie schodzi poniżej 0; expired = minęła data ważności.
export function quoteValidity({ sentAt, validDays = 30 } = {}, now = new Date()) {
  const startDay = dayWarsaw(sentAt);
  if (!startDay) return null;
  const nowIso = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const nowDay = dayWarsaw(nowIso);
  const vd = Number.isFinite(Number(validDays)) ? Number(validDays) : 30;
  const startMs = dayToUTC(startDay);
  const elapsed = Math.round((dayToUTC(nowDay) - startMs) / DAY_MS);
  const remaining = vd - elapsed;
  return {
    remainingDays: Math.max(0, remaining),
    expired: remaining <= 0,
    expiresOn: utcToDay(startMs + vd * DAY_MS),
  };
}
