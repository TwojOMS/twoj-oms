// ODSWIEZENIE STATUSU PRZESYLKI U KURIERA — jedna sciezka dla karty zamowienia i dla
// czuwacza przesylek (zegar #4, audyt 22.08). Do 23.08 funkcja mieszkala w routes/
// zamowienia.js; przeprowadzka wyjela ja z warstwy web, zeby zegar nie importowal tras.
//
// Cala funkcja jest „bezpieczna z zalozenia": awaria kuriera (siec, timeout,
// INCORRECT_LOGIN_OR_PASSWORD po zmianie hasla, wygasly token InPostu, regresja
// programistyczna) ANI awaria zapisu do bazy NIE MOZE wywalic ani zawiesic wolajacego.
// Karta pokazuje wtedy nieodswiezony stan; zegar idzie do nastepnej paczki.
//
// ⚠️ KOGO PYTAC rozstrzyga domain/sledzenie-przesylki.js — take dla paczek „Wysylam
// z Allegro": DPD pytamy podwykonawca numerem carrierWaybill, a One/ORLEN/DHL przez
// klienta Allegro para carrier/waybill z zasobu WzA. `null` znaczy „tej paczki nie da sie sledzic" i jest
// stanem POPRAWNYM: sprzatamy ewentualny osad bledu (zgloszenie wlasciciela 12.08 —
// cztery zamowienia z odznaka bez wyjscia) i wychodzimy cicho, bez wpisu do logu
// (wpis przy kazdym otwarciu karty utopilby prawdziwe awarie).

import {
  wyczyscBladStatusu, zapiszStatusDpd, zapiszProbeStatusuDpd, zapiszOdbiorPrzesylki,
} from '../db/przesylki.js';
import { dopiszLog } from '../../../oms/db/zamowienia.js';
import { zapiszPrzejecie } from '../db/podjazdy.js';
import { sledzeniePrzesylki } from '../../../domena/sledzenie-przesylki.js';
import { dowodPrzejecia } from '../../../domena/przejecie-przesylki.js';
import { dowodOdbioru, chwilaDowoduUKuriera } from '../../../domena/dowod-odbioru.js';

const teraz = () => new Date().toISOString();

// Wspólny dławik per paczka dla karty i zegarów. Zwykłe przesyłki zachowują
// godzinę; nieprzejęte WzA mają 10 minut przez 14 dni, potem dobę.
export const GODZINA_MS = 60 * 60 * 1000;
export const DZIESIEC_MINUT_MS = 10 * 60 * 1000;
export const DOBA_MS = 24 * GODZINA_MS;
const CZTERNASCIE_DNI_MS = 14 * DOBA_MS;

// Argumentem jest WYLACZNIE ZNACZNIK NASZEJ WLASNEJ PROBY (status_kuriera_pobrany_at).
// Czasu ZE ZRODLA (status_kuriera_at / eventTime) NIE WOLNO tu uzyc z dwoch powodow:
//  1. sterowanie: dla paczki doreczonej dawno warunek bylby ZAWSZE prawdziwy (DPD w kolko
//     oddaje to samo stare zdarzenie) — dlawik nie dlawilby niczego;
//  2. strefa: DPD oddaje eventTime BEZ STREFY, wiec Date.parse czyta go w strefie hosta.
// Nieczytelna albo brakujaca data znaczy „pytaj" — dlawik ma opozniac ruch, nie go zabraniac.
export function probaStarszaNizGodzina(probaAt, terazMs = Date.now()) {
  if (!probaAt) return true;
  const czas = Date.parse(probaAt);
  if (Number.isNaN(czas)) return true;
  return terazMs - czas > GODZINA_MS;
}

export function probaPrzesylkiWymagana(p, terazMs = Date.now()) {
  if (!p?.status_kuriera_pobrany_at) return true;
  const od = Date.parse(p.status_kuriera_pobrany_at);
  if (!Number.isFinite(od)) return true;
  let odstep = GODZINA_MS;
  if (p.kurier === 'allegro_wza' && !p.przejeta_at) {
    const utworzona = Date.parse(p.utworzona_at ?? '');
    odstep = Number.isFinite(utworzona) && terazMs - utworzona > CZTERNASCIE_DNI_MS
      ? DOBA_MS : DZIESIEC_MINUT_MS;
  }
  return terazMs - od > odstep;
}

// KAZDY zapis przy odswiezaniu oslaniamy OSOBNO. Zmierzone na bazie oddajacej SQLITE_FULL:
// nieoslonietym zapisem karta przestawala sie otwierac DOKLADNIE wtedy, gdy ktos probowal
// diagnozowac awarie. Nieudany zapis nie ma tu ratunku (log padnie z tego samego powodu),
// wiec go odpuszczamy — nieodswiezony stan jest niepomiernie znosniejszy niz HTTP 500.
export const zapiszLubOdpusc = (operacja) => {
  try { operacja(); return true; } catch { return false; }
};

/**
 * Odswieza status kuriera JEDNEJ przesylki. Wolana osobno dla kazdej paczki — dlawik tez
 * jest per paczka, wiec swiezo nadana paczka nr 2 nie dziedziczy „sprawdzone przed chwila"
 * po paczce nr 1 sprzed tygodnia.
 *
 * Zwraca opis wyniku dla zegara ({ pominieta } / { bezSledzenia } / { blad } / { ok }) —
 * karta wynik ignoruje, jak dotad.
 */
export async function odswiezStatusKuriera(db, kurierzy, z, p, { terazMs = Date.now() } = {}) {
  if (!probaPrzesylkiWymagana(p, terazMs)) return { pominieta: true };

  const cel = sledzeniePrzesylki(p, kurierzy);
  if (!cel) {
    // ⚠️ WYCHODZAC, SPRZATAMY PO SOBIE (12.08.2026): jedyna inna droga skasowania
    // `status_kuriera_blad` to „najblizsze UDANE odswiezenie", ktore u paczki bez
    // sledzenia nie nastapi nigdy. Zapis idzie TYLKO gdy naprawde jest co kasowac
    // (warunek w SQL), wiec zwykle otwarcie karty niczego nie pisze.
    if (p.status_kuriera_blad && zapiszLubOdpusc(() => wyczyscBladStatusu(db, p.id))) p.status_kuriera_blad = null;
    return { bezSledzenia: true };
  }

  const probaAt = teraz();
  let blad = null;
  let wynik = null;
  try {
    // Drugi argument to KONTEKST wyboru (`domain/sledzenie-przesylki.js`) — dzis niesie
    // `carrier` dla kanalu Allegro. Pozostale klienty go ignoruja, wiec dolozenie go tutaj
    // niczego u nich nie zmienia.
    //
    // ⚠️ KANAL DOKLADAMY TUTAJ, bo TU jest zamowienie. `sledzeniePrzesylki` widzi sam wiersz
    // przesylki, a kanal (konto Allegro) siedzi w `zamowienia.sklep` — i jest konieczny,
    // bo zasob sledzenia widzi wylacznie przesylki WLASNEGO konta. Bez tego paczka z drugiego
    // kanalu dostawalaby `trackingDetails: null`, nie do odroznienia od swiezo nadanej.
    wynik = await cel.klient.statusPrzesylki(cel.numer, { ...cel.kontekst, kanal: z?.sklep ?? null });
  } catch (e) {
    // Rozdzielenie adresatow: awaria kuriera mowi po ludzku, nasza wlasna regresja
    // (`statusPrzesylki is not a function`, blad bindowania) dostaje przedrostek
    // BLAD TECHNICZNY — obie zdarzyly sie naprawde i w logu musza wygladac inaczej.
    blad = e?.dlaOperatora ? e.message : `BŁĄD TECHNICZNY: ${e?.message ?? e}`;
  }
  // Pola w pamieci aktualizujemy TYLKO po udanym zapisie: inaczej karta pokazywalaby
  // status, ktorego w bazie nie ma, a przy nastepnym otwarciu cofalaby sie do starego.
  if (wynik && zapiszLubOdpusc(() => zapiszStatusDpd(db, p.id, wynik))) {
    p.status_kuriera = wynik.opis ?? null;
    p.status_kuriera_at = wynik.at ?? null;
    // Kod ida razem z opisem — takze gdy jest NULL (DPD, InPost). Rozjazd tych dwoch pol
    // w pamieci znaczylby etap liczony ze STAREGO kodu przy NOWYM opisie.
    p.status_kuriera_kod = wynik.kod ?? null;
  }
  if (p.kurier === 'allegro_wza' && wynik?.historia?.length && !p.przejeta_at) {
    const dowod = dowodPrzejecia({
      zrodlo: cel.podwykonawca === 'DPD' ? 'dpd' : 'allegro',
      zdarzenia: wynik.historia,
    });
    if (dowod) zapiszLubOdpusc(() => {
      const zapis = zapiszPrzejecie(db, p.id, dowod);
      if (zapis) {
        p.przejeta_at = zapis.przejeta_at;
        p.przejecie_kod = zapis.przejecie_kod;
      }
    });
  }
  // PRZ-108.09 (zdarzenie automatyzacji „Kurier odebrał paczkę”): PIERWSZY dowód odbioru z białej listy — stan zapisany
  // wyżej (pola w pamięci są już po zapisie), przejęcie WzA albo historia tej odpowiedzi — daje chwilę odbioru (nasz
  // zegar, w chwili zapisu) raz na paczkę. Osłonięte jak każdy zapis tutaj: awaria nie może zepsuć karty ani zegara.
  if (!p.odebrana_at) {
    const historia = wynik?.historia ?? null;
    const dowod = dowodOdbioru(p, { historia });
    if (dowod) zapiszLubOdpusc(() => {
      // Recenzja 09, usterka 1: także chwila odbioru U KURIERA — reguła pominie dowód spóźniony o ponad 48 h.
      const kurierAt = chwilaDowoduUKuriera(p, { historia });
      const at = zapiszOdbiorPrzesylki(db, p.id, { at: teraz(), dowod, kurierAt });
      if (at) { p.odebrana_at = at; p.odebrana_dowod = dowod; p.odebrana_kurier_at = kurierAt; }
    });
  }
  // Akcja w logu niesie NAZWE KURIERA Z WIERSZA (`allegro_wza.status`, `dpd.status`) —
  // takze przy pytaniu podwykonawcy: to paczka WzA ma problem, a nie „jakies DPD".
  if (blad) zapiszLubOdpusc(() => dopiszLog(db, z.id, { akcja: `${p.kurier}.status`, wynik: `BŁĄD: ${blad}` }));
  // Znacznik proby ZAWSZE, takze po bledzie i pustej odpowiedzi — inaczej dlawik nie
  // objalby wlasnie tych przypadkow, w ktorych najbardziej boli.
  if (zapiszLubOdpusc(() => zapiszProbeStatusuDpd(db, p.id, { at: probaAt, blad }))) {
    p.status_kuriera_pobrany_at = probaAt;
    p.status_kuriera_blad = blad;
  }
  return blad ? { blad } : { ok: true };
}
