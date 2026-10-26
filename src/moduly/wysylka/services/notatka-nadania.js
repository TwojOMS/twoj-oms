// PRZ-117 — notatka z numerem listu w sklepie i jej ponawianie.
//
// Notatka jest „best effort": paczka już istnieje, więc jej awaria nie cofa nadania (services/nadanie.js),
// tylko zostawia ślad `przesylki.sync_woo_blad` z przedrostkiem „notatka: ". Do 26.10.2026 ten ślad nie miał
// innego wyjścia niż „załatw ręcznie": 3 z 110 notatek padły na chwilowym „błędzie sieci" (1419 i 1437 wisiały
// 13 dni, 1491 26.10), a każde następne zapytanie do tego samego sklepu przechodziło. Stąd trzy drogi ponowienia:
// jedna szybka powtórka przy samym nadaniu (tylko błąd sieci — odmowy sklepu 4xx za 3 s się nie zmienią),
// przycisk „Spróbuj ponownie" na karcie i zegar przesyłek przez OKNO_PONAWIANIA_NOTATKI_H godzin.
//
// Notatka jest PRYWATNA (`customer_note: false`, oms/woo/client.js) — powtórzona po godzinie nie wysyła klientowi
// maila, więc późne ponowienie nikogo nie zaskoczy. Starsze przesyłki zegar zostawia człowiekowi: po dwóch dobach
// paczka zwykle już jedzie i notatka w sklepie przestaje mieć znaczenie.
import { pobierzZamowienie, dopiszLog } from '../../../oms/db/zamowienia.js';
import { pobierzPrzesylke, zapiszBladSync } from '../db/przesylki.js';
import { bladOperatora } from '../../../domena/bledy.js';

export const PREFIKS_NOTATKI = 'notatka: ';
export const OKNO_PONAWIANIA_NOTATKI_H = 48;
export const ODSTEP_POWTORKI_MS = 3000;

export const tekstNotatkiNadania = (kurier, numerListu) =>
  `Nadano ${String(kurier).toUpperCase()}, list przewozowy ${numerListu}`;

// Klient Woo opakowuje KAŻDĄ awarię transportu w „Sklep nieosiągalny: …" (oms/woo/client.js) — odpowiedź sklepu
// (401, 4xx, 5xx) brzmi inaczej. Powtarzamy wyłącznie tę pierwszą.
const bladSieci = (e) => /^Sklep nieosiągalny:/.test(String(e?.message ?? ''));

const spij = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** Notatka z jedną powtórką po błędzie sieci. Rzuca, gdy obie próby padły albo sklep odmówił. */
export async function dodajNotatkeZPowtorka(klient, zrodloId, tekst, { czekaj = spij } = {}) {
  try {
    return await klient.dodajNotatke(zrodloId, tekst);
  } catch (e) {
    if (!bladSieci(e)) throw e;
    await czekaj(ODSTEP_POWTORKI_MS);
    return klient.dodajNotatke(zrodloId, tekst);
  }
}

/**
 * Ponowienie notatki JEDNEJ przesyłki. Odmowa operatorska, gdy nie ma czego ponawiać; awaria sklepu nie rzuca —
 * odświeża ślad i oddaje `{ blad }`, bo wołają to także zegar i przycisk, a żadne z nich nie ma czego wycofywać.
 */
export async function ponowNotatkeNadania({ db, klienci }, przesylkaId) {
  const p = pobierzPrzesylke(db, przesylkaId);
  if (!p || !String(p.sync_woo_blad ?? '').startsWith(PREFIKS_NOTATKI) || !p.numer_listu) {
    throw bladOperatora('Ta przesyłka nie ma nieudanej notatki do ponowienia.');
  }
  const z = pobierzZamowienie(db, p.zamowienie_id);
  const klient = z ? klienci[z.sklep] : null;
  if (!klient) throw bladOperatora(`Panel nie ma połączenia ze sklepem „${z?.sklep ?? '?'}” — notatki nie ma dokąd wysłać.`);
  try {
    await klient.dodajNotatke(z.zrodlo_id, tekstNotatkiNadania(p.kurier, p.numer_listu));
  } catch (e) {
    zapiszBladSync(db, p.id, `${PREFIKS_NOTATKI}${e.message}`);
    dopiszLog(db, z.id, { akcja: 'sync-woo', wynik: `BŁĄD: notatka (ponowienie): ${e.message}` });
    return { blad: e.message };
  }
  zapiszBladSync(db, p.id, null);
  dopiszLog(db, z.id, { akcja: 'sync-woo', wynik: 'OK (ponowienie)' });
  return { ok: true };
}

/**
 * Zegar: nadane przesyłki z nieudaną notatką, młodsze niż okno. Po kolei, jak poller po sklepach.
 * @param {{ db: import('node:sqlite').DatabaseSync, klienci: Record<string, any>, teraz?: Date }} opcje
 */
export async function ponowZalegleNotatki({ db, klienci, teraz = new Date() }) {
  const odIso = new Date(teraz.getTime() - OKNO_PONAWIANIA_NOTATKI_H * 3600e3).toISOString();
  const ids = db.prepare(
    "SELECT id FROM przesylki WHERE status = 'nadana' AND numer_listu IS NOT NULL"
    + ' AND sync_woo_blad LIKE ? AND utworzona_at >= ? ORDER BY id',
  ).all(`${PREFIKS_NOTATKI}%`, odIso).map((/** @type {any} */ w) => Number(w.id));
  let wyslane = 0;
  let bledy = 0;
  for (const id of ids) {
    try {
      // eslint-disable-next-line no-await-in-loop -- po kolei, jeden sklep nie dostaje serii naraz
      const w = await ponowNotatkeNadania({ db, klienci }, id);
      if (w.ok) wyslane += 1; else bledy += 1;
    } catch {
      bledy += 1;
    }
  }
  return { kandydatow: ids.length, wyslane, bledy };
}
