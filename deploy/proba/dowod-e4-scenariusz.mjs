// PRZ-160.E4 — scenariusze dowodu 1 (plan §7.1) na lokalnej kopii bazy demo, tylko OMS_TRYB=proba (atrapy).
// Każdy krok buduje aplikację z tego drzewa (`zbuduj` z dowod-e4.mjs), robi to, co użytkownik w panelu (app.inject),
// i woła przebiegi tych samych zegarów co produkcja. Wynik: JSON z liczbami. Nic nie łączy się z prawdziwym kanałem.
import { zbuduj } from './dowod-e4.mjs';
import { createAtrapaWoo } from './atrapy/kanaly.mjs';
import { createSerwerOfertAllegro } from './atrapy/allegro-oferty.mjs';
import { createZakup } from './zakup.mjs';
import { migawkaStanow } from '../../src/oms/db/stany-magazynowe.js';
import { iloscDlaKanalu } from '../../src/domena/ilosc-kanalu.js';
import { uruchomPulsPollerow } from './atrapy/pollery.mjs';
import { definicjeKanalow } from '../../src/moduly/kanaly/konfiguracja.ts';

const typKanalu = (kanal) => (kanal === 'polcien' ? 'woo' : kanal.startsWith('erli') ? 'erli' : 'allegro');
const objeta = (o) => o.tryb === 'zarzadzana' || (o.tryb === 'obserwowana' && o.ilosc_z_oms);
const tekst = (html) =>
  (/<main[\s\S]*?<\/main>/.exec(html)?.[0] ?? html)
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const token = (html) => /name="podglad" value="([^"]+)"/.exec(html)?.[1] ?? null;
const ZAPIS_ILOSCI = new Set([
  'zmienProdukty',
  'zmienProdukt',
  'komendaIlosci',
  'zapiszStanyHurtem',
  'komendaPublikacji',
]);

/** Stan atrapy kanału dla oferty: ilość i (Allegro) status publikacji. */
async function odczytKanalu(a, o) {
  const typ = typKanalu(o.kanal);
  if (typ === 'erli') {
    const w = a.db
      .prepare("SELECT dane_json FROM atrapa_erli_stan WHERE kanal = ? AND rodzaj = 'produkt' AND id = ?")
      .get(o.kanal, o.id_zewnetrzne);
    const p = w ? JSON.parse(w.dane_json) : null;
    return { ilosc: p?.stock ?? null, status: p?.status ?? null };
  }
  if (typ === 'allegro') {
    const p = createSerwerOfertAllegro({ db: a.db, kanal: o.kanal, env: a.env }).oferta(o.id_zewnetrzne);
    return { ilosc: p?.stock?.available ?? null, status: p?.publication?.status ?? null };
  }
  const woo = createAtrapaWoo({ db: a.db, kanal: o.kanal, env: a.env, log: () => {} });
  const [produkt, wariant] = String(o.id_zewnetrzne).split('/');
  const lista = wariant
    ? await woo.pobierzStanyWariantow(Number(produkt), [Number(wariant)])
    : await woo.pobierzStany([Number(produkt)]);
  return { ilosc: lista[0]?.stock_quantity ?? null, status: lista[0]?.status ?? null };
}

/** Każda oferta objęta ilością: cel (D51, ta sama funkcja domeny co pętle) i odczyt atrapy. */
async function bilans(a) {
  const migawka = migawkaStanow(a.db);
  const bufor = new Map(
    a.db
      .prepare('SELECT klucz, bufor_szt FROM oferty_ustawienia_kont')
      .all()
      .map((w) => [w.klucz, Number(w.bufor_szt ?? 0)]),
  );
  const stala = new Map(
    a.db
      .prepare('SELECT klucz, stala_ilosc FROM oferty_ustawienia_kont')
      .all()
      .map((w) => [w.klucz, w.stala_ilosc]),
  );
  const wiersze = [];
  for (const o of a.db
    .prepare("SELECT * FROM oferty_kanalow WHERE stan IN ('aktywna','nieaktywna','problem') ORDER BY id")
    .all()
    .filter(objeta)) {
    const cel = iloscDlaKanalu({
      migawka,
      kartaId: Number(o.karta_id),
      tryb: o.tryb,
      iloscZOms: o.ilosc_z_oms,
      bufor: bufor.get(o.kanal) ?? 0,
      stalaIlosc: stala.get(o.kanal) ?? null,
    });
    const k = await odczytKanalu(a, o);
    let problem = null;
    try {
      const j = JSON.parse(o.ilosc_problem_json ?? 'null');
      problem = j ? `${j.kod ?? j.rodzaj}${j.wstrzymuje ? ' (wstrzymuje)' : ''}` : null;
    } catch {
      problem = 'zly-json';
    }
    // Allegro przy celu 0 kończy ofertę (ENDED) zamiast wysyłać 0 — dla bilansu ENDED znaczy 0 w sprzedaży.
    const sprzedaz = k.status === 'ENDED' ? 0 : k.ilosc;
    wiersze.push({
      oferta: Number(o.id),
      kanal: o.kanal,
      karta: Number(o.karta_id),
      stan: o.stan,
      cel: cel.ilosc,
      powod: cel.powod,
      odczyt: k.ilosc,
      status: k.status,
      sprzedaz,
      problem,
      wToku: o.ilosc_w_toku_json ? 1 : 0,
    });
  }
  // Porównujemy aktywne oferty bez bezpiecznika: zablokowane wstrzymują ilość z założenia (D53, rozjazd) i są liczone osobno.
  const porownywane = wiersze.filter(
    (w) => w.stan !== 'nieaktywna' && w.odczyt !== null && !/wstrzymuje/.test(w.problem ?? '') && w.cel !== null,
  );
  const rozjazdy = porownywane.filter((w) => w.cel !== w.sprzedaz);
  return {
    ofert: wiersze.length,
    porownane: porownywane.length,
    zgodne: porownywane.length - rozjazdy.length,
    rozjazdy: rozjazdy.length,
    zablokowane: wiersze.filter((w) => /wstrzymuje/.test(w.problem ?? '')).map((w) => `${w.oferta}:${w.problem}`),
    wiersze,
  };
}

const iloscZapisu = (z) => z.zapis && ZAPIS_ILOSCI.has(z.metoda);
/** n przebiegów pętli; `poller` = najpierw zegar pollera zamówień (puls D64), jak co 120 s na produkcji. */
async function przebiegi(a, n, { poller = false } = {}) {
  const wynik = [];
  for (let i = 0; i < n; i++) {
    const start = a.licznik.od();
    if (poller) {
      // Jak start.mjs w trybie próby: puls atrapy pollerów (Woo, Allegro) + prawdziwy zegar pollera (ERLI z atrapy).
      uruchomPulsPollerow({ db: a.db, env: a.env, zrodla: definicjeKanalow(a.env).map((d) => d.klucz) })();
      await a.zegary.get('poller').przebieg();
    }
    const p = await a.przebieg();
    const oplaty = a.licznik.wywolania.slice(start).filter((w) => w.metoda === 'podgladOplat').length;
    wynik.push({
      zapisy: p.zapisy.length,
      ilosci: p.zapisy.filter(iloscZapisu).length,
      podgladOplat: oplaty,
      metody: p.zapisy.map((z) => `${z.kanal}.${z.metoda}`),
      argumenty: p.zapisy.map((z) => JSON.stringify(z.args).slice(0, 300)),
    });
  }
  return wynik;
}

async function przelacz(a, wlacz, rozumiem) {
  const r = await a.post('/ustawienia/magazyn/stany', {
    wlacz: wlacz ? '1' : '0',
    ...(rozumiem ? { rozumiem: '1' } : {}),
  });
  return {
    kod: r.statusCode,
    gdzie: r.headers.location ?? null,
    komunikat: r.statusCode >= 400 ? tekst(r.body).slice(0, 300) : null,
  };
}

/** Przejęcie stanów konta (podgląd → zatwierdź), jak przyciski w „Stany w kanałach”. */
async function przejmij(a, konto) {
  const p = await a.post('/magazyn/stany/kanaly/przejecie', { konto });
  const t = token(p.body);
  if (!t) return { konto, podglad: p.statusCode, blad: tekst(p.body).slice(0, 300) };
  const z = await a.post('/magazyn/stany/kanaly/przejecie', { konto, zatwierdz: '1', podglad: t });
  return {
    konto,
    podglad: p.statusCode,
    zatwierdz: z.statusCode,
    ofert: a.db.prepare('SELECT COUNT(*) n FROM oferty_kanalow WHERE kanal = ?').get(konto).n,
  };
}

/** „Obejmij stany” dla przejętych ofert, które pokazuje ekran (checkboxy) i których sklep prowadzi stan. */
async function obejmij(a, konto) {
  const lista = await a.post('/magazyn/stany/kanaly/przejecie', { konto });
  const naEkranie = [...lista.body.matchAll(/name="zaznaczone" value="(\d+)"/g)].map((m) => Number(m[1]));
  const prowadzi = new Set(
    a.db
      .prepare(
        `SELECT o.id FROM oferty_kanalow o JOIN produkty_sklepowe p ON p.kanal = o.kanal
    AND p.produkt_id || CASE WHEN p.wariant_id <> '' THEN '/' || p.wariant_id ELSE '' END = o.id_zewnetrzne
    WHERE o.kanal = ? AND p.stan_prowadzony = 'tak' AND p.zniknal_at IS NULL`,
      )
      .all(konto)
      .map((w) => w.id),
  );
  const ids = naEkranie.filter((id) => prowadzi.has(id)).map(String);
  const p = await a.post('/magazyn/stany/kanaly/objecie', { konto, zaznaczone: ids });
  const z = await a.post('/magazyn/stany/kanaly/objecie', {
    konto,
    zaznaczone: ids,
    zatwierdz: '1',
    podglad: token(p.body),
  });
  return {
    konto,
    naEkranie: naEkranie.length,
    objete: ids.length,
    podglad: p.statusCode,
    zatwierdz: z.statusCode,
    blad: z.statusCode >= 400 ? tekst(z.body).slice(0, 300) : null,
    zFlaga: a.db.prepare('SELECT COUNT(*) n FROM oferty_kanalow WHERE kanal = ? AND ilosc_z_oms = 1').get(konto).n,
  };
}

/** Stan otwarcia z kanałów: Odczytaj → propozycje (minimum) → zapisz; `zera` = karty zapisane z 0. */
async function otwarcie(a, zera = [], reczna = 6) {
  const o = await a.post('/magazyn/stany/otwarcie/odczytaj', {});
  const t = token(o.body);
  const pola = Object.fromEntries([...o.body.matchAll(/name="(ilosc_\d+)" value="(\d*)"/g)].map((m) => [m[1], m[2]]));
  // Karta bez odczytu w żadnym kanale (szkic, problem) ma puste pole — człowiek wpisuje liczbę sam.
  const wpisaneRecznie = Object.keys(pola)
    .filter((k) => pola[k] === '')
    .map((k) => Number(k.slice(6)));
  for (const k of wpisaneRecznie) pola[`ilosc_${k}`] = String(reczna);
  for (const k of zera) pola[`ilosc_${k}`] = '0';
  const z = await a.post('/magazyn/stany/otwarcie/zapisz', { podglad: t, ...pola });
  return {
    odczytaj: o.statusCode,
    pol: Object.keys(pola).length,
    wpisaneRecznie,
    zera,
    zapisz: z.statusCode,
    gdzie: z.headers.location ?? null,
    blad: z.statusCode >= 400 ? tekst(z.body).slice(0, 300) : null,
  };
}

async function zatwierdz(a) {
  const p = await a.get('/magazyn/stany/kanaly/podglad');
  const z = await a.post('/magazyn/stany/kanaly/zatwierdz', { podglad: token(p.body) });
  return {
    podglad: p.statusCode,
    tekstPodgladu: tekst(p.body)
      .replace(/^.*?Podgląd stanów/, 'Podgląd stanów')
      .slice(0, 600),
    zatwierdz: z.statusCode,
    blad: z.statusCode >= 400 ? tekst(z.body).slice(0, 300) : null,
  };
}

const KROKI = {
  /** §7.1 „Włączenie”: wyłącz (Rozumiem) → stała; włącz; 3 przebiegi → 0 zapisów ilości; otwarcie, podgląd, zatwierdź. */
  async wlaczenie(a, { zero = 3 } = {}) {
    const w = {};
    w.start = await przebiegi(a, 1);
    w.wylaczBezRozumiem = await przelacz(a, false, false);
    w.wylacz = await przelacz(a, false, true);
    w.poWylaczeniu = await przebiegi(a, 1);
    w.bilansWylaczone = await bilans(a);
    w.wlacz = await przelacz(a, true, false);
    w.poWlaczeniu = await przebiegi(a, 3);
    w.przejecieWoo = await przejmij(a, 'polcien');
    w.objecieWoo = await obejmij(a, 'polcien');
    w.otwarcie = await otwarcie(a, [zero]);
    w.zatwierdz = await zatwierdz(a);
    w.poZatwierdzeniu = await przebiegi(a, 2);
    w.bilans = await bilans(a);
    w.kartaZero = w.bilans.wiersze.filter((r) => r.karta === zero);
    return w;
  },
  /**
   * D51: jak „wlaczenie”, ale z kontrolą między zapisem stanu otwarcia a „Zatwierdź”: liczba wierszy
   * `stany_zatwierdzenia` i 1 przebieg PRZED zatwierdzeniem, potem to samo PO.
   */
  async d51(a, { zero = 3, bez } = {}) {
    const ile = () => a.db.prepare('SELECT COUNT(*) n FROM stany_zatwierdzenia').get().n;
    const w = { zatwierdzeniaNaStarcie: ile() };
    w.wlacz = await przelacz(a, true, false);
    w.przejecieWoo = await przejmij(a, 'polcien');
    w.objecieWoo = await obejmij(a, 'polcien');
    w.otwarcie = await otwarcie(a, [zero]);
    w.otwarc = a.db.prepare('SELECT COUNT(*) n FROM stany_otwarcia').get().n;
    w.zatwierdzeniaPrzed = ile();
    w.przebiegPrzed = await przebiegi(a, 1);
    if (bez) return w; // zostaw przed „Zatwierdź” (zrzut podglądu)
    w.zatwierdz = await zatwierdz(a);
    w.zatwierdzeniaPo = ile();
    w.przebiegPo = await przebiegi(a, 1);
    return w;
  },
  async bilans(a) {
    return bilans(a);
  },
  /** `czekaj` s przerwy (puls D64 wymaga ≥ 120 s od odczytu), potem n przebiegów, opcjonalnie z pollerem. */
  async przebiegi(a, { n = 1, czekaj = 0, poller }) {
    if (Number(czekaj) > 0) await new Promise((r) => setTimeout(r, Number(czekaj) * 1000));
    return { przebiegi: await przebiegi(a, Number(n), { poller: Boolean(poller) }), bilans: await bilans(a) };
  },
  /** Ruch na karcie jak formularz karty (przyjęcie / korekta z powodem), potem n przebiegów. */
  async ruch(a, { karta, rodzaj = 'przyjecie', ilosc, powod = '', n = 1 }) {
    const r = await a.post(`/magazyn/${Number(karta)}/ruch`, {
      rodzaj,
      ilosc: String(ilosc),
      powod,
      klucz: `dowod${Date.now()}`,
    });
    const p = await przebiegi(a, Number(n));
    return {
      ruch: r.statusCode,
      blad: r.statusCode >= 400 ? tekst(r.body).slice(0, 300) : null,
      przebiegi: p,
      po: (await bilans(a)).wiersze.filter((w) => w.karta === Number(karta)),
    };
  },
  /** Kilka korekt naraz (`--zmiany 2:-3,5:-4`) przed jednym przebiegiem — np. „zero-masowe” na koncie ERLI. */
  async korekty(a, { zmiany, powod = 'dowód: inwentaryzacja', n = 1 }) {
    const ruchy = [];
    for (const para of String(zmiany).split(',')) {
      const [karta, ilosc] = para.split(':').map(Number);
      const r = await a.post(`/magazyn/${karta}/ruch`, {
        rodzaj: 'korekta',
        ilosc: String(ilosc),
        powod,
        klucz: `dowod${Date.now()}k${karta}`,
      });
      ruchy.push({ karta, ilosc, kod: r.statusCode });
    }
    return { ruchy, przebiegi: await przebiegi(a, Number(n)), bilans: await bilans(a) };
  },
  /**
   * D59 przepięcie produktu sklepu na inną kartę (`--kanal polcien --produkt 1107 --karta 23`) tą samą funkcją,
   * której używa panel (`powiazProdukt`); `--nowa "Nazwa;SKU"` najpierw zakłada kartę formularzem /magazyn/nowa-karta.
   * Potem n przebiegów. Wynik: rejestr oferty, ślad przepięcia, wiersze kart.
   */
  async przepnij(a, { kanal, produkt, karta, nowa, n = 1 }) {
    let cel = karta ? Number(karta) : null;
    let nowaKarta = null;
    if (nowa) {
      const [nazwa, sku] = String(nowa).split(';');
      const r = await a.post('/magazyn/nowa-karta', { nazwa, sku, ean: '', cena_zl: '10', stawka_vat: '23' });
      cel = Number(String(r.headers.location ?? '').match(/\/magazyn\/(\d+)/)?.[1]);
      nowaKarta = { kod: r.statusCode, karta: cel };
      if (!cel) throw new Error(`dowód E4: nowa karta nie powstała (${r.statusCode}) ${tekst(r.body).slice(0, 200)}`);
    }
    const p = a.db
      .prepare('SELECT id, karta_id FROM produkty_sklepowe WHERE kanal = ? AND produkt_id = ?')
      .get(String(kanal), String(produkt));
    if (!p) throw new Error(`dowód E4: brak produktu ${kanal}/${produkt}`);
    const { powiazProdukt } = await import('../../src/oms/db/magazyn.js');
    powiazProdukt(a.db, p.id, cel, { konto: 'dowod' });
    const oferta = a.db
      .prepare('SELECT id, karta_id, stan_karty_wyslany FROM oferty_kanalow WHERE kanal = ? AND id_zewnetrzne = ?')
      .get(String(kanal), String(produkt));
    const slad = a.db.prepare('SELECT * FROM stany_przepiecia ORDER BY rowid DESC LIMIT 1').get();
    const prz = await przebiegi(a, Number(n));
    const bil = await bilans(a);
    return {
      nowaKarta,
      produkt: { id: p.id, staraKarta: p.karta_id, nowaKarta: cel },
      oferta,
      slad,
      przebiegi: prz,
      wiersze: bil.wiersze.filter((w) => w.karta === cel || w.karta === p.karta_id),
    };
  },
  /** §7.1 „Zamówienie w A zdejmuje w B i C”. */
  async kup(a, { kanal, karta, ilosc = 2, n = 2 }) {
    const zakup = createZakup({ db: a.db, env: a.env, log: () => {} });
    const przed = (await bilans(a)).wiersze.filter((r) => r.karta === Number(karta));
    const z = await zakup.kup({ kanal, karta: Number(karta), ilosc: Number(ilosc) });
    const p = await przebiegi(a, Number(n));
    const po = (await bilans(a)).wiersze.filter((r) => r.karta === Number(karta));
    return { zakup: z, przed, przebiegi: p, po };
  },
  /** Przycisk panelu (POST pod adres z ekranu, np. problemy-ofert/7/wznow), potem n przebiegów. */
  async akcja(a, { url, n = 1, czekaj = 0, poller }) {
    if (!/^\/magazyn\//.test(String(url))) throw new Error('dowód E4: --url tylko pod /magazyn/');
    const r = await a.post(String(url), {});
    if (Number(czekaj) > 0) await new Promise((res) => setTimeout(res, Number(czekaj) * 1000));
    const p = await przebiegi(a, Number(n), { poller: Boolean(poller) });
    return {
      akcja: r.statusCode,
      gdzie: r.headers.location ?? null,
      blad: r.statusCode >= 400 ? tekst(r.body).slice(0, 300) : null,
      przebiegi: p,
      bilans: await bilans(a),
    };
  },
  /** Odczyt ekranu panelu (GET pod /magazyn/…): kod i tekst bez znaczników, z okolic `--szukaj`. */
  async ekran(a, { url, szukaj = '' }) {
    if (!/^\/magazyn\//.test(String(url))) throw new Error('dowód E4: --url tylko pod /magazyn/');
    const r = await a.get(String(url));
    const t = tekst(r.body);
    const i = szukaj ? t.indexOf(String(szukaj)) : 0;
    return { kod: r.statusCode, znaleziono: i >= 0, fragment: t.slice(Math.max(0, i - 200), Math.max(0, i) + 900) };
  },
  /** „Ręczna zmiana w kanale”: ustawia ilość oferty w atrapie (Allegro albo ERLI), bez udziału OMS. */
  async atrapa(a, { oferta, ilosc }) {
    const o = a.db.prepare('SELECT * FROM oferty_kanalow WHERE id = ?').get(Number(oferta));
    if (!o) throw new Error(`dowód E4: nie ma oferty ${oferta}`);
    const przed = await odczytKanalu(a, o);
    const typ = typKanalu(o.kanal);
    if (typ === 'allegro') {
      const s = createSerwerOfertAllegro({ db: a.db, kanal: o.kanal, env: a.env });
      const x = s.oferta(o.id_zewnetrzne);
      a.db
        .prepare(
          `INSERT INTO atrapa_allegro_oferty (kanal, id, dane_json) VALUES (?,?,?)
        ON CONFLICT(kanal, id) DO UPDATE SET dane_json = excluded.dane_json`,
        )
        .run(
          o.kanal,
          String(o.id_zewnetrzne),
          JSON.stringify({ ...x, stock: { ...x.stock, available: Number(ilosc) } }),
        );
    } else if (typ === 'erli') {
      const w = a.db
        .prepare("SELECT dane_json FROM atrapa_erli_stan WHERE kanal = ? AND rodzaj = 'produkt' AND id = ?")
        .get(o.kanal, o.id_zewnetrzne);
      a.db
        .prepare("UPDATE atrapa_erli_stan SET dane_json = ? WHERE kanal = ? AND rodzaj = 'produkt' AND id = ?")
        .run(JSON.stringify({ ...JSON.parse(w.dane_json), stock: Number(ilosc) }), o.kanal, o.id_zewnetrzne);
    } else throw new Error('dowód E4: atrapa tylko Allegro albo ERLI');
    return { oferta: Number(oferta), przed, po: await odczytKanalu(a, o) };
  },
  /**
   * §7.1 „Restart w dwóch punktach”: ruch na karcie, przebieg „pada” na wywołaniu `metoda` kanału `kanal`
   * (faza przed = atrapa nie dostała zapisu, po = wykonała, odpowiedź zginęła), nowa aplikacja na tej samej bazie,
   * n przebiegów. Wynik: stan w toku z chwili awarii, zapisy po restarcie, komendy ilości w atrapie Allegro, bilans.
   */
  async restart(a, { baza, karta, ilosc = 3, rodzaj = 'przyjecie', kanal, metoda, faza = 'przed', n = 2, czekaj = 0 }) {
    const r = await a.post(`/magazyn/${Number(karta)}/ruch`, {
      rodzaj,
      ilosc: String(ilosc),
      powod: rodzaj === 'korekta' ? 'dowód restartu' : '',
      klucz: `dowod${Date.now()}`,
    });
    const komendyAtrapy = () =>
      a2db().prepare("SELECT COUNT(*) AS n FROM atrapa_allegro_operacje WHERE rodzaj = 'ilosc'").get().n;
    let a2db = () => a.db;
    const komendPrzed = komendyAtrapy();
    Object.assign(a.licznik.awaria, { kanal, metoda, faza });
    void a.przebieg().catch(() => {});
    for (let i = 0; i < 600 && !a.licznik.awaria.trafiona; i++) await new Promise((res) => setTimeout(res, 50));
    await new Promise((res) => setTimeout(res, 300));
    if (!a.licznik.awaria.trafiona) throw new Error(`dowód E4: przebieg nie wywołał ${kanal}.${metoda}`);
    const zapisAwarii = a.licznik.wywolania.filter((w) => w.zapis).at(-1);
    const wToku = a.db
      .prepare(
        `SELECT id, kanal, ilosc_w_toku_json AS wToku, json_extract(wyslane_pola_json, '$.komendaIlosci') AS komenda
      FROM oferty_kanalow WHERE karta_id = ? AND (ilosc_w_toku_json IS NOT NULL OR json_extract(wyslane_pola_json, '$.komendaIlosci') IS NOT NULL)`,
      )
      .all(Number(karta));
    await a.aplikacja.app.close();
    a.db.close();
    a.zamkniety = true;
    const b = await zbuduj({ baza });
    a2db = () => b.db;
    try {
      // ERLI zapisuje przed batch-update przerwę ponowienia (30 s) — restart wcześniej nie ma czego ponawiać.
      if (Number(czekaj) > 0) await new Promise((res) => setTimeout(res, Number(czekaj) * 1000));
      const p = await przebiegi(b, Number(n));
      const bil = await bilans(b);
      return {
        ruch: r.statusCode,
        awaria: { kanal, metoda, faza, argumenty: JSON.stringify(zapisAwarii?.args ?? null).slice(0, 300) },
        wToku,
        poRestarcie: p,
        komendIlosciAllegro: komendyAtrapy() - komendPrzed,
        karta: bil.wiersze.filter((w) => w.karta === Number(karta)),
        bilans: { porownane: bil.porownane, zgodne: bil.zgodne, rozjazdy: bil.rozjazdy, zablokowane: bil.zablokowane },
      };
    } finally {
      await b.zamknij();
    }
  },
  async anuluj(a, { zamowienie, karta, n = 1 }) {
    const zakup = createZakup({ db: a.db, env: a.env, log: () => {} });
    const przed = (await bilans(a)).wiersze.filter((r) => r.karta === Number(karta));
    const z = await zakup.anuluj({ zamowienie: Number(zamowienie) });
    const p = await przebiegi(a, Number(n));
    const po = (await bilans(a)).wiersze.filter((r) => r.karta === Number(karta));
    return { anulowanie: z, przed, przebiegi: p, po };
  },
};

export async function scenariusz({ baza, krok, ...opcje }) {
  const f = KROKI[krok];
  if (!f) throw new Error(`dowód E4: --krok ${Object.keys(KROKI).join('|')}`);
  const a = await zbuduj({ baza });
  try {
    const wynik = await f(a, { ...opcje, baza });
    return {
      krok,
      wynik,
      logi: a.logi.filter((l) => !/^stany-woo: konto polcien: odczyt 0, zapis 0/.test(l)).slice(-60),
    };
  } finally {
    if (!a.zamkniety) await a.zamknij();
  }
}
