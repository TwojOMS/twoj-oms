import { describe, it, expect } from 'vitest';
import { celeLacznosci, podsumowanie } from '../../src/domena/lacznosc.js';
import { sprawdzLacznosc } from '../../src/oms/services/lacznosc.js';

// ——— DOMENA: LISTA CELOW POWSTAJE Z KONFIGURACJI ————————————————————————————————————
// ⚠️ Panel sprawdza WYLACZNIE to, co ma skonfigurowane. Sztywna lista adresów pokazywałaby
// „inFakt nie działa" na panelu, który inFaktu w ogóle nie ma — czyli czerwień, której nie
// da się naprawić, a od takiej ekran przestaje być czytany.
describe('celeLacznosci', () => {
  it('sklepy biora sie z konfiguracji, po jednym celu na sklep', () => {
    const cele = celeLacznosci({
      sklepy: {
        pro: { baseUrl: 'https://pro.szkicownia.pl' },
        szkicownia: { baseUrl: 'https://szkicownia.pl' },
      },
    });
    expect(cele.map((c) => c.klucz)).toEqual(['sklep:pro', 'sklep:szkicownia']);
    expect(cele[0]).toMatchObject({ host: 'pro.szkicownia.pl', url: 'https://pro.szkicownia.pl' });
  });

  it('kanaly Allegro daja cel na swoj adres API', () => {
    const cele = celeLacznosci({
      kanaly: {
        allegro_szkicownia: { api: 'https://api.allegro.pl' },
        allegro_amarka: { api: 'https://api.allegro.pl' },
      },
    });
    expect(cele.map((c) => c.klucz)).toEqual(['allegro:allegro_szkicownia', 'allegro:allegro_amarka']);
    expect(cele.every((c) => c.host === 'api.allegro.pl')).toBe(true);
  });

  it('inFakt i KSeF pojawiaja sie tylko, gdy sa skonfigurowane', () => {
    expect(celeLacznosci({}).map((c) => c.klucz)).toEqual([]);
    const cele = celeLacznosci({ infakt: { apiKey: 'x' }, ksef: { api: 'https://api.ksef.mf.gov.pl/v2' } });
    expect(cele.map((c) => c.klucz)).toEqual(['infakt', 'ksef']);
    expect(cele[1].host).toBe('api.ksef.mf.gov.pl');
  });

  it('kurierzy i GUS tez sa celami, gdy panel je ma', () => {
    const cele = celeLacznosci({
      dpd: { url: 'https://dpdservices.dpd.com.pl/DPDPackageObjServicesService/DPDPackageObjServices' },
      inpost: { url: 'https://api-shipx-pl.easypack24.net/v1' },
      gus: { url: 'https://wyszukiwarkaregon.stat.gov.pl/wsBIR/UslugaBIRzewnPubl.svc' },
    });
    expect(cele.map((c) => c.klucz)).toEqual(['dpd', 'inpost', 'gus']);
  });

  // ⚠️ Adres nie do przeczytania NIE MOZE wywalic ekranu diagnostycznego — to jedyny ekran,
  // po ktory sie siega, gdy cos juz nie dziala.
  it('niepoprawny adres w konfiguracji nie wywala listy celow', () => {
    const cele = celeLacznosci({ sklepy: { pro: { baseUrl: 'to-nie-jest-adres' } } });
    expect(cele).toHaveLength(1);
    expect(cele[0].host).toBeNull();
  });
});

describe('podsumowanie', () => {
  it('liczy dzialajace i niedzialajace', () => {
    expect(podsumowanie([{ ok: true }, { ok: false }, { ok: true }]))
      .toEqual({ ile: 3, dziala: 2, nieDziala: 1, wszystkoOk: false });
  });

  it('komplet zielony ma wlasny znacznik', () => {
    expect(podsumowanie([{ ok: true }])).toMatchObject({ wszystkoOk: true, nieDziala: 0 });
  });

  it('brak celow to NIE jest „wszystko dziala"', () => {
    // Panel bez ani jednej skonfigurowanej usługi nie ma czego sprawdzać — „wszystko OK"
    // byłoby wtedy zdaniem o niczym, wyglądającym jak zdanie o faktach.
    expect(podsumowanie([])).toMatchObject({ ile: 0, wszystkoOk: false });
  });
});

// ——— USLUGA: SPRAWDZENIE IDZIE PO SIECI, ALE TESTY NIE ——————————————————————————————
describe('sprawdzLacznosc', () => {
  const cel = { klucz: 'sklep:pro', nazwa: 'Sklep PRO', url: 'https://pro.szkicownia.pl', host: 'pro.szkicownia.pl' };

  it('cel osiagalny: DNS rozwiazany i odpowiedz HTTP', async () => {
    const [w] = await sprawdzLacznosc({
      cele: [cel],
      lookup: async () => ({ address: '203.0.113.10' }),
      fetchImpl: async () => ({ status: 200 }),
      teraz: (() => { let t = 0; return () => (t += 120); })(),
    });
    expect(w).toMatchObject({ klucz: 'sklep:pro', ok: true, adresIp: '203.0.113.10', status: 200 });
    expect(w.msDns).toBeGreaterThan(0);
  });

  // ⚠️⚠️ TO JEST CALY POWOD, DLA KTOREGO TEN EKRAN POWSTAL (awaria 17.08.2026): gdy pada DNS,
  // wszystko wyglada jak awaria SKLEPU („fetch failed"), a sklep ma sie dobrze. Ekran ma
  // rozroznic te dwie rzeczy ZANIM ktos zacznie szukac w kodzie panelu.
  it('gdy nie rozwiazuje sie nazwa, mowi wprost o DNS i NIE probuje HTTP', async () => {
    let bylFetch = false;
    const [w] = await sprawdzLacznosc({
      cele: [cel],
      lookup: async () => { throw Object.assign(new Error('getaddrinfo EAI_AGAIN'), { code: 'EAI_AGAIN' }); },
      fetchImpl: async () => { bylFetch = true; return { status: 200 }; },
    });
    expect(w.ok).toBe(false);
    expect(w.warstwa).toBe('dns');
    expect(w.komunikat).toMatch(/nazw/i);
    expect(bylFetch).toBe(false);
  });

  it('DNS dziala, ale usluga nie odpowiada — warstwa to siec, nie DNS', async () => {
    const [w] = await sprawdzLacznosc({
      cele: [cel],
      lookup: async () => ({ address: '203.0.113.10' }),
      fetchImpl: async () => { throw new Error('connect ETIMEDOUT'); },
    });
    expect(w).toMatchObject({ ok: false, warstwa: 'siec', adresIp: '203.0.113.10' });
    expect(w.komunikat).toMatch(/ETIMEDOUT/);
  });

  // ⚠️ 401/403 to DZIALAJACA usluga, ktora nie chce rozmawiac bez klucza — a ekran odpowiada
  // na pytanie „czy da sie tam dojsc". Czerwien przy 403 z api.infakt.pl wysylalaby szukac
  // awarii, ktorej nie ma (zmierzone: inFakt oddaje 403 na goly adres).
  it('odpowiedz 401/403 liczy sie jako OSIAGALNA usluga', async () => {
    const [w] = await sprawdzLacznosc({
      cele: [{ ...cel, klucz: 'infakt', host: 'api.infakt.pl', url: 'https://api.infakt.pl' }],
      lookup: async () => ({ address: '1.2.3.4' }),
      fetchImpl: async () => ({ status: 403 }),
    });
    expect(w).toMatchObject({ ok: true, status: 403 });
  });

  it('kod 5xx to awaria uslugi', async () => {
    const [w] = await sprawdzLacznosc({
      cele: [cel],
      lookup: async () => ({ address: '1.2.3.4' }),
      fetchImpl: async () => ({ status: 502 }),
    });
    expect(w).toMatchObject({ ok: false, warstwa: 'usluga', status: 502 });
  });

  // ⚠️ EKRAN NIE MOZE WISIEC. Bez limitu czasu jedna martwa usługa trzymałaby całą stronę
  // tak długo, jak zechce — a to jest ekran, po który sięga się przy awarii.
  it('kazde sprawdzenie ma limit czasu', async () => {
    const [w] = await sprawdzLacznosc({
      cele: [cel],
      limitMs: 5,
      lookup: async () => ({ address: '1.2.3.4' }),
      fetchImpl: (url, opcje) => new Promise((_, odrzuc) => {
        opcje?.signal?.addEventListener('abort', () => odrzuc(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }),
    });
    expect(w.ok).toBe(false);
    expect(w.komunikat).toMatch(/limit|czas/i);
  });

  // ⚠️⚠️ ANI JEDEN TOKEN NIE JEST TU UZYWANY — i to nie jest oszczednosc, tylko bariera.
  // Refresh token Allegro jest JEDNORAZOWY (awaria 14.08.2026: dwa procesy wyslaly ten sam
  // i kanal padl na siedem godzin). Ekran diagnostyczny odpytywany odswiezaniem strony nie
  // ma prawa dotknac odswiezania tokenu.
  it('sprawdzenie NIE wysyla zadnych naglowkow autoryzacji', async () => {
    const naglowki = [];
    await sprawdzLacznosc({
      cele: [{ klucz: 'allegro:allegro_szkicownia', nazwa: 'Allegro', url: 'https://api.allegro.pl', host: 'api.allegro.pl' }],
      lookup: async () => ({ address: '1.2.3.4' }),
      fetchImpl: async (url, opcje) => { naglowki.push(opcje?.headers ?? {}); return { status: 200 }; },
    });
    const wszystkie = JSON.stringify(naglowki).toLowerCase();
    expect(wszystkie).not.toContain('authorization');
    expect(wszystkie).not.toContain('bearer');
  });

  it('cel bez czytelnego hosta odmawia zamiast probowac', async () => {
    const [w] = await sprawdzLacznosc({
      cele: [{ klucz: 'sklep:pro', nazwa: 'Sklep', url: 'to-nie-adres', host: null }],
      lookup: async () => ({ address: '1.2.3.4' }),
      fetchImpl: async () => ({ status: 200 }),
    });
    expect(w).toMatchObject({ ok: false, warstwa: 'konfiguracja' });
  });

  // ⚠️⚠️ PO KOLEI, NIE RÓWNOLEGLE. Pierwsza wersja sprawdzala wszystko naraz i na produkcji
  // pokazala 4059 ms przy siedmiu roznych hostach CO DO MILISEKUNDY, podczas gdy pojedyncze
  // wywolanie trwa ~300 ms — ekran raportowal wlasne zatkanie puli DNS jako czas odpowiedzi
  // cudzej uslugi. Diagnostyka, ktora klamie o liczbach, jest gorsza niz jej brak.
  it('sprawdzenia ida JEDNO PO DRUGIM, zeby czasy byly prawdziwe', async () => {
    let rownoczesne = 0;
    let szczyt = 0;
    await sprawdzLacznosc({
      cele: [cel, { ...cel, klucz: 'b' }, { ...cel, klucz: 'c' }],
      lookup: async () => ({ address: '1.2.3.4' }),
      fetchImpl: async () => {
        rownoczesne += 1;
        szczyt = Math.max(szczyt, rownoczesne);
        await new Promise((r) => { setTimeout(r, 5); });
        rownoczesne -= 1;
        return { status: 200 };
      },
    });
    expect(szczyt).toBe(1);
  });

  it('cele sprawdzaja sie niezaleznie — jeden zly nie psuje reszty', async () => {
    const wyniki = await sprawdzLacznosc({
      cele: [cel, { ...cel, klucz: 'infakt', host: 'api.infakt.pl', url: 'https://api.infakt.pl' }],
      lookup: async (host) => {
        if (host === 'api.infakt.pl') throw new Error('EAI_AGAIN');
        return { address: '1.2.3.4' };
      },
      fetchImpl: async () => ({ status: 200 }),
    });
    expect(wyniki.map((w) => w.ok)).toEqual([true, false]);
  });
});
