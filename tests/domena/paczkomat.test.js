import { describe, it, expect } from 'vitest';
import {
  METODY_WYSYLKI, ETYKIETY_WYSYLKI, etykietaWysylki, sprawdzZmianeMetody,
  punktOdbioru, punktOdbioruOpis, punktOdbioruZeSklepu, metodaZmienionaRecznie,
} from '../../src/domena/wysylka.js';
import { MAPOWANIE_SKLEPOW, metodaZLinii, metodaWysylkiZamowienia } from '../pomoc/mapowanie-sklepow-historyczne-fixture.js';
import { mapujZamowienie, punktOdbioruZeSurowych } from '../../src/domena/mapowanie.js';
import { podzielDoNadania } from '../../src/domena/masowe.js';

const SZKICOWNIA = MAPOWANIE_SKLEPOW.szkicownia;

// ⚠️ KSZTALTY ODWZOROWANE Z ZYWEGO SKLEPU (odczyt 2026-08-01) — nie zmyslone. Kody
// WRO10B / JAB03M / SLN06M to trzy prawdziwe paczkomaty z produkcji.
const zPaczkomatem = (nad = {}) => ({
  id: 28079,
  number: '28079',
  total: '212.90',
  status: 'processing',
  shipping_lines: [{
    instance_id: 12, method_id: 'easypack_parcel_machines', method_title: 'InPost Paczkomat', total: '13.00',
  }],
  meta_data: [
    { key: '_parcel_machine_id', value: 'WRO10B' },
    { key: '_parcel_machine_desc', value: 'Przy Centrum Handlowyn Borek' },
  ],
  line_items: [{ id: 51, name: 'szablon malarski', sku: 'sz-1', quantity: 1, total: '212.90' }],
  ...nad,
});

const surowyWiersz = (o = {}) => ({
  metoda_wysylki: 'inpost_paczkomat',
  pobranie: 0,
  kwota_pobrania: null,
  punkt_odbioru: 'WRO10B',
  punkt_odbioru_opis: 'Przy Centrum Handlowyn Borek',
  wysylka_reczna_json: null,
  ...o,
});
const nadpisanie = (o) => JSON.stringify(o);

describe('paczkomat jest pełnoprawną metodą wysyłki', () => {
  it('jest na liście metod, które panel rozumie', () => {
    expect(METODY_WYSYLKI).toContain('inpost_paczkomat');
  });

  // Nazwa dla czlowieka ma JEDNO zrodlo — inaczej filtr, lista i karta opisalyby te sama
  // przesylke trzema roznymi napisami.
  it('ma nazwę dla człowieka, a nie surową wartość kolumny', () => {
    expect(ETYKIETY_WYSYLKI.inpost_paczkomat).toBe('InPost Paczkomat');
    expect(etykietaWysylki('inpost_paczkomat', 0)).toBe('InPost Paczkomat');
    expect(etykietaWysylki('inpost_paczkomat', 1)).toBe('InPost Paczkomat (pobranie)');
  });
});

describe('rozpoznanie po instance_id — instancja 12 szkicownia.pl', () => {
  it('instancja 12 to paczkomat InPost', () => {
    expect(metodaZLinii(zPaczkomatem(), SZKICOWNIA.instancje)).toEqual({ metoda: 'inpost_paczkomat' });
  });

  // ⚠️ TO SA PIENIADZE. Sklep dzis NIE sprzedaje paczkomatu za pobraniem, a rozpoznanie
  // ShipX nie potwierdza nawet, czy umowa je obejmuje (44/44 przesylki maja `cod` puste).
  // Dopisanie tu pobrania kazaloby kurierowi inkasowac od klienta, ktory juz zaplacil.
  it('instancja 12 NIE niesie pobrania', () => {
    expect(metodaWysylkiZamowienia(zPaczkomatem(), SZKICOWNIA)).toEqual({
      metoda: 'inpost_paczkomat', pobranie: false,
    });
    const z = mapujZamowienie(zPaczkomatem(), SZKICOWNIA);
    expect(z.pobranie).toBe(0);
    expect(z.kwota_pobrania).toBeNull();
  });

  // Mapowanie idzie po instance_id, NIGDY po tytule — tytul zmienia sie jednym klikiem
  // w wp-adminie (patrz pulapka instancji 9).
  it('ten sam tytuł na innej instancji nie robi paczkomatu', () => {
    const podszywka = zPaczkomatem({
      shipping_lines: [{ instance_id: 3, method_id: 'easypack_parcel_machines', method_title: 'InPost Paczkomat' }],
    });
    expect(metodaWysylkiZamowienia(podszywka, SZKICOWNIA)).toEqual({ metoda: 'dpd', pobranie: false });
  });
});

describe('kod paczkomatu z meta_data zamówienia', () => {
  it('czyta _parcel_machine_id i _parcel_machine_desc', () => {
    expect(punktOdbioruZeSurowych(zPaczkomatem())).toEqual({
      kod: 'WRO10B', opis: 'Przy Centrum Handlowyn Borek',
    });
  });

  it('trafia do zamówienia razem z metodą', () => {
    const z = mapujZamowienie(zPaczkomatem(), SZKICOWNIA);
    expect(z.metoda_wysylki).toBe('inpost_paczkomat');
    expect(z.punkt_odbioru).toBe('WRO10B');
    expect(z.punkt_odbioru_opis).toBe('Przy Centrum Handlowyn Borek');
  });

  it.each(['JAB03M', 'SLN06M'])('działa na prawdziwym kodzie %s', (kod) => {
    const z = mapujZamowienie(
      zPaczkomatem({ meta_data: [{ key: '_parcel_machine_id', value: kod }] }),
      SZKICOWNIA,
    );
    expect(z.punkt_odbioru).toBe(kod);
    expect(z.punkt_odbioru_opis).toBeNull();
  });

  // Woo zapisuje niewypelnione pole raz jako '', raz wcale — „paczkomat o kodzie pustym"
  // nie jest wartoscia, ktora wolno wpuscic do bazy.
  it('pusty kod i brak meta czyta się jako NULL, nie jako pusty napis', () => {
    expect(punktOdbioruZeSurowych({ meta_data: [{ key: '_parcel_machine_id', value: '' }] }).kod).toBeNull();
    expect(punktOdbioruZeSurowych({}).kod).toBeNull();
    expect(mapujZamowienie(zPaczkomatem({ meta_data: [] }), SZKICOWNIA).punkt_odbioru).toBeNull();
  });

  // Zamowienie DPD nie ma tej meta i ma z niej wyjsc puste — bez tego kolumna wygladalaby
  // na wypelniona przy przesylkach, ktore z paczkomatem nie maja nic wspolnego.
  it('zamówienie bez paczkomatu nie dostaje punktu odbioru', () => {
    const dpd = zPaczkomatem({
      shipping_lines: [{ instance_id: 3, method_id: 'flexible_shipping', method_title: 'Kurier DPD' }],
      meta_data: [],
    });
    const z = mapujZamowienie(dpd, SZKICOWNIA);
    expect(z.metoda_wysylki).toBe('dpd');
    expect(z.punkt_odbioru).toBeNull();
  });
});

describe('ręczna korekta kodu punktu — nadpisanie WYGRYWA przy odczycie', () => {
  it('bez nadpisania rządzi sklep', () => {
    expect(punktOdbioru(surowyWiersz())).toBe('WRO10B');
    expect(punktOdbioruOpis(surowyWiersz())).toBe('Przy Centrum Handlowyn Borek');
  });

  // ⚠️ SEDNO. Poprawka wpisana wprost do kolumny zniknelaby przy najblizszym przebiegu
  // pollera (co dwie minuty), wiec mieszka w `wysylka_reczna_json` — i musi PRZEBIC sklep.
  it('kod z nadpisania bije kod ze sklepu', () => {
    const w = surowyWiersz({
      wysylka_reczna_json: nadpisanie({ metoda: 'inpost_paczkomat', pobranie: 0, punkt_odbioru: 'JAB03M' }),
    });
    expect(punktOdbioru(w)).toBe('JAB03M');
    expect(punktOdbioruZeSklepu(w)).toBe('WRO10B');
  });

  // Klient podal kod w uwagach zamiast wybrac w checkoucie — w kolumnie nie ma nic,
  // a nadac trzeba.
  it('kod da się dopisać zamówieniu, które nie ma go ze sklepu', () => {
    const w = surowyWiersz({
      punkt_odbioru: null,
      punkt_odbioru_opis: null,
      wysylka_reczna_json: nadpisanie({ metoda: 'inpost_paczkomat', pobranie: 0, punkt_odbioru: 'SLN06M' }),
    });
    expect(punktOdbioru(w)).toBe('SLN06M');
  });

  // ⚠️ Roznica wobec kwoty pobrania jest CELOWA: tam brak klucza znaczy „ma nie byc
  // pobrania", tu znaczy „czlowiek o punkcie nie decydowal". Zgubiony kod przy zwyklym
  // przelaczeniu pobrania zostawilby zamowienie, ktorego nie da sie nadac.
  it('nadpisanie BEZ kodu nie kasuje kodu ze sklepu', () => {
    const w = surowyWiersz({
      wysylka_reczna_json: nadpisanie({ metoda: 'inpost_paczkomat', pobranie: 1, kwota_pobrania: '212.90' }),
    });
    expect(punktOdbioru(w)).toBe('WRO10B');
  });

  // ⚠️ Opis nalezy do KODU, z ktorym przyszedl. Pokazany obok poprawionego kodu klamalby
  // o tym, dokad jedzie paczka — dokladnie tam, gdzie operator sprawdza, czy trafil dobrze.
  it('po korekcie kodu opis ze sklepu MILKNIE, zamiast opisywać inny paczkomat', () => {
    const w = surowyWiersz({
      wysylka_reczna_json: nadpisanie({ metoda: 'inpost_paczkomat', pobranie: 0, punkt_odbioru: 'JAB03M' }),
    });
    expect(punktOdbioruOpis(w)).toBeNull();
  });

  it('własny opis wpisany razem z korektą wygrywa', () => {
    const w = surowyWiersz({
      wysylka_reczna_json: nadpisanie({
        metoda: 'inpost_paczkomat', pobranie: 0, punkt_odbioru: 'JAB03M', punkt_odbioru_opis: 'Przy myjni',
      }),
    });
    expect(punktOdbioruOpis(w)).toBe('Przy myjni');
  });

  // Uszkodzony JSON (reczny UPDATE w pliku SQLite) nie moze wywalic karty — czytamy sklep.
  it('uszkodzone nadpisanie czyta się jako brak nadpisania', () => {
    expect(punktOdbioru(surowyWiersz({ wysylka_reczna_json: '{niedomkniety' }))).toBe('WRO10B');
  });

  it('poprawiony kod JEST oznaczany na karcie jako zmiana ręczna', () => {
    const w = surowyWiersz({
      wysylka_reczna_json: nadpisanie({ metoda: 'inpost_paczkomat', pobranie: 0, punkt_odbioru: 'JAB03M' }),
    });
    expect(metodaZmienionaRecznie(w)).toBe(true);
  });
});

describe('sprawdzZmianeMetody — kod punktu przechodzi przez tę samą bramkę', () => {
  it('zapisuje kod razem z metodą i pobraniem', () => {
    expect(sprawdzZmianeMetody('inpost_paczkomat', false, '', 'WRO10B')).toEqual({
      nadpisanie: { metoda: 'inpost_paczkomat', pobranie: 0, punkt_odbioru: 'WRO10B' }, blad: null,
    });
    expect(sprawdzZmianeMetody('inpost_paczkomat', true, '212.90', 'WRO10B').nadpisanie).toEqual({
      metoda: 'inpost_paczkomat', pobranie: 1, kwota_pobrania: '212.90', punkt_odbioru: 'WRO10B',
    });
  });

  // Ta sama rodzina normalizacji, co telefon bez `+48`: kod przepisany z uwag klienta
  // malymi literami zostalby przez ShipX odrzucony.
  it('kod przycina i podnosi do wielkich liter', () => {
    expect(sprawdzZmianeMetody('inpost_paczkomat', false, '', ' wro10b ').nadpisanie.punkt_odbioru).toBe('WRO10B');
  });

  it('pusty kod nie zapisuje klucza w ogóle', () => {
    expect(sprawdzZmianeMetody('inpost_paczkomat', false, '', '  ').nadpisanie)
      .toEqual({ metoda: 'inpost_paczkomat', pobranie: 0 });
    expect(sprawdzZmianeMetody('inpost_paczkomat', false, '').nadpisanie)
      .toEqual({ metoda: 'inpost_paczkomat', pobranie: 0 });
  });

  // Kod zostawiony przy przelaczeniu na DPD bylby smieciem udajacym adres.
  it('kod przy metodzie, która punktu odbioru nie ma, jest pomijany', () => {
    expect(sprawdzZmianeMetody('dpd', false, '', 'WRO10B').nadpisanie)
      .toEqual({ metoda: 'dpd', pobranie: 0 });
  });

  // Paczkomat NIE jest wyjatkiem od bramki na pieniadze — te same odmowy, co przy DPD.
  it('paczkomat za pobraniem bez kwoty dostaje odmowę', () => {
    const { nadpisanie: n, blad } = sprawdzZmianeMetody('inpost_paczkomat', true, '', 'WRO10B');
    expect(n).toBeNull();
    expect(blad).toMatch(/kwot[ęy] pobrania/i);
  });
});

// ⚠️ Zadanie 8 dodało paczkomatom WLASNY powod pominiecia („paczkomat — nadaj pojedynczo").
// Tu pilnujemy rzeczy wazniejszej i wczesniejszej: dopisanie metody do METODY_WYSYLKI NIE MA
// PRAWA wpuscic paczkomatow do nadania zbiorczego przez biala liste METODY_HURTEM. Dziesiec
// przesylek razy kilkanascie sekund to ponad dwie minuty w jednym zadaniu HTTP, a urwanie
// w polowie zostawia wiersze `w_trakcie`, ktore blokuja ponowienie.
// PRZ-070 (właściciel 14.10.2026): paczkomat WCHODZI do hurtu — nie przez biała listę, tylko przez
// te same funkcje, co karta. Czas pilnuje budżet partii (services/nadanie-hurtem.js: pętla
// przestaje ZACZYNAĆ paczki po 150 s), a wiersz `w_trakcie` dokańcza „Sprawdź ponownie".
describe('nadanie zbiorcze a paczkomaty', () => {
  it('zamówienie paczkomatowe z kodem idzie do nadania jako paczkomat', () => {
    const z = {
      id: 1, numer: '28079', metoda_wysylki: 'inpost_paczkomat', pobranie: 0,
      punkt_odbioru: 'WRO10B', przesylki: [], oplacone_at: '2026-08-01T10:00:00Z',
    };
    const { doNadania, pominiete } = podzielDoNadania([z]);
    expect(pominiete).toEqual([]);
    expect(doNadania).toHaveLength(1);
    expect(doNadania[0].rodzajFormularza).toBe('paczkomat');
  });
});
