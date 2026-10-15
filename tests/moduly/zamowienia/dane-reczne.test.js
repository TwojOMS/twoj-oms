import { potwierdzOdmoweHistorycznegoSchema } from '../../pomoc/baseline-historyczne.js';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import {
  zapiszZamowienie, pobierzZamowienie,
  zapiszNadpisaniaWysylki, zapiszNadpisaniaFaktury, przywrocDaneZeSklepu,
} from '../../../src/oms/db/zamowienia.js';
import { createWooAdapter } from '../../../src/oms/woo/adapter.js';
import { createPoller } from '../../../src/moduly/kanaly/services/poller.js';
import { createFaktura } from '../../../src/moduly/faktury/services/faktura.js';
import { adresOdbiorcy, adresZeSklepu, polaReczneAdresu } from '../../../src/domena/adres-odbiorcy.js';
import {
  daneFaktury, daneFakturyZeSklepu, polaReczneFaktury, chceFakture,
} from '../../../src/domena/dane-faktury.js';
import { roznice, sklejUlice } from '../../../src/domena/dane-reczne.js';

const zmapowane = (nad = {}) => ({
  zrodlo_id: 1501, numer: '1501',
  klient: {
    first_name: 'Jan', last_name: 'Kowalski', company: 'ACME sp. z o.o.', email: 'j@k.pl',
    phone: '+48500600700', address_1: 'Polna 1', postcode: '00-650', city: 'Pęki', country: 'PL',
  },
  dostawa: { first_name: 'Jan', last_name: 'Kowalski', company: '', address_1: 'Polna 1', postcode: '00-650', city: 'Pęki', country: 'PL' },
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 1, nip: '1000001201',
  kwota_brutto: '123.00', koszt_dostawy_brutto: '0.00', status_woo: 'processing',
  oplacone_at: null, anulowane: 0, utworzone_at: '2026-07-29T13:19:52',
  pozycje: [{ nazwa: 'STOP', sku: 'PRO-STOP-001', ilosc: 1, cena_brutto: '123.00', brutto_linii: '123.00', vat: null }],
  ...nad,
});

let db;
beforeEach(() => { db = openOmsDb(':memory:'); });

// ---------------------------------------------------------------------------------
// Migracja. Na produkcji lezy ZYWA baza z prawdziwym zamowieniem i prawdziwa przesylka —
// dolozenie kolumn nie jest cwiczeniem. Test idzie na PLIK, bo dwa razy ':memory:' to dwie
// osobne bazy i nie sprawdzaloby to niczego.
// ---------------------------------------------------------------------------------

describe('migracja kolumn z ręcznymi poprawkami', () => {
  const plikBazy = () => join(mkdtempSync(join(tmpdir(), 'oms-dane-')), 'oms.sqlite');

  it('dokłada trzy kolumny do bazy założonej wcześniej, nie ruszając danych', () => {
    // Wyjątek zatwierdzony przez właściciela 2026-09-30: odmowa niezgodnego baseline + prawidłowe reopen.
    potwierdzOdmoweHistorycznegoSchema(["ALTER TABLE zamowienia DROP COLUMN dostawa_reczna_json","ALTER TABLE zamowienia DROP COLUMN klient_reczny_json","ALTER TABLE zamowienia DROP COLUMN chce_fakture_reczne"], ['dostawa_reczna_json', 'klient_reczny_json', 'chce_fakture_reczne']);
    const plik = plikBazy();
    const pierwsza = openOmsDb(plik);
    const id = zapiszZamowienie(pierwsza, 'pro', zmapowane(), {});
    // Poprawny baseline zawiera kolumny; reopen zachowuje dane zamówienia.
    pierwsza.close();

    const druga = openOmsDb(plik);
    const kolumny = druga.prepare('PRAGMA table_info(zamowienia)').all().map((k) => k.name);
    expect(kolumny).toContain('dostawa_reczna_json');
    expect(kolumny).toContain('klient_reczny_json');
    expect(kolumny).toContain('chce_fakture_reczne');
    // Zamowienie przezylo, a brak poprawek znaczy DOKLADNIE dzisiejsze zachowanie.
    const z = pobierzZamowienie(druga, id);
    expect(z.numer).toBe('1501');
    expect(adresOdbiorcy(z)).toEqual(adresZeSklepu(z));
    expect(chceFakture(z)).toBe(true);
    druga.close();
  });

  it('drugie otwarcie bazy nie kasuje zapisanych poprawek', () => {
    const plik = plikBazy();
    const pierwsza = openOmsDb(plik);
    const id = zapiszZamowienie(pierwsza, 'pro', zmapowane(), {});
    zapiszNadpisaniaWysylki(pierwsza, id, { kod: '00-651' });
    pierwsza.close();

    const druga = openOmsDb(plik);
    expect(adresOdbiorcy(pobierzZamowienie(druga, id)).kod).toBe('00-651');
    druga.close();
  });
});

// ---------------------------------------------------------------------------------
// Odczyt: wartosc reczna, jesli jest; w przeciwnym razie ze sklepu.
// ---------------------------------------------------------------------------------

describe('adresOdbiorcy — nadpisania ręczne', () => {
  it('bez nadpisań oddaje dokładnie dane ze sklepu', () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    const z = pobierzZamowienie(db, id);
    expect(adresOdbiorcy(z)).toEqual(adresZeSklepu(z));
  });

  it('nadpisane pole wygrywa ze sklepem', () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    zapiszNadpisaniaWysylki(db, id, { kod: '00-651' });
    expect(adresOdbiorcy(pobierzZamowienie(db, id)).kod).toBe('00-651');
  });

  // ⚠️ SEDNO nadpisania POLOWEGO. Poprawka jednego kodu pocztowego NIE MOZE zamrozic
  // reszty danych: zmiana nazwiska w sklepie ma dalej dochodzic.
  it('nienadpisane pola dalej płyną ze sklepu po zmianie w sklepie', () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    zapiszNadpisaniaWysylki(db, id, { kod: '00-651' });
    const wSklepie = zmapowane();
    wSklepie.dostawa = { ...wSklepie.dostawa, last_name: 'Nowak' };
    zapiszZamowienie(db, 'pro', wSklepie, {});
    const a = adresOdbiorcy(pobierzZamowienie(db, id));
    expect(a.nazwa).toBe('Jan Nowak');
    expect(a.kod).toBe('00-651');
  });

  it('nadpisanie na wartość pustą czyści pole (a nie wraca do sklepu)', () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    zapiszNadpisaniaWysylki(db, id, { phone: null });
    expect(adresOdbiorcy(pobierzZamowienie(db, id)).phone).toBeNull();
  });

  // ⚠️ ZMIENIONE 2026-08-05. Dawniej ta funkcja podstawiała pod `company` nadpisane
  // nazwisko (DPD wymaga niepustego <company>) — i przez to pole „Firma" na karcie
  // pokazywało nazwisko przy każdym zamówieniu od osoby prywatnej. Fallback zjechał na
  // granicę kuriera; że poprawione nazwisko dalej trafia na etykietę W OBU polach, pilnuje
  // tests/oms/adres-firma-fallback.test.js („poprawione ręcznie nazwisko wchodzi w <company>").
  it('nadpisane imię i nazwisko NIE wchodzi już w pole firmy — to zostaje puste', () => {
    const bezFirmy = zmapowane({ klient: { first_name: 'Jan', last_name: 'Kowalski', email: 'j@k.pl' } });
    const id = zapiszZamowienie(db, 'pro', bezFirmy, {});
    zapiszNadpisaniaWysylki(db, id, { nazwa: 'Anna Nowak' });
    const a = adresOdbiorcy(pobierzZamowienie(db, id));
    expect(a.nazwa).toBe('Anna Nowak');
    expect(a.company).toBeNull();
  });

  it('uszkodzony JSON nadpisań nie wywala karty — czytamy wtedy sam sklep', () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    db.prepare('UPDATE zamowienia SET dostawa_reczna_json = ? WHERE id = ?').run('{to nie jest json', id);
    const z = pobierzZamowienie(db, id);
    expect(() => adresOdbiorcy(z)).not.toThrow();
    expect(adresOdbiorcy(z).kod).toBe('00-650');
  });
});

describe('polaReczneAdresu — oznaczenie „zmienione ręcznie"', () => {
  it('bez nadpisań — pusta lista', () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    expect(polaReczneAdresu(pobierzZamowienie(db, id))).toEqual([]);
  });

  it('zgłasza WYŁĄCZNIE pole odbiegające od sklepu', () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    zapiszNadpisaniaWysylki(db, id, { kod: '00-651' });
    expect(polaReczneAdresu(pobierzZamowienie(db, id))).toEqual(['kod']);
  });

  // Sklep dogonil reczna poprawke — od tej chwili nie ma juz czego oznaczac, bo pole
  // NIE odbiega od sklepu.
  it('nadpisanie równe wartości ze sklepu nie jest oznaczane', () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    zapiszNadpisaniaWysylki(db, id, { kod: '00-650' });
    expect(polaReczneAdresu(pobierzZamowienie(db, id))).toEqual([]);
  });
});

describe('daneFaktury — nadpisania ręczne', () => {
  it('bez nadpisań oddaje dane ze sklepu', () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    const z = pobierzZamowienie(db, id);
    expect(daneFaktury(z)).toEqual(daneFakturyZeSklepu(z));
    expect(daneFaktury(z).nip).toBe('1000001201');
    expect(daneFaktury(z).firma).toBe('ACME sp. z o.o.');
  });

  it('nadpisany NIP i nazwa firmy wygrywają ze sklepem', () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    zapiszNadpisaniaFaktury(db, id, { nip: '5252445556', firma: 'BETA sp. z o.o.' }, null);
    const d = daneFaktury(pobierzZamowienie(db, id));
    expect(d.nip).toBe('5252445556');
    expect(d.firma).toBe('BETA sp. z o.o.');
  });

  it('nienadpisane pola faktury dalej płyną ze sklepu', () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    zapiszNadpisaniaFaktury(db, id, { nip: '5252445556' }, null);
    const wSklepie = zmapowane();
    wSklepie.klient = { ...wSklepie.klient, city: 'Oświęcim' };
    zapiszZamowienie(db, 'pro', wSklepie, {});
    const d = daneFaktury(pobierzZamowienie(db, id));
    expect(d.miasto).toBe('Oświęcim');
    expect(d.nip).toBe('5252445556');
  });

  it('polaReczneFaktury zgłasza wyłącznie pole odbiegające od sklepu', () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    zapiszNadpisaniaFaktury(db, id, { nip: '5252445556' }, null);
    expect(polaReczneFaktury(pobierzZamowienie(db, id))).toEqual(['nip']);
  });
});

describe('chceFakture — przełącznik ręczny', () => {
  it('bez nadpisania oddaje wartość ze sklepu', () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane({ chce_fakture: 0, nip: null }), {});
    expect(chceFakture(pobierzZamowienie(db, id))).toBe(false);
  });

  // „Ktos nie zaznaczy opcji i pozniej pisze albo dzwoni, ze potrzebuje FV".
  it('włączony ręcznie wygrywa ze sklepowym „nie chce"', () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane({ chce_fakture: 0, nip: null }), {});
    zapiszNadpisaniaFaktury(db, id, {}, 1);
    expect(chceFakture(pobierzZamowienie(db, id))).toBe(true);
  });

  // Wylaczenie MUSI dzialac tak samo jak wlaczenie: 0 to wartosc, nie brak wartosci.
  it('wyłączony ręcznie wygrywa ze sklepowym „chce"', () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    zapiszNadpisaniaFaktury(db, id, {}, 0);
    expect(chceFakture(pobierzZamowienie(db, id))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------
// sklejUlice() — sklep na pro.szkicownia.pl rozbija adres na address_1 (ulica) i
// address_2 (numer budynku). Zamowienie 1275 z briefu: address_1='Lipowa',
// address_2='91' — panel czytal dotad WYLACZNIE address_1 i gubil numer budynku.
// ---------------------------------------------------------------------------------

describe('sklejUlice', () => {
  it('skleja ulicę i numer budynku jedną spacją (zamówienie 1275 z briefu)', () => {
    expect(sklejUlice('Lipowa', '91')).toBe('Lipowa 91');
  });

  it('sam address_1, bez address_2 (pusty string) — dokładnie ulica, bez spacji na końcu', () => {
    expect(sklejUlice('3 maja 22', '')).toBe('3 maja 22');
  });

  it('sam address_1, address_2 == null — dokładnie ulica', () => {
    expect(sklejUlice('Wysyłkowa 123', null)).toBe('Wysyłkowa 123');
  });

  it('sam address_1, address_2 nieustawione (undefined) — dokładnie ulica', () => {
    expect(sklejUlice('Wysyłkowa 123', undefined)).toBe('Wysyłkowa 123');
  });

  it('address_2 same białe znaki — traktowane jak puste, bez spacji na końcu', () => {
    expect(sklejUlice('Lipowa', '   ')).toBe('Lipowa');
  });

  it('przycina białe znaki z obu części przed sklejeniem, bez podwójnej spacji', () => {
    expect(sklejUlice('  Lipowa  ', '  91  ')).toBe('Lipowa 91');
  });

  it('oba puste — null, nie pusty string ani sama spacja', () => {
    expect(sklejUlice('', '')).toBeNull();
    expect(sklejUlice(null, null)).toBeNull();
    expect(sklejUlice(undefined, undefined)).toBeNull();
  });

  it('pusty address_1, samo address_2 — oddaje sam numer, bez wiodącej spacji', () => {
    expect(sklejUlice('', '91')).toBe('91');
  });
});

// ---------------------------------------------------------------------------------
// roznice() — to ONA pilnuje, ze zapisujemy WYLACZNIE zmienione pola.
// ---------------------------------------------------------------------------------

describe('roznice', () => {
  const POLA = ['ulica', 'kod', 'miasto'];

  it('formularz identyczny ze sklepem → żadnego nadpisania', () => {
    expect(roznice({ ulica: 'Polna 1', kod: '00-650', miasto: 'Pęki' }, { ulica: 'Polna 1', kod: '00-650', miasto: 'Pęki' }, POLA)).toEqual({});
  });

  it('zmienione jedno pole → nadpisanie tylko tego jednego', () => {
    expect(roznice({ ulica: 'Polna 1', kod: '00-650', miasto: 'Pęki' }, { ulica: 'Polna 1', kod: '00-651', miasto: 'Pęki' }, POLA)).toEqual({ kod: '00-651' });
  });

  it('puste pole ze sklepu i puste w formularzu to ta sama wartość', () => {
    expect(roznice({ ulica: null }, { ulica: '  ' }, ['ulica'])).toEqual({});
  });

  it('wyczyszczenie pola jest nadpisaniem na null', () => {
    expect(roznice({ ulica: 'Polna 1' }, { ulica: '' }, ['ulica'])).toEqual({ ulica: null });
  });
});

// ---------------------------------------------------------------------------------
// ⚠️ NAJWAZNIEJSZY TEST CALEGO ZADANIA: poller nadpisuje dane zamowienia co dwie minuty.
// Poprawka zapisana w polu, ktore synchronizacja przepisuje ze sklepu, dzialalaby
// w testach jednostkowych i znikala na produkcji.
// ---------------------------------------------------------------------------------

describe('ręczne poprawki a synchronizacja ze sklepem', () => {
  const surowe = (nad = {}) => ({
    id: 1501, number: '1501', status: 'processing', total: '123.00',
    date_created: '2026-07-29T10:00:00', date_modified: '2026-07-29T11:00:00', date_modified_gmt: '2026-07-29T09:00:00',
    billing: { first_name: 'Jan', last_name: 'Kowalski', company: 'ACME sp. z o.o.', email: 'j@k.pl', address_1: 'Polna 1', postcode: '00-650', city: 'Pęki', country: 'PL' },
    shipping: { first_name: 'Jan', last_name: 'Kowalski', address_1: 'Polna 1', postcode: '00-650', city: 'Pęki', country: 'PL' },
    shipping_lines: [{ method_id: 'flat_rate', instance_id: '1' }],
    line_items: [], meta_data: [{ key: '_billing_nip', value: '1000001201' }],
    ...nad,
  });

  it('pełny przebieg pollera NIE kasuje ręcznych poprawek', async () => {
    const woo = { pobierzZamowienia: vi.fn().mockResolvedValue({ zamowienia: [surowe()], stron: 1 }) };
    const poller = createPoller({ db, kanal: createWooAdapter({ woo, mapowanie: { instancje: { 1: { metoda: 'dpd' } }, poPozycji: [] } }), sklep: 'pro' });
    await poller.przebieg();

    const id = db.prepare('SELECT id FROM zamowienia').get().id;
    zapiszNadpisaniaWysylki(db, id, { kod: '00-651', miasto: 'Nowa Wieś' });
    zapiszNadpisaniaFaktury(db, id, { nip: '5252445556' }, 0);

    // Drugi przebieg — dokladnie to, co dzieje sie na produkcji co dwie minuty.
    await poller.przebieg();

    const z = pobierzZamowienie(db, id);
    expect(adresOdbiorcy(z).kod).toBe('00-651');
    expect(adresOdbiorcy(z).miasto).toBe('Nowa Wieś');
    expect(daneFaktury(z).nip).toBe('5252445556');
    expect(chceFakture(z)).toBe(false);
  });

  it('zapiszZamowienie nie dotyka kolumn z ręcznymi poprawkami', () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    zapiszNadpisaniaWysylki(db, id, { kod: '00-651' });
    zapiszNadpisaniaFaktury(db, id, { nip: '5252445556' }, 1);
    zapiszZamowienie(db, 'pro', zmapowane(), {});
    const w = db.prepare('SELECT * FROM zamowienia WHERE id = ?').get(id);
    expect(JSON.parse(w.dostawa_reczna_json)).toEqual({ kod: '00-651' });
    expect(JSON.parse(w.klient_reczny_json)).toEqual({ nip: '5252445556' });
    expect(w.chce_fakture_reczne).toBe(1);
  });
});

// ---------------------------------------------------------------------------------
// Wyjscie ze stanu, z ktorego panel sam by nie wyszedl.
// ---------------------------------------------------------------------------------

describe('przywrocDaneZeSklepu', () => {
  it('kasuje WSZYSTKIE nadpisania — adres, fakturę i przełącznik', () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    zapiszNadpisaniaWysylki(db, id, { kod: '00-651' });
    zapiszNadpisaniaFaktury(db, id, { nip: '5252445556' }, 0);
    przywrocDaneZeSklepu(db, id);
    const z = pobierzZamowienie(db, id);
    expect(adresOdbiorcy(z).kod).toBe('00-650');
    expect(daneFaktury(z).nip).toBe('1000001201');
    expect(chceFakture(z)).toBe(true);
    expect(polaReczneAdresu(z)).toEqual([]);
    expect(polaReczneFaktury(z)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------
// Faktura MUSI czytac dane z karty, nie ze sklepu.
// ---------------------------------------------------------------------------------

describe('faktura czyta poprawione dane klienta', () => {
  const zestaw = (atrapy = {}) => {
    const infakt = {
      znajdzKlientaPoNip: atrapy.znajdz ?? vi.fn().mockResolvedValue(null),
      zalozKlienta: atrapy.zaloz ?? vi.fn().mockResolvedValue(555),
      wystaw: atrapy.wystaw ?? vi.fn().mockResolvedValue({ uuid: 'u1', numer: 'FV/1/2026', ksefStatus: null }),
    };
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    return { infakt, id, faktura: createFaktura({ db, infakt }) };
  };

  it('szuka nabywcy po NIP-ie POPRAWIONYM ręcznie', async () => {
    const znajdz = vi.fn().mockResolvedValue(7);
    const { infakt, faktura, id } = zestaw({ znajdz });
    zapiszNadpisaniaFaktury(db, id, { nip: '5252445556' }, null);
    await faktura.wystaw(id);
    expect(infakt.znajdzKlientaPoNip).toHaveBeenCalledWith('5252445556');
  });

  it('zakłada nabywcę z POPRAWIONĄ nazwą, adresem i NIP-em', async () => {
    const { infakt, faktura, id } = zestaw();
    zapiszNadpisaniaFaktury(db, id, {
      firma: 'BETA sp. z o.o.', nip: '5252445556', ulica: 'Lipowa 7', kod: '00-651', miasto: 'Oświęcim',
    }, null);
    await faktura.wystaw(id);
    expect(infakt.zalozKlienta).toHaveBeenCalledWith(expect.objectContaining({
      company_name: 'BETA sp. z o.o.', nip: '5252445556', street: 'Lipowa 7', postal_code: '00-651', city: 'Oświęcim',
    }));
  });

  // Wlasnie po to jest przelacznik: klient nie zaznaczyl opcji w sklepie, a potem
  // zadzwonil po fakture.
  it('przełącznik „chce fakturę" włączony ręcznie odblokowuje wystawienie', async () => {
    const infakt = {
      znajdzKlientaPoNip: vi.fn().mockResolvedValue(7),
      zalozKlienta: vi.fn(),
      wystaw: vi.fn().mockResolvedValue({ uuid: 'u1', numer: 'FV/2/2026', ksefStatus: null }),
    };
    const id = zapiszZamowienie(db, 'pro', zmapowane({ chce_fakture: 0, nip: null }), {});
    const faktura = createFaktura({ db, infakt });
    await expect(faktura.wystaw(id)).rejects.toThrow('Klient nie prosił o fakturę.');
    zapiszNadpisaniaFaktury(db, id, { nip: '1000001201' }, 1);
    await expect(faktura.wystaw(id)).resolves.toBeTruthy();
  });

  it('przełącznik wyłączony ręcznie blokuje wystawienie mimo NIP-u ze sklepu', async () => {
    const { faktura, id } = zestaw();
    zapiszNadpisaniaFaktury(db, id, {}, 0);
    await expect(faktura.wystaw(id)).rejects.toThrow('Klient nie prosił o fakturę.');
  });
});
