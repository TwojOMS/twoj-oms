// PRZ-108.09 (zmiana C2 planu automatyzacji): czy paczka ma DOWÓD, że kurier ją odebrał — podstawa zdarzenia „Kurier
// odebrał paczkę”, a więc maila do klienta, którego nie da się cofnąć.
//
// ⚠️ BIAŁA LISTA, NIE `etapPrzesylki`. Etap grupuje do pastylki i filtra: nieznany opis uznaje za „w drodze”
// („InPost: nieznany stan „x”” też), a w opisie DPD szuka podłańcucha „odbiorc” (więc „odbiorca nieobecny” = doręczona).
// Dla pastylki to dobra klasa, dla automatu — mail wysłany na podstawie zdania, którego kurier nie powiedział.
// Tu przechodzi wyłącznie stan ZMIERZONY:
//  • `przejeta_at` — dowód przejęcia paczki „Wysyłam z Allegro” (domena/przejecie-przesylki.js);
//  • Allegro — maszynowy kod zasobu śledzenia; KOD ROZSTRZYGA (opis to tłumaczenie zależne od Accept-Language), więc
//    paczka z nieznanym kodem nie przechodzi po opisie. Lista = PRZEJETE_ALLEGRO (wszystko z KODY_ALLEGRO poza PENDING);
//  • DPD — opisy zdarzeń z sondy na żywym API (23.08) i bazy produkcyjnej: PRZEJETE_DPD (domena/przejecie-przesylki.js);
//  • InPost — NASZE opisy stanów z OPISY_STANOW (oms/kurierzy/inpost.js) dla stanów PO przyjęciu przez InPost. Każdy stan
//    słownika ma tu jawną decyzję (strażnik w tests/domena/dowod-odbioru.test.js): nowy stan bez decyzji = czerwony test;
//  • historia ostatniej odpowiedzi (DPD oddaje całą listę zdarzeń, Allegro też): czuwacz pyta co godzinę, więc najnowsze
//    zdarzenie bywa już spoza listy („Wydanie przesyłki do doręczenia”) — odbiór widać wtedy tylko w historii.
// Najnowszy stan „zwrot” zawsze odmawia: „kurier odebrał paczkę” przy paczce wracającej do nadawcy wprowadza w błąd.
// Wynik: krótki kod dowodu (zapisywany w `przesylki.odebrana_dowod` — „dlaczego mail poszedł”) albo `null`.
import { PRZEJETE_ALLEGRO, PRZEJETE_DPD, dowodPrzejecia } from './przejecie-przesylki.js';
import { etapPrzesylki } from './etap-przesylki.js';

export const KODY_ODBIORU_ALLEGRO = PRZEJETE_ALLEGRO;

/** Stany InPost (klucz OPISY_STANOW) po przyjęciu paczki przez InPost → nasz opis (ten sam tekst co w słowniku klienta). */
export const OPISY_ODBIORU_INPOST = Object.freeze({
  adopted_at_source_branch: 'Przyjęta w oddziale nadawczym',
  sent_from_source_branch: 'Wysłana z oddziału nadawczego',
  out_for_delivery: 'W doręczeniu',
  ready_to_pickup: 'Gotowa do odbioru w paczkomacie',
  delivered: 'Odebrana przez klienta',
});
/** Stany InPost, które NIE dowodzą odbioru: rejestracja i zwrot do nadawcy. */
export const STANY_INPOST_BEZ_ODBIORU = Object.freeze(['confirmed', 'returned_to_sender']);
const INPOST_PO_OPISIE = new Map(Object.entries(OPISY_ODBIORU_INPOST).map(([stan, opis]) => [opis, stan]));

const tekst = (w) => String(w ?? '').trim();

/**
 * Recenzja 09, usterka 1: dowód odbioru bywa SPÓŹNIONY — pierwszy odczyt śledzenia przychodzi dni po odbiorze (awaria
 * czuwacza, kurier podłączony w Ustawieniach później, numer z Allegro dociągnięty przy otwarciu karty). Odbiór zapisuje się
 * wtedy dla historii, ale reguła „Kurier odebrał paczkę” pomija wykonanie: „paczka odebrana” trzy dni po fakcie myli
 * kupującego bardziej, niż pomaga. 48 h — ta sama miara co przeterminowanie wykonania w silniku (plan, sekcja 5).
 */
export const ODBIOR_SPOZNIONY_H = 48;
const GODZINA_MS = 3600 * 1000;

/**
 * Chwila zdarzenia kuriera jako ms. DPD oddaje `eventTime` BEZ STREFY („2026-07-29T20:07:14.918”) — to czas warszawski
 * (usługa DPD Polska; sonda 23.08), więc liczymy przesunięcie Europe/Warsaw dla tej chwili (lato +2, zima +1; w godzinie
 * zmiany czasu błąd do 1 h — bez znaczenia przy progu 48 h). Allegro (`Z`) i InPost (przesunięcie strefy) — jak podano.
 */
export function msCzasuKuriera(tekst) {
  const s = tekst == null ? '' : String(tekst).trim();
  if (!s) return NaN;
  if (/(?:Z|[+-]\d{2}:?\d{2})$/u.test(s)) return Date.parse(s);
  const jakoUtc = Date.parse(`${s}Z`);
  if (Number.isNaN(jakoUtc)) return NaN;
  const warszawa = Date.parse(`${new Date(jakoUtc).toLocaleString('sv-SE', { timeZone: 'Europe/Warsaw' }).replace(' ', 'T')}Z`);
  return jakoUtc - (warszawa - jakoUtc);
}

const iso = (ms) => (Number.isNaN(ms) ? null : new Date(ms).toISOString());

/**
 * Kiedy kurier NAPRAWDĘ odebrał paczkę (ISO z `Z`) albo null: najwcześniejszy odbiór w historii odpowiedzi (DPD, Allegro),
 * inaczej czas zdarzenia przejęcia WzA, inaczej czas najnowszego zdarzenia (odbiór był nie później niż ono).
 */
export function chwilaDowoduUKuriera(p, { historia = null } = {}) {
  if (!p) return null;
  if (Array.isArray(historia) && historia.length) {
    const z = dowodPrzejecia({ zrodlo: historia.some((h) => h && 'code' in h) ? 'allegro' : 'dpd', zdarzenia: historia });
    const ms = msCzasuKuriera(z?.zdarzenieAt);
    if (!Number.isNaN(ms)) return iso(ms);
  }
  if (p.przejeta_at && p.przejecie_zdarzenie_at) return iso(msCzasuKuriera(p.przejecie_zdarzenie_at));
  return iso(msCzasuKuriera(p.status_kuriera_at));
}

/**
 * Warunek wykonania reguły „Kurier odebrał paczkę”: paczka wykonania odebrana u kuriera ponad ODBIOR_SPOZNIONY_H godzin
 * przed chwilą, w której OMS ją zobaczył (`odebrana_at`) → pominięte z powodem. Brak czasu u kuriera → spełnione.
 */
export function odbiorSpozniony(z, wykonanie, { godzin = ODBIOR_SPOZNIONY_H } = {}) {
  const p = (z?.przesylki ?? []).find((x) => Number(x.id) === Number(wykonanie?.przesylka_id));
  const kurier = Date.parse(p?.odebrana_kurier_at ?? '');
  const zapis = Date.parse(p?.odebrana_at ?? '');
  if (Number.isNaN(kurier) || Number.isNaN(zapis) || zapis - kurier <= godzin * GODZINA_MS) return { ok: true };
  const h = Math.floor((zapis - kurier) / GODZINA_MS);
  return { ok: false, kod: 'odbior_spozniony', powod: `Odbiór u kuriera ${h} godzin przed tym, jak OMS go zobaczył (próg ${godzin} h) — `
    + 'mail „kurier odebrał paczkę” byłby spóźniony. W razie potrzeby wyślij go ręcznie z karty.' };
}

/**
 * @param {{ status_kuriera?: string|null, status_kuriera_kod?: string|null, przejeta_at?: string|null } | null} p
 * @param {{ historia?: Array<{ opis?: string, at?: string, code?: string, occurredAt?: string }> | null }} [opcje]
 * @returns {string | null} kod dowodu odbioru albo null
 */
export function dowodOdbioru(p, { historia = null } = {}) {
  if (!p) return null;
  const opis = tekst(p.status_kuriera);
  const kod = tekst(p.status_kuriera_kod);
  if ((opis || kod) && etapPrzesylki(opis, kod || null) === 'zwrot') return null;
  if (p.przejeta_at) return 'przejecie';
  if (kod) {
    if (KODY_ODBIORU_ALLEGRO.has(kod)) return `allegro:${kod}`;
  } else if (opis) {
    const dpd = PRZEJETE_DPD.get(opis.toLowerCase());
    if (dpd) return `dpd:${dpd}`;
    const inpost = INPOST_PO_OPISIE.get(opis);
    if (inpost) return `inpost:${inpost}`;
  }
  if (Array.isArray(historia) && historia.length) {
    const zHistorii = dowodPrzejecia({ zrodlo: historia.some((z) => z && 'code' in z) ? 'allegro' : 'dpd', zdarzenia: historia });
    if (zHistorii) return `historia:${zHistorii.kod}`;
  }
  return null;
}
