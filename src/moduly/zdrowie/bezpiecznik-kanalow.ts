import type { DatabaseSync } from 'node:sqlite';
import { czyKanalAllegro } from '../../domena/wysylka.js';

const PRZED_PIERWSZYM = 'zmień klucz w OMS_KANALY przed pierwszym zamówieniem';
/**
 * PRZ-062: panel rozpoznaje Allegro po przedrostku klucza (`czyKanalAllegro`, ta sama reguła — bez kopii).
 * Definicja typu allegro bez niego albo sklep z nim przechodzą walidację OMS_KANALY i po cichu zmieniają
 * wysyłkę, faktury, terminy i statystyki. Klucz po pierwszym zamówieniu zmienić trudno (kolumna `sklep`).
 */
export function alarmyNazwKanalow(definicje: readonly { klucz: string; typ: string }[]): string[] {
  return definicje.flatMap(({ klucz, typ }) => {
    if (typ === 'allegro' && !czyKanalAllegro({ sklep: klucz })) return [`kanał ${klucz} (typ allegro): klucz kanału Allegro musi zaczynać się od „allegro_” — bez tego panel nie rozpozna jego zamówień jako Allegro (wysyłka, faktury, terminy, statystyki); ${PRZED_PIERWSZYM}`];
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
