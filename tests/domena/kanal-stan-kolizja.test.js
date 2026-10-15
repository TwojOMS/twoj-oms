import { describe, it, expect } from 'vitest';
import { stanKanalu, kanalyWymagajaceUwagi, stanyKanalowZKolizjami } from '../../src/domena/kanal-stan.js';

// ⚠️⚠️ POMYLKA Z 28.08.2026: kanal `allegro_amarka` zostal zwiazany z kontem `szkicownia`,
// bo wlasciciel byl akurat na nim zalogowany w przegladarce. Bariera wiazania znala wtedy
// TRZY powody do przewiazania — kanal zepsuty, wygasajacy, z niepelnymi uprawnieniami —
// i kanal na cudzym koncie nie spelnial zadnego. Byl polaczony, bez bledu, z kompletem
// osmiu zakresow i 89 dniami waznosci. Panel uznal go za zdrowy i UKRYL PRZYCISK, wiec
// naprawa musiala isc przez terminal na NAS-ie.
//
// Tymczasem poller pracowal dalej: 6 zdublowanych zamowien, 5 zdublowanych platnosci
// i przestawiony kursor. Kanal wiszacy na cudzym koncie nie jest „lekko niepoprawny" —
// on AKTYWNIE PSUJE DANE, i dlatego jest `pilne`, a nie `uprzedzenie`.

const zdrowy = (extra) => stanKanalu({
  kanal: 'allegro_amarka',
  polaczony: true,
  zostaloDni: 89,
  refreshWygasaAt: '2026-11-26T12:00:00.000Z',
  brakujaceUprawnienia: [],
  ...extra,
});

describe('kanal wiszacy na tym samym koncie co inny', () => {
  it('jest PILNY, a nie tylko „do przewiazania"', () => {
    const s = zdrowy({ kontoAllegro: '36457435', kolizjaKonta: true });
    // Kanal na cudzym koncie sciaga cudze zamowienia POD SWOJA NAZWA — to awaria danych,
    // nie zblizajacy sie termin.
    expect(s.pilne).toBe(true);
    expect(s.zyje).toBe(false);
  });

  it('OTWIERA bariere wiazania — inaczej naprawa idzie przez terminal', () => {
    expect(zdrowy({ kontoAllegro: '36457435', kolizjaKonta: true }).wolnoWiazac).toBe(true);
  });

  it('powod NAZYWA konto, na ktorym kanal wisi', () => {
    const { powod } = zdrowy({ kontoAllegro: '36457435', kolizjaKonta: true });
    // Bez numeru czlowiek nie ma jak sprawdzic, ktore z dwoch wiazan poszlo nie tam.
    expect(powod).toContain('36457435');
    // I musi wiedziec, ze samo klikniecie nie wystarczy: trzeba sie WYLOGOWAC z Allegro,
    // bo inaczej powtorzy dokladnie ten sam blad.
    expect(powod).toMatch(/wyloguj/i);
  });

  it('kolizja ma pierwszenstwo przed zblizajacym sie terminem', () => {
    // Oba naraz: termin poczeka, cudze zamowienia nie.
    const s = zdrowy({ zostaloDni: 3, kontoAllegro: '36457435', kolizjaKonta: true });
    expect(s.pilne).toBe(true);
    expect(s.powod).toContain('36457435');
  });

  it('trafia na liste kanalow wymagajacych uwagi, PRZED uprzedzeniami', () => {
    const kolizja = zdrowy({ kanal: 'allegro_amarka', kontoAllegro: '36457435', kolizjaKonta: true });
    const wygasa = zdrowy({ kanal: 'allegro_szkicownia', zostaloDni: 3, kontoAllegro: '75246625' });
    expect(kanalyWymagajaceUwagi([wygasa, kolizja]).map((s) => s.kanal))
      .toEqual(['allegro_amarka', 'allegro_szkicownia']);
  });
});

describe('kanal zdrowy i sam na swoim koncie', () => {
  it('NIE dostaje przycisku wiazania', () => {
    // Bariera zostaje barierą: ponowne wiazanie nadpisuje dzialajaca pare tokenow
    // i uniewaznia ja po stronie Allegro.
    expect(zdrowy({ kontoAllegro: '75246625', kolizjaKonta: false }).wolnoWiazac).toBe(false);
  });

  it('POKAZUJE konto Allegro, mimo ze nic sie nie dzieje', () => {
    // ⚠️ TO JEST WLASCIWA NAPRAWA TEJ POMYLKI. Gdyby ekran pokazywal konto od poczatku,
    // wlasciciel zobaczylby swoj blad zaraz po klikniecu — a nie po podwojnym imporcie.
    expect(zdrowy({ kontoAllegro: '75246625', kolizjaKonta: false }).kontoAllegro).toBe('75246625');
  });

  it('znosi brak informacji o koncie bez wywracania sie', () => {
    const s = zdrowy({});
    expect(s.kontoAllegro).toBeNull();
    expect(s.wolnoWiazac).toBe(false);
  });
});

describe('stanyKanalowZKolizjami — jedna funkcja dla ekranu i dla uslugi', () => {
  it('ocenia wszystkie kanaly naraz i sam wykrywa sklejone konto', () => {
    const wynik = stanyKanalowZKolizjami([
      { kanal: 'allegro_szkicownia', polaczony: true, zostaloDni: 89, kontoAllegro: '36457435', brakujaceUprawnienia: [] },
      { kanal: 'allegro_amarka', polaczony: true, zostaloDni: 89, kontoAllegro: '36457435', brakujaceUprawnienia: [] },
    ]);
    // OBA sa pilne i OBA wolno przewiazac — panel nie wie, ktore wiazanie poszlo nie tam.
    expect(wynik.map((s) => s.pilne)).toEqual([true, true]);
    expect(wynik.map((s) => s.wolnoWiazac)).toEqual([true, true]);
  });

  it('nie rusza kanalow stojacych na swoich kontach', () => {
    const wynik = stanyKanalowZKolizjami([
      { kanal: 'allegro_szkicownia', polaczony: true, zostaloDni: 89, kontoAllegro: '36457435', brakujaceUprawnienia: [] },
      { kanal: 'allegro_amarka', polaczony: true, zostaloDni: 89, kontoAllegro: '75246625', brakujaceUprawnienia: [] },
    ]);
    expect(wynik.map((s) => s.pilne)).toEqual([false, false]);
    expect(wynik.map((s) => s.wolnoWiazac)).toEqual([false, false]);
  });

  it('znosi pustke', () => {
    expect(stanyKanalowZKolizjami([])).toEqual([]);
    expect(stanyKanalowZKolizjami(null)).toEqual([]);
  });
});
