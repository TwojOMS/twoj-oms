import { describe, it, expect } from 'vitest';
import { czyPobranieRozliczone, czyPaczkaBezGotowki, dataZaplatyPobrania } from '../../src/domena/pobranie-zaplacone.js';
import { etapPrzesylki } from '../../src/domena/etap-przesylki.js';

const zamPobranie = (nadpisz) => ({ pobranie: 1, wysylka_reczna_json: null, ...nadpisz });
const doreczona = { status_kuriera: 'Przesyłka doręczona', status_kuriera_kod: null, status_kuriera_at: '2026-08-25T14:20:00.000' };

describe('czy pobranie jest rozliczone', () => {
  it('pobranie z doręczoną paczką i fakturą jest rozliczone', () => {
    expect(czyPobranieRozliczone({
      zamowienie: zamPobranie(), przesylka: doreczona, uuidFaktury: 'u-1',
    })).toBe(true);
  });

  // ⚠️⚠️ TO JEST CAŁY SENS TEJ REGUŁY. „Pobranie = opłacone" byłoby fałszem: paczka
  // nieodebrana wraca zwrotem i pieniędzy NIE MA. Rozstrzyga DORĘCZENIE, nie metoda.
  it('zwrot NIE jest zapłatą', () => {
    expect(czyPobranieRozliczone({
      zamowienie: zamPobranie(),
      przesylka: { status_kuriera: 'Zwrot do nadawcy', status_kuriera_kod: null },
      uuidFaktury: 'u-1',
    })).toBe(false);
  });

  it('paczka w drodze nie jest zapłatą', () => {
    expect(czyPobranieRozliczone({
      zamowienie: zamPobranie(),
      przesylka: { status_kuriera: 'Przyjęcie przesyłki w sortowni', status_kuriera_kod: null },
      uuidFaktury: 'u-1',
    })).toBe(false);
  });

  it('brak statusu u kuriera nie jest zapłatą', () => {
    expect(czyPobranieRozliczone({
      zamowienie: zamPobranie(), przesylka: { status_kuriera: null, status_kuriera_kod: null }, uuidFaktury: 'u-1',
    })).toBe(false);
    expect(czyPobranieRozliczone({ zamowienie: zamPobranie(), przesylka: null, uuidFaktury: 'u-1' })).toBe(false);
  });

  it('bez faktury nie ma czego oznaczać', () => {
    expect(czyPobranieRozliczone({ zamowienie: zamPobranie(), przesylka: doreczona, uuidFaktury: null })).toBe(false);
  });

  // ⚠️ Wartość EFEKTYWNA, po ręcznych korektach. Zamówienie przełączone na przedpłatę
  // (klient zapłacił z góry) NIE jest pobraniem — kurier niczego nie inkasował.
  it('pobranie przełączone ręcznie na przedpłatę nie jest pobraniem', () => {
    expect(czyPobranieRozliczone({
      zamowienie: zamPobranie({ wysylka_reczna_json: JSON.stringify({ metoda: 'dpd', pobranie: 0 }) }),
      przesylka: doreczona, uuidFaktury: 'u-1',
    })).toBe(false);
  });

  it('zwykła przesyłka bez pobrania nie jest rozliczana tą drogą', () => {
    expect(czyPobranieRozliczone({
      zamowienie: { pobranie: 0, wysylka_reczna_json: null }, przesylka: doreczona, uuidFaktury: 'u-1',
    })).toBe(false);
  });

  // ⚠️⚠️ POPRAWKA 2 (recenzja 28.08.2026). `etapPrzesylki` łapie „nie doręczono" i
  // „odbiorca nieobecny" na tych samych wzorcach co prawdziwe doręczenie (`doręczon`,
  // `odbiorc`) — nie naprawiamy TAMTEJ funkcji (obsługuje też zakładkę przesyłek i
  // czuwacza), tylko stawiamy własny bezpiecznik w ścieżce pieniędzy.
  describe('bezpiecznik nieudanego doręczenia', () => {
    it('„Nie doręczono — adresat nieobecny" nie jest zapłatą', () => {
      expect(czyPobranieRozliczone({
        zamowienie: zamPobranie(),
        przesylka: { status_kuriera: 'Nie doręczono — adresat nieobecny', status_kuriera_kod: null },
        uuidFaktury: 'u-1',
      })).toBe(false);
    });

    it('„Nieudana próba doręczenia, odbiorca nieobecny" nie jest zapłatą', () => {
      expect(czyPobranieRozliczone({
        zamowienie: zamPobranie(),
        przesylka: { status_kuriera: 'Nieudana próba doręczenia, odbiorca nieobecny', status_kuriera_kod: null },
        uuidFaktury: 'u-1',
      })).toBe(false);
    });

    it('„Awizo pozostawione" nie jest zapłatą', () => {
      expect(czyPobranieRozliczone({
        zamowienie: zamPobranie(),
        przesylka: { status_kuriera: 'Awizo pozostawione', status_kuriera_kod: null },
        uuidFaktury: 'u-1',
      })).toBe(false);
    });

    // Bezpiecznik nie może zjeść poprawnego przypadku — „Przesyłka doręczona" dalej płaci.
    it('„Przesyłka doręczona" dalej jest zapłatą — bezpiecznik nie łapie prawdziwego doręczenia', () => {
      expect(czyPobranieRozliczone({
        zamowienie: zamPobranie(), przesylka: doreczona, uuidFaktury: 'u-1',
      })).toBe(true);
    });

    // Kod maszynowy Allegro rozstrzyga i opis go nie rusza — nawet gdy opis brzmi jak
    // nieudane doręczenie (np. dołączony po polsku obok kodu, który jednak mówi co innego).
    it('kod DELIVERED rozstrzyga mimo opisu brzmiącego jak nieudane doręczenie', () => {
      expect(czyPobranieRozliczone({
        zamowienie: zamPobranie(),
        przesylka: { status_kuriera: 'Nieudana próba doręczenia', status_kuriera_kod: 'DELIVERED' },
        uuidFaktury: 'u-1',
      })).toBe(true);
    });
  });
});

// ⚠️⚠️ JEDNA REGUŁA, DWÓCH CZYTELNIKÓW (recenzja poprawkowa 28.08.2026, W4). Pas długów
// (services/faktury-widok.js) pytał wyłącznie `etapPrzesylki(...) === 'zwrot'`, więc paczka
// z nieudanym doręczeniem — etap `doreczona` — znikała z listy „kto nam zalega" NA STAŁE:
// czuwacz przesyłek przestaje odpytywać doręczone, a pas jej nie pokazywał. Ta funkcja jest
// tą samą bramką, z której korzysta ścieżka pieniędzy; test pilnuje, że odpowiada na OBA
// przypadki i że nie zjada prawdziwego doręczenia.
describe('czy przy paczce nie ma gotówki', () => {
  it('zwrot to brak gotówki', () => {
    expect(czyPaczkaBezGotowki({ status_kuriera: 'Zwrot do nadawcy', status_kuriera_kod: null })).toBe(true);
  });

  it('nieudane doręczenie to brak gotówki, choć etap mówi „doreczona"', () => {
    expect(etapPrzesylki('Nie doręczono — adresat nieobecny', null)).toBe('doreczona');
    expect(czyPaczkaBezGotowki({ status_kuriera: 'Nie doręczono — adresat nieobecny', status_kuriera_kod: null })).toBe(true);
    expect(czyPaczkaBezGotowki({ status_kuriera: 'Awizo pozostawione', status_kuriera_kod: null })).toBe(true);
  });

  it('prawdziwe doręczenie to NIE jest brak gotówki', () => {
    expect(czyPaczkaBezGotowki(doreczona)).toBe(false);
  });

  // ⚠️ „W drodze" to NIE jest ta odpowiedź: gotówki jeszcze nie ma, ale BĘDZIE — i właśnie
  // dlatego pas długów takiego dokumentu nie pokazuje.
  it('paczka w drodze i paczka bez statusu to NIE jest brak gotówki', () => {
    expect(czyPaczkaBezGotowki({ status_kuriera: 'Przyjęcie przesyłki w sortowni', status_kuriera_kod: null })).toBe(false);
    expect(czyPaczkaBezGotowki({ status_kuriera: null, status_kuriera_kod: null })).toBe(false);
    expect(czyPaczkaBezGotowki(null)).toBe(false);
  });

  it('kod DELIVERED rozstrzyga mimo opisu brzmiącego jak nieudane doręczenie', () => {
    expect(czyPaczkaBezGotowki({ status_kuriera: 'Nieudana próba doręczenia', status_kuriera_kod: 'DELIVERED' })).toBe(false);
  });
});

describe('data zapłaty pobrania', () => {
  it('bierze dzień doręczenia u kuriera', () => {
    expect(dataZaplatyPobrania(doreczona, '2026-08-20')).toBe('2026-08-25');
  });

  // ⚠️ inFakt odrzuca `paid_date` wcześniejszą niż data wystawienia — ta sama bramka,
  // co w `dataZaplatyDoOznaczenia` (services/faktura.js).
  it('nigdy nie schodzi poniżej daty wystawienia', () => {
    expect(dataZaplatyPobrania(doreczona, '2026-08-27')).toBe('2026-08-27');
  });

  // ⚠️ `status_kuriera_at` bywa PUSTA — zapisywana jako `at ?? null`, a kurier nie zawsze
  // oddaje czas zdarzenia. Brak daty NIE JEST powodem do odmowy oznaczenia: to krok po
  // fakcie, więc spadamy na datę wystawienia, która zawsze spełnia warunek inFaktu.
  it('brak czasu zdarzenia spada na datę wystawienia, a nie odmawia', () => {
    expect(dataZaplatyPobrania({ status_kuriera_at: null }, '2026-08-20')).toBe('2026-08-20');
    expect(dataZaplatyPobrania({ status_kuriera_at: 'bzdura' }, '2026-08-20')).toBe('2026-08-20');
    expect(dataZaplatyPobrania(null, '2026-08-20')).toBe('2026-08-20');
  });

  // ⚠️⚠️ POPRAWKA 1 (recenzja 28.08.2026). `invoiceDate === null` (osiągalne z odpowiedzi
  // inFaktu: `dane?.invoice_date ?? null`) szło dawniej przez `dzien > null` → `NaN > 0` →
  // `false`, więc funkcja PO CICHU oddawała `null`, mimo że dzień doręczenia był znany.
  describe('invoiceDate nie jest poprawną datą, ale dzień doręczenia JEST znany', () => {
    it('invoiceDate: null → zwraca dzień doręczenia, NIE null', () => {
      expect(dataZaplatyPobrania(doreczona, null)).toBe('2026-08-25');
    });

    it('invoiceDate: undefined → zwraca dzień doręczenia', () => {
      expect(dataZaplatyPobrania(doreczona, undefined)).toBe('2026-08-25');
    });

    it('invoiceDate: „bzdura" → zwraca dzień doręczenia', () => {
      expect(dataZaplatyPobrania(doreczona, 'bzdura')).toBe('2026-08-25');
    });
  });

  // Jedyny przypadek, w którym wolno odmówić: nie znamy ANI dnia doręczenia, ANI poprawnej
  // invoiceDate. Zmyślona data w dokumencie księgowym jest gorsza niż brak oznaczenia.
  it('brak stempla kuriera i invoiceDate: null → zwraca null (nie ma żadnej daty)', () => {
    expect(dataZaplatyPobrania({ status_kuriera_at: null }, null)).toBe(null);
    expect(dataZaplatyPobrania(null, null)).toBe(null);
  });

  // Ten sam przypadek co wyżej, ale invoiceDate NIE jest `null` — jest napisem, tylko
  // niepoprawnym. Odróżnia to od mutacji „zwróć invoiceDate zamiast null": przy
  // invoiceDate === null taka mutacja przypadkiem daje ten sam wynik (null), więc dowód
  // wymaga wartości innej niż null po obu stronach.
  it('brak stempla kuriera i invoiceDate: „bzdura" → zwraca null, nie „bzdura"', () => {
    expect(dataZaplatyPobrania({ status_kuriera_at: null }, 'bzdura')).toBe(null);
  });

  it('oba poprawne, doręczenie wcześniejsze → zwraca invoiceDate (późniejsza z dwóch)', () => {
    expect(dataZaplatyPobrania(doreczona, '2026-08-27')).toBe('2026-08-27');
  });
});
