import { describe, it, expect } from 'vitest';
import {
  przewoznikPrzesylki, adresSledzenia, przewoznikWiersza, PRZEWOZNICY,
} from '../../src/domena/przewoznik-przesylki.js';

// PRZ-067 (decyzja właściciela 13.10): filtr i kolumna „Kurier” w zakładce Przesyłki po PRAWDZIWYM
// przewoźniku. Tabela niżej to DOSŁOWNIE pomiar z produkcji (13.10, 60 dni, 257 przesyłek):
// kurier | carrier_allegro | metoda_wysylki | metoda_wysylki_nazwa | liczba → oczekiwany klucz.
const POMIAR = `
dpd||dpd||99|dpd
allegro_wza||allegro_dpd|Allegro Kurier DPD|81|dpd
inpost||allegro_paczkomat|Allegro Paczkomaty InPost|18|inpost
allegro_wza||allegro_dpd|Allegro Kurier DPD pobranie|11|dpd
allegro|ALLEGRO|allegro_dpd|Allegro Kurier DPD|10|dpd
allegro_wza||allegro_punkt|Allegro One Box, One Kurier|7|allegro-one
allegro|ALLEGRO|allegro_punkt|Allegro One Box, One Kurier|6|allegro-one
allegro|ALLEGRO|allegro_inne|Allegro Automaty Paczkowe DPD|2|dpd
allegro|ALLEGRO|allegro_inne|Allegro Kurier DHL|2|dhl
allegro|ALLEGRO|allegro_kurier|Allegro One Kurier - dostawa jutro|2|allegro-one
allegro|ALLEGRO|allegro_punkt|Allegro Automat ORLEN Paczka|2|orlen
allegro|INPOST|allegro_inne|Allegro Kurier24 InPost|2|inpost
allegro_wza||allegro_inne|Allegro One Box, DPD|2|dpd
inpost||dpd||2|inpost
inpost||inpost_paczkomat||2|inpost
allegro|ALLEGRO|allegro_dpd|Allegro Kurier DPD pobranie|1|dpd
allegro|ALLEGRO|allegro_punkt|Allegro Automat DHL BOX 24/7|1|dhl
allegro|ALLEGRO|allegro_punkt|Allegro Odbiór w Punkcie DHL|1|dhl
allegro|INPOST|allegro_paczkomat|Allegro Paczkomaty InPost|1|inpost
allegro|PACKETA|allegro_inne|Allegro Wysyłka z Polski do Słowacji - Automaty Paczkowe Packeta, ORLEN Paczka|1|packeta
allegro_wza||allegro_inne|Allegro Automaty Paczkowe DPD|1|dpd
allegro_wza||allegro_inne|Allegro Kurier DHL|1|dhl
dpd||inpost_paczkomat||1|dpd
inpost||allegro_paczkomat|Allegro Paczkomaty InPost pobranie|1|inpost
`.trim().split('\n').map((l) => l.split('|'));

const NAZWY = {
  dpd: 'DPD', inpost: 'InPost', dhl: 'DHL', orlen: 'ORLEN Paczka', 'allegro-one': 'Allegro One', packeta: 'Packeta',
};

describe('przewoznikPrzesylki — 24 kombinacje z produkcji', () => {
  it('pomiar ma 24 wiersze i 257 przesyłek', () => {
    expect(POMIAR).toHaveLength(24);
    expect(POMIAR.reduce((s, w) => s + Number(w[4]), 0)).toBe(257);
  });

  for (const [kurier, carrier, metoda, nazwa, ile, klucz] of POMIAR) {
    it(`${kurier}|${carrier}|${metoda}|${nazwa} (${ile}) → ${klucz}`, () => {
      const p = przewoznikPrzesylki({
        kurier, carrierAllegro: carrier || null, nazwaUslugi: nazwa || null, metoda: metoda || null,
      });
      expect(p).toEqual(expect.objectContaining({ klucz, nazwa: NAZWY[klucz] }));
    });
  }
});

describe('przewoznikPrzesylki — brzegi', () => {
  it('kod nadania wygrywa z metodą zamówienia (inpost|dpd → InPost, dpd|inpost_paczkomat → DPD)', () => {
    expect(przewoznikPrzesylki({ kurier: 'inpost', metoda: 'dpd', nazwaUslugi: 'Kurier DPD' }).klucz).toBe('inpost');
    expect(przewoznikPrzesylki({ kurier: 'dpd', metoda: 'inpost_paczkomat', nazwaUslugi: 'InPost Paczkomat' }).klucz).toBe('dpd');
  });

  // WzA nie zapisuje `carrier_allegro` (w pomiarze NULL we wszystkich 104 przesyłkach allegro_wza),
  // więc przy wysyłce na Słowację rozstrzyga sama kolejność słów: Packeta przed ORLEN.
  it('Packeta przed ORLEN także bez carriera (allegro_wza)', () => {
    const nazwa = 'Allegro Wysyłka z Polski do Słowacji - Automaty Paczkowe Packeta, ORLEN Paczka';
    expect(przewoznikPrzesylki({ kurier: 'allegro_wza', carrierAllegro: null, nazwaUslugi: nazwa, metoda: 'allegro_inne' }).klucz).toBe('packeta');
  });

  it('carrier ALLEGRO nie jest sygnałem — sam w sobie nie daje przewoźnika', () => {
    expect(przewoznikPrzesylki({ kurier: 'allegro', carrierAllegro: 'ALLEGRO' })).toBeNull();
  });

  it('nieznana nazwa i nieznana metoda → null', () => {
    expect(przewoznikPrzesylki({ kurier: 'allegro_wza', nazwaUslugi: 'Allegro punkt / automat', metoda: 'allegro_punkt' })).toBeNull();
    expect(przewoznikPrzesylki({ kurier: 'allegro', nazwaUslugi: 'Wysyłka ekspresowa', metoda: 'allegro_inne' })).toBeNull();
  });

  it('NULL wszędzie → null, bez wyjątku', () => {
    expect(przewoznikPrzesylki({ kurier: null, carrierAllegro: null, nazwaUslugi: null, metoda: null })).toBeNull();
    expect(przewoznikPrzesylki()).toBeNull();
  });

  it('dopasowanie pełnym słowem: „Phone”, „Done”, „DPDX”, „Orlenowo” nie są przewoźnikiem', () => {
    expect(przewoznikPrzesylki({ kurier: 'allegro', nazwaUslugi: 'Allegro Phone Box' })).toBeNull();
    expect(przewoznikPrzesylki({ kurier: 'allegro', nazwaUslugi: 'Done DPDX Orlenowo' })).toBeNull();
  });

  it('wielkość liter nie ma znaczenia', () => {
    expect(przewoznikPrzesylki({ kurier: 'allegro', nazwaUslugi: 'allegro kurier dhl' }).klucz).toBe('dhl');
    expect(przewoznikPrzesylki({ kurier: 'allegro', nazwaUslugi: 'ALLEGRO ONE KURIER' }).klucz).toBe('allegro-one');
  });

  it('metoda jest zapasem, gdy nazwy brak: allegro_dpd → DPD, allegro_paczkomat → InPost', () => {
    expect(przewoznikPrzesylki({ kurier: 'allegro_wza', metoda: 'allegro_dpd' }).klucz).toBe('dpd');
    expect(przewoznikPrzesylki({ kurier: 'allegro_wza', metoda: 'allegro_paczkomat' }).klucz).toBe('inpost');
    expect(przewoznikPrzesylki({ kurier: 'allegro_wza', metoda: 'inpost_paczkomat' }).klucz).toBe('inpost');
  });

  it('każdy przewoźnik ma logo pod /public/przewoznicy/ (packeta jako PNG)', () => {
    expect(przewoznikPrzesylki({ kurier: 'dpd' }).logo).toBe('/public/przewoznicy/dpd.svg');
    expect(PRZEWOZNICY.packeta.logo).toBe('/public/przewoznicy/packeta.png');
    expect(PRZEWOZNICY['allegro-one'].logo).toBe('/public/przewoznicy/allegro-one.png');
  });
});

describe('przewoznikWiersza — nazwa usługi tą samą drogą, co kolumna „Dostawa”', () => {
  const zam = (o) => ({ metoda_wysylki: 'allegro_dpd', metoda_wysylki_nazwa: 'Allegro Kurier DPD', pobranie: 0, ...o });

  it('ręczna zmiana metody unieważnia nazwę od Allegro — rządzi nowa metoda', () => {
    const z = zam({ wysylka_reczna_json: JSON.stringify({ metoda: 'inpost_paczkomat', pobranie: 0 }) });
    expect(przewoznikWiersza({ kurier: 'allegro_wza', carrier_allegro: null }, z).klucz).toBe('inpost');
  });

  it('ręczna zmiana na allegro_punkt (nazwa ogólna) → nieznany, a nie DPD ze starej nazwy', () => {
    const z = zam({ wysylka_reczna_json: JSON.stringify({ metoda: 'allegro_punkt', pobranie: 0 }) });
    expect(przewoznikWiersza({ kurier: 'allegro_wza', carrier_allegro: null }, z)).toBeNull();
  });

  it('bez nadpisania bierze nazwę od Allegro', () => {
    const z = zam({ metoda_wysylki: 'allegro_inne', metoda_wysylki_nazwa: 'Allegro Kurier DHL' });
    expect(przewoznikWiersza({ kurier: 'allegro', carrier_allegro: 'ALLEGRO' }, z).klucz).toBe('dhl');
  });

  it('bez zamówienia działa na samym kodzie', () => {
    expect(przewoznikWiersza({ kurier: 'dpd' }, null).klucz).toBe('dpd');
    expect(przewoznikWiersza({ kurier: 'allegro_wza' }, null)).toBeNull();
  });
});

describe('adresSledzenia', () => {
  it('każdy przewoźnik ma adres z numerem na końcu', () => {
    expect(adresSledzenia('dpd', '123')).toBe('https://tracktrace.dpd.com.pl/parcelDetails?typ=1&p1=123');
    expect(adresSledzenia('inpost', '123')).toBe('https://inpost.pl/sledzenie-przesylek?number=123');
    expect(adresSledzenia('dhl', '123')).toBe('https://www.dhl.com/pl-pl/home/sledzenie-przesylek.html?tracking-id=123');
    expect(adresSledzenia('orlen', '123')).toBe('https://www.orlenpaczka.pl/sledz-paczke/?numer=123');
    expect(adresSledzenia('allegro-one', '123')).toBe('https://allegro.pl/allegrodelivery/sledzenie-paczki?numer=123');
    expect(adresSledzenia('packeta', '123')).toBe('https://tracking.packeta.com/pl/?id=123');
  });

  it('numer jest kodowany (spacja, &, #, /)', () => {
    expect(adresSledzenia('dpd', 'AB 12&x=1#y/z')).toBe('https://tracktrace.dpd.com.pl/parcelDetails?typ=1&p1=AB%2012%26x%3D1%23y%2Fz');
  });

  it('numer jest przycinany ze spacji na brzegach', () => {
    expect(adresSledzenia('inpost', '  6200 ')).toBe('https://inpost.pl/sledzenie-przesylek?number=6200');
  });

  it('brak numeru albo nieznany przewoźnik → null', () => {
    expect(adresSledzenia('dpd', null)).toBeNull();
    expect(adresSledzenia('dpd', '   ')).toBeNull();
    expect(adresSledzenia(null, '123')).toBeNull();
    expect(adresSledzenia('allegro_wza', '123')).toBeNull();
    expect(adresSledzenia('__proto__', '123')).toBeNull();
  });
});
