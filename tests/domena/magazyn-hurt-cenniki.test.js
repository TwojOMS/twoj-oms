// Edycja hurtowa cennika dostaw: pole cennika OMS i pole na każde konto. Puste pole = bez zmian, „__usun__” = usuń,
// klucz konta spoza listy albo wartość spoza listy konta odmawia całości. Dane zmyślone (lampy „Pracownia Półcień”).
import { describe, expect, it } from 'vitest';
import { polecenieZFormularza, planHurtu, polaDoPrzeniesienia } from '../../src/domena/magazyn-hurt.js';

const OMS = [
  { id: 1, nazwa: 'Paczkomat mały' },
  { id: 2, nazwa: 'Kurier gabaryt' },
];
const ALLEGRO = {
  klucz: 'allegro_lampy',
  etykieta: 'Allegro · lampy',
  cenniki: [
    { wartosc: 'cen-a', nazwa: 'Półcień — paczkomat' },
    { wartosc: 'cen-k', nazwa: 'Półcień — kurier' },
  ],
};
const ERLI = { klucz: 'erli_lampy', etykieta: 'ERLI · lampy', cenniki: [{ wartosc: 'Kurier', nazwa: 'Kurier' }] };
const BEZ_LISTY = { klucz: 'allegro_kinkiety', etykieta: 'Allegro · kinkiety', cenniki: null };
// Ta sama reguła co `bladWyboruCennika` z modułu: nowy wybór tylko z pobranej listy konta.
const bladWyboru = (konto, wartosc) =>
  konto.cenniki?.some((p) => p.wartosc === wartosc) ? null : `Wybierz cennik z listy konta ${konto.etykieta}.`;
const cenniki = { oms: OMS, konta: [ALLEGRO, ERLI, BEZ_LISTY], bladWyboru };
const polecenie = (body) => polecenieZFormularza(body, { cenniki });

const karta = (id) => ({ id, nazwa: `Lampa stołowa Gliwka ${id}` });
const stan = (wpisy) =>
  new Map(wpisy.map(([id, oms, konta = {}]) => [id, { oms, konta: new Map(Object.entries(konta)) }]));

describe('formularz hurtu — cennik OMS i cenniki kont', () => {
  it('puste pola i pola nieprzysłane to „bez zmian”: polecenie bez cenników', () => {
    const { polecenie: p, blad } = polecenie({
      cennik_oms_hurt: '',
      cennik_konta_hurt_allegro_lampy: '',
      cennik_konta_hurt_allegro_kinkiety: '',
      waga_kg: '1',
    });
    expect(blad).toBeNull();
    expect(p).toEqual({ waga_g: 1000 });
  });

  it('„__usun__” usuwa, wartość z listy ustawia — osobno dla cennika OMS i każdego konta', () => {
    const { polecenie: p, blad } = polecenie({
      cennik_oms_hurt: '__usun__',
      cennik_konta_hurt_allegro_lampy: 'cen-k',
      cennik_konta_hurt_erli_lampy: '__usun__',
    });
    expect(blad).toBeNull();
    expect(p.cennikOms).toBeNull();
    expect(p.cennikiKont).toEqual([
      { konto: ALLEGRO, wartosc: 'cen-k' },
      { konto: ERLI, wartosc: null },
    ]);
    expect(polecenie({ cennik_oms_hurt: '2' }).polecenie.cennikOms).toEqual(OMS[1]);
  });

  it('klucz konta spoza bieżących kont odmawia całości — także obok poprawnych pól', () => {
    const r = polecenie({ waga_kg: '1', cennik_konta_hurt_allegro_lampy: 'cen-a', cennik_konta_hurt_inne_konto: 'x' });
    expect(r.polecenie).toBeNull();
    expect(r.blad).toContain('inne_konto');
  });

  it('wartość spoza listy konta, konto bez pobranej listy i cennik OMS, którego nie ma → odmowa całości', () => {
    for (const body of [
      { cennik_konta_hurt_allegro_lampy: 'cen-obcy' },
      { cennik_konta_hurt_allegro_kinkiety: 'cen-a' },
      { cennik_oms_hurt: '99' },
      { cennik_oms_hurt: 'Paczkomat mały' },
    ]) {
      const r = polecenie({ waga_kg: '1', ...body });
      expect(r.polecenie, JSON.stringify(body)).toBeNull();
      expect(r.blad).toBeTruthy();
    }
    expect(polecenie({ cennik_konta_hurt_allegro_lampy: 'cen-obcy' }).blad).toBe(
      'Wybierz cennik z listy konta Allegro · lampy.',
    );
  });

  it('klucz konta z „-” (dozwolony w konfiguracji kanałów) niesie wybór, a nie ginie po cichu', () => {
    const zMyslnikiem = { ...ERLI, klucz: 'erli-lampy', etykieta: 'ERLI · lampy-2' };
    const body = { cennik_konta_hurt_erli_lampy: '', 'cennik_konta_hurt_erli-lampy': 'Kurier' };
    const r = polecenieZFormularza(body, { cenniki: { ...cenniki, konta: [ERLI, zMyslnikiem] } });
    expect(r.blad).toBeNull();
    expect(r.polecenie.cennikiKont).toEqual([{ konto: zMyslnikiem, wartosc: 'Kurier' }]);
    expect(polaDoPrzeniesienia(body)).toEqual([{ name: 'cennik_konta_hurt_erli-lampy', value: 'Kurier' }]);
  });

  it('pole przysłane dwa razy odmawia całości', () => {
    expect(polecenie({ cennik_oms_hurt: ['1', '2'] }).blad).toBeTruthy();
    expect(polecenie({ cennik_konta_hurt_allegro_lampy: ['cen-a', 'cen-k'] }).blad).toBeTruthy();
  });

  it('ukryte pola podglądu niosą wybory cenników (puste pomija)', () => {
    expect(
      polaDoPrzeniesienia({
        cennik_oms_hurt: '__usun__',
        cennik_konta_hurt_allegro_lampy: 'cen-a',
        cennik_konta_hurt_erli_lampy: '',
        cennik_konta_hurt_ZLE: 'x',
      }),
    ).toEqual([
      { name: 'cennik_oms_hurt', value: '__usun__' },
      { name: 'cennik_konta_hurt_allegro_lampy', value: 'cen-a' },
    ]);
  });
});

describe('plan hurtu — cenniki', () => {
  it('karta, której nic się nie zmienia, nie trafia do planu; opisy z → na nazwami', () => {
    const { polecenie: p } = polecenie({
      cennik_oms_hurt: '2',
      cennik_konta_hurt_allegro_lampy: 'cen-k',
      cennik_konta_hurt_erli_lampy: '__usun__',
    });
    const cennikiKart = stan([
      [1, OMS[1], { allegro_lampy: 'cen-k' }],
      [2, null, { allegro_lampy: 'cen-a', erli_lampy: 'Kurier' }],
    ]);
    const { plan, blad } = planHurtu([karta(1), karta(2)], p, { cennikiKart });
    expect(blad).toBeNull();
    expect(plan).toEqual([
      {
        id: 2,
        nazwa: 'Lampa stołowa Gliwka 2',
        zmiany: {},
        cennikOms: 2,
        cennikiKont: { allegro_lampy: 'cen-k', erli_lampy: null },
        opisy: [
          { pole: 'Cennik OMS', z: 'według rozmiaru', na: 'Kurier gabaryt' },
          { pole: 'Cennik · Allegro · lampy', z: 'Półcień — paczkomat', na: 'Półcień — kurier' },
          { pole: 'Cennik · ERLI · lampy', z: 'Kurier', na: 'z cennika OMS / według rozmiaru' },
        ],
      },
    ]);
  });

  it('usunięcie cennika OMS: wpis.cennikOms = null; karta bez cennika OMS nie trafia do planu', () => {
    const { polecenie: p } = polecenie({ cennik_oms_hurt: '__usun__' });
    const { plan } = planHurtu([karta(1), karta(2)], p, {
      cennikiKart: stan([
        [1, OMS[0]],
        [2, null],
      ]),
    });
    expect(plan.map((w) => [w.id, w.cennikOms, w.opisy])).toEqual([
      [1, null, [{ pole: 'Cennik OMS', z: 'Paczkomat mały', na: 'według rozmiaru' }]],
    ]);
    expect(Object.hasOwn(plan[0], 'cennikiKont')).toBe(false);
  });

  it('wybór konta spoza bieżącej listy opisany surową wartością', () => {
    const { polecenie: p } = polecenie({ cennik_konta_hurt_allegro_lampy: '__usun__' });
    const { plan } = planHurtu([karta(1)], p, { cennikiKart: stan([[1, null, { allegro_lampy: 'cen-stary' }]]) });
    expect(plan[0].opisy).toEqual([
      { pole: 'Cennik · Allegro · lampy', z: 'cen-stary', na: 'z cennika OMS / według rozmiaru' },
    ]);
  });

  it('polecenie z cennikami bez mapy stanu kart to błąd wołającego', () => {
    const { polecenie: p } = polecenie({ cennik_oms_hurt: '1' });
    expect(() => planHurtu([karta(1)], p, {})).toThrow(/cennikiKart/);
  });
});
