import { describe, it, expect } from 'vitest';
import {
  MAPOWANIE_SKLEPOW, metodaZLinii, metodaZPozycji, metodaWysylkiZamowienia,
} from '../pomoc/mapowanie-sklepow-historyczne-fixture.js';
import { METODY_WYSYLKI } from '../../src/domena/wysylka.js';
import { mapujZamowienie } from '../../src/domena/mapowanie.js';

const SZKICOWNIA = MAPOWANIE_SKLEPOW.szkicownia;

// Ksztalty ODWZOROWANE Z ZYWEGO SKLEPU (odczyt 2026-08-01), nie zmyslone.
const zLinia = (instanceId, methodId, tytul) => ({
  id: 1, number: '28079', total: '212.90', status: 'processing',
  shipping_lines: [{ instance_id: instanceId, method_id: methodId, method_title: tytul }],
  line_items: [{ name: 'lampa wisząca', sku: 'x', quantity: 1, total: '212.90' }],
});

const zOferty = () => ({
  id: 2, number: '28163', total: '386.00', status: 'processing',
  shipping_lines: [],
  line_items: [
    { name: 'Lampa wisząca Kopuła 40 cm, stal malowana', sku: 'sz-1', quantity: 2, total: '300.00' },
    { name: 'wysyłka kurierem DPD', sku: 'psm-zam-placeholder', quantity: 1, total: '0.00' },
  ],
});

describe('metodaZLinii — droga główna, po instance_id', () => {
  it('flexible_shipping instancji 3 to kurier DPD', () => {
    expect(metodaZLinii(zLinia(3, 'flexible_shipping', 'Kurier DPD'), SZKICOWNIA.instancje))
      .toEqual({ metoda: 'dpd' });
  });

  // ⚠️⚠️ SEDNO CALEJ TABLICY. Ta instancja nazywa sie „Kurier DPD pobranie", ale jej
  // `method_id` to `local_pickup` — w WooCommerce „odbior osobisty". Panel czytajacy RODZAJ
  // metody wyslalby te paczke BEZ pobrania: kurier nie zainkasowalby ani zlotowki.
  it('local_pickup instancji 9 to POBRANIE, mimo że WooCommerce nazywa to odbiorem osobistym', () => {
    expect(metodaZLinii(zLinia(9, 'local_pickup', 'Kurier DPD pobranie'), SZKICOWNIA.instancje))
      .toEqual({ metoda: 'dpd', pobranie: true });
  });

  // Ten sam tytul co wyzej, ale INNA instancja — gdyby mapowanie szlo po tytule, obie
  // dostalyby to samo.
  it('ten sam tytuł na innej instancji NIE daje pobrania', () => {
    expect(metodaZLinii(zLinia(3, 'local_pickup', 'Kurier DPD pobranie'), SZKICOWNIA.instancje))
      .toEqual({ metoda: 'dpd' });
  });

  // Od 2026-08-01 (Etap 2) panel umie paczkomaty — instancja 12 przestala byc „nieznana".
  // ⚠️ BEZ pobrania: sklep nie sprzedaje dzis paczkomatu za pobraniem. Pelny komplet
  // testow paczkomatowych siedzi w tests/oms/paczkomat.test.js.
  it('paczkomat (instancja 12) to InPost Paczkomat, bez pobrania', () => {
    expect(metodaZLinii(zLinia(12, 'easypack_parcel_machines', 'InPost Paczkomat'), SZKICOWNIA.instancje))
      .toEqual({ metoda: 'inpost_paczkomat' });
  });

  it('brak linii wysyłki to „nie wiem", nie błąd', () => {
    expect(metodaZLinii(zOferty(), SZKICOWNIA.instancje)).toBeNull();
    expect(metodaZLinii({}, SZKICOWNIA.instancje)).toBeNull();
  });
});

describe('metodaZPozycji — warstwa zapasowa, gdy sklep nie zapisał metody', () => {
  // Zamowienia zlozone z oferty (panel indywidualny) nie maja `shipping_lines` w ogole —
  // wysylka jest tam zwykla pozycja. W probce z zywego sklepu to 14 z 21 zamowien.
  it('rozpoznaje wysyłkę sprzedaną jako pozycja, po SKU zaślepki', () => {
    expect(metodaZPozycji(zOferty(), SZKICOWNIA.poPozycji)).toMatchObject({ metoda: 'dpd' });
  });

  it('zamówienie bez takiej pozycji zostaje nierozpoznane', () => {
    const bez = { line_items: [{ name: 'lampa', sku: 'sz-9' }] };
    expect(metodaZPozycji(bez, SZKICOWNIA.poPozycji)).toBeNull();
  });

  it('dopasowanie po SKU nie zależy od wielkości liter', () => {
    const z = { line_items: [{ name: 'x', sku: 'PSM-ZAM-Placeholder' }] };
    expect(metodaZPozycji(z, SZKICOWNIA.poPozycji)).toMatchObject({ metoda: 'dpd' });
  });

  it('reguła po fragmencie nazwy też działa', () => {
    const reguly = [{ nazwaZawiera: 'paczkomat', metoda: 'dpd' }];
    expect(metodaZPozycji({ line_items: [{ name: 'Wysyłka PACZKOMAT InPost' }] }, reguly))
      .toMatchObject({ metoda: 'dpd' });
  });

  it('pusta tablica reguł nie rozpoznaje niczego', () => {
    expect(metodaZPozycji(zOferty(), [])).toBeNull();
    expect(metodaZPozycji(zOferty(), undefined)).toBeNull();
  });
});

describe('metodaWysylkiZamowienia — jedno wejście dla panelu', () => {
  // ⚠️ KOLEJNOSC WARSTW MA ZNACZENIE. Linia wysylki jest jedyna PEWNA dana; pozycja to
  // zgadywanie po nazwie. Odwrocenie kolejnosci znaczyloby, ze zamowienie z prawdziwym
  // pobraniem, ktore ma przy okazji pozycje-zaslepke, wyszloby jako zwykle „dpd" —
  // czyli paczka bez pobrania.
  it('linia wysyłki WYGRYWA z regułą po pozycji', () => {
    const mieszane = {
      ...zLinia(9, 'local_pickup', 'Kurier DPD pobranie'),
      line_items: [{ name: 'wysyłka kurierem DPD', sku: 'psm-zam-placeholder' }],
    };
    expect(metodaWysylkiZamowienia(mieszane, SZKICOWNIA)).toEqual({ metoda: 'dpd', pobranie: true });
  });

  it('bez linii wysyłki schodzi do reguły po pozycji', () => {
    expect(metodaWysylkiZamowienia(zOferty(), SZKICOWNIA)).toEqual({ metoda: 'dpd', pobranie: false });
  });

  // „nieznana" jest PELNOPRAWNYM wynikiem: karta pokazuje „nadaj w Apilo", nadanie odmawia,
  // a operator moze ustawic metode recznie.
  it('zamówienie bez żadnego śladu wysyłki wychodzi jako „nieznana"', () => {
    expect(metodaWysylkiZamowienia({ line_items: [{ name: 'lampa', sku: 'sz-1' }] }, SZKICOWNIA))
      .toEqual({ metoda: 'nieznana', pobranie: false });
  });

  // Literowka w tablicy nie ma prawa wpuscic do bazy wartosci, ktorej nie zna reszta modulu.
  it('śmieć w tablicy nie przecieka do bazy', () => {
    const zepsute = { instancje: { 3: { metoda: 'teleport' } }, poPozycji: [] };
    expect(metodaWysylkiZamowienia(zLinia(3, 'flexible_shipping', 'x'), zepsute))
      .toEqual({ metoda: 'nieznana', pobranie: false });
  });

  it('każdy możliwy wynik jest wartością, którą rozumie reszta panelu', () => {
    for (const sklep of Object.values(MAPOWANIE_SKLEPOW)) {
      for (const wpis of Object.values(sklep.instancje)) expect(METODY_WYSYLKI).toContain(wpis.metoda);
      for (const r of sklep.poPozycji) expect(METODY_WYSYLKI).toContain(r.metoda);
    }
  });
});

// ⚠️ Test przez PRAWDZIWA sciezke mapowania zamowienia — mutacja w `mapujZamowienie`
// (np. pominiecie warstwy zapasowej) nie ma jak wpasc na testy samej domeny wyzej.
describe('mapujZamowienie — kwota pobrania idzie za rozpoznaną metodą', () => {
  it('zamówienie z oferty dostaje kuriera i NIE dostaje pobrania', () => {
    const z = mapujZamowienie(zOferty(), SZKICOWNIA);
    expect(z.metoda_wysylki).toBe('dpd');
    expect(z.pobranie).toBe(0);
    expect(z.kwota_pobrania).toBeNull();
  });

  // To sa pieniadze, ktore inkasuje kurier: przy pobraniu kwota MUSI byc calym zamowieniem.
  it('pobranie z instancji 9 niesie kwotę całego zamówienia', () => {
    const z = mapujZamowienie(zLinia(9, 'local_pickup', 'Kurier DPD pobranie'), SZKICOWNIA);
    expect(z.metoda_wysylki).toBe('dpd');
    expect(z.pobranie).toBe(1);
    expect(z.kwota_pobrania).toBe('212.90');
  });

  // ⚠️ Nierozpoznana dostawa NIE MOZE niesc pobrania — panel i tak jej nie nada, a
  // „nieznana + pobranie" wygladaloby na paczke, za ktora kurier ma cos zainkasowac.
  // (Instancja 12 przestala byc nierozpoznana 2026-08-01, wiec reguly pilnuje instancja
  // wylaczona w sklepie — 6 — i to jest wlasciwsze miejsce: chodzi o KAZDA nieznana metode.)
  it('nierozpoznana dostawa nie dostaje ani kuriera, ani kwoty pobrania', () => {
    const z = mapujZamowienie(zLinia(6, 'flat_rate', 'Metoda wyłączona w sklepie'), SZKICOWNIA);
    expect(z.metoda_wysylki).toBe('nieznana');
    expect(z.pobranie).toBe(0);
    expect(z.kwota_pobrania).toBeNull();
  });
});

// ============================================================================
// PRO PO PRZEPROWADZCE WTYCZKI — 2026-08-21, zgłoszenie właściciela: „metoda wysyłki
// w zamówieniu z panelu indyw jest nieznana w OMS, powinno wykrywać DPD".
//
// Wtyczka ofert przeniosła się na pro.szkicownia.pl 19.08. Reguła po pozycji istniała
// WYŁĄCZNIE pod `szkicownia` — bo tam wtedy stała wtyczka — więc pierwsze zamówienie z oferty
// złożone na PRO (nr 1294) wylądowało jako „Nieznana metoda": sklep nie daje ani jednej linii
// wysyłki, a warstwa zapasowa dla PRO była pusta.
// ============================================================================
const PRO = MAPOWANIE_SKLEPOW.pro;

const zOfertyPro = (pozycje) => ({
  id: 3, number: '1294', total: '32.16', status: 'processing',
  shipping_lines: [],
  line_items: pozycje,
});

describe('PRO — zamówienie z oferty (wtyczka od 19.08.2026)', () => {
  it('bez linii wysyłki schodzi do reguły po pozycji i daje DPD', () => {
    const z = zOfertyPro([
      { name: 'Lampa wisząca Szpulka 50cm', sku: 'psm-zam-placeholder', quantity: 1, total: '12.00' },
      { name: 'wysyłka kurierem DPD', sku: 'psm-zam-placeholder', quantity: 1, total: '2.00' },
    ]);
    expect(metodaWysylkiZamowienia(z, PRO)).toEqual({ metoda: 'dpd', pobranie: false });
  });

  // ⚠️ Oferta BEZ osobnej pozycji transportowej (nr 1297 — projekt plus lampa, nic więcej)
  // też jedzie kurierem. Reguła dopasowuje po SKU zaślepki, nie po nazwie linii transportowej —
  // dokładnie tak samo, jak od początku działa na szkicownia.pl.
  it('oferta bez pozycji transportowej też daje DPD, nie „nieznaną"', () => {
    const z = zOfertyPro([
      { name: 'Klosz szklany do lamp wiszących 35cm', sku: 'psm-zam-placeholder', quantity: 1, total: '8.90' },
      { name: 'przygotowanie projektu', sku: 'psm-zam-placeholder', quantity: 1, total: '1.23' },
    ]);
    expect(metodaWysylkiZamowienia(z, PRO)).toEqual({ metoda: 'dpd', pobranie: false });
  });

  // ⚠️ GRANICA: zwykły koszyk na PRO ma prawdziwą linię wysyłki i ona dalej WYGRYWA — także
  // wtedy, gdy jest pobraniowa (instancja 2). Reguła po pozycji nie ma prawa jej przykryć.
  it('zwykłe zamówienie z PRO dalej idzie linią wysyłki, z pobraniem włącznie', () => {
    const z = {
      id: 4, number: '1300', total: '99.00', status: 'processing',
      shipping_lines: [{ instance_id: 2, method_id: 'flat_rate', method_title: 'Kurier DPD (pobranie)' }],
      line_items: [{ name: 'lampa', sku: 'PRO-1', quantity: 1, total: '80.00' }],
    };
    expect(metodaWysylkiZamowienia(z, PRO)).toEqual({ metoda: 'dpd', pobranie: true });
  });

  it('zamówienie z PRO bez śladu wysyłki i bez zaślepki dalej jest „nieznane"', () => {
    expect(metodaWysylkiZamowienia({ line_items: [{ name: 'lampa', sku: 'PRO-1' }] }, PRO))
      .toEqual({ metoda: 'nieznana', pobranie: false });
  });
});
