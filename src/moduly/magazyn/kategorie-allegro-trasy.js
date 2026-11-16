// Jedyny ekran mapowania: kategoria karty → kategoria Allegro (liść) z regułami
// wymaganych parametrów oraz marka → wartość słownika marek Allegro.
// Mapy i reguły są na środowisko (produkcja/sandbox), nie na konto. Opis kategorii i podpowiedzi czytamy
// przez `kontoOpisuSrodowiska` (pierwsze połączone konto środowiska ze zgodą na odczyt ofert).
// Uprawnienie: ekran „magazyn” (prefiks /magazyn, jak strony słowników); CSRF pilnuje rdzeń dla każdego POST.
// Producent marki jest ustawieniem konta — nie tutaj.
import { listaSlownika, czystaNazwa, wTransakcji } from './services/slowniki-kart.js';
import { opisKategoriiAllegro, kontoOpisuSrodowiska, szukajWartosciSlownika } from './services/kategorie-allegro.js';
import { uprawnieniaZTokenu } from '../../domena/uprawnienia-kanalu.js';
import { wczytajTokeny } from '../../oms/db/tokeny.js';
import { stronaOdmowy } from '../../core/web/odmowa.js';

export const SRODOWISKA = Object.freeze(['produkcja', 'sandbox']);
const NAJWIECEJ_PODPOWIEDZI = 10;
const NAJWIECEJ_ZAPYTAN_LISCIA = 2 * NAJWIECEJ_PODPOWIEDZI;
const PRZYKLADOWE_KARTY = 3;
const PARAMETR_STAN = '11323';
// Pola karty, z których reguła „pole karty” może brać wartość; `marka` idzie przez mapę marek.
export const POLA_KARTY = Object.freeze({
  sku: 'SKU', ean: 'EAN', nazwa: 'Nazwa', marka: 'Marka (mapa marek)',
  szerokosc_mm: 'Szerokość [mm]', wysokosc_mm: 'Wysokość [mm]', glebokosc_mm: 'Głębokość [mm]', waga_g: 'Waga [g]',
});
// Te same klucze co przeliczniki w src/domena/allegro-oferta-z-karty.js (tam niewyeksportowane).
export const PRZELICZNIKI = Object.freeze({ '': 'bez przeliczenia', mm_na_cm: 'mm → cm', g_na_kg: 'g → kg' });
const RODZAJE = new Set(['stala', 'pole', 'na_karcie']);

const napis = v => (typeof v === 'string' ? v.trim() : '');
const jsonLista = tekst => { try { const v = JSON.parse(tekst ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
const sciezkaTekst = sciezka => jsonLista(sciezka).map(k => k?.nazwa ?? k?.name ?? k?.id).filter(Boolean).join(' › ');
const nazwaKategoriiAllegro = (sciezkaJson, id) => {
  const ostatnia = jsonLista(sciezkaJson).at(-1);
  return napis(ostatnia?.nazwa) || `kategoria ${id}`;
};
const bezWielkosci = v => String(v ?? '').trim().toLocaleLowerCase('pl');

/** Konta Allegro w kształcie, którego oczekuje `kontoOpisuSrodowiska` (uprawnienia z tokenu w bazie). */
function kontaDoOpisu(db, kontaAllegro) {
  return (kontaAllegro?.() ?? []).map(k => ({ klucz: k.klucz, klient: k.klient, srodowisko: k.srodowisko,
    autoryzacja: 'polaczone', uprawnienia: uprawnieniaZTokenu(wczytajTokeny(db, k.klucz)?.access_token) }));
}

/** Kolumna „Allegro” na stronach słowników: mapowania wg nazwy (tylko gdy jest konto Allegro albo mapa). */
export function kolumnaAllegro(db, typ, kontaAllegro) {
  const tabela = typ === 'kategorie' ? 'allegro_mapa_kategorii' : 'allegro_marki';
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tabela)) return null;
  const wiersze = typ === 'kategorie'
    ? db.prepare('SELECT kategoria_karty AS nazwa, srodowisko, kategoria_allegro_id AS id, sciezka_json FROM allegro_mapa_kategorii').all()
      .map(w => ({ nazwa: w.nazwa, srodowisko: w.srodowisko, tekst: sciezkaTekst(w.sciezka_json) || `kategoria ${w.id}` }))
    : db.prepare('SELECT marka AS nazwa, srodowisko, wartosc_id, wartosc_tekst FROM allegro_marki').all()
      .map(w => ({ nazwa: w.nazwa, srodowisko: w.srodowisko, tekst: napis(w.wartosc_tekst) || napis(w.wartosc_id) }));
  const konta = kontaAllegro?.() ?? [];
  if (!konta.length && !wiersze.length) return null;
  const mapa = new Map();
  for (const w of wiersze.sort((a, b) => SRODOWISKA.indexOf(a.srodowisko) - SRODOWISKA.indexOf(b.srodowisko))) {
    mapa.set(w.nazwa, [...(mapa.get(w.nazwa) ?? []), w]);
  }
  const adres = nazwa => `/magazyn/${typ}/${encodeURIComponent(nazwa)}/allegro`;
  const wieleSrodowisk = new Set([...konta.map(k => k.srodowisko), ...wiersze.map(w => w.srodowisko)]).size > 1;
  return { przypisania: nazwa => mapa.get(nazwa) ?? [], adres, wieleSrodowisk };
}

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {{ db: any, kontaAllegro?: () => Array<{ klucz: string, klient: any, srodowisko: string }> }} opcje
 */
export function registerKategorieAllegro(app, { db, kontaAllegro = () => [] }) {
  const konta = () => kontaDoOpisu(db, kontaAllegro);
  const srodowiskaKont = () => SRODOWISKA.filter(s => konta().some(k => k.srodowisko === s));
  const wybraneSrodowisko = wartosc => (SRODOWISKA.includes(wartosc) ? wartosc : srodowiskaKont()[0] ?? 'produkcja');
  const brakKonta = srodowisko => `Połącz konto Allegro w środowisku ${srodowisko} ze zgodą na odczyt ofert (Ustawienia → Integracje), żeby pobrać kategorie i słowniki.`;
  const istnieje = (typ, nazwa) => listaSlownika(db, typ).pozycje.some(p => p.nazwa === nazwa);
  const login = req => req.konto?.login ?? null;

  const mapaKategorii = (nazwa, srodowisko) => db.prepare(`SELECT kategoria_allegro_id, sciezka_json, potwierdzil, potwierdzono_at
    FROM allegro_mapa_kategorii WHERE kategoria_karty = ? AND srodowisko = ?`).get(nazwa, srodowisko) ?? null;
  const regulyKategorii = (srodowisko, kategoriaId) => db.prepare(`SELECT parametr_id, rodzaj, wartosc_json, pole, przelicznik
    FROM allegro_reguly_parametrow WHERE srodowisko = ? AND kategoria_allegro_id = ?`).all(srodowisko, String(kategoriaId));

  // ——— Kategoria ———————————————————————————————————————————————————————————————————————————————

  // `sprawdzone`: id → liść?, wspólne dla nazw jednej podpowiedzi; najwyżej NAJWIECEJ_ZAPYTAN_LISCIA GET-ów na ekran.
  async function czyLisc(konto, k, id, sprawdzone) {
    if (typeof k?.leaf === 'boolean') return k.leaf;
    if (!sprawdzone.has(id)) {
      if (sprawdzone.size >= NAJWIECEJ_ZAPYTAN_LISCIA) return false;
      sprawdzone.set(id, await konto.klient.pobierzKategorie(id).then(d => d?.leaf === true, () => false));
    }
    return sprawdzone.get(id);
  }

  async function podpowiedziKategorii(konto, nazwa) {
    const nazwy = [nazwa, ...db.prepare('SELECT nazwa FROM karty_produktow WHERE kategoria_glowna = ? AND trim(nazwa) <> \'\' ORDER BY id LIMIT ?')
      .all(nazwa, PRZYKLADOWE_KARTY).map(r => r.nazwa)];
    const wynik = new Map();
    const sprawdzone = new Map();
    for (const tekst of [...new Set(nazwy)]) {
      const lista = await konto.klient.dopasujKategorie(tekst);
      for (const k of Array.isArray(lista) ? lista : []) {
        const id = napis(String(k?.id ?? ''));
        if (!id || wynik.has(id) || wynik.size >= NAJWIECEJ_PODPOWIEDZI) continue;
        // Podpowiadamy wyłącznie liście. matching-categories zwykle nie oddaje `leaf` — wtedy pytamy o kategorię.
        if (!(await czyLisc(konto, k, id, sprawdzone))) continue;
        wynik.set(id, { id, nazwa: napis(k?.name) || id, rodzic: napis(k?.parentCategory?.name) });
      }
    }
    return [...wynik.values()];
  }

  function komplet(nazwa, srodowisko, kategoriaId, wymagane, reguly) {
    const karty = db.prepare('SELECT * FROM karty_produktow WHERE kategoria_glowna = ?').all(nazwa);
    const marki = new Map(db.prepare('SELECT marka, wartosc_id, wartosc_tekst, kategorie_sprawdzone_json FROM allegro_marki WHERE srodowisko = ?')
      .all(srodowisko).map(m => [m.marka, m]));
    const nadpisania = new Map(db.prepare(`SELECT ka.karta_id, ka.parametry_json FROM karty_allegro ka
      JOIN karty_produktow k ON k.id = ka.karta_id WHERE k.kategoria_glowna = ?`).all(nazwa)
      .map(w => [w.karta_id, new Set(jsonLista(w.parametry_json).map(p => String(p?.id)))]));
    const regula = new Map(reguly.map(r => [r.parametr_id, r]));
    const braki = new Map();
    let pelne = 0;
    for (const karta of karty) {
      let ok = true;
      for (const p of wymagane) {
        const r = regula.get(String(p.id));
        let jest = nadpisania.get(karta.id)?.has(String(p.id)) ?? false;
        if (!jest && r?.rodzaj === 'stala') jest = Boolean(r.wartosc_json);
        else if (!jest && r?.rodzaj === 'pole' && r.pole === 'marka') {
          const m = marki.get(karta.marka);
          jest = Boolean(m && (m.wartosc_id || m.wartosc_tekst) && jsonLista(m.kategorie_sprawdzone_json).map(String).includes(String(kategoriaId)));
        } else if (!jest && r?.rodzaj === 'pole') jest = karta[r.pole] !== null && karta[r.pole] !== undefined && String(karta[r.pole]).trim() !== '';
        if (!jest) { ok = false; braki.set(p.nazwa, (braki.get(p.nazwa) ?? 0) + 1); }
      }
      if (ok) pelne += 1;
    }
    return { karty: karty.length, pelne, braki: [...braki.entries()].map(([parametr, ile]) => ({ parametr, ile })) };
  }

  async function ekranKategorii(req, reply, nazwa, { kod = 200, blad = null, srodowisko: wymuszone = null } = {}) {
    const q = req.query ?? {};
    const srodowisko = wybraneSrodowisko(wymuszone ?? q.srodowisko);
    const konto = kontoOpisuSrodowiska(konta(), srodowisko);
    const mapa = mapaKategorii(nazwa, srodowisko);
    const stan = { brakKonta: konto ? null : brakKonta(srodowisko), podpowiedzi: [], bladPodpowiedzi: null,
      opis: null, bladOpisu: null, wymagane: [], reguly: new Map(), komplet: null, wyszukane: null };
    if (konto && (!mapa || q.podpowiedzi === '1')) {
      try { stan.podpowiedzi = await podpowiedziKategorii(konto, nazwa); }
      catch { stan.bladPodpowiedzi = 'Nie udało się pobrać podpowiedzi z Allegro (brak dostępu albo błąd połączenia). Wpisz numer kategorii ręcznie albo spróbuj później.'; }
    }
    if (konto && mapa) {
      try {
        stan.opis = await opisKategoriiAllegro({ db, klient: konto.klient, polaczenie: konto.klucz, kategoriaId: mapa.kategoria_allegro_id });
        if (!stan.opis) stan.bladOpisu = 'Allegro odmówiło opisu tej kategorii — sprawdź zgody konta.';
      } catch { stan.bladOpisu = 'Nie udało się pobrać opisu kategorii z Allegro. Spróbuj później.'; }
    }
    if (stan.opis && mapa) {
      stan.wymagane = (stan.opis.parametry ?? []).filter(p => p.wymagany || p.wymaganyDlaProduktu);
      const reguly = regulyKategorii(srodowisko, mapa.kategoria_allegro_id);
      stan.reguly = new Map(reguly.map(r => [r.parametr_id, r]));
      stan.komplet = komplet(nazwa, srodowisko, mapa.kategoria_allegro_id, stan.wymagane, reguly);
      const szukany = stan.wymagane.find(p => String(p.id) === napis(q.parametr));
      if (szukany && napis(q.szukaj)) {
        try {
          stan.wyszukane = { parametrId: String(szukany.id), tekst: napis(q.szukaj),
            wartosci: await szukajWartosciSlownika({ klient: konto.klient, kategoriaId: mapa.kategoria_allegro_id, parametrId: szukany.id, tekst: q.szukaj }) };
        } catch { stan.bladOpisu = 'Nie udało się przeszukać słownika w Allegro. Spróbuj później.'; }
      }
    }
    return reply.code(kod).view('magazyn-kategoria-allegro.ejs', {
      title: `Magazyn — kategoria „${nazwa}” w Allegro`, nazwa, srodowisko, srodowiska: srodowiskaKont(), blad,
      adres: `/magazyn/kategorie/${encodeURIComponent(nazwa)}/allegro`, mozeZatwierdzic: req.konto?.admin === true,
      mapa, sciezka: mapa ? sciezkaTekst(mapa.sciezka_json) : '', pola: POLA_KARTY, przeliczniki: PRZELICZNIKI, ...stan,
    });
  }

  /** Słownik parametru z pełnej odpowiedzi Allegro (słowniki ponad 200 wartości nie trafiają do opisu w bazie). */
  const slownikParametru = (odpowiedz, parametrId) => {
    const p = (Array.isArray(odpowiedz?.parameters) ? odpowiedz.parameters : []).find(x => String(x?.id) === String(parametrId));
    return Array.isArray(p?.dictionary) ? p.dictionary : [];
  };

  app.get('/magazyn/kategorie/:nazwa/allegro', async (req, reply) => {
    const nazwa = czystaNazwa(req.params.nazwa);
    if (!nazwa || !istnieje('kategorie', nazwa)) return stronaOdmowy(reply, 404, 'Nie ma takiej kategorii.', { wroc: '/magazyn/kategorie', napisWroc: 'Kategorie' });
    return ekranKategorii(req, reply, nazwa);
  });

  app.post('/magazyn/kategorie/:nazwa/allegro', async (req, reply) => {
    // Mapę kategorii (wpływa na wszystkie oferty kategorii) zatwierdza tylko administrator.
    if (req.konto?.admin !== true) {
      return stronaOdmowy(reply, 403, 'Tylko administrator może zatwierdzić kategorię Allegro.', { wroc: '/magazyn/kategorie', napisWroc: 'Kategorie' });
    }
    const nazwa = czystaNazwa(req.params.nazwa);
    if (!nazwa || !istnieje('kategorie', nazwa)) return stronaOdmowy(reply, 404, 'Nie ma takiej kategorii.', { wroc: '/magazyn/kategorie', napisWroc: 'Kategorie' });
    const srodowisko = napis(req.body?.srodowisko);
    // Numer wpisany ręcznie wygrywa z zaznaczoną podpowiedzią.
    const kategoriaId = napis(req.body?.kategoria_reczna) || napis(req.body?.kategoria_id);
    const odmowa = (kod, blad) => ekranKategorii(req, reply, nazwa, { kod, blad, srodowisko: SRODOWISKA.includes(srodowisko) ? srodowisko : null });
    if (!SRODOWISKA.includes(srodowisko)) return odmowa(400, 'Wybierz środowisko Allegro.');
    if (!/^\d{1,12}$/.test(kategoriaId)) return odmowa(400, 'Podaj numer kategorii Allegro (same cyfry).');
    const konto = kontoOpisuSrodowiska(konta(), srodowisko);
    if (!konto) return odmowa(400, brakKonta(srodowisko));
    let opis;
    let surowe = null;
    const marki = db.prepare(`SELECT marka, parametr_id, wartosc_id, kategorie_sprawdzone_json FROM allegro_marki
      WHERE srodowisko = ? AND wartosc_id IS NOT NULL AND parametr_id IS NOT NULL`).all(srodowisko);
    try {
      opis = await opisKategoriiAllegro({ db, klient: konto.klient, polaczenie: konto.klucz, kategoriaId });
      if (opis?.lisc && marki.length) surowe = await konto.klient.pobierzParametryKategorii(kategoriaId);
    } catch {
      return odmowa(502, 'Nie udało się pobrać opisu kategorii z Allegro. Sprawdź numer i spróbuj ponownie.');
    }
    if (!opis) return odmowa(400, `Allegro nie oddało kategorii ${kategoriaId} — sprawdź numer i zgody konta.`);
    if (!opis.lisc) return odmowa(400, `Kategoria ${kategoriaId} nie jest liściem — wybierz najniższą kategorię (bez podkategorii).`);
    const teraz = new Date().toISOString();
    const stan = (opis.parametry ?? []).find(p => String(p.id) === PARAMETR_STAN);
    const nowy = (stan?.slownik ?? []).find(w => bezWielkosci(w.wartosc) === 'nowy');
    wTransakcji(db, () => {
      const zmiana = { nazwa, srodowisko, id: kategoriaId, sciezka: JSON.stringify(opis.sciezka ?? []), kto: login(req), teraz };
      const zmienione = db.prepare(`UPDATE allegro_mapa_kategorii SET kategoria_allegro_id = @id, sciezka_json = @sciezka,
        potwierdzil = @kto, potwierdzono_at = @teraz WHERE kategoria_karty = @nazwa AND srodowisko = @srodowisko`).run(zmiana).changes;
      if (!zmienione) {
        db.prepare(`INSERT INTO allegro_mapa_kategorii (kategoria_karty, srodowisko, kategoria_allegro_id, sciezka_json, potwierdzil, potwierdzono_at)
          VALUES (@nazwa, @srodowisko, @id, @sciezka, @kto, @teraz)`).run(zmiana);
      }
      // „Stan” od razu „stała: Nowy”; istniejącej reguły nie nadpisujemy.
      if (nowy) {
        db.prepare(`INSERT OR IGNORE INTO allegro_reguly_parametrow (srodowisko, kategoria_allegro_id, parametr_id, rodzaj, wartosc_json, potwierdzil, zmieniono_at)
          VALUES (?, ?, ?, 'stala', ?, ?, ?)`).run(srodowisko, kategoriaId, PARAMETR_STAN, JSON.stringify({ valuesIds: [nowy.id] }), login(req), teraz);
      }
      // Słownik każdej zmapowanej marki w tej kategorii — dopisanie albo zdjęcie z `kategorie_sprawdzone_json`.
      for (const m of surowe ? marki : []) {
        const jest = slownikParametru(surowe, m.parametr_id).some(w => String(w?.id) === m.wartosc_id);
        const lista = jsonLista(m.kategorie_sprawdzone_json).map(String).filter(id => id !== kategoriaId);
        if (jest) lista.push(kategoriaId);
        db.prepare('UPDATE allegro_marki SET kategorie_sprawdzone_json = ?, zmieniono_at = ? WHERE marka = ? AND srodowisko = ?')
          .run(JSON.stringify(lista), teraz, m.marka, srodowisko);
      }
    });
    return reply.code(303).redirect(`/magazyn/kategorie/${encodeURIComponent(nazwa)}/allegro?srodowisko=${srodowisko}`);
  });

  app.post('/magazyn/kategorie/:nazwa/allegro/regula', async (req, reply) => {
    // Reguła parametru zmienia treść żywych ofert kategorii — tylko administrator.
    if (req.konto?.admin !== true) {
      return stronaOdmowy(reply, 403, 'Tylko administrator może ustalać reguły parametrów Allegro.', { wroc: '/magazyn/kategorie', napisWroc: 'Kategorie' });
    }
    const nazwa = czystaNazwa(req.params.nazwa);
    if (!nazwa || !istnieje('kategorie', nazwa)) return stronaOdmowy(reply, 404, 'Nie ma takiej kategorii.', { wroc: '/magazyn/kategorie', napisWroc: 'Kategorie' });
    const b = req.body ?? {};
    const srodowisko = napis(b.srodowisko);
    const odmowa = (kod, blad) => ekranKategorii(req, reply, nazwa, { kod, blad, srodowisko: SRODOWISKA.includes(srodowisko) ? srodowisko : null });
    if (!SRODOWISKA.includes(srodowisko)) return odmowa(400, 'Wybierz środowisko Allegro.');
    const mapa = mapaKategorii(nazwa, srodowisko);
    if (!mapa) return odmowa(400, 'Najpierw zatwierdź kategorię Allegro w tym środowisku.');
    const konto = kontoOpisuSrodowiska(konta(), srodowisko);
    if (!konto) return odmowa(400, brakKonta(srodowisko));
    const kategoriaId = mapa.kategoria_allegro_id;
    let opis;
    try { opis = await opisKategoriiAllegro({ db, klient: konto.klient, polaczenie: konto.klucz, kategoriaId }); }
    catch { return odmowa(502, 'Nie udało się pobrać opisu kategorii z Allegro. Spróbuj później.'); }
    const parametrId = napis(b.parametr_id);
    const parametr = (opis?.parametry ?? []).find(p => String(p.id) === parametrId);
    if (!parametr) return odmowa(400, `Parametr ${parametrId || '(pusty)'} jest spoza kategorii Allegro ${kategoriaId}.`);
    const rodzaj = napis(b.rodzaj);
    if (!RODZAJE.has(rodzaj)) return odmowa(400, 'Wybierz, skąd brać wartość parametru.');
    const regula = { wartosc_json: null, pole: null, przelicznik: null };
    if (rodzaj === 'stala') {
      const wartosc = napis(b.wartosc);
      if (!wartosc) return odmowa(400, `Podaj wartość parametru „${parametr.nazwa}”.`);
      if (parametr.typ === 'dictionary') {
        let jest = (parametr.slownik ?? []).some(w => w.id === wartosc);
        if (!jest && parametr.slownikWyciety) {
          try { jest = slownikParametru(await konto.klient.pobierzParametryKategorii(kategoriaId), parametrId).some(w => String(w?.id) === wartosc); }
          catch { return odmowa(502, 'Nie udało się sprawdzić wartości w słowniku Allegro. Spróbuj później.'); }
        }
        if (!jest) return odmowa(400, `Wartości „${wartosc}” nie ma w słowniku parametru „${parametr.nazwa}”.`);
        regula.wartosc_json = JSON.stringify({ valuesIds: [wartosc] });
      } else {
        if (wartosc.length > 200) return odmowa(400, 'Wartość jest za długa (najwyżej 200 znaków).');
        regula.wartosc_json = JSON.stringify({ values: [wartosc] });
      }
    } else if (rodzaj === 'pole') {
      const pole = napis(b.pole);
      const przelicznik = napis(b.przelicznik);
      if (!Object.hasOwn(POLA_KARTY, pole)) return odmowa(400, 'Wybierz pole karty z listy.');
      if (!Object.hasOwn(PRZELICZNIKI, przelicznik)) return odmowa(400, 'Wybierz przelicznik z listy.');
      regula.pole = pole;
      regula.przelicznik = przelicznik || null;
    }
    db.prepare(`INSERT INTO allegro_reguly_parametrow (srodowisko, kategoria_allegro_id, parametr_id, rodzaj, wartosc_json, pole, przelicznik, potwierdzil, zmieniono_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (srodowisko, kategoria_allegro_id, parametr_id) DO UPDATE SET rodzaj = excluded.rodzaj, wartosc_json = excluded.wartosc_json,
        pole = excluded.pole, przelicznik = excluded.przelicznik, potwierdzil = excluded.potwierdzil, zmieniono_at = excluded.zmieniono_at`)
      .run(srodowisko, kategoriaId, parametrId, rodzaj, regula.wartosc_json, regula.pole, regula.przelicznik, login(req), new Date().toISOString());
    return reply.code(303).redirect(`/magazyn/kategorie/${encodeURIComponent(nazwa)}/allegro?srodowisko=${srodowisko}#parametr-${encodeURIComponent(parametrId)}`);
  });

  // ——— Marka ——————————————————————————————————————————————————————————————————————————————————

  const kategorieSrodowiska = srodowisko => db.prepare(`SELECT kategoria_allegro_id AS id, MIN(sciezka_json) AS sciezka_json,
    group_concat(kategoria_karty, ', ') AS karty FROM allegro_mapa_kategorii WHERE srodowisko = ? GROUP BY kategoria_allegro_id ORDER BY kategoria_allegro_id`)
    .all(srodowisko).map(k => ({ id: k.id, nazwa: nazwaKategoriiAllegro(k.sciezka_json, k.id), karty: k.karty }));

  /** Parametr marki: reguła „pole karty: marka” środowiska, inaczej parametr „Marka” z opisu pierwszej kategorii. */
  async function parametrMarki(konto, srodowisko, kategorie) {
    const zReguly = db.prepare(`SELECT parametr_id FROM allegro_reguly_parametrow WHERE srodowisko = ? AND rodzaj = 'pole' AND pole = 'marka'
      ORDER BY kategoria_allegro_id LIMIT 1`).get(srodowisko);
    if (zReguly) return String(zReguly.parametr_id);
    if (!kategorie.length) return null;
    const opis = await opisKategoriiAllegro({ db, klient: konto.klient, polaczenie: konto.klucz, kategoriaId: kategorie[0].id });
    const p = (opis?.parametry ?? []).find(x => bezWielkosci(x.nazwa) === 'marka');
    return p ? String(p.id) : null;
  }

  async function ekranMarki(req, reply, marka, { kod = 200, blad = null, srodowisko: wymuszone = null } = {}) {
    const q = req.query ?? {};
    const srodowisko = wybraneSrodowisko(wymuszone ?? q.srodowisko);
    const konto = kontoOpisuSrodowiska(konta(), srodowisko);
    const kategorie = kategorieSrodowiska(srodowisko);
    const wiersz = db.prepare('SELECT * FROM allegro_marki WHERE marka = ? AND srodowisko = ?').get(marka, srodowisko) ?? null;
    const sprawdzone = new Set(jsonLista(wiersz?.kategorie_sprawdzone_json).map(String));
    const stan = { brakKonta: konto ? null : brakKonta(srodowisko), parametrId: null, propozycje: [], bezMarki: [], bladSlownika: null, szukaj: napis(q.szukaj) };
    if (konto && kategorie.length) {
      try {
        stan.parametrId = await parametrMarki(konto, srodowisko, kategorie);
        if (stan.parametrId) {
          // Jedno pobranie słownika na żądanie ekranu (słownik marek nie trafia do bazy).
          const pamiec = new Map();
          const klient = { pobierzParametryKategorii: id => {
            if (!pamiec.has(id)) pamiec.set(id, konto.klient.pobierzParametryKategorii(id));
            return pamiec.get(id);
          } };
          const szukaj = tekst => szukajWartosciSlownika({ klient, kategoriaId: kategorie[0].id, parametrId: stan.parametrId, tekst });
          const trafienia = await szukaj(stan.szukaj || marka);
          // Podpowiedź: dokładne trafienie (bez wielkości liter i spacji brzegowych) na górze.
          stan.propozycje = trafienia.map(w => ({ ...w, dokladna: bezWielkosci(w.wartosc) === bezWielkosci(marka) }))
            .sort((a, b) => Number(b.dokladna) - Number(a.dokladna));
          stan.bezMarki = await szukaj('bez marki');
        } else {
          stan.bladSlownika = 'Przypisane kategorie Allegro nie mają parametru marki.';
        }
      } catch { stan.bladSlownika = 'Nie udało się pobrać słownika marek z Allegro (brak dostępu albo błąd połączenia). Spróbuj później.'; }
    }
    return reply.code(kod).view('magazyn-marka-allegro.ejs', {
      title: `Magazyn — marka „${marka}” w Allegro`, marka, srodowisko, srodowiska: srodowiskaKont(), blad, wiersz, kategorie,
      adres: `/magazyn/marki/${encodeURIComponent(marka)}/allegro`, mozeZatwierdzic: req.konto?.admin === true,
      bezWartosci: wiersz ? kategorie.filter(k => !sprawdzone.has(String(k.id))) : [], ...stan,
    });
  }

  app.get('/magazyn/marki/:marka/allegro', async (req, reply) => {
    const marka = czystaNazwa(req.params.marka);
    if (!marka || !istnieje('marki', marka)) return stronaOdmowy(reply, 404, 'Nie ma takiej marki.', { wroc: '/magazyn/marki', napisWroc: 'Marki' });
    return ekranMarki(req, reply, marka);
  });

  app.post('/magazyn/marki/:marka/allegro', async (req, reply) => {
    // Marka trafia do treści żywych ofert — tylko administrator.
    if (req.konto?.admin !== true) {
      return stronaOdmowy(reply, 403, 'Tylko administrator może zatwierdzić markę Allegro.', { wroc: '/magazyn/marki', napisWroc: 'Marki' });
    }
    const marka = czystaNazwa(req.params.marka);
    if (!marka || !istnieje('marki', marka)) return stronaOdmowy(reply, 404, 'Nie ma takiej marki.', { wroc: '/magazyn/marki', napisWroc: 'Marki' });
    const b = req.body ?? {};
    const srodowisko = napis(b.srodowisko);
    const odmowa = (kod, blad) => ekranMarki(req, reply, marka, { kod, blad, srodowisko: SRODOWISKA.includes(srodowisko) ? srodowisko : null });
    if (!SRODOWISKA.includes(srodowisko)) return odmowa(400, 'Wybierz środowisko Allegro.');
    const parametrId = napis(b.parametr_id);
    const wartoscId = napis(b.wartosc_id);
    if (!/^\d{1,12}$/.test(parametrId) || !wartoscId || wartoscId.length > 100) return odmowa(400, 'Wybierz wartość ze słownika marek Allegro.');
    const konto = kontoOpisuSrodowiska(konta(), srodowisko);
    if (!konto) return odmowa(400, brakKonta(srodowisko));
    const kategorie = kategorieSrodowiska(srodowisko);
    if (!kategorie.length) return odmowa(400, `Najpierw przypisz kategorię Allegro w środowisku ${srodowisko} (Magazyn → Kategorie).`);
    // Wartość sprawdzana w słowniku KAŻDEJ zmapowanej kategorii środowiska.
    const sprawdzone = [];
    let tekst = null;
    try {
      for (const k of kategorie) {
        const wartosc = slownikParametru(await konto.klient.pobierzParametryKategorii(k.id), parametrId).find(w => String(w?.id) === wartoscId);
        if (wartosc) tekst ??= napis(wartosc.value) || null;
        if (wartosc) sprawdzone.push(String(k.id));
      }
    } catch {
      return odmowa(502, 'Nie udało się sprawdzić wartości w słownikach Allegro. Spróbuj później.');
    }
    if (!sprawdzone.length) return odmowa(400, 'Tej wartości nie ma w słowniku marek żadnej przypisanej kategorii Allegro.');
    db.prepare(`INSERT INTO allegro_marki (marka, srodowisko, parametr_id, wartosc_id, wartosc_tekst, kategorie_sprawdzone_json, potwierdzil, zmieniono_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (marka, srodowisko) DO UPDATE SET parametr_id = excluded.parametr_id, wartosc_id = excluded.wartosc_id,
        wartosc_tekst = excluded.wartosc_tekst, kategorie_sprawdzone_json = excluded.kategorie_sprawdzone_json,
        potwierdzil = excluded.potwierdzil, zmieniono_at = excluded.zmieniono_at`)
      .run(marka, srodowisko, parametrId, wartoscId, tekst, JSON.stringify(sprawdzone), login(req), new Date().toISOString());
    return reply.code(303).redirect(`/magazyn/marki/${encodeURIComponent(marka)}/allegro?srodowisko=${srodowisko}`);
  });
}
