// CZWARTY ZEGAR — SLEDZENIE PACZEK W DRODZE (audyt 22.08; zgoda właściciela 23.08: „przy paczce
// status w drodze / w doreczeniu / doreczona" + ostrzezenie bez ruchu >3 dni robocze).
//
// Raz na godzine odpytuje statusy przesylek NADANYCH z ostatnich OKNO_SLEDZENIA_DNI dni —
// TA SAMA sciezka, co odswiezanie przy otwarciu karty (services/status-kuriera.js): wspolny
// dlawik godzinowy per paczka (karta i zegar dziela jeden licznik, zero podwojnego ruchu
// do kuriera), wspolny wybor „kogo pytac" (domain/sledzenie-przesylki.js: podwykonawca
// DPD albo Allegro dla One/ORLEN/DHL WzA). Po „Wyslane" proces przestaje byc slepy: doreczenie,
// zwrot i paczka bez ruchu wychodza SAME, nie dopiero gdy klient napisze (status_kuriera
// byl NULL dla 37 z 64 produkcyjnych przesylek).
//
// ⚠️ Paczki DORECZONE i ZWROCONE wypadaja z odpytywania (etap z ostatniego statusu) —
// DPD w kolko oddaje to samo koncowe zdarzenie, wiec pytanie o nie to czysty ruch bez
// tresci. Okno 14 dni domyka reszte: paczka starsza niz dwa tygodnie nie jest juz „w
// drodze" w zadnym operacyjnym sensie, a jesli wisi bez doreczenia — zdazyla przez dwa
// tygodnie alarmowac regula „bez ruchu".
//
// ⚠️ Straznik „jeden przebieg naraz" — ta sama zasada, co w czuwaczu KSeF: przebieg
// przekraczajacy godzine nie moze nawarstwiac rownoleglych petli po tych samych paczkach.

import { przesylkiDoSledzenia } from '../db/przesylki.js';
import { odswiezStatusKuriera } from './status-kuriera.js';
import { etapPrzesylki } from '../../../domena/etap-przesylki.js';
import { oznaczDoreczonePobrania } from './oznaczanie-pobran.js';
import { ponowZalegleNotatki } from './notatka-nadania.js';

export const OKNO_SLEDZENIA_DNI = 14;

export function createCzuwaczPrzesylek({
  db, kurierzy = {}, infakt = null, teraz = () => new Date(), klienci = {},
}) {
  let trwa = false;

  async function przebieg() {
    if (trwa) return { pominiety: true };
    trwa = true;
    try {
      const chwila = teraz();
      const odIso = new Date(chwila.getTime() - OKNO_SLEDZENIA_DNI * 24 * 3600 * 1000).toISOString();
      const kandydaci = przesylkiDoSledzenia(db, odIso)
        // Etap liczony z OSTATNIEGO znanego statusu — doreczona/zwrot nie wraca do puli.
        .filter((p) => !['doreczona', 'zwrot'].includes(etapPrzesylki(p.status_kuriera, p.status_kuriera_kod)));

      let sprawdzone = 0;
      let bledy = 0;
      let pominiete = 0;
      for (const p of kandydaci) {
        // eslint-disable-next-line no-await-in-loop -- kurierzy sekwencyjnie, jak poller po sklepach
        // ⚠️ `sklep` OBOK `id`, a nie sama atrapa `{ id }` (regresja 31.08.2026). Klient
        // sledzenia kanalu Allegro wybiera KONTO po kanale zamowienia — atrapa dawala mu
        // `kanal: null`, wiec oddawal `null` i zegar przez szesc dni udawal, ze pyta:
        // zapisu nie bylo, bledu nie bylo, znacznik proby rosl. Karta dziala od poczatku,
        // bo tam leci prawdziwy wiersz zamowienia — i wlasnie to ukrylo usterke.
        // Kanal przynosi `przesylkiDoSledzenia` (LEFT JOIN po zamowieniu).
        const w = await odswiezStatusKuriera(
          db, kurierzy, { id: p.zamowienie_id, sklep: p.sklep ?? null }, p, { terazMs: chwila.getTime() },
        );
        if (w?.pominieta) pominiete += 1;
        else if (w?.blad) bledy += 1;
        else if (w?.ok) sprawdzone += 1;
      }
      // ⚠️ PO ODPYTANIU KURIERÓW, NIE PRZED: paczka, która doręczyła się w TYM przebiegu,
      // ma zostać rozliczona od razu, a nie za godzinę. Skan jest idempotentny (rezerwacja
      // w `oznaczenia_zaplaty`), więc uruchamiamy go w każdym przebiegu, także pustym.
      //
      // ⚠️ NIE JEST TO „jedno zapytanie": to jedno zapytanie SQL (wyłania kandydatów) PLUS
      // jeden `GET` do inFaktu NA KAŻDEGO kandydata i `POST` na tych, którzy przejdą regułę.
      // Ruch skaluje się z liczbą DORĘCZONYCH POBRAŃ BEZ REZERWACJI, a nie z liczbą paczek
      // w oknie — kandydat obsłużony raz znika z zapytania na zawsze, więc w spokojną godzinę
      // sieci nie ma wcale.
      //
      // ⚠️ WŁASNY `try` — awaria rozliczania pobrań NIE JEST awarią śledzenia paczek
      // i nie ma prawa zabrać wyniku przebiegu ani zapalić czujki od statusów kurierskich.
      let pobrania = {
        kandydatow: 0, obsluzone: 0, ponadSufit: 0, zlecone: 0, pominiete: 0, bezDaty: 0, bledy: 0,
      };
      try {
        pobrania = await oznaczDoreczonePobrania({ db, infakt });
      } catch (e) {
        pobrania = {
          kandydatow: 0,
          obsluzone: 0,
          ponadSufit: 0,
          zlecone: 0,
          pominiete: 0,
          bezDaty: 0,
          bledy: 1,
          blad: e.message,
        };
      }

      // PRZ-117: notatki z numerem listu, które nie doszły do sklepu — co przebieg (raz na godzinę) przez 48 h.
      // Własny `try` z tego samego powodu co pobrania: awaria sklepu nie jest awarią śledzenia paczek.
      let notatki = { kandydatow: 0, wyslane: 0, bledy: 0 };
      if (Object.keys(klienci).length) {
        try {
          notatki = await ponowZalegleNotatki({ db, klienci, teraz: chwila });
        } catch (e) {
          notatki = { kandydatow: 0, wyslane: 0, bledy: 1, blad: e.message };
        }
      }

      return {
        kandydatow: kandydaci.length, sprawdzone, bledy, pominiete, pobrania, notatki,
      };
    } finally {
      trwa = false;
    }
  }

  return { przebieg };
}
