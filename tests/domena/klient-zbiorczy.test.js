import { describe, it, expect } from 'vitest';
import { umowaZbiorcza, parsujKlientowZbiorczych } from '../../src/domena/klient-zbiorczy.js';

const KLIENT = {
  klucz: 'zetaklient', nazwa: 'PHU Ewa Zieliński', nip: '1000001017',
  rabatProcent: 30, progDarmowejDostawyGr: 50000,
  oplataObslugiGr: 400, oplataKurierskaGr: 1900,
};

describe('umowaZbiorcza', () => {
  const WIERSZ = {
    klucz: 'zetaklient', nazwa: 'PHU Ewa Zieliński', nip: '1000001017', rabat_procent: 30,
    rozliczenie_zbiorcze: 1, prog_darmowej_dostawy_gr: 50000,
    oplata_obslugi_gr: 400, oplata_kurierska_gr: 1900,
  };

  it('sklada warunki umowy z wiersza karty klienta', () => {
    expect(umowaZbiorcza(WIERSZ)).toEqual(KLIENT);
  });

  it('normalizuje NIP zapisany z myslnikami', () => {
    expect(umowaZbiorcza({ ...WIERSZ, nip: '100-000-10-17' })).toEqual(KLIENT);
  });

  it('oddaje null, gdy klienta nie ma', () => {
    expect(umowaZbiorcza(null)).toBeNull();
  });

  // ⚠️ To jest granica calego mechanizmu: klient JEST w bazie, ale nie ma umowy zbiorczej.
  // Bez tego warunku kazdy staly klient dostawalby oplate za obsluge.
  it('oddaje null, gdy klient nie jest rozliczany zbiorczo', () => {
    expect(umowaZbiorcza({ ...WIERSZ, rozliczenie_zbiorcze: 0 })).toBeNull();
  });

  // ⚠️ ODMOWA, NIGDY ZERO. Zero przy progu znaczyloby „kazda wysylka za darmo", a przy
  // oplacie „nie pobieramy" — oba wygladaja w bazie poprawnie i oba kosztuja pieniadze.
  it.each([
    ['prog_darmowej_dostawy_gr', /próg darmowej dostawy/],
    ['oplata_obslugi_gr', /opłata za obsługę/],
    ['oplata_kurierska_gr', /opłata kurierska/],
  ])('rzuca, gdy brakuje kwoty %s', (kolumna, opis) => {
    expect(() => umowaZbiorcza({ ...WIERSZ, [kolumna]: null })).toThrow(opis);
  });

  it('komunikat odmowy nazywa klienta i odsyla na karte', () => {
    expect(() => umowaZbiorcza({ ...WIERSZ, oplata_obslugi_gr: null }))
      .toThrow(/PHU Ewa Zieliński[\s\S]*karcie klienta/);
  });

  // Zero WPISANE jest poprawnym ustaleniem („wysylka gratis od zera") — odrzucamy BRAK,
  // nie wartosc zerowa. Rozroznienie NULL vs 0 jest tu cala rzecza.
  it('zero wpisane recznie przechodzi — odrzucamy brak, nie zero', () => {
    expect(umowaZbiorcza({ ...WIERSZ, prog_darmowej_dostawy_gr: 0 }).progDarmowejDostawyGr).toBe(0);
  });
});

describe('parsujKlientowZbiorczych', () => {
  it('brak zmiennej to pusta lista, a nie awaria', () => {
    expect(parsujKlientowZbiorczych({})).toEqual([]);
  });

  it('literowka w liczbie ma wywalic start, a nie zamienic sie w zero', () => {
    const env = { OMS_KLIENCI_ZBIORCZY: 'zetaklient:PHU Ewa Zieliński:1000001017:trzydziesci:500:4:19' };
    expect(() => parsujKlientowZbiorczych(env)).toThrow(/rabat/i);
  });

  it('parsuje pelny wpis i przelicza zlote na grosze', () => {
    const env = { OMS_KLIENCI_ZBIORCZY: 'zetaklient:PHU Ewa Zieliński:1000001017:30:500:4:19' };
    expect(parsujKlientowZbiorczych(env)).toEqual([KLIENT]);
  });

  it('pusty rabat (podwojny dwukropek) ma wywalic start, a nie zamienic sie w zero', () => {
    const env = { OMS_KLIENCI_ZBIORCZY: 'zetaklient:PHU Ewa Zieliński:1000001017::500:4:19' };
    expect(() => parsujKlientowZbiorczych(env)).toThrow(/rabat/i);
  });

  it('rabat z samych spacji ma wywalic start, a nie zamienic sie w zero', () => {
    const env = { OMS_KLIENCI_ZBIORCZY: 'zetaklient:PHU Ewa Zieliński:1000001017: :500:4:19' };
    expect(() => parsujKlientowZbiorczych(env)).toThrow(/rabat/i);
  });

  it('pusty prog darmowej dostawy ma wywalic start, a nie stac sie „kazda wysylka za darmo"', () => {
    const env = { OMS_KLIENCI_ZBIORCZY: 'zetaklient:PHU Ewa Zieliński:1000001017:30::4:19' };
    expect(() => parsujKlientowZbiorczych(env)).toThrow(/próg/i);
  });

  it('prog darmowej dostawy z samych spacji ma wywalic start', () => {
    const env = { OMS_KLIENCI_ZBIORCZY: 'zetaklient:PHU Ewa Zieliński:1000001017:30: :4:19' };
    expect(() => parsujKlientowZbiorczych(env)).toThrow(/próg/i);
  });

  it('pusta oplata za obsluge ma wywalic start', () => {
    const env = { OMS_KLIENCI_ZBIORCZY: 'zetaklient:PHU Ewa Zieliński:1000001017:30:500::19' };
    expect(() => parsujKlientowZbiorczych(env)).toThrow(/opłat[aę] za obsługę/i);
  });

  it('oplata za obsluge z samych spacji ma wywalic start', () => {
    const env = { OMS_KLIENCI_ZBIORCZY: 'zetaklient:PHU Ewa Zieliński:1000001017:30:500: :19' };
    expect(() => parsujKlientowZbiorczych(env)).toThrow(/opłat[aę] za obsługę/i);
  });
});
