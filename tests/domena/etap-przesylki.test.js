import { describe, it, expect } from 'vitest';
import {
  etapPrzesylki, etykietaEtapu, dniRoboczeMiedzy, bezRuchu, PROG_BEZ_RUCHU_DNI_ROBOCZYCH,
  KODY_ALLEGRO,
} from '../../src/domena/etap-przesylki.js';

// ETAP PRZESYLKI — klasa stanu liczona z OPISU zdarzenia kuriera (audyt 22.08, zgoda właściciela
// 23.08: „w drodze (N dni) / w doręczeniu / doręczona" + ostrzezenie bez ruchu >3 dni ROBOCZE).
//
// ⚠️ ETAP GRUPUJE, NIE TLUMACZY. Surowy opis kuriera zostaje na ekranie ZAWSZE — etap sluzy
// pastylce, filtrom zakladki i regule „bez ruchu". Nieznany opis z historia zdarzen to
// z definicji paczka W DRODZE (ma zdarzenia, nie zna wzorca konca) — to klasa, nie zdanie
// wypowiedziane za kuriera, wiec nie klamie.
//
// Wzorce DPD sa ZMIERZONE (sonda na zywym API zdarzen 23.08 + produkcyjna baza); wzorce
// InPost to NASZE WLASNE opisy z OPISY_STANOW (kurierzy/inpost.js) — jedno zrodlo etykiet.

describe('etapPrzesylki', () => {
  it('rejestracja danych to jeszcze nie droga', () => {
    expect(etapPrzesylki('Zarejestrowano dane przesyłki, jeszcze nie nadana')).toBe('nadana');
    expect(etapPrzesylki('Zarejestrowano dane przesyłki, przesyłka jeszcze nie nadana')).toBe('nadana');
    expect(etapPrzesylki('Przesyłka zarejestrowana')).toBe('nadana');
  });

  it('odebranie przez kuriera i ruch po sortowniach to droga', () => {
    expect(etapPrzesylki('Przesyłka odebrana przez Kuriera')).toBe('w_drodze');
    expect(etapPrzesylki('Przyjęcie przesyłki w sortowni')).toBe('w_drodze');
    expect(etapPrzesylki('Wysłana z oddziału nadawczego')).toBe('w_drodze');
  });

  it('wydanie do doreczenia i paczkomat gotowy do odbioru to doreczanie', () => {
    expect(etapPrzesylki('Wydana do doręczenia')).toBe('w_doreczeniu');
    expect(etapPrzesylki('Przesyłka wydana do doręczenia')).toBe('w_doreczeniu');
    expect(etapPrzesylki('Gotowa do odbioru w paczkomacie')).toBe('w_doreczeniu');
    expect(etapPrzesylki('W doręczeniu')).toBe('w_doreczeniu');
  });

  it('doreczenie i odbior koncza droge', () => {
    expect(etapPrzesylki('Przesyłka doręczona')).toBe('doreczona');
    expect(etapPrzesylki('Doręczona do odbiorcy')).toBe('doreczona');
    expect(etapPrzesylki('Odebrana przez klienta')).toBe('doreczona');
  });

  it('zwrot do nadawcy jest osobnym etapem, nigdy „doreczona"', () => {
    expect(etapPrzesylki('Zwrócona do nadawcy')).toBe('zwrot');
    expect(etapPrzesylki('Zwrot przesyłki do nadawcy')).toBe('zwrot');
  });

  // ⚠️ „Doręczona" zawiera slowo „doręczenie" w rdzeniu — kolejnosc wzorcow jest trescia,
  // jak p24 przed przelewem w metodach platnosci.
  it('doreczona NIE wpada do „w doreczeniu"', () => {
    expect(etapPrzesylki('Przesyłka doręczona do odbiorcy')).toBe('doreczona');
  });

  it('nieznany opis z historia = w drodze; brak opisu = null (nic nie wiemy)', () => {
    expect(etapPrzesylki('Skan w terminalu przeładunkowym XYZ')).toBe('w_drodze');
    expect(etapPrzesylki(null)).toBe(null);
    expect(etapPrzesylki('   ')).toBe(null);
  });
});

// KOD MASZYNOWY ALLEGRO — drugi argument `etapPrzesylki`.
//
// ⚠️ KOD WYGRYWA Z OPISEM, I TO JEST CALA TRESC TEJ ZMIANY. Allegro oddaje `code`
// (maszynowy) obok `description` (TLUMACZONEGO na jezyk z Accept-Language). Regula tego
// repozytorium mowi „mapowanie idzie PO id, NIGDY po nazwie" — a nazwa, ktora jest
// tlumaczeniem, zmienia sie najlatwiej ze wszystkiego. Klasyfikowanie polskiego opisu
// dzialaloby dzis i zamilkloby po cichu przy pierwszej korekcie tekstu u Allegro.
//
// Kody i opisy ZMIERZONE sonda na zywym API 25.08.2026 (konto allegro_szkicownia, paczki
// #42 AD0SSC8LN5Q06GPJN i #50 A005DUH6H5 — obie Allegro Punkt, nadane POZA panelem).
describe('etapPrzesylki — kod Allegro', () => {
  it('kod rozstrzyga etap', () => {
    expect(etapPrzesylki('Przesyłka została doręczona', 'DELIVERED')).toBe('doreczona');
    expect(etapPrzesylki('Przesyłka oczekuje na odbiór', 'AVAILABLE_FOR_PICKUP')).toBe('w_doreczeniu');
    expect(etapPrzesylki('Przesyłka wydana do doręczenia', 'RELEASED_FOR_DELIVERY')).toBe('w_doreczeniu');
    expect(etapPrzesylki('Przesyłka odebrana przez kuriera', 'IN_TRANSIT')).toBe('w_drodze');
    expect(etapPrzesylki('Przesyłka przygotowana przez nadawcę', 'PENDING')).toBe('nadana');
  });

  // ⚠️ To jest test na to, ze kod NAPRAWDE wygrywa, a nie ze oba zrodla przypadkiem
  // zgadzaja sie na zmierzonych parach. Bez rozbieznego opisu mutacja „czytaj opis zamiast
  // kodu" przezylaby caly zestaw wyzej.
  it('kod wygrywa nawet wtedy, gdy opis mowi co innego', () => {
    expect(etapPrzesylki('Przesyłka doręczona', 'IN_TRANSIT')).toBe('w_drodze');
    expect(etapPrzesylki('Przesyłka odebrana przez Kuriera', 'DELIVERED')).toBe('doreczona');
  });

  it('opisy Allegro po ANGIELSKU tez sa klasyfikowane — bo decyduje kod', () => {
    expect(etapPrzesylki('Parcel has been delivered', 'DELIVERED')).toBe('doreczona');
    expect(etapPrzesylki('Parcel is awaiting pick-up', 'AVAILABLE_FOR_PICKUP')).toBe('w_doreczeniu');
  });

  it('nieznany kod schodzi do opisu, a nie do zgadywania', () => {
    expect(etapPrzesylki('Przesyłka doręczona', 'JAKIS_NOWY_KOD')).toBe('doreczona');
    expect(etapPrzesylki('Skan w terminalu XYZ', 'JAKIS_NOWY_KOD')).toBe('w_drodze');
  });

  // REGRESJA: DPD i InPost kodow nie maja i nie moga zaczac zachowywac sie inaczej.
  it('brak kodu zachowuje dotychczasowe dopasowanie po opisie', () => {
    expect(etapPrzesylki('Przesyłka doręczona', null)).toBe('doreczona');
    expect(etapPrzesylki('Przesyłka doręczona', undefined)).toBe('doreczona');
    expect(etapPrzesylki('Zarejestrowano dane przesyłki', '')).toBe('nadana');
    expect(etapPrzesylki(null, null)).toBe(null);
  });

  // ⚠️ STRAZNIK ZUPELNOSCI. Nowy kod Allegro nie moze po cichu wpasc do „w drodze":
  // paczka ZWROCONA sklasyfikowana jako jadaca znika z pola widzenia dokladnie wtedy,
  // gdy wymaga czlowieka. Ten test pilnuje, ze komplet kodow z sondy ma decyzje.
  it('komplet zmierzonych kodow ma jawna decyzje w mapie', () => {
    const ZMIERZONE = ['PENDING', 'IN_TRANSIT', 'RELEASED_FOR_DELIVERY', 'AVAILABLE_FOR_PICKUP', 'DELIVERED'];
    for (const kod of ZMIERZONE) expect(KODY_ALLEGRO[kod], `kod ${kod} bez decyzji`).toBeTruthy();
  });
});

describe('etykietaEtapu', () => {
  it('w drodze niesie liczbe dni, pozostale sam opis', () => {
    expect(etykietaEtapu('w_drodze', 1)).toBe('W drodze (1 dzień)');
    expect(etykietaEtapu('w_drodze', 3)).toBe('W drodze (3 dni)');
    expect(etykietaEtapu('w_doreczeniu', 2)).toBe('W doręczeniu');
    expect(etykietaEtapu('doreczona', 5)).toBe('Doręczona');
    expect(etykietaEtapu('zwrot', 5)).toBe('Zwrot do nadawcy');
    expect(etykietaEtapu('nadana', 0)).toBe('Zarejestrowana');
  });

  it('polska odmiana dni: 1 dzień / 2 dni / 5 dni', () => {
    expect(etykietaEtapu('w_drodze', 0)).toBe('W drodze (dziś)');
    expect(etykietaEtapu('w_drodze', 2)).toBe('W drodze (2 dni)');
    expect(etykietaEtapu('w_drodze', 7)).toBe('W drodze (7 dni)');
  });
});

describe('dniRoboczeMiedzy', () => {
  // 2026-08-21 = piątek, 22-23 weekend, 24 = poniedziałek.
  it('weekend nie liczy sie do dni roboczych', () => {
    expect(dniRoboczeMiedzy('2026-08-21T10:00:00Z', '2026-08-24T10:00:00Z')).toBe(1);
    expect(dniRoboczeMiedzy('2026-08-21T10:00:00Z', '2026-08-22T10:00:00Z')).toBe(0);
    expect(dniRoboczeMiedzy('2026-08-17T10:00:00Z', '2026-08-21T10:00:00Z')).toBe(4);
  });

  it('ten sam dzien to zero, odwrotna kolejnosc tez zero (nie ujemne)', () => {
    expect(dniRoboczeMiedzy('2026-08-20T08:00:00Z', '2026-08-20T18:00:00Z')).toBe(0);
    expect(dniRoboczeMiedzy('2026-08-24T10:00:00Z', '2026-08-21T10:00:00Z')).toBe(0);
  });

  it('dni liczone po dacie warszawskiej, nie po pelnych dobach zegarowych', () => {
    // 21.08 23:30 Warszawy (21:30Z) → 24.08 rano: pt→pn = 1 dzien roboczy.
    expect(dniRoboczeMiedzy('2026-08-21T21:30:00Z', '2026-08-24T06:00:00Z')).toBe(1);
  });
});

describe('bezRuchu', () => {
  const teraz = new Date('2026-08-27T10:00:00Z'); // czwartek
  it('ponad 3 dni robocze od ostatniego zdarzenia = alarm (pt→czw z weekendem = 4)', () => {
    expect(PROG_BEZ_RUCHU_DNI_ROBOCZYCH).toBe(3);
    expect(bezRuchu({ etap: 'w_drodze', statusKurieraAt: '2026-08-21T10:00:00', nadanaAt: '2026-08-20T10:00:00Z', teraz })).toBe(true);
  });

  it('rowno 3 dni roboczych jeszcze nie alarmuje, doreczona i zwrot nigdy', () => {
    expect(bezRuchu({ etap: 'w_drodze', statusKurieraAt: '2026-08-24T10:00:00', nadanaAt: null, teraz })).toBe(false);
    expect(bezRuchu({ etap: 'doreczona', statusKurieraAt: '2026-08-10T10:00:00', nadanaAt: null, teraz })).toBe(false);
    expect(bezRuchu({ etap: 'zwrot', statusKurieraAt: '2026-08-10T10:00:00', nadanaAt: null, teraz })).toBe(false);
  });

  it('bez zadnego zdarzenia liczy od nadania (paczka moze zginac przed pierwszym skanem)', () => {
    expect(bezRuchu({ etap: null, statusKurieraAt: null, nadanaAt: '2026-08-20T10:00:00Z', teraz })).toBe(true);
    expect(bezRuchu({ etap: null, statusKurieraAt: null, nadanaAt: '2026-08-25T10:00:00Z', teraz })).toBe(false);
  });

  it('bez zadnej daty nie alarmuje (nie ma od czego liczyc)', () => {
    expect(bezRuchu({ etap: 'w_drodze', statusKurieraAt: null, nadanaAt: null, teraz })).toBe(false);
  });
});

describe('dniKalendarzowe', () => {
  it('liczy pelne doby, bez ujemnych', async () => {
    const { dniKalendarzowe } = await import('../../src/domena/etap-przesylki.js');
    expect(dniKalendarzowe('2026-08-20T10:00:00Z', '2026-08-23T12:00:00Z')).toBe(3);
    expect(dniKalendarzowe('2026-08-23T10:00:00Z', '2026-08-23T12:00:00Z')).toBe(0);
    expect(dniKalendarzowe('2026-08-24T10:00:00Z', '2026-08-23T12:00:00Z')).toBe(0);
    expect(dniKalendarzowe(null, '2026-08-23T12:00:00Z')).toBe(0);
  });
});
