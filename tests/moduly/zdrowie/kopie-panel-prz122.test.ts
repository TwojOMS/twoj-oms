// PRZ-122.B16a: nadzór kopii bazy w panelu (usługa zdrowie.kopie → tabelka ostrzeżeń) i uwaga 26 h w /health.
// Kopię robi dalej oms-kopia — tu tylko patrzymy na pliki oms-RRRR-MM-DD.sqlite (mtime ustawiany ręcznie).
// Zegar sterowany (2026-10-28T10:00Z), dane zmyślone, sieć zabroniona.
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stanKopii, PROG_UWAGI_KOPII_H, nadzorKopiiWymagany } from '../../../src/moduly/zdrowie/kopie.ts';
import { ostrzezeniaKopii } from '../../../src/domena/ostrzezenia.js';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { programTestowy } from '../../pomoc/program-testowy.js';
import { modulRdzen } from '../../../src/moduly/rdzen/modul.ts';
import { modulWeb } from '../../../src/core/web/modul.ts';
import { modulKanaly } from '../../../src/moduly/kanaly/modul.ts';
import { modulFaktury } from '../../../src/moduly/faktury/modul.ts';
import { modulWiadomosci } from '../../../src/moduly/wiadomosci/modul.ts';
import { createModulZamowienia } from '../../../src/moduly/zamowienia/modul.ts';
import { modulWysylka } from '../../../src/moduly/wysylka/modul.ts';
import { modulMagazyn } from '../../../src/moduly/magazyn/modul.ts';
import { modulZwroty } from '../../../src/moduly/zwroty/modul.ts';
import { modulKoszty } from '../../../src/moduly/koszty/modul.ts';
import { modulUstawienia } from '../../../src/moduly/ustawienia/modul.ts';
import { modulMarketing } from '../../../src/moduly/marketing/modul.ts';
import { modulRaporty } from '../../../src/moduly/raporty/modul.ts';
import { modulApiPanelu } from '../../../src/moduly/api-panelu/modul.ts';
import { modulAutomatyzacje } from '../../../src/moduly/automatyzacje/modul.ts';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { nowyPanel, jako, get } from '../../pomoc/konta-prz068.js';

const TERAZ = new Date('2026-10-28T10:00:00Z');
const NAZWA_TWOJEFAKTURY = Object.freeze({ mianownik: 'TwojeFaktury', dopelniacz: 'TwojeFaktury', miejscownik: 'TwojeFaktury', narzednik: 'TwojeFaktury' });
const katalogi: string[] = [];
const sprzatanie: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const s of sprzatanie.splice(0)) await s();
  for (const k of katalogi.splice(0)) fs.rmSync(k, { recursive: true, force: true });
  vi.unstubAllGlobals(); vi.useRealTimers();
});
function katalog() { const k = fs.mkdtempSync(path.join(os.tmpdir(), 'oms-kopie-panel-')); katalogi.push(k); return k; }
function kopia(k: string, nazwa: string, wiekH: number) {
  const p = path.join(k, nazwa); fs.writeFileSync(p, 'x');
  const t = new Date(TERAZ.getTime() - wiekH * 3600_000); fs.utimesSync(p, t, t);
}
const ZDANIE_31 = 'Ostatnia kopia bazy ma 31 h — oms-kopia nie zrobił kopii w ostatniej dobie';
const oKopii = (x: string) => x.startsWith('kopia bazy') || x.startsWith('Ostatnia kopia');

describe('stanKopii — próg uwagi 26 h i pola dla panelu', () => {
  it('kopia sprzed 25 h: bez uwag i alarmów o kopii, panel milczy', () => {
    expect(PROG_UWAGI_KOPII_H).toBe(26);
    const lok = katalog(); kopia(lok, 'oms-2026-10-27.sqlite', 25);
    const s = stanKopii({ katalog: lok, zewnetrzna: '', teraz: TERAZ });
    expect([...s.alarmy, ...s.uwagi].filter(oKopii)).toEqual([]);
    expect(s).toMatchObject({ ostatnia: { plik: 'oms-2026-10-27.sqlite', wiekH: 25 }, katalogDostepny: true, zewnetrzna: false });
    expect(ostrzezeniaKopii({ kopie: s })).toEqual([]);
  });

  it('kopia sprzed 31 h: jedna uwaga, zero alarmów; w panelu jeden wiersz z datą kopii', () => {
    const lok = katalog(); kopia(lok, 'oms-2026-10-27.sqlite', 31);
    const s = stanKopii({ katalog: lok, zewnetrzna: '', teraz: TERAZ });
    expect(s.alarmy).toEqual([]);
    expect(s.uwagi.filter(oKopii)).toEqual([ZDANIE_31]);
    const w = ostrzezeniaKopii({ kopie: s });
    expect(w.map((x: any) => [x.klucz, x.tekst])).toEqual([['integracja:kopia:stara:2026-10-27', `${ZDANIE_31}.`]]);
  });

  it('kopia sprzed 49 h: alarm jak dotąd, bez uwagi 26 h (jedno zdanie), w panelu jeden wiersz', () => {
    const lok = katalog(); kopia(lok, 'oms-2026-10-26.sqlite', 49);
    const s = stanKopii({ katalog: lok, zewnetrzna: '', teraz: TERAZ });
    expect(s.alarmy).toEqual(['kopia bazy: najnowsza oms-2026-10-26.sqlite ma 49 h (próg 48 h)']);
    expect(s.uwagi.filter(oKopii)).toEqual([]);
    expect(ostrzezeniaKopii({ kopie: s })).toHaveLength(1);
  });

  it('nowa kopia zmienia klucz wiersza (wyciszenie starej nie chowa nowej)', () => {
    const lok = katalog(); kopia(lok, 'oms-2026-10-26.sqlite', 49);
    const [a] = ostrzezeniaKopii({ kopie: stanKopii({ katalog: lok, zewnetrzna: '', teraz: TERAZ }) });
    kopia(lok, 'oms-2026-10-27.sqlite', 31);
    const [b] = ostrzezeniaKopii({ kopie: stanKopii({ katalog: lok, zewnetrzna: '', teraz: TERAZ }) });
    expect(a.klucz).toBe('integracja:kopia:stara:2026-10-26');
    expect(b.klucz).toBe('integracja:kopia:stara:2026-10-27');
  });

  it('pusty katalog: alarm jak dotąd + wiersz „Brak kopii”; katalog niedostępny: wiersz „nie widzi katalogu”', () => {
    const lok = katalog();
    const pusty = stanKopii({ katalog: lok, zewnetrzna: '', teraz: TERAZ });
    expect(pusty.alarmy).toEqual([`kopia bazy: brak kopii w ${lok}`]);
    expect(pusty).toMatchObject({ ostatnia: null, katalogDostepny: true });
    expect(ostrzezeniaKopii({ kopie: pusty }).map((x: any) => x.tekst)).toEqual(['Brak kopii bazy w katalogu kopii.']);
    const brak = stanKopii({ katalog: path.join(lok, 'nie-ma'), zewnetrzna: lok, teraz: TERAZ });
    expect(brak).toMatchObject({ ostatnia: null, katalogDostepny: false, zewnetrzna: true });
    expect(ostrzezeniaKopii({ kopie: brak }).map((x: any) => x.tekst)).toEqual(['OMS nie widzi katalogu kopii.', 'Kopia poza dyskiem nie trafia na nośnik — podłącz nośnik kopii (brak znacznika w katalogu).']);
  });

  it('nadzorKopiiWymagany: tylko program wbudowany poza próbą (jedno miejsce reguły)', () => {
    expect(nadzorKopiiWymagany({ wbudowany: true, proba: false })).toBe(true);
    expect(nadzorKopiiWymagany({ wbudowany: true, proba: true })).toBe(false);
    expect(nadzorKopiiWymagany({ wbudowany: false, proba: false })).toBe(false);
  });
});

describe('usługa zdrowie.kopie i /health (kompozycja jak u klienta)', () => {
  const env = { OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000',
    OMS_USER: 'operator', OMS_PASS: 'test', OMS_PROFORMY_KATALOG: '/nieuzywany-proformy', OMS_ETYKIETY_KATALOG: '/nieuzywany-etykiety' };
  /** Program wbudowany w kontrakcie: opis atrapy niezależny od obecności adaptera. */
  // B16 jest wspólne: wystarczy opis programu, bez importu opcjonalnego adaptera.
  const wbudowany = () => { const p = programTestowy({ id: 'twojefaktury', nazwa: NAZWA_TWOJEFAKTURY as any }); return { ...p, opis: Object.freeze({ ...p.opis, wbudowany: true }) }; };
  async function oms(e: Record<string, string>, program: unknown) {
    vi.stubGlobal('fetch', vi.fn(async () => { throw Error('Sieć zabroniona'); }));
    const a = await zbudujOms({ env: { ...env, ...e }, teraz: () => TERAZ, nadpisania: { 'faktury.infakt': program } });
    sprzatanie.push(async () => { await a.app.close(); (a as any).db.close(); });
    return a;
  }
  const UWAGA_TF = `${NAZWA_TWOJEFAKTURY.mianownik} trzyma faktury tylko w bazie, a nadzór kopii jest wyłączony (brak OMS_KOPIE_KATALOG) — kopia bazy musi trafiać poza ten dysk (oms-kopia).`;

  // Zrzut sprzed B16a (e265efe): inFakt bez OMS_KOPIE_KATALOG — produkcja właściciela. Umowa z czujką monitoring.
  const HEALTH_PRZED = '{"ok":true,"alarmy":[],"uwagi":[],"poller":{"zdrowy":true,"zrodla":[]},"czuwaczKsef":{"wlaczony":false,"zdrowy":true,"okAt":null,"wiekS":null,"blad":null,"bladAt":null,"bladSwiezszy":false},"czuwaczPrzesylek":{"wlaczony":false,"zdrowy":true,"okAt":null,"wiekS":null,"blad":null,"bladAt":null,"bladSwiezszy":false},"czuwaczOstrzezen":{"wlaczony":true,"zdrowy":true,"okAt":null,"wiekS":null,"blad":null,"bladAt":null,"bladSwiezszy":false},"czuwaczKosztow":{"wlaczony":false,"zdrowy":true,"ostatnieUdaneAt":null,"wiekS":null,"blad":null,"bladAt":null,"stan":"brak tokenu KSeF"},"kanaly":[],"proces":{"startAt":"2026-10-28T10:00:00.000Z","wiekS":0}}';

  it('program inFakt bez katalogu kopii: /health bajt w bajt jak przed zmianą, panel milczy', async () => {
    const a = await oms({}, programTestowy({ id: 'infakt' }));
    expect((await a.app.inject('/health')).body).toBe(HEALTH_PRZED);
    expect(a.usluga<() => any>('zdrowie', 'kopie')()).toEqual({ brakNadzoru: true, wbudowany: false, wymagany: false, nazwa: null });
    expect(ostrzezeniaKopii({ kopie: a.usluga<() => any>('zdrowie', 'kopie')() })).toEqual([]);
  });

  it('program wbudowany bez katalogu, nie próba: uwaga w /health (nazwa z programu) i wiersz w panelu; ok bez zmian', async () => {
    const a = await oms({}, wbudowany());
    const j = (await a.app.inject('/health')).json();
    expect(j.ok).toBe(true);
    expect(j.uwagi).toEqual([UWAGA_TF]);
    const k = a.usluga<() => any>('zdrowie', 'kopie')();
    expect(k).toEqual({ brakNadzoru: true, wbudowany: true, wymagany: true, nazwa: NAZWA_TWOJEFAKTURY.mianownik });
    expect(ostrzezeniaKopii({ kopie: k }).map((w: any) => w.tekst))
      .toEqual([`Faktury ${NAZWA_TWOJEFAKTURY.mianownik} są tylko w bazie, a ten OMS nie widzi katalogu kopii.`]);
  });

  it('ten sam stan w próbie: ani uwagi, ani wiersza', async () => {
    const a = await oms({ OMS_TRYB: 'proba' }, wbudowany());
    const j = (await a.app.inject('/health')).json();
    expect(j.uwagi.filter((x: string) => x.includes('nadzór kopii'))).toEqual([]);
    expect(ostrzezeniaKopii({ kopie: a.usluga<() => any>('zdrowie', 'kopie')() })).toEqual([]);
  });

  it('z katalogiem: kopia 31 h → uwaga w /health, ok=true, kolejność kluczy bez zmian; usługa zwraca stan kopii', async () => {
    const lok = katalog(); kopia(lok, 'oms-2026-10-27.sqlite', 31);
    const a = await oms({ OMS_KOPIE_KATALOG: lok }, wbudowany());
    const j = (await a.app.inject('/health')).json();
    expect(j.ok).toBe(true);
    expect(j.alarmy).toEqual([]);
    expect(j.uwagi).toContain(ZDANIE_31);
    expect(j.uwagi.filter((x: string) => x.includes('nadzór kopii'))).toEqual([]);
    expect(Object.keys(j)).toEqual(Object.keys(JSON.parse(HEALTH_PRZED)));
    expect(a.usluga<() => any>('zdrowie', 'kopie')()).toMatchObject({ ostatnia: { plik: 'oms-2026-10-27.sqlite', wiekH: 31 }, katalogDostepny: true, zewnetrzna: false });
  });
});

describe('tabelka ostrzeżeń na stronie głównej', () => {
  const zegar = () => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(TERAZ); };
  function panel(o: Record<string, unknown>) {
    const p = nowyPanel(o);
    sprzatanie.push(async () => { await p.app.close(); p.db.close(); });
    zalozKonto(p.db, { login: 'admin-test', imie: 'Administrator', haslo: 'h', rola: 'administrator', admin: true });
    zalozKonto(p.db, { login: 'prod-test', imie: 'Produkcja', haslo: 'h', rola: 'produkcja' });
    return p;
  }

  it('stara kopia: administrator widzi wiersz z przyciskiem „Kopie zapasowe”, konto bez Ustawień nie', async () => {
    zegar();
    const lok = katalog(); kopia(lok, 'oms-2026-10-27.sqlite', 31);
    const p = panel({ env: { OMS_KOPIE_KATALOG: lok } });
    const admin = await get(p.app, '/', jako(p.db, 'admin-test'));
    expect(admin.statusCode).toBe(200);
    expect(admin.body).toContain(ZDANIE_31);
    expect(admin.body).toContain('/ustawienia/kopie');
    const prod = await get(p.app, '/', jako(p.db, 'prod-test'));
    expect(prod.statusCode).toBe(200);
    expect(prod.body).not.toContain(ZDANIE_31);
  });

  it('usługa zdrowie niezbudowana (moduł wyłączony): tabelka działa, wiersza kopii brak', async () => {
    zegar();
    const lok = katalog();
    const moduly = [modulRdzen, modulWeb, modulKanaly, modulFaktury, modulWiadomosci, createModulZamowienia({ zWiadomosciami: true }),
      modulWysylka, modulMagazyn, modulZwroty, modulKoszty, modulUstawienia, modulAutomatyzacje, modulRaporty, modulMarketing, modulApiPanelu];
    const p = panel({ env: { OMS_KOPIE_KATALOG: lok }, moduly });
    const r = await get(p.app, '/', jako(p.db, 'admin-test'));
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain('Brak kopii bazy');
  });

  it('wyjątek usługi kopii nie gasi reszty tabelki (wiersz pollera zostaje)', async () => {
    zegar();
    const p = panel({ nadpisania: {
      'zdrowie.kopie': () => { throw new Error('dysk kopii zniknął'); },
      'zdrowie.zdrowie': () => ({ poller: { zrodla: [{ zrodlo: 'woo_polcien', zdrowy: false, blad: 'fetch failed' }] } }),
    } });
    const r = await get(p.app, '/', jako(p.db, 'admin-test'));
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Poller woo_polcien nie działa: fetch failed');
  });
});
