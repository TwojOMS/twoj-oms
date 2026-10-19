import type { DatabaseSync } from 'node:sqlite';

const PRZED_PIERWSZYM = 'zmień klucz w OMS_KANALY przed pierwszym zamówieniem';
/**
 * PRZ-062: sklep z kluczem zaczynającym się od „allegro” przechodzi walidację OMS_KANALY i po cichu zmienia
 * terminy (a z „allegro_” — wysyłkę, faktury i statystyki, bo prefiks w `czyKanalAllegro` wygrywa z typem).
 * Klucz po pierwszym zamówieniu zmienić trudno (kolumna `sklep`).
 * PRZ-101.08: alarm „Allegro bez allegro_” zniknął — kanał `typ: 'allegro'` panel rozpoznaje po konfiguracji.
 */
export function alarmyNazwKanalow(definicje: readonly { klucz: string; typ: string }[]): string[] {
  return definicje.flatMap(({ klucz, typ }) => {
    if (typ !== 'allegro' && klucz.toLowerCase().startsWith('allegro')) return [`kanał ${klucz} (typ ${typ}): klucz sklepu nie może zaczynać się od „allegro” — terminy wysyłki liczyłyby się jak dla Allegro (a z „allegro_” cały panel wziąłby zamówienia za Allegro); ${PRZED_PIERWSZYM}`];
    return [];
  });
}

type Konfiguracja = { sklepy: Record<string, unknown>; kanaly: Record<string, unknown>; braki?: Record<string, string[]> };

/** Odczyt lokalnego stanu przy każdym /health, bez kontaktu z integracjami. */
export function alarmyKonfiguracjiKanalow(db: DatabaseSync, config: Konfiguracja, teraz: Date, proba: boolean): string[] {
  if (proba) return [];
  const kanaly = db.prepare(`SELECT DISTINCT sklep FROM zamowienia
    WHERE sklep <> 'reczne' AND julianday(utworzone_at) >= julianday(?, '-30 days')
      AND julianday(utworzone_at) <= julianday(?) ORDER BY sklep`).all(teraz.toISOString(), teraz.toISOString()) as { sklep: string }[];
  return kanaly.flatMap(({ sklep }) => {
    if (Object.hasOwn(config.sklepy, sklep) || Object.hasOwn(config.kanaly, sklep)) return [];
    const nazwy = config.braki?.[sklep];
    const braki = nazwy?.length ? nazwy : ['OMS_KANALY'];
    return [`kanał ${sklep}: brak kompletnej konfiguracji (${braki.join(', ')})`];
  });
}
