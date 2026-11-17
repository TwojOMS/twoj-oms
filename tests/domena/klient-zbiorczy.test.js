import { describe, it, expect } from 'vitest';
import { umowaZbiorcza, parsujKlientowZbiorczych } from '../../src/domena/klient-zbiorczy.js';
import { RABAT_MAX } from '../../src/domena/rabat.js';

const KLIENT = {
  klucz: 'przykladowa', nazwa: 'Pracownia Przykładowa sp. z o.o.', nip: '1234500011',
  rabatProcent: 30, progDarmowejDostawyGr: 50000,
  oplataObslugiGr: 400, oplataKurierskaGr: 1900,
};

const OKRES = { klucz: KLIENT.klucz, nazwa: KLIENT.nazwa, nip: KLIENT.nip };

describe('umowaZbiorcza', () => {
  const WIERSZ = {
    klucz: 'przykladowa', nazwa: 'Pracownia Przykładowa sp. z o.o.', nip: '1234500011', rabat_procent: 30,
    rozliczenie_zbiorcze: 1, prog_darmowej_dostawy_gr: 50000,
    oplata_obslugi_gr: 400, oplata_kurierska_gr: 1900,
  };

  it('sklada warunki umowy z wiersza karty klienta', () => {
    expect(umowaZbiorcza(WIERSZ)).toEqual(OKRES);
  });

  it('normalizuje NIP zapisany z myslnikami', () => {
    expect(umowaZbiorcza({ ...WIERSZ, nip: '123-450-00-11' })).toEqual(OKRES);
  });

  it('oddaje null, gdy klienta nie ma', () => {
    expect(umowaZbiorcza(null)).toBeNull();
  });

  // ⚠️ To jest granica calego mechanizmu: klient JEST w bazie, ale nie ma umowy zbiorczej.
  // Bez tego warunku każdy stały klient dostawałby miesięczny okres rozliczeniowy.
  it('oddaje null, gdy klient nie jest rozliczany zbiorczo', () => {
    expect(umowaZbiorcza({ ...WIERSZ, rozliczenie_zbiorcze: 0 })).toBeNull();
  });

  it.each(['prog_darmowej_dostawy_gr', 'oplata_obslugi_gr', 'oplata_kurierska_gr'])(
    'brak %s nie blokuje okresu miesięcznego', (kolumna) => {
      expect(umowaZbiorcza({ ...WIERSZ, [kolumna]: null })).toEqual(OKRES);
    },
  );
  it('okres nie zawiera kwot, także zerowych', () => {
    expect(umowaZbiorcza({ ...WIERSZ, prog_darmowej_dostawy_gr: 0 })).toEqual(OKRES);
  });
  it('brak wszystkich kwot nie wymaga poprawiania karty klienta dla okresu', () => {
    expect(() => umowaZbiorcza({ ...WIERSZ, prog_darmowej_dostawy_gr: null,
      oplata_obslugi_gr: null, oplata_kurierska_gr: null })).not.toThrow();
  });

  // ⚠️ PRZ-180: umowa okresu NIE NIESIE rabatu — nie było czytelnika, a pole przepuszczało 300%.
  // Zły rabat w wierszu nie wywraca okresu (lista okresów mapuje wszystkich klientów naraz).
  it.each([[300], [-5], [7.5], [null]])('rabat %s w wierszu nie trafia do umowy i jej nie wywraca', (rabat) => {
    const umowa = umowaZbiorcza({ ...WIERSZ, rabat_procent: rabat });
    expect(umowa).not.toHaveProperty('rabatProcent');
    expect(umowa.klucz).toBe(WIERSZ.klucz);
  });

});

describe('parsujKlientowZbiorczych — granica rabatu (PRZ-180)', () => {
  const wpis = (rabat) => ({ OMS_KLIENCI_ZBIORCZY: `przykladowa:Pracownia Przykładowa sp. z o.o.:1234500011:${rabat}:500:4:19` });

  it('przyjmuje rabat równy RABAT_MAX', () => {
    expect(parsujKlientowZbiorczych(wpis(RABAT_MAX))[0].rabatProcent).toBe(RABAT_MAX);
  });
  // Parser woła dziś tylko migracja jednorazowa, której nic w `src` nie uruchamia (decyzja D06) —
  // stąd „odmawia wpisu”, nie „wywraca start”.
  it.each([[RABAT_MAX + 1], [300], ['7.5']])('odmawia wpisu z rabatem %s procent zamiast przyjąć cenę ujemną', (rabat) => {
    expect(() => parsujKlientowZbiorczych(wpis(rabat))).toThrow(/rabat/i);
  });
  it('komunikat wskazuje wpis, nie dane klienta', () => {
    expect(() => parsujKlientowZbiorczych(wpis(300))).toThrow(/wpis nr 1/);
    expect(() => parsujKlientowZbiorczych(wpis(300))).not.toThrow(/1234500011|Przykładowa/);
  });
  it('kwoty nadal mogą być ułamkowe i większe niż 90', () => {
    const [k] = parsujKlientowZbiorczych({ OMS_KLIENCI_ZBIORCZY: 'przykladowa:P:1234500011:30:500.50:4:190' });
    expect(k.progDarmowejDostawyGr).toBe(50050);
    expect(k.oplataKurierskaGr).toBe(19000);
  });
});

describe('parsujKlientowZbiorczych', () => {
  it('brak zmiennej to pusta lista, a nie awaria', () => {
    expect(parsujKlientowZbiorczych({})).toEqual([]);
  });

  it('literowka w liczbie ma wywalic start, a nie zamienic sie w zero', () => {
    const env = { OMS_KLIENCI_ZBIORCZY: 'przykladowa:Pracownia Przykładowa sp. z o.o.:1234500011:trzydziesci:500:4:19' };
    expect(() => parsujKlientowZbiorczych(env)).toThrow(/rabat/i);
  });

  it('parsuje pelny wpis i przelicza zlote na grosze', () => {
    const env = { OMS_KLIENCI_ZBIORCZY: 'przykladowa:Pracownia Przykładowa sp. z o.o.:1234500011:30:500:4:19' };
    expect(parsujKlientowZbiorczych(env)).toEqual([KLIENT]);
  });

  it('pusty rabat (podwojny dwukropek) ma wywalic start, a nie zamienic sie w zero', () => {
    const env = { OMS_KLIENCI_ZBIORCZY: 'przykladowa:Pracownia Przykładowa sp. z o.o.:1234500011::500:4:19' };
    expect(() => parsujKlientowZbiorczych(env)).toThrow(/rabat/i);
  });

  it('rabat z samych spacji ma wywalic start, a nie zamienic sie w zero', () => {
    const env = { OMS_KLIENCI_ZBIORCZY: 'przykladowa:Pracownia Przykładowa sp. z o.o.:1234500011: :500:4:19' };
    expect(() => parsujKlientowZbiorczych(env)).toThrow(/rabat/i);
  });

  it('pusty prog darmowej dostawy ma wywalic start, a nie stac sie „kazda wysylka za darmo"', () => {
    const env = { OMS_KLIENCI_ZBIORCZY: 'przykladowa:Pracownia Przykładowa sp. z o.o.:1234500011:30::4:19' };
    expect(() => parsujKlientowZbiorczych(env)).toThrow(/próg/i);
  });

  it('prog darmowej dostawy z samych spacji ma wywalic start', () => {
    const env = { OMS_KLIENCI_ZBIORCZY: 'przykladowa:Pracownia Przykładowa sp. z o.o.:1234500011:30: :4:19' };
    expect(() => parsujKlientowZbiorczych(env)).toThrow(/próg/i);
  });

  it('pusta oplata za obsluge ma wywalic start', () => {
    const env = { OMS_KLIENCI_ZBIORCZY: 'przykladowa:Pracownia Przykładowa sp. z o.o.:1234500011:30:500::19' };
    expect(() => parsujKlientowZbiorczych(env)).toThrow(/opłat[aę] za obsługę/i);
  });

  it('oplata za obsluge z samych spacji ma wywalic start', () => {
    const env = { OMS_KLIENCI_ZBIORCZY: 'przykladowa:Pracownia Przykładowa sp. z o.o.:1234500011:30:500: :19' };
    expect(() => parsujKlientowZbiorczych(env)).toThrow(/opłat[aę] za obsługę/i);
  });
});
