import { describe, it, expect } from 'vitest';
import { zCzekaniemNa429, LIMIT_KSEF_NA_MINUTE } from '../../src/oms/ksef/limit.js';

// ⚠️ KAZDY test wstrzykuje `spij` — czekanie na PRAWDZIWYM zegarze zamienialoby te suite
// w minuty przestoju, a przy `retryAfterS: 54` w test, ktorego nikt nigdy nie uruchomi.
const b429 = (s = 54) => Object.assign(new Error('HTTP 429'), { status: 429, retryAfterS: s });

describe('zCzekaniemNa429', () => {
  it('bez 429 oddaje wynik od razu, bez spania', async () => {
    let spal = 0;
    const wynik = await zCzekaniemNa429(async () => 'ok', {
      spij: async () => { spal += 1; }, teraz: () => new Date(0), doKiedy: 1e9,
    });
    expect(wynik).toBe('ok');
    expect(spal).toBe(0);
  });

  it('na 429 czeka retryAfterS (+1 s zapasu) i ponawia', async () => {
    const spania = [];
    let n = 0;
    const w = await zCzekaniemNa429(async () => {
      n += 1;
      if (n === 1) throw b429(54);
      return 'ok';
    }, {
      spij: async (ms) => spania.push(ms), teraz: () => new Date(0), doKiedy: 10 * 60 * 1000,
    });

    expect(w).toBe('ok');
    expect(spania).toEqual([55000]);
  });

  it('bez retryAfterS czeka 60 s', async () => {
    const spania = [];
    let n = 0;
    await zCzekaniemNa429(async () => {
      n += 1;
      if (n === 1) throw Object.assign(new Error('x'), { status: 429 });
      return 1;
    }, {
      spij: async (ms) => spania.push(ms), teraz: () => new Date(0), doKiedy: 10 * 60 * 1000,
    });

    expect(spania).toEqual([61000]);
  });

  // ⚠️⚠️ BUDZET JEST TWARDY. Bez tego straznika archiwum kosztow (budzet 10 minut) spaloby
  // po 55 s przy KAZDYM z setek zaleglych dokumentow — czyli przebieg zjadalby kolejne
  // tykniecia zegara, a wolajacy nie mialby jak tego zauwazyc. Odmowa z `powod: 'limit'`
  // jest sygnalem „wroc nastepnym przebiegiem", a nie awaria zrodla.
  it('gdy czekanie nie miesci sie w budzecie, rzuca z powod=limit BEZ spania', async () => {
    let spal = 0;
    await expect(zCzekaniemNa429(async () => { throw b429(54); }, {
      spij: async () => { spal += 1; }, teraz: () => new Date(0), doKiedy: 30 * 1000,
    })).rejects.toMatchObject({ powod: 'limit', status: 429 });
    expect(spal).toBe(0);
  });

  it('po 3 nieudanych ponowieniach oddaje blad', async () => {
    let n = 0;
    await expect(zCzekaniemNa429(async () => { n += 1; throw b429(1); }, {
      spij: async () => {}, teraz: () => new Date(0), doKiedy: 1e9,
    })).rejects.toMatchObject({ status: 429 });
    // Pierwsze wywolanie plus trzy ponowienia — czwarta odmowa leci do wolajacego.
    expect(n).toBe(4);
  });

  it('inny blad leci od razu', async () => {
    await expect(zCzekaniemNa429(async () => { throw new Error('500'); }, {
      spij: async () => {}, teraz: () => new Date(0), doKiedy: 1e9,
    })).rejects.toThrow('500');
  });

  // Odmowa z limitu NIE jest wina jednego dokumentu — wolajacy (czuwacz kosztow) rozpoznaje
  // ja po `powod`, a nie po tresci zdania, wiec znacznik musi przetrwac ponowienia.
  it('blad z limitu zachowuje oryginalna tresc i znacznik dlaOperatora', async () => {
    const e = Object.assign(new Error('KSeF odmówił: HTTP 429'), {
      status: 429, retryAfterS: 54, dlaOperatora: true,
    });
    await expect(zCzekaniemNa429(async () => { throw e; }, {
      spij: async () => {}, teraz: () => new Date(0), doKiedy: 1000,
    })).rejects.toMatchObject({ powod: 'limit', dlaOperatora: true, message: 'KSeF odmówił: HTTP 429' });
  });

  // ⚠️⚠️ CZEKANIE MA SUFIT. `Retry-After` (albo liczba w tresci odmowy) przychodzi Z ZEWNATRZ
  // — pisze ja MF, a nie my. Wartosc bledna, zlosliwa albo podana w innej jednostce (godziny
  // zamiast sekund) zaparkowalaby zadanie na godzine bez ani jednego sladu w logu, a przy
  // `doKiedy: Infinity` (paczka dla biura, Task 11 — przegladarka czeka do skutku) straznik
  // budzetu nawet by tego nie zlapal. Sufit jest wiec DRUGA, niezalezna bariera.
  it('czekanie ma sufit 5 minut — bogus Retry-After nie parkuje zadania na godzine', async () => {
    const spania = [];
    let n = 0;
    const w = await zCzekaniemNa429(async () => {
      n += 1;
      if (n === 1) throw b429(3600);
      return 'ok';
    }, {
      spij: async (ms) => spania.push(ms), teraz: () => new Date(0), doKiedy: Infinity,
    });

    expect(w).toBe('ok');
    expect(spania).toEqual([301000]);
  });

  it('limit KSeF to 16 zadan na minute', () => {
    expect(LIMIT_KSEF_NA_MINUTE).toBe(16);
  });
});
