import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import {
  dodajZwrot, zwrotyZamowienia, zwrot, usunZwrot, oznaczPieniadzeOddane, zamowieniaZeZwrotem,
  zarezerwujKorekte, zapiszKorekte, zapiszBladKorekty, odblokujKorekte, zapiszRecznyNumerKorekty,
} from '../../../src/oms/db/zwroty.js';

const zmapowane = (nad = {}) => ({
  zrodlo_id: 1301, numer: '1301', klient: { email: 'j@k.pl' }, dostawa: { city: 'Pęki' },
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null,
  kwota_brutto: '212.90', status_woo: 'processing', oplacone_at: null, anulowane: 0,
  utworzone_at: '2026-07-29T13:19:52', pozycje: [],
  ...nad,
});

let db;
let id;
beforeEach(() => {
  db = openOmsDb(':memory:');
  // Liczniki AUTOINCREMENT roznych tabel zbiegaja sie w swiezej bazie (przewodnik OMS, 6.3),
  // wiec zamowienie i zwrot dostawalyby to samo `id` — pomylka argumentu przeszlaby niezauwazona.
  for (let i = 0; i < 4; i += 1) zapiszZamowienie(db, 'pro', zmapowane({ zrodlo_id: 9000 + i, numer: `900${i}` }), {});
  // ⚠️ Rozbieznosc z briefem: `zapiszZamowienie` oddaje LICZBOWE `id` wprost (return id w
  // db/zamowienia.js), nie obiekt { id }. Brief mial tu `.id` — usuniete, bo `(liczba).id`
  // dawaloby `undefined` i psulo cala fikture cicho (zob. tez tests/oms/platnosci-db.test.js).
  id = zapiszZamowienie(db, 'pro', zmapowane(), {});
});

describe('zapis i odczyt zwrotu', () => {
  it('zapisuje zwrot z pozycjami i oddaje go z powrotem', () => {
    dodajZwrot(db, id, {
      data: '2026-08-14',
      kwota: '99.00',
      kwotaDostawy: '19.00',
      powod: 'nie pasuje',
      pozycje: [{ klucz_pozycji: 's77', nazwa: 'Szablon Kot 70x100', ilosc: 1, kwota: '99.00' }],
    });
    const lista = zwrotyZamowienia(db, id);
    expect(lista).toHaveLength(1);
    expect(lista[0].kwota).toBe('99.00');
    expect(lista[0].kwota_dostawy).toBe('19.00');
    expect(lista[0].pieniadze_oddane_at).toBeNull();
    expect(lista[0].pozycje).toEqual([
      { klucz_pozycji: 's77', nazwa: 'Szablon Kot 70x100', ilosc: 1, kwota: '99.00' },
    ]);
  });

  it('dwa zwroty do jednego zamowienia zyja obok siebie, po dacie', () => {
    dodajZwrot(db, id, { data: '2026-09-02', kwota: '50.00', pozycje: [] });
    dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', pozycje: [] });
    expect(zwrotyZamowienia(db, id).map((z) => z.data)).toEqual(['2026-08-14', '2026-09-02']);
  });

  it('usuniecie zwrotu zabiera ze soba jego pozycje', () => {
    const z = dodajZwrot(db, id, {
      data: '2026-08-14', kwota: '99.00',
      pozycje: [{ klucz_pozycji: 's77', nazwa: 'Kot', ilosc: 1, kwota: '99.00' }],
    });
    usunZwrot(db, id, z.id);
    expect(zwrotyZamowienia(db, id)).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM zwroty_pozycje').get().n).toBe(0);
  });

  it('zwrotu z CUDZEGO zamowienia nie da sie odczytac ani usunac', () => {
    const z = dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', pozycje: [] });
    expect(zwrot(db, id + 1, z.id)).toBeNull();
    expect(() => usunZwrot(db, id + 1, z.id)).toThrow(/Nie ma takiego zwrotu/);
  });

  it('oznaczenie oddania pieniedzy zapisuje FAKT z data', () => {
    const z = dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', pozycje: [] });
    oznaczPieniadzeOddane(db, id, z.id, '2026-08-15T09:00:00.000Z');
    expect(zwrot(db, id, z.id).pieniadze_oddane_at).toBe('2026-08-15T09:00:00.000Z');
  });

  it('zamowieniaZeZwrotem oddaje identyfikatory jednym zapytaniem', () => {
    dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', pozycje: [] });
    expect(zamowieniaZeZwrotem(db).has(id)).toBe(true);
  });

  it('zwrot PRZEZYWA synchronizacje, ktora kasuje i wstawia pozycje od nowa', () => {
    // ⚠️ Rozbieznosc z briefem: fikstura ponizej dostala `sku: null` i `vat: null` — brief je
    // pomijal, ale `node:sqlite` (inaczej niz sterowniki, dla ktorych brief mogl byc pisany)
    // odmawia zbindowania `undefined` jako parametru („Provided value cannot be bound to
    // SQLite parameter 3", potem „...parameter 9") i cala fikstura padala w `zapiszZamowienie`,
    // zanim doszlo do sedna testu. Kazda inna fikstura pozycji w tym repo (np.
    // tests/oms/web-pozycje.test.js) podaje oba pola wprost z tego samego powodu.
    const zPozycjami = zmapowane({
      pozycje: [{
        zrodlo_id: 77, nazwa: 'Kot 70x100', sku: null, ilosc: 2, cena_brutto: '99.00', brutto_linii: '198.00',
        vat: null,
      }],
    });
    // ⚠️ Rozbieznosc z briefem: `zapiszZamowienie` oddaje LICZBOWE `id` (nie `{ id }`) — patrz
    // komentarz w beforeEach powyzej. `zam` ponizej jest wiec juz samym identyfikatorem.
    const zam = zapiszZamowienie(db, 'pro', zPozycjami, {});
    const przedId = db.prepare('SELECT id FROM pozycje WHERE zamowienie_id = ?').get(zam).id;
    dodajZwrot(db, zam, {
      data: '2026-08-14', kwota: '99.00',
      pozycje: [{ klucz_pozycji: 's77', nazwa: 'Kot 70x100', ilosc: 1, kwota: '99.00' }],
    });

    // Poller: ten sam przebieg, te same dane — pozycje leca i wracaja z NOWYM `id`.
    zapiszZamowienie(db, 'pro', zPozycjami, {});
    const poId = db.prepare('SELECT id FROM pozycje WHERE zamowienie_id = ?').get(zam).id;
    expect(poId).not.toBe(przedId);

    const [w] = zwrotyZamowienia(db, zam);
    expect(w.pozycje[0].klucz_pozycji).toBe('s77');
    expect(w.pozycje[0].nazwa).toBe('Kot 70x100');
  });
});

// ⚠️⚠️ I6 (recenzja 2026-08-15): REJESTRACJA ZWROTU NIE MIALA OBRONY PRZED POWTORNYM WYSLANIEM.
// Bariery liczyl `parsujZwrot` POZA transakcja, a `dodajZwrot` wstawial bez zadnego warunku.
// Back+resubmit, dwuklik i dwie otwarte karty to znane drogi do drugiego dokumentu (opisane
// wprost przy rezerwacji korekty niżej w tym samym pliku) — przy rejestracji obrony nie bylo.
// Skutek: suma zwrotow sie PODWAJA, a raport zdejmuje kwote z przychodu DWA RAZY.
describe('dodajZwrot — obrona przed powtornym wyslaniem tego samego formularza', () => {
  const formularz = {
    data: '2026-08-14', kwota: '99.00', kwotaDostawy: '19.00', powod: 'nie pasuje',
    pozycje: [{ klucz_pozycji: 's77', nazwa: 'Kot 70x100', ilosc: 1, kwota: '99.00' }],
  };

  it('drugi IDENTYCZNY zwrot dostaje ODMOWE, a w bazie zostaje dokladnie jeden', () => {
    dodajZwrot(db, id, formularz);
    expect(() => dodajZwrot(db, id, formularz)).toThrow(/już zapisany|taki sam/i);
    expect(zwrotyZamowienia(db, id)).toHaveLength(1);
    // ⚠️ Odmowa NIE MOZE zostawic osieroconych pozycji: sprawdzenie i INSERT ida jedna
    // transakcja, wiec po ROLLBACK-u tabela pozycji ma zostac taka, jaka byla.
    expect(db.prepare('SELECT COUNT(*) AS n FROM zwroty_pozycje').get().n).toBe(1);
  });

  it('zwrot rozniacy sie DATA, KWOTA albo ZESTAWEM POZYCJI przechodzi — to nie jest duplikat', () => {
    dodajZwrot(db, id, formularz);
    dodajZwrot(db, id, { ...formularz, data: '2026-09-02' });
    dodajZwrot(db, id, { ...formularz, kwota: '50.00' });
    dodajZwrot(db, id, { ...formularz, pozycje: [{ klucz_pozycji: 's78', nazwa: 'Pies', ilosc: 1, kwota: '99.00' }] });
    expect(zwrotyZamowienia(db, id)).toHaveLength(4);
  });

  // ⚠️ KOMUNIKAT NIE MA NAMAWIAC NA NIEPRAWDE (recenzja kontrolna 2026-08-15). Rada „zmień datę
  // albo kwotę" prowadzi operatora do zapisania zwrotu, ktorego nie bylo: data zwrotu RZADZI
  // MIESIACEM PODATKOWYM (art. 14 ust. 1m PIT, art. 29a ust. 13 VAT), a kwota idzie wprost do
  // korekty. Prawdziwe dwa zwroty tego samego dnia i za te sama kwote sa nieodroznialne od
  // powtorki, wiec jedyna uczciwa rada to POLACZYC je w jeden wpis.
  it('komunikat proponuje POLACZENIE w jeden zwrot, a nie zmiane daty albo kwoty', () => {
    dodajZwrot(db, id, formularz);
    let zlapany = null;
    try { dodajZwrot(db, id, formularz); } catch (e) { zlapany = e; }
    expect(zlapany).not.toBeNull();
    expect(zlapany.message).toMatch(/jeden zwrot/i);
    expect(zlapany.message).not.toMatch(/zmień datę albo kwotę/i);
  });

  it('identyczny zwrot przy INNYM zamowieniu przechodzi — bariera jest per zamowienie', () => {
    const inne = zapiszZamowienie(db, 'pro', zmapowane({ zrodlo_id: 1302, numer: '1302' }), {});
    dodajZwrot(db, id, formularz);
    dodajZwrot(db, inne, formularz);
    expect(zwrotyZamowienia(db, id)).toHaveLength(1);
    expect(zwrotyZamowienia(db, inne)).toHaveLength(1);
  });
});

// ⚠️⚠️ C2 (recenzja 2026-08-15): WYJSCIE Z REZERWACJI, KTORA PRZEPADLA. Do tego dnia zwrot
// ze zleconą i odrzuconą korektą zostawał NIEROZLICZONY NA ZAWSZE, a jedynym wyjsciem byl
// reczny UPDATE na produkcyjnej bazie — czyli dokladnie to, przed czym panel ma chronic
// (przewodnik OMS, 4.9). Wzorem `odblokujFakture` (db/faktury.js).
describe('odblokujKorekte — kasuje SAMA rezerwacje, niczego nie wystawia', () => {
  it('czysci rezerwacje, referencje i blad, a zwraca stan SPRZED zmiany do logu', () => {
    const w = dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', pozycje: [] });
    zarezerwujKorekte(db, id, w.id, '2026-08-14T10:00:00.000Z');
    zapiszKorekte(db, id, w.id, { referencja: 'REF-1' });

    const przed = odblokujKorekte(db, id, w.id);
    expect(przed.korekta_zlecona_at).toBe('2026-08-14T10:00:00.000Z');
    expect(przed.korekta_referencja).toBe('REF-1');

    const po = zwrot(db, id, w.id);
    expect(po.korekta_zlecona_at).toBeNull();
    expect(po.korekta_referencja).toBeNull();
    expect(po.korekta_blad).toBeNull();
  });

  it('po odblokowaniu rezerwacja da sie zalozyc PONOWNIE — to jest cale wyjscie ze stanu', () => {
    const w = dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', pozycje: [] });
    zarezerwujKorekte(db, id, w.id);
    expect(zarezerwujKorekte(db, id, w.id)).toBe(false);
    odblokujKorekte(db, id, w.id);
    expect(zarezerwujKorekte(db, id, w.id)).toBe(true);
  });

  // ⚠️ TWARDA GRANICA: rezerwacji z NUMEREM nie wolno ruszyc — dokument w inFakcie ISTNIEJE,
  // a zwolnienie otwieraloby droge do drugiej korekty do tej samej faktury.
  it('ODMAWIA, gdy korekta ma juz numer — i nie kasuje niczego', () => {
    const w = dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', pozycje: [] });
    zarezerwujKorekte(db, id, w.id, '2026-08-14T10:00:00.000Z');
    zapiszKorekte(db, id, w.id, { numer: '1/KOR/08/2026' });
    expect(() => odblokujKorekte(db, id, w.id)).toThrow();
    expect(zwrot(db, id, w.id).korekta_zlecona_at).toBe('2026-08-14T10:00:00.000Z');
  });

  it('ODMAWIA dla zwrotu z CUDZEGO zamowienia', () => {
    const w = dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', pozycje: [] });
    zarezerwujKorekte(db, id, w.id);
    expect(() => odblokujKorekte(db, id + 1, w.id)).toThrow(/Nie ma takiego zwrotu/);
  });

  it('kasuje takze sam BLAD korekty po odmowie 4xx, gdy rezerwacja jest juz zwolniona', () => {
    const w = dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', pozycje: [] });
    zarezerwujKorekte(db, id, w.id);
    zapiszBladKorekty(db, id, w.id, 'inFakt: 422');
    odblokujKorekte(db, id, w.id);
    expect(zwrot(db, id, w.id).korekta_blad).toBeNull();
  });
});

describe('zapiszRecznyNumerKorekty — korekta wystawiona poza panelem', () => {
  it('zapisuje numer bez zadnej rezerwacji i bez dotykania inFaktu', () => {
    const w = dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', pozycje: [] });
    zapiszRecznyNumerKorekty(db, id, w.id, '2/KOR/09/2026');
    expect(zwrot(db, id, w.id).korekta_numer).toBe('2/KOR/09/2026');
  });

  // Dwuklik: drugi zapis nie ma prawa podmienic numeru pierwszego.
  it('ODMAWIA, gdy numer juz jest — i zostawia ten pierwszy', () => {
    const w = dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', pozycje: [] });
    zapiszRecznyNumerKorekty(db, id, w.id, '2/KOR/09/2026');
    expect(() => zapiszRecznyNumerKorekty(db, id, w.id, '3/KOR/09/2026')).toThrow();
    expect(zwrot(db, id, w.id).korekta_numer).toBe('2/KOR/09/2026');
  });

  it('ODMAWIA dla zwrotu z CUDZEGO zamowienia', () => {
    const w = dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', pozycje: [] });
    expect(() => zapiszRecznyNumerKorekty(db, id + 1, w.id, '2/KOR/09/2026')).toThrow();
    expect(zwrot(db, id, w.id).korekta_numer).toBeNull();
  });

  // ⚠️⚠️ W3 (recenzja kontrolna 2026-08-15): TEN SAM NUMER KOREKTY NA DWOCH ZWROTACH JEDNEGO
  // ZAMOWIENIA znaczy, ze panel policzyl JEDEN dokument DWA RAZY — oba zwroty melduja sie
  // jako rozliczone i zamowienie schodzi z listy roboczej, choc drugiej korekty nie ma.
  // Bariera stoi w BAZIE (UNIQUE), bo droga reczna omija kazde sito w kodzie.
  it('ODMAWIA numeru, ktory ma juz INNY zwrot tego samego zamowienia', () => {
    const a = dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', pozycje: [] });
    const b = dodajZwrot(db, id, { data: '2026-09-02', kwota: '50.00', pozycje: [] });
    zapiszRecznyNumerKorekty(db, id, a.id, '2/KOR/09/2026');
    expect(() => zapiszRecznyNumerKorekty(db, id, b.id, '2/KOR/09/2026'))
      .toThrow(/2\/KOR\/09\/2026/);
    expect(zwrot(db, id, b.id).korekta_numer).toBeNull();
    expect(zwrot(db, id, a.id).korekta_numer).toBe('2/KOR/09/2026');
  });

  // ⚠️ BARIERA JEST TAKZE W SCHEMACIE, NIE TYLKO W TEJ FUNKCJI. Numer korekty potrafi zapisac
  // rowniez `zapiszKorekte` (doczytanie z inFaktu), a sita doczytania nie widza zwrotu, ktory
  // numeru jeszcze nie ma. Ten test pilnuje samego indeksu `zwroty_korekta_numer_zamowienia` —
  // bez niego ostatnia instancja bariery znika, a zaden test przez funkcje tego nie zauwazy.
  it('BAZA broni sie sama — duplikat numeru odbija sie nawet przy zapisie wprost SQL-em', () => {
    const a = dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', pozycje: [] });
    const b = dodajZwrot(db, id, { data: '2026-09-02', kwota: '50.00', pozycje: [] });
    const zapis = db.prepare('UPDATE zwroty SET korekta_numer = ? WHERE id = ?');
    zapis.run('2/KOR/09/2026', a.id);
    expect(() => zapis.run('2/KOR/09/2026', b.id)).toThrow(/UNIQUE|constraint/i);
  });

  // Bariera jest PER ZAMOWIENIE, nie globalna: numeracja korekt w inFakcie jest jedna, ale
  // dwa rozne zamowienia maja rozne faktury — ten sam napis przy obu bylby pomylka czlowieka,
  // a nie duplikatem dokumentu, i baza nie ma prawa tego rozstrzygac.
  it('ten sam numer przy INNYM zamowieniu przechodzi — bariera jest per zamowienie', () => {
    const inne = zapiszZamowienie(db, 'pro', zmapowane({ zrodlo_id: 1302, numer: '1302' }), {});
    const a = dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', pozycje: [] });
    const b = dodajZwrot(db, inne, { data: '2026-08-14', kwota: '99.00', pozycje: [] });
    zapiszRecznyNumerKorekty(db, id, a.id, '2/KOR/09/2026');
    zapiszRecznyNumerKorekty(db, inne, b.id, '2/KOR/09/2026');
    expect(zwrot(db, inne, b.id).korekta_numer).toBe('2/KOR/09/2026');
  });
});

// ⚠️⚠️ K1 + W4 (recenzja kontrolna 2026-08-15). Rezerwacja bronila JEDNEGO WIERSZA, a regula
// „jedna korekta na fakture" liczyla sie POZA transakcja, w usludze. Dwa rownolegle zgloszenia
// na dwa zwroty tego samego zamowienia oba przeczytalyby „nikt inny nie ma korekty" i oba
// zarezerwowalyby wlasny wiersz → duplikat u organu. Wzorem `dodajZwrot` wyzej: sprawdzenie
// i zapis w JEDNYM `BEGIN IMMEDIATE`.
describe('zarezerwujKorekte — granica faktu w SQL-u i regula w transakcji', () => {
  it('K1: nie rezerwuje przy ZAPISANYM RECZNIE numerze — nawet bez rezerwacji', () => {
    const w = dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', pozycje: [] });
    zapiszRecznyNumerKorekty(db, id, w.id, '9/KOR/08/2026');
    expect(zarezerwujKorekte(db, id, w.id)).toBe(false);
    expect(zwrot(db, id, w.id).korekta_zlecona_at).toBeNull();
    expect(zwrot(db, id, w.id).korekta_numer).toBe('9/KOR/08/2026');
  });

  it('W4: regula „jedna korekta na fakture" odmawia WEWNATRZ transakcji rezerwacji', () => {
    const a = dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', pozycje: [] });
    const b = dodajZwrot(db, id, { data: '2026-09-02', kwota: '50.00', pozycje: [] });
    zarezerwujKorekte(db, id, a.id);
    expect(() => zarezerwujKorekte(db, id, b.id)).toThrow(/ręcznie/);
    expect(zwrot(db, id, b.id).korekta_zlecona_at).toBeNull();
  });

  it('W4: odmowa nie zostawia otwartej transakcji — kolejny zapis dziala', () => {
    const a = dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', pozycje: [] });
    const b = dodajZwrot(db, id, { data: '2026-09-02', kwota: '50.00', pozycje: [] });
    zarezerwujKorekte(db, id, a.id);
    expect(() => zarezerwujKorekte(db, id, b.id)).toThrow();
    oznaczPieniadzeOddane(db, id, b.id, '2026-09-03T09:00:00.000Z');
    expect(zwrot(db, id, b.id).pieniadze_oddane_at).toBe('2026-09-03T09:00:00.000Z');
  });

  it('zwolniona rezerwacja (4xx) NIE blokuje korekty dla drugiego zwrotu', () => {
    const a = dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', pozycje: [] });
    const b = dodajZwrot(db, id, { data: '2026-09-02', kwota: '50.00', pozycje: [] });
    zarezerwujKorekte(db, id, a.id);
    zapiszBladKorekty(db, id, a.id, 'inFakt: 422');
    expect(zarezerwujKorekte(db, id, b.id)).toBe(true);
  });
});

// ⚠️ USUNIECIE ZWROTU: warunek MUSI byc w SQL-u, a nie tylko nad nim. `powodOdmowyUsunieciaZwrotu`
// liczy sie w trasie, POZA transakcja — dwie otwarte karty i „pieniądze oddane" kliknięte miedzy
// sprawdzeniem a `DELETE` kasowalo zwrot z JUZ WYPLACONA kwota, a razem z nim jedyny slad, ile
// i kiedy wyszlo do kupujacego.
describe('usunZwrot — bariera faktu w SQL-u, nie tylko w trasie', () => {
  it('ODMAWIA zwrotu z oddanymi pieniedzmi, nawet gdy wolajacy sprawdzil to wczesniej', () => {
    const w = dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', pozycje: [] });
    oznaczPieniadzeOddane(db, id, w.id);
    expect(() => usunZwrot(db, id, w.id)).toThrow();
    expect(zwrotyZamowienia(db, id)).toHaveLength(1);
  });

  it('ODMAWIA zwrotu ze zlecona korekta i zwrotu z zapisanym numerem korekty', () => {
    const a = dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', pozycje: [] });
    zarezerwujKorekte(db, id, a.id);
    expect(() => usunZwrot(db, id, a.id)).toThrow();

    const b = dodajZwrot(db, id, { data: '2026-09-02', kwota: '50.00', pozycje: [] });
    zapiszRecznyNumerKorekty(db, id, b.id, '9/KOR/08/2026');
    expect(() => usunZwrot(db, id, b.id)).toThrow();
    expect(zwrotyZamowienia(db, id)).toHaveLength(2);
  });
});
