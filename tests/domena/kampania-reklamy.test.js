import { describe, it, expect } from 'vitest';
import {
  stanKampanii, dolaczZrodla, dolaczZamowieniaZReklam, alertyKampanii, faleKampanii,
} from '../../src/domena/kampania.js';

// Drugi licznik kampanii (2026-08-27): zamowienia z utm_campaign w atrybucji — takze
// (przede wszystkim) BEZ kodu rabatowego. Kod mierzy cala promocje (rozdaje go tez baner
// na stronie), utm mierzy wylacznie klikniecia w reklame; tych liczb sie nie sumuje.
// Do tego alerty kontrolne i dwie miary przy zrodlach: pokrycie pomiaru GA4 i prognoza
// wydatku.

const KAMPANIA = {
  id: 1, kod: 'wrzesien30', nazwa: 'Nowy początek. Bez remontu.',
  od_dnia: '2026-08-24', do_dnia: '2026-09-07', sklep: 'szkicownia', cel_uzyc: 10,
};

// Ksztalt zLinii, jak w kampania-domena.test.js.
const zam = (nad = {}) => ({
  id: 1, numer: '28225', sklep: 'szkicownia', kwota_brutto: '64.79',
  utworzone_at: '2026-08-27T10:54:27Z', anulowane: 0, oplacone_at: '2026-08-27T10:55:11Z',
  kupony_json: null,
  atrybucja_json: '{"typ":"utm","zrodlo":"facebook","medium":"cpc","kampania":"wrzesien30"}',
  pozycje: [], ...nad,
});

const stanBazowy = () => stanKampanii({ kampania: KAMPANIA, zamowienia: [], dzis: '2026-08-27' });

describe('dolaczZamowieniaZReklam — dopasowanie', () => {
  it('liczy zamówienie z utm_campaign kampanii, także bez kodu rabatowego', () => {
    const w = dolaczZamowieniaZReklam(stanBazowy(), { kampania: KAMPANIA, zamowieniaUtm: [zam()] });
    expect(w.reklamy.liczba).toBe(1);
    expect(w.reklamy.bezKodu).toBe(1);
    expect(w.reklamy.zKodem).toBe(0);
    expect(w.reklamy.kwotaZl).toBe('64.79');
    expect(w.reklamy.bezKoduKwotaZl).toBe('64.79');
  });

  it('wielkość liter kampanii w utm bez znaczenia', () => {
    const w = dolaczZamowieniaZReklam(stanBazowy(), {
      kampania: KAMPANIA,
      zamowieniaUtm: [zam({ atrybucja_json: '{"typ":"utm","zrodlo":"facebook","kampania":"WRZESIEN30"}' })],
    });
    expect(w.reklamy.liczba).toBe(1);
  });

  // ⚠️ Prefiks to NIE dopasowanie — ta sama zasada, co przy kuponach (wrzesien30/wrzesien305).
  it('inna kampania o wspólnym prefiksie NIE liczy się', () => {
    const w = dolaczZamowieniaZReklam(stanBazowy(), {
      kampania: KAMPANIA,
      zamowieniaUtm: [zam({ atrybucja_json: '{"typ":"utm","zrodlo":"facebook","kampania":"wrzesien305"}' })],
    });
    expect(w.reklamy.liczba).toBe(0);
    expect(w.reklamy.wiersze).toHaveLength(0);
  });

  it('atrybucja bez kampanii albo uszkodzona nie liczy się i nie wywala ekranu', () => {
    const w = dolaczZamowieniaZReklam(stanBazowy(), {
      kampania: KAMPANIA,
      zamowieniaUtm: [
        zam({ atrybucja_json: '{"typ":"typein","zrodlo":"(direct)","kampania":null}' }),
        zam({ id: 2, numer: '28226', atrybucja_json: '{zepsuty json' }),
      ],
    });
    expect(w.reklamy.liczba).toBe(0);
  });

  it('zamówienie z reklam I z kodem stoi w rozbiciu „z kodem", ale nie w tabeli bez kodu', () => {
    const w = dolaczZamowieniaZReklam(stanBazowy(), {
      kampania: KAMPANIA,
      zamowieniaUtm: [zam({ kupony_json: '[{"kod":"wrzesien30","rabat":"27.77"}]' })],
    });
    expect(w.reklamy.liczba).toBe(1);
    expect(w.reklamy.zKodem).toBe(1);
    expect(w.reklamy.bezKodu).toBe(0);
    expect(w.reklamy.wiersze).toHaveLength(0);
  });
});

describe('dolaczZamowieniaZReklam — zasięg i anulowane', () => {
  it('ten sam zasięg co przy kodzie: inny sklep i data poza oknem lądują w „poza zasięgiem"', () => {
    const w = dolaczZamowieniaZReklam(stanBazowy(), {
      kampania: KAMPANIA,
      zamowieniaUtm: [
        zam({ sklep: 'pro' }),
        zam({ id: 2, numer: '28300', utworzone_at: '2026-09-20T10:00:00Z' }),
      ],
    });
    expect(w.reklamy.liczba).toBe(0);
    expect(w.reklamy.pozaZasiegiem).toBe(2);
  });

  it('anulowane nie wchodzi do kafli, ale stoi w tabeli ze statusem', () => {
    const w = dolaczZamowieniaZReklam(stanBazowy(), {
      kampania: KAMPANIA,
      zamowieniaUtm: [zam(), zam({ id: 2, numer: '28226', anulowane: 1 })],
    });
    expect(w.reklamy.liczba).toBe(1);
    expect(w.reklamy.anulowanych).toBe(1);
    expect(w.reklamy.kwotaZl).toBe('64.79');
    expect(w.reklamy.wiersze).toHaveLength(2);
    expect(w.reklamy.wiersze.find((x) => x.numer === '28226').status).toBe('anulowane');
  });

  it('dokleja liczbę zamówień z reklam do dni kampanii', () => {
    const w = dolaczZamowieniaZReklam(stanBazowy(), { kampania: KAMPANIA, zamowieniaUtm: [zam()] });
    expect(w.dni.find((d) => d.dzien === '2026-08-27').zReklam).toBe(1);
    expect(w.dni.find((d) => d.dzien === '2026-08-26').zReklam).toBe(0);
  });

  // ——— KWOTY DNIA (wykres „pieniadze dzien po dniu", 2026-08-27) ————————————————————

  it('dzień niesie kwotę zamówień bez kodu — zamówienie z kodem NIE wchodzi do tego kawałka', () => {
    const w = dolaczZamowieniaZReklam(stanBazowy(), {
      kampania: KAMPANIA,
      zamowieniaUtm: [
        zam(), // 64.79 bez kodu
        zam({ id: 2, numer: '28227', kwota_brutto: '100.00', kupony_json: '[{"kod":"wrzesien30","rabat":"30.00"}]' }),
      ],
    });
    // Kawalek „z reklam" DOPELNIA kawalek kodu do unii — 100 zl z kodem juz siedzi
    // w kodKwotaZl (stanKampanii), tu liczyloby sie drugi raz.
    expect(w.dni.find((d) => d.dzien === '2026-08-27').reklamyKwotaZl).toBe('64.79');
  });

  it('dzień niesie też LICZBĘ zamówień bez kodu — tor zamówień lejka liczy unię', () => {
    const w = dolaczZamowieniaZReklam(stanBazowy(), {
      kampania: KAMPANIA,
      zamowieniaUtm: [
        zam(), // bez kodu
        zam({ id: 2, numer: '28227', kupony_json: '[{"kod":"wrzesien30","rabat":"30.00"}]' }),
      ],
    });
    // Z kodem NIE wchodzi do liczby bez-kodu — juz siedzi w uzyciach (stanKampanii).
    expect(w.dni.find((d) => d.dzien === '2026-08-27').zReklamBezKodu).toBe(1);
    expect(w.dni.find((d) => d.dzien === '2026-08-26').zReklamBezKodu).toBe(0);
  });

  it('stanKampanii niesie kwotę dnia z kodem — tą samą miarą co kafel przychodu', () => {
    const stan = stanKampanii({
      kampania: KAMPANIA,
      zamowienia: [zam({ kupony_json: '[{"kod":"wrzesien30","rabat":"27.77"}]' })],
      dzis: '2026-08-27',
    });
    expect(stan.dni.find((d) => d.dzien === '2026-08-27').kodKwotaZl).toBe('64.79');
    expect(stan.dni.find((d) => d.dzien === '2026-08-26').kodKwotaZl).toBe('0.00');
  });
});

describe('dolaczZamowieniaZReklam — koszt i zwrot', () => {
  const meta = [{ dzien: '2026-08-26', wydatek: '50.00', wyswietlenia: 1000, zasieg: 800, klikniecia: 60, klikniecia_linku: 20 }];
  const zeZrodlami = (zamowieniaUtm) => dolaczZamowieniaZReklam(
    dolaczZrodla(stanBazowy(), { meta, ga4: [], stany: {} }),
    { kampania: KAMPANIA, zamowieniaUtm },
  );

  it('koszt zamówienia z reklam: wydatek ÷ zamówienia z utm', () => {
    const w = zeZrodlami([zam(), zam({ id: 2, numer: '28226' })]);
    expect(w.reklamy.kosztZamowieniaZl).toBe('25.00');
  });

  it('zwrot z reklam: przychód z utm na złotówkę wydatku', () => {
    const w = zeZrodlami([zam({ kwota_brutto: '100.00' })]);
    expect(w.reklamy.zwrot).toBe('2.0');
  });

  // ⚠️ Zero przy wydanych pieniadzach ZOSTAJE zerem — „wydaliśmy i nic nie przyszło
  // z reklam" to najważniejszy sygnał tej sekcji, nie brak miary.
  it('wydatek bez ani jednego zamówienia z utm → zwrot zero, koszt niedostępny', () => {
    const w = zeZrodlami([]);
    expect(w.reklamy.zwrot).toBe('0.0');
    expect(w.reklamy.kosztZamowieniaZl).toBeNull();
  });

  it('bez danych Mety koszt i zwrot są niedostępne, liczby zamówień zostają', () => {
    const w = dolaczZamowieniaZReklam(stanBazowy(), { kampania: KAMPANIA, zamowieniaUtm: [zam()] });
    expect(w.reklamy.kosztZamowieniaZl).toBeNull();
    expect(w.reklamy.zwrot).toBeNull();
    expect(w.reklamy.liczba).toBe(1);
  });
});

describe('stanKampanii — użycia po końcu okna', () => {
  it('kod użyty po do_dnia liczy się osobno (niewygaszony kupon)', () => {
    const stan = stanKampanii({
      kampania: KAMPANIA,
      zamowienia: [zam({
        kupony_json: '[{"kod":"wrzesien30","rabat":"10.00"}]',
        utworzone_at: '2026-09-09T10:00:00Z',
      })],
      dzis: '2026-09-09',
    });
    expect(stan.pozaZasiegiem).toBe(1);
    expect(stan.uzycPoOknie).toBe(1);
  });

  it('użycie w innym sklepie NIE liczy się jako „po oknie"', () => {
    const stan = stanKampanii({
      kampania: KAMPANIA,
      zamowienia: [zam({ sklep: 'pro', kupony_json: '[{"kod":"wrzesien30","rabat":"10.00"}]' })],
      dzis: '2026-08-27',
    });
    expect(stan.pozaZasiegiem).toBe(1);
    expect(stan.uzycPoOknie).toBe(0);
  });

  // ⚠️ Kod uzyty na INNYM sklepie po 7.09 to nie „niewygaszony kupon szkicownia" — alert
  // o wygasnieciu ma bic wylacznie na wlasnym sklepie kampanii.
  it('inny sklep po końcu okna też nie alarmuje o kuponie', () => {
    const stan = stanKampanii({
      kampania: KAMPANIA,
      zamowienia: [zam({
        sklep: 'pro',
        kupony_json: '[{"kod":"wrzesien30","rabat":"10.00"}]',
        utworzone_at: '2026-09-09T10:00:00Z',
      })],
      dzis: '2026-09-10',
    });
    expect(stan.uzycPoOknie).toBe(0);
  });
});

// ——— MIARY PRZY ZRODLACH: pokrycie pomiaru GA4 i prognoza wydatku ———————————————————

describe('dolaczZrodla — pokrycie pomiaru GA4', () => {
  const meta = [{ dzien: '2026-08-26', wydatek: '50.00', wyswietlenia: 1000, zasieg: 800, klikniecia: 60, klikniecia_linku: 20 }];

  it('podaje, jaki odsetek kliknięć linkowych z Mety GA4 widzi jako sesje', () => {
    const ga4 = [{ dzien: '2026-08-26', sesje: 30, uzytkownicy: 25, sesje_meta: 7, odslony_promo: 2 }];
    const w = dolaczZrodla(stanBazowy(), { meta, ga4, stany: {} });
    expect(w.ga4.pokryciePct).toBe(35);
  });

  // ⚠️ 0% Z BRAKU DANYCH GA4 wygladaloby jak fakt o zgodach, a jest luka w pomiarze.
  it('bez danych GA4 pokrycie jest niedostępne, nie zerowe', () => {
    const w = dolaczZrodla(stanBazowy(), { meta, ga4: [], stany: {} });
    expect(w.ga4.pokryciePct).toBeNull();
  });

  it('bez kliknięć linkowych nie ma czego dzielić', () => {
    const bezKlikniec = [{ dzien: '2026-08-26', wydatek: '5.00', wyswietlenia: 100, zasieg: 90, klikniecia: 0, klikniecia_linku: 0 }];
    const ga4 = [{ dzien: '2026-08-26', sesje: 3, uzytkownicy: 3, sesje_meta: 0, odslony_promo: 0 }];
    const w = dolaczZrodla(stanBazowy(), { meta: bezKlikniec, ga4, stany: {} });
    expect(w.ga4.pokryciePct).toBeNull();
  });

  // Zero PRZY danych zostaje zerem — to sygnal (alert o utm), nie brak miary.
  it('GA4 działa, a z Mety nie widzi nic → pokrycie 0%, nie myślnik', () => {
    const ga4 = [{ dzien: '2026-08-26', sesje: 30, uzytkownicy: 25, sesje_meta: 0, odslony_promo: 2 }];
    const w = dolaczZrodla(stanBazowy(), { meta, ga4, stany: {} });
    expect(w.ga4.pokryciePct).toBe(0);
  });
});

describe('dolaczZrodla — kliknięcia linkowe w dniach (tor lejka)', () => {
  it('dokleja kliknięcia linkowe dnia; dzień bez danych dostaje zero', () => {
    const meta = [{ dzien: '2026-08-26', wydatek: '50.00', wyswietlenia: 1000, zasieg: 800, klikniecia: 60, klikniecia_linku: 20 }];
    const w = dolaczZrodla(stanBazowy(), { meta, ga4: [], stany: {} });
    expect(w.dni.find((d) => d.dzien === '2026-08-26').kliknieciaLinku).toBe(20);
    expect(w.dni.find((d) => d.dzien === '2026-08-25').kliknieciaLinku).toBe(0);
  });
});

describe('dolaczZrodla — prognoza wydatku', () => {
  // stanBazowy: okno 24.08–07.09 (15 dni), dzis = 27.08 (indeks 3) → pozostalo 12 dni z dzisiejszym.
  it('pełne dni z wydatkiem dają tempo; dzisiejszy, niepełny dzień, liczy się po średniej', () => {
    const meta = [
      { dzien: '2026-08-26', wydatek: '30.00', wyswietlenia: 0, zasieg: 0, klikniecia: 0, klikniecia_linku: 0 },
      { dzien: '2026-08-27', wydatek: '5.00', wyswietlenia: 0, zasieg: 0, klikniecia: 0, klikniecia_linku: 0 },
    ];
    const w = dolaczZrodla(stanBazowy(), { meta, ga4: [], stany: {} });
    // 30 zl z pelnego dnia + 30 zl/dzien × 12 pozostalych (z dzisiejszym) = 390 zl.
    expect(w.meta.prognozaZl).toBe('390.00');
  });

  // ⚠️ Jeden NIEPELNY dzien to nie tempo — prognoza z niego bylaby zmysleniem.
  it('bez ani jednego pełnego dnia z wydatkiem prognozy nie ma', () => {
    const meta = [{ dzien: '2026-08-27', wydatek: '5.00', wyswietlenia: 0, zasieg: 0, klikniecia: 0, klikniecia_linku: 0 }];
    const w = dolaczZrodla(stanBazowy(), { meta, ga4: [], stany: {} });
    expect(w.meta.prognozaZl).toBeNull();
  });

  it('po końcu okna prognozy nie ma — nie ma już czego prognozować', () => {
    const poOknie = stanKampanii({ kampania: KAMPANIA, zamowienia: [], dzis: '2026-09-20' });
    const meta = [{ dzien: '2026-08-26', wydatek: '30.00', wyswietlenia: 0, zasieg: 0, klikniecia: 0, klikniecia_linku: 0 }];
    const w = dolaczZrodla(poOknie, { meta, ga4: [], stany: {} });
    expect(w.meta.prognozaZl).toBeNull();
  });
});

// ——— ETAPY KAMPANII (prowadnice wykresu pieniedzy, 2026-08-28) ——————————————————————

describe('faleKampanii — etapy z wiersza kampanii', () => {
  const kamp = (fale_json) => ({ ...KAMPANIA, fale_json });

  it('parsuje, odfiltrowuje wpisy spoza okna i porządkuje po dacie', () => {
    const f = faleKampanii(kamp('[{"od":"2026-09-04","napis":"fala 3"},{"od":"2026-08-26","napis":"start reklam"},{"od":"2026-10-01","napis":"poza oknem"}]'));
    expect(f).toEqual([
      { od: '2026-08-26', napis: 'start reklam' },
      { od: '2026-09-04', napis: 'fala 3' },
    ]);
  });

  // Uszkodzona kolumna jednego wiersza nie ma prawa wywalic ekranu — wykres wraca
  // wtedy do wyliczanej prowadnicy, ta sama zasada co przy kazdej kolumnie *_json.
  it('uszkodzony JSON, nie-tablica i brak kolumny → brak etapów, nie wyjątek', () => {
    expect(faleKampanii(kamp('{zepsute'))).toEqual([]);
    expect(faleKampanii(kamp('{"nie":"tablica"}'))).toEqual([]);
    expect(faleKampanii(KAMPANIA)).toEqual([]);
    expect(faleKampanii(kamp('[{"od":"2026-08-26"},{"napis":"bez daty"}]'))).toEqual([]);
  });
});

// ——— ALERTY KONTROLNE ———————————————————————————————————————————————————————————————

describe('alertyKampanii', () => {
  // ⚠️ Domyslne klikniecia daja CPC = 0,125 zl (punkt odniesienia) — fixture „spokoju"
  // nie ma prawa sama z siebie obudzic alertu CPC.
  const metaDzien = (dzien, wydatek, klikniecia = 400) => ({
    dzien, wydatek, wyswietlenia: 1000, zasieg: 800, klikniecia, klikniecia_linku: 12,
  });
  const zloz = ({ zamowienia = [], meta = [], ga4 = [], dzis = '2026-08-27' } = {}) => {
    const stan = dolaczZrodla(
      stanKampanii({ kampania: KAMPANIA, zamowienia, dzis }),
      { meta, ga4, stany: {} },
    );
    return alertyKampanii({ stan, meta, dzis });
  };

  it('spokój: reklama wydaje, GA4 widzi sesje, kupon w ryzach → zero alertów', () => {
    const alerty = zloz({
      meta: [metaDzien('2026-08-26', '50.00')],
      ga4: [{ dzien: '2026-08-26', sesje: 30, uzytkownicy: 25, sesje_meta: 7, odslony_promo: 2 }],
    });
    expect(alerty).toHaveLength(0);
  });

  it('reklama wydawała, a wczoraj zero → alert o cichym zatrzymaniu', () => {
    const alerty = zloz({
      meta: [metaDzien('2026-08-25', '50.00'), metaDzien('2026-08-26', '0.00', 0)],
    });
    expect(alerty.some((a) => a.includes('nie wydała wczoraj'))).toBe(true);
  });

  // ⚠️ Pierwszy dzien bez wydatku to rozbieg, nie awaria — bez tej bramki alert bilby
  // kazdego ranka przed pierwszym przebiegiem czuwacza.
  it('bez wcześniejszego dnia z wydatkiem cisza wczoraj NIE alarmuje', () => {
    const alerty = zloz({ meta: [metaDzien('2026-08-26', '0.00', 0)] });
    expect(alerty.some((a) => a.includes('nie wydała wczoraj'))).toBe(false);
  });

  it('wydatek jest, a GA4 nie widzi ani jednej sesji z Mety → alert o utm', () => {
    const alerty = zloz({
      meta: [metaDzien('2026-08-26', '50.00')],
      ga4: [{ dzien: '2026-08-26', sesje: 20, uzytkownicy: 18, sesje_meta: 0, odslony_promo: 1 }],
    });
    expect(alerty.some((a) => a.includes('ani jednej sesji z Mety'))).toBe(true);
  });

  it('bez danych GA4 alert o utm nie bije — brak pomiaru to nie brak sesji', () => {
    const alerty = zloz({ meta: [metaDzien('2026-08-26', '50.00')] });
    expect(alerty.some((a) => a.includes('ani jednej sesji z Mety'))).toBe(false);
  });

  it('kod użyty po końcu kampanii → alert o niewygaszonym kuponie', () => {
    const alerty = zloz({
      zamowienia: [zam({
        kupony_json: '[{"kod":"wrzesien30","rabat":"10.00"}]',
        utworzone_at: '2026-09-09T10:00:00Z',
      })],
      dzis: '2026-09-10',
    });
    expect(alerty.some((a) => a.includes('po końcu kampanii'))).toBe(true);
  });

  it('wczorajszy CPC ponad dwukrotność odniesienia → alert', () => {
    // 20 zl / 50 klikniec = 0,40 zl > 2 × 0,125 zl.
    const alerty = zloz({
      meta: [metaDzien('2026-08-25', '10.00'), metaDzien('2026-08-26', '20.00', 50)],
    });
    expect(alerty.some((a) => a.includes('przekroczył dwukrotność'))).toBe(true);
  });

  // ⚠️ Pierwszy dzien z wydatkiem bywa CZESCIOWY (start wieczorem) — CPC z trzech godzin
  // rozbiegu to nie tempo. Zmierzone na produkcji 27.08: 0,26 zl i falszywy alarm.
  it('drogi CPC pierwszego dnia z wydatkiem NIE alarmuje (dzień częściowy)', () => {
    const alerty = zloz({ meta: [metaDzien('2026-08-26', '8.68', 33)] });
    expect(alerty.some((a) => a.includes('przekroczył dwukrotność'))).toBe(false);
  });

  // ⚠️ Kilka klikniec to szum jednej drogiej aukcji — prog probki trzyma alert w ryzach.
  it('drogi CPC na małej próbce kliknięć NIE alarmuje', () => {
    const alerty = zloz({
      meta: [metaDzien('2026-08-25', '10.00'), metaDzien('2026-08-26', '5.00', 5)],
    });
    expect(alerty.some((a) => a.includes('przekroczył dwukrotność'))).toBe(false);
  });
});
