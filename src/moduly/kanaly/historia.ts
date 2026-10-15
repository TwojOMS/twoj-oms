import type { Srodowisko } from '../../core/kontrakty.ts';
import { wczytajKlientowWdt } from '../../core/klienci-wdt.ts';
/** Wspólne reguły WDT i filtrów, niezależne od konta importu. */
export function regulyHistorii(env: Srodowisko) {
  const lista = (n: string) => (env[n] ?? '').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
  const wlasne = new Set(lista('OMS_HISTORIA_MAILE_TESTOWE'));
  const domeny = lista('OMS_HISTORIA_DOMENY_TESTOWE');
  const prefiksy = lista('OMS_HISTORIA_PREFIKSY_TESTOWE');
  const nazwy = lista('OMS_HISTORIA_NAZWY_TESTOWE');
  return { klienciWdt: wczytajKlientowWdt(env),
    czyTestowe: (email: string, nazwa: string) => { const m=String(email??'').toLowerCase(); const n=String(nazwa??'').toLowerCase();
      return wlasne.has(m)||domeny.some(d=>m.endsWith(`@${d}`))||prefiksy.some(p=>m.startsWith(p))||nazwy.some(t=>n.includes(t)); },
  };
}
/** Brak konta nadal blokuje import sklepu; reguły są te same co dla raportów. */
export function konfiguracjaHistorii(env: Srodowisko, sklep: string, prefiks: string) {
  const konto = Number(env[`${prefiks}_HISTORIA_KONTO_APILO`]);
  if (!env[`${prefiks}_HISTORIA_KONTO_APILO`] || !Number.isSafeInteger(konto) || konto < 0) throw new Error(`Brak poprawnego ${prefiks}_HISTORIA_KONTO_APILO`);
  return { konta: new Map([[sklep,konto]]), ...regulyHistorii(env) };
}
