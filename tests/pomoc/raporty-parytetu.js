import { regulyFixture as regulyImportuFixture } from './import-sklep-parytet.js';
import { klasyfikacjaHistorycznaFixture } from './raporty-historyczne-fixture.js';
const regulyFixture = { ...regulyImportuFixture, klasyfikacja: klasyfikacjaHistorycznaFixture };
import * as sprzedaz from '../../src/domena/sprzedaz-okresu.js';
import { rachunekOkresu as rachunek } from '../../src/domena/rachunek-zarzadczy.js';
import { zamowieniaOkresu as zamowienia } from '../../src/domena/statystyki-okresu.js';
import { zastrzezenia as zastrzezeniaProdukcja } from '../../src/domena/zastrzezenia-historii.js';

// Jawne wejście frozen. Każdy wynik wylicza produkcyjna domena.
export const PODLOGA = '2026-01';
export const PODLOGA_ZWROTOW = '2026-08-15';
export const KLIENCI_WDT = regulyFixture.klienciWdt;
export const czyTestowe = (email, nazwa) => sprzedaz.czyTestowe(email, nazwa, regulyFixture);
export const sprzedazWOkresie = (db, zakres) => sprzedaz.sprzedazWOkresie(db, zakres, regulyFixture);
export const zwrotyWOkresie = (db, zakres) => sprzedaz.zwrotyWOkresie(db, zakres, regulyFixture);
export const nettoZamowieniaGrosze = (brutto, email) => sprzedaz.nettoZamowieniaGrosze(brutto, email, KLIENCI_WDT);
export const rachunekOkresu = (db, zakres) => rachunek(db, zakres, { regulySprzedazy: regulyFixture, podlogaKosztow: PODLOGA });
export const zamowieniaOkresu = (db, zakres) => zamowienia(db, zakres, regulyFixture);
export const zastrzezenia = o => zastrzezeniaProdukcja({ ...o, nazwaSklepu: 'szkicownia.pl', dataImportu: '2026-08-27' });
export const configRaportowFixture = {
  podlogaKosztow: PODLOGA,
  kontoHistorii: 9,
  regulySprzedazy: regulyFixture, podlogaZwrotow: PODLOGA_ZWROTOW, pierwszyDzienOms: '2026-07-03',
  nazwaSklepuHistorii: 'szkicownia.pl', dataImportuHistorii: '2026-08-27',
  nazwyKanalow: {
    ALLEGRO_SZKICOWNIA: 'Allegro szkicownia_pl', ALLEGRO_AMARKA: 'Allegro Amarka',
    SZKICOWNIA_PL: 'Szkicownia.pl', SZKICOWNIA_PRO: 'Szkicownia PRO', INDYWIDUALNE: 'Indywidualne',
    RECZNE: 'Ręczne', DROPSHIPPING: 'Dropshipping', B2B: 'B2B', GDD: 'GDD (Fundacja)',
    PRESTASHOP_ARCHIWUM: 'Prestashop (archiwum)', WOO_AMARKA: 'Woo Amarka (archiwum)', ETSY_ARCHIWUM: 'Etsy (archiwum)',
  },
};
