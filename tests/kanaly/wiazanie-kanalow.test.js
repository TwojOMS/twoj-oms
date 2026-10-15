import { describe, it, expect, vi } from 'vitest';
import { createWiazanieKanalow } from '../../src/moduly/kanaly/services/wiazanie-kanalow.js';

const stanZdrowy = { kanal: 'allegro_szkicownia', polaczony: true, zostaloDni: 89, ostatniBlad: null };
const stanMartwy = { ...stanZdrowy, ostatniBlad: 'invalid_grant' };

// Atrapa `przeprowadzWiazanie`: oddaje kod przez `naStart` i NIE konczy petli, dopoki
// test jej nie rozwiaze — bo dokladnie tak zachowuje sie prawdziwe device flow.
function atrapaPetli({ kod = 'xtsxfpnh', konczOd = null } = {}) {
  const wywolania = [];
  const fn = vi.fn(async ({ naStart, opisKanalu }) => {
    wywolania.push(opisKanalu);
    naStart({ userCode: kod, adres: `https://allegro.pl/...?code=${kod}`, limitMs: 1800000, wygasaAt: 1000 + 1800000 });
    return konczOd ? konczOd() : new Promise(() => {});
  });
  return { fn, wywolania };
}

const zbuduj = (n = {}) => {
  const { fn, wywolania } = n.petla ?? atrapaPetli();
  const tokeny = { stanDlaEkranu: () => (n.stanEkranu ?? stanMartwy) };
  const u = createWiazanieKanalow({
    tokenyKanalow: { allegro_szkicownia: tokeny, ...(n.dodatkowe ?? {}) },
    przeprowadz: fn,
    teraz: n.teraz ?? (() => 1000),
  });
  return { u, fn, wywolania };
};

describe('wiązanie kanału z panelu', () => {
  it('oddaje kod od razu, nie czekając na potwierdzenie', async () => {
    const { u } = zbuduj();
    const w = await u.rozpocznij('allegro_szkicownia');
    expect(w.ok).toBe(true);
    expect(w.stan.userCode).toBe('xtsxfpnh');
    expect(w.stan.adres).toContain('xtsxfpnh');
  });

  // ⚠️ BARIERA PIERWSZA. Ponowne wiazanie uniewaznia dzialajaca pare po stronie Allegro.
  it('ODMAWIA kanału zdrowego — i nie woła Allegro', async () => {
    const { u, fn } = zbuduj({ stanEkranu: stanZdrowy });
    const w = await u.rozpocznij('allegro_szkicownia');
    expect(w.ok).toBe(false);
    expect(w.powod).toMatch(/działa/i);
    expect(fn).not.toHaveBeenCalled();
  });

  // ⚠️⚠️ BARIERA DRUGA — TA, KTORA SAM ZLAMALEM 14.08.2026, uruchamiajac dwa procesy
  // wiazania rownolegle (kody `5jazcov8` i `xtsxfpnh`). Kazde `rozpocznijPowiazanie()` prosi
  // Allegro o WLASNY kod, a potwierdzenie nowego uniewaznia poprzedni.
  it('drugie kliknięcie oddaje TEN SAM kod, a nie nowy', async () => {
    const { u, fn } = zbuduj();
    const pierwsze = await u.rozpocznij('allegro_szkicownia');
    const drugie = await u.rozpocznij('allegro_szkicownia');
    expect(drugie.juzTrwa).toBe(true);
    expect(drugie.stan.userCode).toBe(pierwsze.stan.userCode);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // Wpis po terminie NIE MOZE blokowac kanalu — inaczej nieudane wiazanie zamyka go
  // na pol godziny bez powodu (4.9).
  it('po wygaśnięciu kodu wolno zacząć od nowa', async () => {
    let czas = 1000;
    const { u, fn } = zbuduj({ teraz: () => czas });
    await u.rozpocznij('allegro_szkicownia');
    czas = 1000 + 1800000 + 1;
    expect(u.stan('allegro_szkicownia')).toBeNull();
    await u.rozpocznij('allegro_szkicownia');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('nieznany kanał to odmowa, nie wyjątek', async () => {
    const { u } = zbuduj();
    expect((await u.rozpocznij('nie_ma')).ok).toBe(false);
  });

  // ⚠️ NIGDY `device_code` NA EKRAN (4.10) — to nim odbiera sie pare tokenow.
  it('stan dla ekranu NIE NIESIE device_code', async () => {
    const petla = atrapaPetli();
    const oryginalna = petla.fn;
    petla.fn = vi.fn(async (a) => {
      a.naStart({ userCode: 'kod', adres: 'https://x', limitMs: 1000, wygasaAt: 2000, device_code: 'SEKRET' });
      return new Promise(() => {});
    });
    const { u } = zbuduj({ petla });
    await u.rozpocznij('allegro_szkicownia');
    expect(JSON.stringify(u.stan('allegro_szkicownia'))).not.toContain('SEKRET');
    expect(oryginalna).not.toHaveBeenCalled();
  });

  // Nieudane wiazanie ZOSTAJE widoczne z powodem — inaczej ekran wraca do „nic sie nie
  // dzieje", a kanal dalej nie zyje.
  it('nieudane wiązanie zostawia powód na ekranie', async () => {
    const petla = { fn: vi.fn(async ({ naStart }) => {
      naStart({ userCode: 'k', adres: 'https://x', limitMs: 1000, wygasaAt: 5000 });
      return { gotowe: false, komunikat: 'Czas na potwierdzenie upłynął.' };
    }) };
    const { u } = zbuduj({ petla });
    await u.rozpocznij('allegro_szkicownia');
    await new Promise((r) => { setTimeout(r, 0); });
    expect(u.stan('allegro_szkicownia').blad).toMatch(/upłynął/);
  });

  // ⚠️ Odrzucona obietnica petli bez `.catch` to `unhandled rejection`, ktore kladzie CALY
  // proces OMS-u — w srodku nocy, z powodu jednego wiazania.
  it('wywrócona pętla nie wywala procesu', async () => {
    const petla = { fn: vi.fn(async ({ naStart }) => {
      naStart({ userCode: 'k', adres: 'https://x', limitMs: 1000, wygasaAt: 5000 });
      throw new Error('sieć padła');
    }) };
    const { u } = zbuduj({ petla });
    await expect(u.rozpocznij('allegro_szkicownia')).resolves.toMatchObject({ ok: true });
    await new Promise((r) => { setTimeout(r, 0); });
    expect(u.stan('allegro_szkicownia').blad).toMatch(/przerwane/i);
  });
});
