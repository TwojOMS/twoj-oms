// PRZ-108.07 (zmiana B planu automatyzacji, właściciel 21.10): czyste reguły automatyzacji — walidacja formularza reguły,
// biała lista kanałów, zgodność szablonu ze zdarzeniem, granica, kursor z zakładką, przeterminowanie od terminu,
// klasyfikacja błędu poczty. Silnik i trasy: tests/moduly/automatyzacje/.
import { describe, it, expect } from 'vitest';
import {
  sprawdzRegule, czyPasujeKanalom, zgodnoscSzablonu, nowaGranica, klasyfikujBladPoczty, noweKanalyOdZapisu,
  odKursora, terminWykonania, czyPrzeterminowane, zmianaPrzesuwaGranice, KATALOG_ZDARZEN,
  OPOZNIENIE_MAX_MIN, BEZPIECZNIK_NARAZ, LIMIT_OMS_NA_GODZINE, PRZETERMINOWANIE_H,
} from '../../src/domena/automatyzacje.js';

const KANALY = [{ klucz: 'sklep', etykieta: 'Sklep' }, { klucz: 'allegro', etykieta: 'Allegro' },
  { klucz: 'reczne', etykieta: 'ręczne' }, { klucz: 'indywidualne', etykieta: 'Indywidualne' }];
const KONTEKST = {
  kanaly: KANALY,
  zdarzenia: [{ klucz: 'status_zmieniony' }, { klucz: 'test_zdarzenie' }],
  akcje: [{ klucz: 'mail_kupujacy', szablon: true }],
  szablony: ['potwierdzenie', 'proforma', 'faktura', 'przypomnienie', 'wyslane', 'wlasny-3'],
};
const DOBRY = { nazwa: 'Wysłane — sklep', zdarzenie: 'status_zmieniony', kanaly: ['sklep'], opoznienie: '30',
  limit: '20', akcja: 'mail_kupujacy', szablon: 'wyslane' };

describe('sprawdzRegule', () => {
  it('poprawny formularz → reguła z białą listą kanałów i migawką kanałów znanych w chwili zapisu', () => {
    const w = sprawdzRegule(DOBRY, KONTEKST);
    expect(w.ok).toBe(true);
    expect(w.regula).toEqual({
      nazwa: 'Wysłane — sklep', zdarzenie: 'status_zmieniony', zdarzenie_json: {},
      // C1: warunki w chwili wykonania; szablon „Zamówienie wysłane” wymusza „ma numer listu”.
      warunki: { kanaly: ['sklep'], kanalyZnane: ['sklep', 'allegro', 'reczne', 'indywidualne'], statusy: [],
        maNumerListu: true, metody: [], pobranie: 'dowolne' },
      akcja: 'mail_kupujacy', akcja_json: { szablon: 'wyslane' }, opoznienie_min: 30, limit_na_godzine: 20,
    });
  });
  it('jeden kanał przychodzi z formularza jako tekst, nie tablica', () => {
    expect(sprawdzRegule({ ...DOBRY, kanaly: 'allegro' }, KONTEKST).regula.warunki.kanaly).toEqual(['allegro']);
  });
  it('0 kanałów → „Zaznacz co najmniej jeden kanał”', () => {
    for (const kanaly of [undefined, [], '']) {
      const w = sprawdzRegule({ ...DOBRY, kanaly }, KONTEKST);
      expect(w.ok).toBe(false);
      expect(w.bledy.join(' ')).toContain('Zaznacz co najmniej jeden kanał');
    }
  });
  it('kanał spoza konfiguracji → błąd', () => {
    expect(sprawdzRegule({ ...DOBRY, kanaly: ['obcy'] }, KONTEKST).ok).toBe(false);
  });
  it.each(['-1', '10081', 'abc', '1.5', '30 min'])('opóźnienie %s → błąd', (opoznienie) => {
    const w = sprawdzRegule({ ...DOBRY, opoznienie }, KONTEKST);
    expect(w.ok).toBe(false);
    expect(w.bledy.join(' ')).toContain('Opóźnienie');
  });
  it('opóźnienie 0, 10 080 (7 dni) i puste (= 0) przechodzą', () => {
    expect(sprawdzRegule({ ...DOBRY, opoznienie: '0' }, KONTEKST).regula.opoznienie_min).toBe(0);
    expect(sprawdzRegule({ ...DOBRY, opoznienie: '10080' }, KONTEKST).regula.opoznienie_min).toBe(OPOZNIENIE_MAX_MIN);
    expect(sprawdzRegule({ ...DOBRY, opoznienie: '' }, KONTEKST).regula.opoznienie_min).toBe(0);
  });
  it.each(['0', '201', 'x'])('limit %s → błąd; puste → 20', (limit) => {
    expect(sprawdzRegule({ ...DOBRY, limit }, KONTEKST).ok).toBe(false);
    expect(sprawdzRegule({ ...DOBRY, limit: '' }, KONTEKST).regula.limit_na_godzine).toBe(20);
  });
  it('nazwa pusta albo dłuższa niż 60 znaków → błąd', () => {
    expect(sprawdzRegule({ ...DOBRY, nazwa: '  ' }, KONTEKST).ok).toBe(false);
    expect(sprawdzRegule({ ...DOBRY, nazwa: 'x'.repeat(61) }, KONTEKST).ok).toBe(false);
    expect(sprawdzRegule({ ...DOBRY, nazwa: 'x'.repeat(60) }, KONTEKST).ok).toBe(true);
  });
  it('zdarzenie spoza rejestru (np. jeszcze nienapisane) → błąd', () => {
    const w = sprawdzRegule({ ...DOBRY, zdarzenie: 'paczka_doreczona' }, KONTEKST);
    expect(w.ok).toBe(false);
    expect(w.bledy.join(' ')).toContain('niedostępne');
  });
  it('akcja spoza rejestru → błąd', () => {
    expect(sprawdzRegule({ ...DOBRY, akcja: 'zmien_status' }, KONTEKST).ok).toBe(false);
  });
  it('szablon niezgodny ze zdarzeniem (proforma przy zmianie statusu) → błąd; własny pasuje do każdego', () => {
    const w = sprawdzRegule({ ...DOBRY, szablon: 'proforma' }, KONTEKST);
    expect(w.ok).toBe(false);
    expect(w.bledy.join(' ')).toContain('nie pasuje');
    expect(sprawdzRegule({ ...DOBRY, szablon: 'wlasny-3' }, KONTEKST).ok).toBe(true);
    expect(sprawdzRegule({ ...DOBRY, szablon: 'wlasny-9' }, KONTEKST).ok).toBe(false); // usunięty / nieistniejący
    expect(sprawdzRegule({ ...DOBRY, szablon: '' }, KONTEKST).ok).toBe(false);
  });
});

describe('zgodnoscSzablonu', () => {
  it('tabela z planu (sekcja 4)', () => {
    for (const z of ['paczka_nadana', 'paczka_odebrana', 'paczka_doreczona', 'status_zmieniony']) {
      expect(zgodnoscSzablonu(z, 'wyslane')).toBe(true);
      expect(zgodnoscSzablonu(z, 'proforma')).toBe(false);
    }
    expect(zgodnoscSzablonu('zamowienie_nowe', 'potwierdzenie')).toBe(true);
    expect(zgodnoscSzablonu('proforma_wystawiona', 'proforma')).toBe(true);
    expect(zgodnoscSzablonu('faktura_wystawiona', 'faktura')).toBe(true);
    for (const z of KATALOG_ZDARZEN.map((k) => k.klucz)) expect(zgodnoscSzablonu(z, 'przypomnienie')).toBe(false);
    expect(zgodnoscSzablonu('test_zdarzenie', 'wlasny-1')).toBe(true);
    expect(zgodnoscSzablonu('test_zdarzenie', 'wyslane')).toBe(false);
    expect(zgodnoscSzablonu('status_zmieniony', 'zaproszenie')).toBe(false);
  });
});

describe('czyPasujeKanalom — biała lista', () => {
  const warunki = { kanaly: ['sklep', 'reczne'], kanalyZnane: ['sklep', 'allegro', 'reczne', 'indywidualne'] };
  it('zaznaczony → tak; odznaczony → nie; kanał dodany później (nieznany przy zapisie) → nie', () => {
    expect(czyPasujeKanalom('sklep', warunki)).toBe(true);
    expect(czyPasujeKanalom('allegro', warunki)).toBe(false);
    expect(czyPasujeKanalom('nowy-sklep', warunki)).toBe(false);
    expect(czyPasujeKanalom(undefined, warunki)).toBe(false);
    expect(czyPasujeKanalom('sklep', {})).toBe(false);
  });
});

describe('noweKanalyOdZapisu', () => {
  it('nowe = w konfiguracji, a nieznane przy zapisie; usunięte = zaznaczone, a nie ma w konfiguracji', () => {
    const warunki = { kanaly: ['a', 'stary'], kanalyZnane: ['a', 'b', 'stary'] };
    expect(noweKanalyOdZapisu(warunki, [{ klucz: 'a' }, { klucz: 'b' }, { klucz: 'c' }]))
      .toEqual({ nowe: ['c'], usuniete: ['stary'] });
  });
});

describe('granica, kursor, termin', () => {
  it('nowaGranica: chwila włączenia i migawka MAX(id)', () => {
    const g = nowaGranica(new Date('2026-10-21T10:00:00.000Z'), { zamowienia: 7, przesylki: null });
    expect(g).toEqual({ granica_at: '2026-10-21T10:00:00.000Z', granica_json: { zamowienia: 7, przesylki: 0 } });
  });
  it('odKursora: bez kursora od granicy; z kursorem od kursora − 5 min, ale nigdy sprzed granicy', () => {
    expect(odKursora({ granica_at: '2026-10-21T10:00:00.000Z', kursor_json: null })).toBe('2026-10-21T10:00:00.000Z');
    expect(odKursora({ granica_at: '2026-10-21T10:00:00.000Z', kursor_json: '{"at":"2026-10-21T12:00:00.000Z"}' }))
      .toBe('2026-10-21T11:55:00.000Z');
    expect(odKursora({ granica_at: '2026-10-21T10:00:00.000Z', kursor_json: '{"at":"2026-10-21T10:02:00.000Z"}' }))
      .toBe('2026-10-21T10:00:00.000Z');
  });
  it('terminWykonania = zdarzenie + opóźnienie', () => {
    expect(terminWykonania('2026-10-21T10:00:00.000Z', 30)).toBe('2026-10-21T10:30:00.000Z');
    expect(terminWykonania('2026-10-21T10:00:00.000Z', 10080)).toBe('2026-10-28T10:00:00.000Z');
  });
  it(`przeterminowane: więcej niż ${PRZETERMINOWANIE_H} h po terminie`, () => {
    const termin = '2026-10-21T10:00:00.000Z';
    expect(czyPrzeterminowane(termin, new Date('2026-10-23T10:00:00.000Z'))).toBe(false);
    expect(czyPrzeterminowane(termin, new Date('2026-10-23T10:00:01.000Z'))).toBe(true);
  });
  it('stałe bezpieczników z decyzji 21.10', () => {
    expect([BEZPIECZNIK_NARAZ, LIMIT_OMS_NA_GODZINE, PRZETERMINOWANIE_H, OPOZNIENIE_MAX_MIN]).toEqual([50, 100, 48, 10080]);
  });
  it('zmiana zdarzenia albo warunków przesuwa granicę; nazwy, szablonu, limitu i opóźnienia — nie', () => {
    const r = { zdarzenie: 'a', zdarzenie_json: {}, warunki: { kanaly: ['x'], kanalyZnane: ['x', 'y'] }, nazwa: 'n',
      akcja_json: { szablon: 'wyslane' }, limit_na_godzine: 20, opoznienie_min: 0 };
    expect(zmianaPrzesuwaGranice(r, { ...r, nazwa: 'inna', limit_na_godzine: 5, opoznienie_min: 30,
      akcja_json: { szablon: 'wlasny-1' } })).toBe(false);
    expect(zmianaPrzesuwaGranice(r, { ...r, warunki: { ...r.warunki, kanaly: ['x', 'y'] } })).toBe(true);
    expect(zmianaPrzesuwaGranice(r, { ...r, zdarzenie: 'b' })).toBe(true);
    expect(zmianaPrzesuwaGranice(r, { ...r, zdarzenie_json: { status: 'wyslane' } })).toBe(true);
    // Sama migawka kanałów znanych (nowy kanał w konfiguracji) nie rozszerza reguły.
    expect(zmianaPrzesuwaGranice(r, { ...r, warunki: { ...r.warunki, kanalyZnane: ['x', 'y', 'z'] } })).toBe(false);
  });
});

describe('klasyfikujBladPoczty', () => {
  // Recenzja 07, usterka 1: ECONNECTION nodemailer daje też po DATA (serwer ma treść) → nie ponawiać.
  it('na pewno przed MAIL FROM (EDNS, ETLS, EAUTH) → ponow; reszta, także ECONNECTION → niepewne', () => {
    for (const code of ['EDNS', 'ETLS', 'EAUTH']) expect(klasyfikujBladPoczty(Object.assign(new Error('x'), { code }))).toBe('ponow');
    for (const code of ['ECONNECTION', 'ESOCKET', 'ETIMEDOUT', 'EMESSAGE', 'EENVELOPE', undefined]) expect(klasyfikujBladPoczty(Object.assign(new Error('x'), { code }))).toBe('niepewne');
    expect(klasyfikujBladPoczty(null)).toBe('niepewne');
  });
});

// PRZ-108.08 (zmiana C1): parametr zdarzenia „status zmienił się na …” i warunki w chwili wykonania w formularzu reguły.
describe('sprawdzRegule — C1: status zdarzenia i warunki', () => {
  const C1 = { ...KONTEKST, statusy: ['nowe', 'w_realizacji', 'wyslane', 'zwrot', 'anulowane', 'w_klosz'],
    zdarzenia: [{ klucz: 'status_zmieniony', opcje: ['wyslane', 'w_realizacji', 'w_klosz'] }, { klucz: 'paczka_nadana' }] };
  const FORM = { ...DOBRY, zdarzenie_status: 'wyslane', status_warunek: 'jeden_z', statusy: ['wyslane'], ma_numer_listu: ['0', '1'],
    dostawa: '', pobranie: 'dowolne' };
  it('przypadek właściciela: status → Wysłane, warunki kanał + status Wysłane + numer listu, opóźnienie 30', () => {
    const w = sprawdzRegule(FORM, C1);
    expect(w.ok).toBe(true);
    expect(w.regula.zdarzenie_json).toEqual({ status: 'wyslane' });
    expect(w.regula.warunki).toEqual({ kanaly: ['sklep'], kanalyZnane: ['sklep', 'allegro', 'reczne', 'indywidualne'],
      statusy: ['wyslane'], maNumerListu: true, metody: [], pobranie: 'dowolne' });
    expect(w.regula.opoznienie_min).toBe(30);
  });
  it('status zdarzenia: brak albo spoza listy (Nowe, Anulowane, usunięty własny) → błąd', () => {
    for (const zdarzenie_status of [undefined, '', 'nowe', 'anulowane', 'w_usuniety']) {
      const w = sprawdzRegule({ ...FORM, zdarzenie_status }, C1);
      expect(w.ok, String(zdarzenie_status)).toBe(false);
      expect(w.bledy.join(' ')).toContain('status');
    }
    expect(sprawdzRegule({ ...FORM, zdarzenie_status: 'w_klosz', statusy: ['w_klosz'] }, C1).regula.zdarzenie_json).toEqual({ status: 'w_klosz' });
  });
  it('zdarzenie bez parametru (paczka nadana) → zdarzenie_json pusty, status z formularza pomijany', () => {
    expect(sprawdzRegule({ ...FORM, zdarzenie: 'paczka_nadana' }, C1).regula.zdarzenie_json).toEqual({});
  });
  it('„status jest dowolny” → pusta lista; „jednym z” bez zaznaczenia → błąd; status spoza konfiguracji → błąd', () => {
    expect(sprawdzRegule({ ...FORM, status_warunek: 'dowolny' }, C1).regula.warunki.statusy).toEqual([]);
    expect(sprawdzRegule({ ...FORM, statusy: [] }, C1).ok).toBe(false);
    expect(sprawdzRegule({ ...FORM, statusy: ['wyslane', 'obcy'] }, C1).ok).toBe(false);
    expect(sprawdzRegule({ ...FORM, statusy: 'zwrot' }, C1).regula.warunki.statusy).toEqual(['zwrot']);
  });
  it('szablon „Zamówienie wysłane” WYMUSZA „ma numer listu”: brak pola → wymuszony; jawne „nie” → błąd', () => {
    const { ma_numer_listu: _pomin, ...bezPola } = FORM;
    expect(sprawdzRegule(bezPola, C1).regula.warunki.maNumerListu).toBe(true);
    const nie = sprawdzRegule({ ...FORM, ma_numer_listu: '0' }, C1);
    expect(nie.ok).toBe(false);
    expect(nie.bledy.join(' ')).toContain('„Zamówienie wysłane” wymaga warunku');
    // szablon własny: warunek opcjonalny
    expect(sprawdzRegule({ ...FORM, szablon: 'wlasny-3', ma_numer_listu: '0' }, C1).regula.warunki.maNumerListu).toBe(false);
    expect(sprawdzRegule({ ...FORM, szablon: 'wlasny-3', ma_numer_listu: ['0', '1'] }, C1).regula.warunki.maNumerListu).toBe(true);
  });
  it('dostawa i pobranie: z listy albo błąd', () => {
    expect(sprawdzRegule({ ...FORM, dostawa: 'dpd' }, C1).regula.warunki.metody).toEqual(['dpd']);
    expect(sprawdzRegule({ ...FORM, dostawa: 'teleport' }, C1).ok).toBe(false);
    expect(sprawdzRegule({ ...FORM, pobranie: 'tak' }, C1).regula.warunki.pobranie).toBe('tak');
    expect(sprawdzRegule({ ...FORM, pobranie: 'może' }, C1).ok).toBe(false);
  });
  it.each(['-1', '10081', 'abc'])('opóźnienie %s → błąd (kreator, test 9)', (opoznienie) => {
    expect(sprawdzRegule({ ...FORM, opoznienie }, C1).ok).toBe(false);
  });
});
