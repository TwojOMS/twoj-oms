import { describe, it, expect } from 'vitest';
import {
  podzielDoFaktury, powodZaDuzejPartii, SUFIT_FAKTUR_HURTEM,
  powodZaDuzegoDruku, SUFIT_SPECYFIKACJI_DRUKU,
} from '../../../src/domena/masowe.js';

// ⚠️ FIXTURE MA POZYCJE SUMUJACA SIE DO KWOTY ZAMOWIENIA — od 12.08.2026 (recenzja).
// Do tego dnia stalo tu `pozycje: []` przy `kwota_brutto: '100.00'`, czyli zamowienie
// ARYTMETYCZNIE NIEMOZLIWE: taki wiersz nie przeszedlby przez bariere w `wystaw()` nigdy.
// Wszystkie testy podzialu chodzily wiec po danych, ktorych panel w zyciu nie zobaczy —
// a szosta bariera (`powodRozjazduDokumentu`) nie miala jak istniec, bo kazdy fixture by
// od niej odpadl. To ta sama pulapka, co przy testach PDF-a z jedna pozycja: dane testowe
// nie siegaly tam, gdzie mieszkal blad.
const POZYCJA = {
  nazwa: 'STOP 70x100', sku: 'STOP-70', ilosc: 1, cena_brutto: '100.00', brutto_linii: '100.00',
};
const zam = (n) => ({
  id: 1, numer: '3001', utworzone_at: '2026-08-05T10:00:00.000Z',
  okres_rozliczeniowy_id: null, anulowane: 0, chce_fakture: 1, nip: '1234563218',
  kwota_brutto: '100.00', pozycje: [POZYCJA], platnosci: [{ kwota: '100.00' }], faktura: null, ...n,
});

describe('podzial zaznaczenia do faktur hurtem', () => {
  it('przepuszcza oplacone i pomija nieoplacone Z POWODEM', () => {
    const { doWystawienia, pominiete } = podzielDoFaktury([
      zam({ id: 1, numer: 'A' }),
      zam({ id: 2, numer: 'B', platnosci: [] }),
    ]);
    expect(doWystawienia.map((z) => z.numer)).toEqual(['A']);
    expect(pominiete).toEqual([{ id: 2, numer: 'B', powod: expect.stringMatching(/wpłat/i) }]);
  });

  // ⚠️ To jest wymaganie wlasciciela, nie kosmetyka: numery faktur sa kolejne, wiec kolejnosc
  // wystawiania przeklada sie na numeracje.
  it('ustawia od NAJSTARSZEGO do najnowszego, niezaleznie od kolejnosci zaznaczenia', () => {
    const { doWystawienia } = podzielDoFaktury([
      zam({ id: 3, numer: 'C', utworzone_at: '2026-08-07T10:00:00.000Z' }),
      zam({ id: 1, numer: 'A', utworzone_at: '2026-08-05T10:00:00.000Z' }),
      zam({ id: 2, numer: 'B', utworzone_at: '2026-08-06T10:00:00.000Z' }),
    ]);
    expect(doWystawienia.map((z) => z.numer)).toEqual(['A', 'B', 'C']);
  });

  it('przy rownym stemplu rozstrzyga id rosnaco', () => {
    const { doWystawienia } = podzielDoFaktury([
      zam({ id: 9, numer: 'X' }), zam({ id: 4, numer: 'Y' }),
    ]);
    expect(doWystawienia.map((z) => z.numer)).toEqual(['Y', 'X']);
  });

  it('pomija zamowienie, ktore ma juz fakture', () => {
    const { doWystawienia, pominiete } = podzielDoFaktury([
      zam({ id: 1, numer: 'A', faktura: { numer: '1/08/2026', uuid: 'u1' } }),
    ]);
    expect(doWystawienia).toEqual([]);
    expect(pominiete[0].powod).toMatch(/fakturę|wystawian/i);
  });

  it('nie wywraca sie na pustce', () => {
    expect(podzielDoFaktury(null)).toEqual({ doWystawienia: [], pominiete: [] });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // BARIERA ARYTMETYCZNA — szosta bariera, dolozona 12.08.2026 (recenzja koncowa).
  //
  // ⚠️ CO DOKLADNIE PSULO SIE BEZ NIEJ: zamowienie z rozjechana suma stawalo na ekranie
  // podgladu w sekcji „Pójdzie do inFaktu", operator je zatwierdzal, a ono ladowalo w „Nie
  // udało się". Zaden dokument nie powstawal (bariera w services/faktura.js dziala), ale
  // PODGLAD OBIECYWAL COS, CZEGO TRASA NA PEWNO NIE ZROBI — czyli dokladnie ten rozjazd
  // miedzy ekranem a wykonaniem, ktory ta galaz miala zlikwidowac.
  // ─────────────────────────────────────────────────────────────────────────────
  describe('bariera arytmetyczna', () => {
    // ⚠️ DWIE POZYCJE, nie jedna, i tu jest cala roznica: przy jednej pozycji „suma pozycji"
    // i „wartosc pozycji" to ta sama liczba, wiec fixture nigdy nie dotyka sumowania. Tutaj
    // pierwsza jest poprawna, a druga psuje sume — czyli blad siedzi w miejscu, ktorego
    // jednopozycyjny fixture w ogole nie odwiedza.
    it('pomija zamowienie, w ktorym pozycje nie sumuja sie do kwoty zamowienia', () => {
      const zle = zam({
        id: 2,
        numer: 'B',
        kwota_brutto: '150.00',
        pozycje: [
          { nazwa: 'A', ilosc: 1, cena_brutto: '100.00', brutto_linii: '100.00' },
          { nazwa: 'B', ilosc: 1, cena_brutto: '40.00', brutto_linii: '40.00' },
        ],
        platnosci: [{ kwota: '150.00' }],
      });
      const { doWystawienia, pominiete } = podzielDoFaktury([zam({ id: 1, numer: 'A' }), zle]);
      expect(doWystawienia.map((z) => z.numer)).toEqual(['A']);
      expect(pominiete).toHaveLength(1);
      expect(pominiete[0].numer).toBe('B');
      // Powod ma podac OBIE liczby — inaczej operator wie tylko, ze „cos nie gra".
      expect(pominiete[0].powod).toContain('140.00');
      expect(pominiete[0].powod).toContain('150.00');
    });

    // Lustro powyzszego: dwie pozycje, ktore sumuja sie POPRAWNIE, maja przejsc. Bez tego
    // testu bariera zbyt ostra (np. porownujaca kwote z PIERWSZA pozycja) przechodzilaby
    // niezauwazona — test wyzej sam w sobie nie odroznia „bariera dziala" od „bariera odrzuca
    // wszystko, co ma wiecej niz jedna pozycje".
    it('dwie pozycje sumujace sie poprawnie przechodza', () => {
      const dobre = zam({
        kwota_brutto: '150.00',
        pozycje: [
          { nazwa: 'A', ilosc: 1, cena_brutto: '100.00', brutto_linii: '100.00' },
          { nazwa: 'B', ilosc: 1, cena_brutto: '50.00', brutto_linii: '50.00' },
        ],
        platnosci: [{ kwota: '150.00' }],
      });
      const { doWystawienia, pominiete } = podzielDoFaktury([dobre]);
      expect(doWystawienia).toHaveLength(1);
      expect(pominiete).toEqual([]);
    });

    it('zamowienie bez ani jednej pozycji, przy niezerowej kwocie, wypada z powodem', () => {
      const { doWystawienia, pominiete } = podzielDoFaktury([zam({ pozycje: [] })]);
      expect(doWystawienia).toEqual([]);
      expect(pominiete[0].powod).toMatch(/sumują się|pozycji/i);
    });

    // ⚠️ JEDYNA DZIURA W SAMYM SUMOWANIU, i dlatego pytamy o nia osobno: zamowienie na 0,00 zl
    // bez pozycji sumuje sie POPRAWNIE (0 = 0), wiec `podsumowaniePozycji` mowi „zgadza sie",
    // a `sprawdzSumeDokumentu` w `wystaw()` mimo to odmawia — faktura bez pozycji to realny
    // blad w inFakcie. Bez tego czlonu podglad znow obiecywalby cos, czego trasa nie zrobi.
    it('zamowienie na 0,00 zl bez pozycji sumuje sie poprawnie, a mimo to wypada — bo dokument bylby pusty', () => {
      const puste = zam({
        kwota_brutto: '0.00', pozycje: [], platnosci: [{ kwota: '0.00' }],
      });
      const { doWystawienia, pominiete } = podzielDoFaktury([puste]);
      expect(doWystawienia).toEqual([]);
      expect(pominiete[0].powod).toMatch(/nie ma żadnej pozycji/i);
    });

    // Kolejnosc powodow jest czescia reguly: zamowienie ANULOWANE z rozjechana suma ma
    // dostac powod o anulowaniu, a nie o arytmetyce — inaczej podglad kazalby operatorowi
    // poprawiac pozycje zamowienia, ktorego i tak nie wolno fakturowac.
    it('anulowanie wygrywa nad rozjazdem sumy', () => {
      const { pominiete } = podzielDoFaktury([zam({ anulowane: 1, pozycje: [] })]);
      expect(pominiete[0].powod).toMatch(/anulowan/i);
    });
  });
});

describe('sufit partii', () => {
  it('milczy przy partii w sam raz', () => {
    expect(powodZaDuzejPartii(SUFIT_FAKTUR_HURTEM)).toBeNull();
  });

  // ⚠️ ODMOWA, NIE CICHE PRZYCIECIE. Wziecie pierwszych N z zaznaczenia wygladaloby na ekranie
  // dokladnie tak samo jak komplet — a to jest ekran o dokumentach ksiegowych.
  it('odmawia partii ponad sufit i podaje obie liczby', () => {
    const powod = powodZaDuzejPartii(SUFIT_FAKTUR_HURTEM + 1);
    expect(powod).toContain(String(SUFIT_FAKTUR_HURTEM + 1));
    expect(powod).toContain(String(SUFIT_FAKTUR_HURTEM));
  });

  // ⚠️ Trasa (web/routes/zamowienia.js) woła `powodZaDuzejPartii(doWystawienia.length)` —
  // liczbą PO odsianiu pominiętych, NIE liczbą zaznaczonych na liście. Do 12.08.2026 zdanie
  // brzmiało „Zaznaczono N zamówień" z tą właśnie liczbą, co przy jakimkolwiek pominięciu
  // było nieprawdą (40 zaznaczonych, 14 pominiętych → ekran kłamał „Zaznaczono 26"). Zdanie
  // ma mówić o tym, co KWALIFIKUJE SIĘ do wystawienia — to jest jedyne, co ta liczba
  // faktycznie znaczy.
  it('nie udaje, że podana liczba to liczba zaznaczonych — to liczba kwalifikujących się', () => {
    const powod = powodZaDuzejPartii(SUFIT_FAKTUR_HURTEM + 1);
    expect(powod).not.toMatch(/Zaznaczono/);
    expect(powod).toMatch(/kwalifikuje się/);
  });
});

// Sufit partii DRUKU specyfikacji — dołożony 12.08.2026 (recenzja). Uzasadnienie, dlaczego
// w ogóle istnieje mimo tego, że rysowanie jest lokalne, stoi przy stałej w domain/masowe.js:
// lista nie ma stronicowania, „zaznacz wszystkie" zaznacza całą bazę, a rysowanie jest
// synchroniczne — czyli jedno pomyłkowe kliknięcie zatrzymuje panel dla wszystkich.
describe('sufit partii druku specyfikacji', () => {
  it('milczy dokładnie na granicy', () => {
    expect(powodZaDuzegoDruku(SUFIT_SPECYFIKACJI_DRUKU)).toBeNull();
  });

  it('odmawia o jeden ponad sufit i podaje obie liczby', () => {
    const powod = powodZaDuzegoDruku(SUFIT_SPECYFIKACJI_DRUKU + 1);
    expect(powod).toContain(String(SUFIT_SPECYFIKACJI_DRUKU + 1));
    expect(powod).toContain(String(SUFIT_SPECYFIKACJI_DRUKU));
    // ODMOWA, nie ciche przycięcie — zdanie ma to powiedzieć wprost.
    expect(powod).toMatch(/Nie wydrukowano niczego/);
  });

  // ⚠️ OSOBNA STAŁA, WYŻSZA NIŻ przy fakturach — i to jest decyzja, nie przeoczenie:
  // to nakład drukarki, a nie dokumenty księgowe. Gdyby ktoś kiedyś „uprościł" moduł,
  // podpinając druk pod SUFIT_FAKTUR_HURTEM, pakowacz zacząłby dzielić dzień wysyłkowy
  // na porcje po 25 kartek bez powodu.
  it('sufit druku jest wyższy niż sufit faktur', () => {
    expect(SUFIT_SPECYFIKACJI_DRUKU).toBeGreaterThan(SUFIT_FAKTUR_HURTEM);
  });
});
