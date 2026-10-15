import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../pomoc/dane-miesieczne-parytetu.js';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { dodajZwrot } from '../../../src/oms/db/zwroty.js';
import { ustawGranice } from '../../../src/oms/db/historia-sprzedazy.js';
import { sprzedazWOkresie, zwrotyWOkresie } from '../../pomoc/raporty-parytetu.js';
import { agreguj } from '../../../src/domena/agregacja-sprzedazy.js';
import { rachunekOkresu, PODLOGA_ZWROTOW } from '../../pomoc/raporty-parytetu.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

// ⚠️ sklep 'pro' → kanalOms (domain/kanaly-raportowe.js, mapa SKLEPY) mapuje na 'SZKICOWNIA_PRO',
// NIE na 'PRO'. Brief mówił 'PRO' — to nazwa, której w kodzie nie ma; poprawione po sprawdzeniu
// src/oms/domain/kanaly-raportowe.js.
const zmapowane = (nad = {}) => ({
  zrodlo_id: 1301, numer: '1301', klient: { email: 'j@k.pl' }, dostawa: {},
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null,
  kwota_brutto: '123.00', status_woo: 'processing', oplacone_at: null, anulowane: 0,
  utworzone_at: '2026-08-01T10:00:00', pozycje: [],
  ...nad,
});

let db; let id;
beforeEach(() => {
  db = openOmsDb(':memory:');
  // ⚠️ granice_historii ma kolumny (kanal, do_dnia, zrodlo, uwaga) — nie (kanal, granica), jak
  // mówił brief. `zrodlo` jest NOT NULL. Uzywamy pomocnika `ustawGranice` (db/historia-sprzedazy.js),
  // tak jak robi to tests/oms/sprzedaz-okresu.test.js, zamiast recznego INSERT-u ze zla nazwa kolumny.
  ustawGranice(db, 'SZKICOWNIA_PRO', '2025-12-31', 'test', null);
  // ⚠️ zapiszZamowienie zwraca PLAIN `id` (liczbe), nie `{ id }` — brief mial `.id` na koncu,
  // co dawaloby `undefined`. Sprawdzone w src/oms/db/zamowienia.js (`return id;`) i potwierdzone
  // wzorcem uzycia w kilkunastu innych testach (np. tests/oms/dane-reczne.test.js).
  id = zapiszZamowienie(db, 'pro', zmapowane(), {});
});

const ZAKRES = { od: '2026-08-01', do: '2026-08-31' };

describe('zwroty w okresie', () => {
  it('zwrot trafia do MIESIACA ZWROTU, nie miesiaca sprzedazy', () => {
    dodajZwrot(db, id, { data: '2026-09-03', kwota: '50.00', pozycje: [] });
    expect(zwrotyWOkresie(db, ZAKRES)).toEqual([]);
    expect(zwrotyWOkresie(db, { od: '2026-09-01', do: '2026-09-30' })).toHaveLength(1);
  });

  it('kwota zwrotu obejmuje dostawe, a netto liczy sie TA SAMA regula co sprzedaz', () => {
    dodajZwrot(db, id, { data: '2026-08-14', kwota: '100.00', kwotaDostawy: '23.00', pozycje: [] });
    const [w] = zwrotyWOkresie(db, ZAKRES);
    expect(w.bruttoGrosze).toBe(12300);
    expect(w.nettoGrosze).toBe(10000);
    expect(w.kanal).toBe('SZKICOWNIA_PRO');
  });

  it('zwrot do zamowienia ANULOWANEGO nie wchodzi do raportu', () => {
    const anul = zapiszZamowienie(db, 'pro', zmapowane({ zrodlo_id: 1302, numer: '1302', anulowane: 1 }), {});
    dodajZwrot(db, anul, { data: '2026-08-14', kwota: '50.00', pozycje: [] });
    expect(zwrotyWOkresie(db, ZAKRES)).toEqual([]);
  });
});

describe('agregacja ze zwrotami', () => {
  it('zwrot pomniejsza sprzedaz, ale NIE zmienia liczby zamowien ani sztuk', () => {
    const wiersze = sprzedazWOkresie(db, ZAKRES);
    const bez = agreguj(wiersze, []);
    const ze = agreguj(wiersze, [{ dzien: '2026-08-14', kanal: 'SZKICOWNIA_PRO', bruttoGrosze: 5000, nettoGrosze: 4065 }]);
    expect(ze.kpi.zamowien).toBe(bez.kpi.zamowien);
    expect(ze.kpi.sztuk).toBe(bez.kpi.sztuk);
    expect(ze.kpi.aovGrosze).toBe(bez.kpi.aovGrosze);
    expect(ze.kpi.zwrotyGrosze).toBe(5000);
    expect(ze.kpi.bruttoPoZwrotachGrosze).toBe(bez.kpi.bruttoGrosze - 5000);
  });

  it('BRAMKA REGRESJI: bez zwrotow agregacja oddaje DOKLADNIE to, co dotad', () => {
    const wiersze = sprzedazWOkresie(db, ZAKRES);
    const a = agreguj(wiersze, []);
    expect(a.kpi.bruttoGrosze).toBe(12300);
    expect(a.kpi.zwrotyGrosze).toBe(0);
    expect(a.kpi.bruttoPoZwrotachGrosze).toBe(a.kpi.bruttoGrosze);
  });
});

// ⚠️ Nazwa describe INNA niz w tests/oms/rachunek-zarzadczy.test.js ('rachunek zarzadczy') —
// vitest nie wymaga unikalnosci nazw miedzy plikami, ale osobna nazwa czyni raport testow
// czytelniejszym przy debugowaniu (widac od razu, ktory plik odpalil ktory opis).
describe('rachunek zarzadczy — zwroty', () => {
  it('przychod jest pomniejszony o zwroty Z TEGO MIESIACA', () => {
    dodajZwrot(db, id, { data: '2026-08-14', kwota: '23.00', pozycje: [] });
    const r = rachunekOkresu(db, ZAKRES);
    // 123,00 brutto = 100,00 netto; zwrot 23,00 brutto = 18,70 netto (zaokraglone jak sprzedaz)
    expect(r.przychodNettoGrosze).toBe(10000 - Math.round(2300 / 1.23));
  });

  it('zwrot z INNEGO miesiaca nie rusza tego rachunku', () => {
    dodajZwrot(db, id, { data: '2026-09-03', kwota: '23.00', pozycje: [] });
    expect(rachunekOkresu(db, ZAKRES).przychodNettoGrosze).toBe(10000);
  });

  it('BRAMKA REGRESJI: bez zwrotow przychod jest DOKLADNIE taki, jak dotad', () => {
    expect(rachunekOkresu(db, ZAKRES).przychodNettoGrosze).toBe(10000);
  });

  it('zwrocona kwota netto jedzie tez osobnym polem w zwracanym obiekcie', () => {
    dodajZwrot(db, id, { data: '2026-08-14', kwota: '23.00', pozycje: [] });
    const r = rachunekOkresu(db, ZAKRES);
    expect(r.zwrotyNettoGrosze).toBe(Math.round(2300 / 1.23));
  });
});

// ⚠️⚠️ ZADANIE 12: `rachunekOkresu` (gorny poziom) juz odejmuje zwroty — ale `rachunekMiesiaca`
// (rozbicie miesiac po miesiacu) i `dochodRoku` (podstawa podatku, sekcja `podatek`) tego NIE
// ROBILY i zostaly poza zakresem Zadania 11. Te testy pokazuja dziure: suma miesiecy przestaje
// zgadzac sie co do grosza z rachunkiem calego okresu, gdy zwroty sa rozlozone na rozne
// miesiace, a podatek liczy sie od przychodu bez zwrotow — wiec wychodzi ZAWYZONY.
describe('rachunek zarzadczy — zwroty w rozbiciu miesiac po miesiacu i w podatku', () => {
  const zam = (nad) => zapiszZamowienie(db, 'pro', zmapowane(nad), {});

  it('suma miesiecy zgadza sie co do grosza z rachunkiem calego okresu, gdy zwroty sa rozlozone na rozne miesiace', () => {
    const idMaj = zam({ zrodlo_id: 3001, numer: '3001', utworzone_at: '2026-05-10T10:00:00', kwota_brutto: '12300.00' }); // netto 1_000_000
    const idCzerwiec = zam({ zrodlo_id: 3002, numer: '3002', utworzone_at: '2026-06-10T10:00:00', kwota_brutto: '24600.00' }); // netto 2_000_000
    dodajZwrot(db, idMaj, { data: '2026-05-20', kwota: '123.00', pozycje: [] }); // zwrot W TYM SAMYM miesiacu, netto 10_000
    dodajZwrot(db, idCzerwiec, { data: '2026-06-25', kwota: '246.00', pozycje: [] }); // netto 20_000
    dodajZwrot(db, idMaj, { data: '2026-06-05', pozycje: [], kwota: '123.00' }); // zwrot majowego zamowienia, ALE datowany na czerwiec

    const r = rachunekOkresu(db, { od: '2026-05-01', do: '2026-06-30' });
    const suma = r.miesiacami.reduce((s, m) => s + m.wynikGrosze, 0);
    expect(suma).toBe(r.wynikGrosze);
    expect(r.przychodNettoGrosze).toBe(2_960_000); // 3_000_000 - (10_000 + 20_000 + 10_000)

    const maj = r.miesiacami.find((m) => m.miesiac === '2026-05');
    const czerwiec = r.miesiacami.find((m) => m.miesiac === '2026-06');
    expect(maj.przychodNettoGrosze).toBe(990_000);        // 1_000_000 - zwrot majowy (10_000)
    expect(czerwiec.przychodNettoGrosze).toBe(1_970_000); // 2_000_000 - (20_000 + 10_000 przekazany z maja)
  });

  it('zwrot z INNEGO miesiaca nie rusza rachunku TEGO miesiaca w rozbiciu miesiac po miesiacu', () => {
    const idMaj = zam({ zrodlo_id: 3101, numer: '3101', utworzone_at: '2026-05-10T10:00:00', kwota_brutto: '12300.00' });
    zam({ zrodlo_id: 3102, numer: '3102', utworzone_at: '2026-06-10T10:00:00', kwota_brutto: '24600.00' });
    // zwrot do MAJOWEGO zamowienia, ale datowany na CZERWIEC
    dodajZwrot(db, idMaj, { data: '2026-06-15', kwota: '123.00', pozycje: [] });

    const r = rachunekOkresu(db, { od: '2026-05-01', do: '2026-06-30' });
    const maj = r.miesiacami.find((m) => m.miesiac === '2026-05');
    const czerwiec = r.miesiacami.find((m) => m.miesiac === '2026-06');
    expect(maj.przychodNettoGrosze).toBe(1_000_000);          // maj NIE dotkniety
    expect(czerwiec.przychodNettoGrosze).toBe(1_990_000);     // 2_000_000 - 10_000, zwrot obciaza czerwiec
  });

  it('zwrot pomniejsza dochod narastajaco (podstawe podatku) W MIESIACU ZWROTU', () => {
    const id = zam({ zrodlo_id: 3201, numer: '3201', utworzone_at: '2026-02-10T10:00:00', kwota_brutto: '24600.00' });
    const bezZwrotu = rachunekOkresu(db, { od: '2026-06-01', do: '2026-06-30' }).podatek.podstawaGrosze;
    dodajZwrot(db, id, { data: '2026-06-15', kwota: '123.00', pozycje: [] });
    const zeZwrotem = rachunekOkresu(db, { od: '2026-06-01', do: '2026-06-30' }).podatek.podstawaGrosze;
    expect(bezZwrotu - zeZwrotem).toBe(10_000);
  });

  it('zwrot NIE pomniejsza dochodu narastajaco PRZED dniem zwrotu', () => {
    // ⚠️ OBA WYWOLANIA MAJA TO SAMO `odStycznia` (styczen–czerwiec, patrz `miesiaceOkresu`:
    // lista miesiecy patrzy na 'RRRR-MM' z `do`, nie na dzien) — wiec skladka spoleczna
    // narastajaco jest W OBU IDENTYCZNA, a jedyna zmienna jest to, czy okno konczy sie PRZED
    // czy PO dacie zwrotu (15 czerwca). Porownanie miesiac-do-miesiaca (maj vs czerwiec) mieszaloby
    // TA roznice ze skladka spoleczna za dodatkowy miesiac — i to jest wlasnie ten blad testu,
    // ktory RED pokazal jako 178900/188900 zamiast 10000.
    const id = zam({ zrodlo_id: 3301, numer: '3301', utworzone_at: '2026-02-10T10:00:00', kwota_brutto: '24600.00' });
    dodajZwrot(db, id, { data: '2026-06-15', kwota: '123.00', pozycje: [] });
    const przedZwrotem = rachunekOkresu(db, { od: '2026-01-01', do: '2026-06-14' }).podatek.podstawaGrosze;
    const poZwrocie = rachunekOkresu(db, { od: '2026-01-01', do: '2026-06-30' }).podatek.podstawaGrosze;
    expect(przedZwrotem - poZwrocie).toBe(10_000);
  });

  it('BRAMKA REGRESJI: bez zwrotow rachunek miesiac po miesiacu i podatek licza sie DOKLADNIE jak dotad', () => {
    zam({ zrodlo_id: 3401, numer: '3401', utworzone_at: '2026-05-10T10:00:00', kwota_brutto: '12300.00' });
    zam({ zrodlo_id: 3402, numer: '3402', utworzone_at: '2026-06-10T10:00:00', kwota_brutto: '24600.00' });
    const r = rachunekOkresu(db, { od: '2026-05-01', do: '2026-06-30' });
    const suma = r.miesiacami.reduce((s, m) => s + m.wynikGrosze, 0);
    expect(suma).toBe(r.wynikGrosze);
    expect(r.przychodNettoGrosze).toBe(3_000_000);
    expect(r.miesiacami.find((m) => m.miesiac === '2026-05').przychodNettoGrosze).toBe(1_000_000);
    expect(r.miesiacami.find((m) => m.miesiac === '2026-06').przychodNettoGrosze).toBe(2_000_000);
  });
});

describe('ekran /raporty — zwroty', () => {
  const naglowek = { authorization: `Basic ${Buffer.from('adam:x').toString('base64')}` };
  const config = { auth: { user: 'adam', pass: 'x' }, klienciZbiorczy: [] };
  const wejdz = async (url) => {
    const app = buildOmsServer({ db, config });
    const odp = await app.inject({ method: 'GET', url, headers: naglowek });
    await app.close();
    return odp;
  };

  it('PO podlodze (2026-08-15) zwroty pokazuja sie jako liczba, nie „brak danych”', async () => {
    dodajZwrot(db, id, { data: '2026-08-14', kwota: '50.00', pozycje: [] });
    const odp = await wejdz('/raporty?od=2026-08-01&do=2026-08-31');
    expect(odp.statusCode).toBe(200);
    expect(odp.body).toContain('−50,00 zł');
    expect(odp.body).not.toContain('brak danych');
  });

  // ⚠️ Od przebudowy 17.08.2026 okres sprzed podlogi NIE pokazuje dwoch kafli „brak
  // danych" — kafle bez liczby zajmowaly czwarta czesc rzedu KPI. Zamiast nich stoi jedna
  // przygaszona linijka (pasek-info) mowiaca wprost, OD KIEDY zwroty w ogole sa mierzone.
  // Zasada bez zmian: zadnego zmyslonego „0,00 zł".
  it('PRZED podloga zwrotow ekran pisze jedna linijke „brak danych” zamiast kafli — nigdy 0,00 zł', async () => {
    const odp = await wejdz('/raporty?od=2026-08-01&do=2026-08-14');
    expect(odp.statusCode).toBe(200);
    expect(odp.body.match(/brak danych/g)).toHaveLength(1);
    expect(odp.body).toContain('pasek-info');
    // Kafli zwrotow nie ma w ogole (naglowek „Zwroty" zostal w pasku, nie w kaflu)…
    expect(odp.body).not.toContain('Sprzedaż po zwrotach');
    // …a linijka mowi, od kiedy zwroty sie licza.
    expect(odp.body).toContain('2026-08-15');
  });

  it('stala podlogi ma wartosc dnia wdrozenia', () => {
    expect(PODLOGA_ZWROTOW).toBe('2026-08-15');
  });
});
