// Przebieg „Pobierz treść i zdjęcia ofert": oferty Allegro powiązane z kartą → pola karty, galeria
// i dane kanału. Tylko odczyt z Allegro; zapis wyłącznie do bazy OMS i katalogu zdjęć.
//
// Kolejność na ofertę: pobierzOferte → opisKategoriiAllegro → trescOfertyAllegro → zdjęcia (poza transakcją,
// najwyżej 2 naraz) → jedna transakcja zapisu. Zapytania do Allegro idą po kolei.
// Wznowienie: kolejka to oferty bez `tresc_pobrana_at`; odczyt listy (`magazyn-sync.js`) zeruje to pole, gdy
// `updatedAt` z listy różni się od `tresc_zmieniona_at`.
import { importMozeZapisac, polePuste } from '../../../domena/zrodla-pol.js';
import { markaZParametrow } from '../../../domena/slowniki-kart.js';
import { kolejnoscZrodel } from './kolejnosc-zrodel.js';
import { trescOfertyAllegro } from '../../../domena/tresc-oferty-allegro.js';
import { opisKategoriiAllegro } from './kategorie-allegro.js';
import { pobierzZdjecie as pobierzZdjecieSieci, zapiszZdjecie as zapiszZdjeciePlik } from './zdjecia-pliki.js';

const LIMIT_ZDJEC = 20;
const ZDJECIA_NARAZ = 2;

const opisBledu = e => (typeof e?.message === 'string' && e.message ? e.message : String(e));
const odmowa = e => e?.status === 401 || e?.status === 403;
const komunikatOdmowy = (kanal, e) => `Allegro odmówiło dostępu do konta ${kanal} (HTTP ${e.status}). `
  + 'Połącz konto ponownie w Ustawieniach i uruchom pobieranie jeszcze raz — pobrane oferty zostaną pominięte.';

// Zdjęcie ma najwyżej 3 próby; odstęp przed 2. i 3. próbą (ms). Ponawiamy tylko błędy chwilowe.
const PROBY_ZDJECIA = 3;
const ODSTEPY_PROB = [2000, 10000];
const KODY_SIECI = new Set(['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN',
  'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
const czekajDomyslnie = ms => new Promise(r => { setTimeout(r, ms); });

// Chwilowy: HTTP 429 i 5xx, zerwana sieć, przekroczony czas (`chwilowy` z `pobierzZdjecie`). Reszta (404, 410,
// zły typ, za duży plik, niedozwolony adres) — od razu błąd.
function chwilowyBladZdjecia(e) {
  if (Number.isInteger(e?.status)) return (e.status === 429 || e.status >= 500);
  return e?.chwilowy === true || KODY_SIECI.has(e?.code) || KODY_SIECI.has(e?.cause?.code);
}

// Tekst do `tresc_blad`: bez adresów (zapytania mogą nieść tokeny), krótki.
const bezAdresow = t => t.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '(adres)').slice(0, 300);

/**
 * Oferty do pobrania. Jedna oferta na kartę i konto (kanał): aktywna (`zniknal_at` puste; `status_publikacji`
 * ACTIVE albo nieznany) o najniższym `id` w lustrze; bez aktywnej — najniższe `id` spośród niezniknietych.
 * `ofertaWskazana` (id wiersza `produkty_sklepowe`) omija ten wybór i `tresc_pobrana_at` — dla przycisku
 * „Weź treść z tej oferty".
 * `karty` (opcjonalne) zawęża kolejkę do podanych kart — import „tylko nowe" bierze treść
 * wyłącznie dla kart, które właśnie utworzył.
 */
export function kolejka(db, kanaly, ofertaWskazana = null, karty = null) {
  if (!kanaly.length) return [];
  if (karty && !karty.length) return [];
  const naKartach = karty ? ` AND karta_id IN (${karty.map(() => '?').join(', ')})` : '';
  const wKanalach = `kanal IN (${kanaly.map(() => '?').join(', ')}) AND karta_id IS NOT NULL AND zniknal_at IS NULL${naKartach}`;
  const parametry = karty ? [...kanaly, ...karty] : kanaly;
  if (ofertaWskazana !== null && ofertaWskazana !== undefined) {
    return db.prepare(`SELECT id, kanal, produkt_id, karta_id FROM produkty_sklepowe WHERE ${wKanalach} AND id = ?`)
      .all(...parametry, ofertaWskazana);
  }
  return db.prepare(`SELECT id, kanal, produkt_id, karta_id FROM (
    SELECT id, kanal, produkt_id, karta_id, tresc_pobrana_at, ROW_NUMBER() OVER (PARTITION BY kanal, karta_id
      ORDER BY (status_publikacji IS NULL OR status_publikacji = 'ACTIVE') DESC, id) AS nr
    FROM produkty_sklepowe WHERE ${wKanalach}
  ) WHERE nr = 1
    AND tresc_pobrana_at IS NULL
    ORDER BY kanal, id`).all(...parametry);
}

const galeria = (db, kartaId) => db.prepare('SELECT * FROM zdjecia_kart WHERE karta_id = ? ORDER BY kolejnosc, id').all(kartaId);
const zrodloZdjec = (db, kartaId) => db.prepare("SELECT * FROM karty_zrodla_pol WHERE karta_id = ? AND pole = 'zdjecia'").get(kartaId);
const takieSame = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// Adresy do pobrania albo null, gdy galerii nie wolno ruszyć albo własne odnośniki są już te same.
function adresyDoPobrania(db, kartaId, zrodlo, adresy) {
  const unikalne = [...new Set(adresy)].slice(0, LIMIT_ZDJEC);
  if (!unikalne.length) return null;
  const wiersze = galeria(db, kartaId);
  if (!importMozeZapisac('zdjecia', wiersze, zrodloZdjec(db, kartaId), zrodlo, kolejnoscZrodel(db))) return null;
  const wlasne = wiersze.filter(z => z.zrodlo === zrodlo).map(z => z.adres_zrodlowy);
  return takieSame(wlasne, unikalne) ? null : unikalne;
}

async function pobierzZPonowieniem(adres, pobierz, czekaj) {
  for (let proba = 1; ; proba++) {
    try {
      return await pobierz(adres);
    } catch (e) {
      if (proba >= PROBY_ZDJECIA || !chwilowyBladZdjecia(e)) throw e;
      await czekaj(ODSTEPY_PROB[proba - 1]);
    }
  }
}

async function pobierzZdjeciaOferty(adresy, { pobierz, zapisz, katalog, czekaj }) {
  const wyniki = new Array(adresy.length);
  let nastepny = 0;
  const pracownik = async () => {
    while (nastepny < adresy.length) {
      const n = nastepny++;
      try {
        const zapis = await zapisz(await pobierzZPonowieniem(adresy[n], pobierz, czekaj), { katalog });
        wyniki[n] = { adres: adresy[n], ...zapis };
      } catch (e) {
        wyniki[n] = { adres: adresy[n], blad: opisBledu(e) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(ZDJECIA_NARAZ, adresy.length) }, pracownik));
  return wyniki;
}

/** Zapis jednej oferty — wywoływany w transakcji. */
function zapiszOferte(db, { wiersz, tresc, zdjecia, zrodlo, at }) {
  const id = wiersz.karta_id;
  const karta = db.prepare('SELECT * FROM karty_produktow WHERE id = ?').get(id);
  if (!karta) throw new Error(`Karta ${id} nie istnieje.`);
  const zrodla = new Map(db.prepare('SELECT * FROM karty_zrodla_pol WHERE karta_id = ?').all(id).map(w => [w.pole, w]));
  const kolejnosc = kolejnoscZrodel(db);
  const wolno = (pole, wartosc) => importMozeZapisac(pole, wartosc, zrodla.get(pole), zrodlo, kolejnosc);
  const oznacz = pole => db.prepare(`INSERT INTO karty_zrodla_pol (karta_id, pole, zrodlo, reczne, zmieniono_at)
    VALUES (?, ?, ?, 0, ?) ON CONFLICT (karta_id, pole) DO UPDATE SET
    zrodlo = excluded.zrodlo, reczne = 0, zmieniono_at = excluded.zmieniono_at`).run(id, pole, zrodlo, at);

  // Producenta nie zapisujemy; stanów ten przebieg nie dotyka.
  const pola = {
    ...tresc.pola,
    opis_sekcje_json: tresc.opisSekcje?.sekcje?.length ? JSON.stringify(tresc.opisSekcje) : null,
  };
  for (const [pole, wartosc] of Object.entries(pola)) {
    if (polePuste(pole, wartosc) || !wolno(pole, karta[pole])) continue;
    if (zrodla.get(pole)?.zrodlo !== zrodlo) oznacz(pole);
    const liczbowe = pole === 'cena_gr';
    if ((liczbowe ? Number(wartosc) : String(wartosc)) === karta[pole]) continue;
    db.prepare(`UPDATE karty_produktow SET ${pole} = ?, zmieniony_at = ? WHERE id = ?`).run(wartosc, at, id);
    oznacz(pole);
  }

  // Parametr „Marka” oferty → marka karty, tylko do pustego pola i nigdy przez ręczne źródło.
  const marka = markaZParametrow(tresc.daneKanalu?.parametry);
  if (marka && polePuste('marka', karta.marka) && !zrodla.get('marka')?.reczne && wolno('marka', karta.marka)) {
    db.prepare('UPDATE karty_produktow SET marka = ?, zmieniony_at = ? WHERE id = ?').run(marka, at, id);
    oznacz('marka');
    db.prepare('INSERT OR IGNORE INTO marki (nazwa, utworzona_at) VALUES (?, ?)').run(marka, at);
  }

  const zapisane = (zdjecia ?? []).filter(z => z.sha256);
  const wiersze = galeria(db, id);
  const starePoSha = new Map(wiersze.filter(z => z.sha256).map(z => [z.sha256, z]));
  const adresyAi = new Set(tresc.zdjeciaAi);
  if (zapisane.length && wolno('zdjecia', wiersze)) {
    const przejecie = zrodla.get('zdjecia')?.zrodlo !== zrodlo;
    const wlasne = wiersze.filter(z => z.zrodlo === zrodlo);
    // To samo zdjęcie na karcie = jeden wiersz (UNIQUE karta_id, sha256): pomijamy powtórki w ofercie
    // i pliki innych źródeł, chyba że przejmujemy ich galerię.
    const zajete = new Set(wiersze.filter(z => !przejecie && z.zrodlo !== zrodlo && z.sha256).map(z => z.sha256));
    const nowe = [];
    for (const z of zapisane) {
      if (!zajete.has(z.sha256)) { zajete.add(z.sha256); nowe.push(z); }
    }
    if (nowe.length && (przejecie || !takieSame(wlasne.map(z => z.sha256), nowe.map(z => z.sha256)))) {
      if (przejecie) db.prepare('DELETE FROM zdjecia_kart WHERE karta_id = ? AND zrodlo <> ?').run(id, zrodlo);
      db.prepare('DELETE FROM zdjecia_kart WHERE karta_id = ? AND zrodlo = ?').run(id, zrodlo);
      const dodaj = db.prepare(`INSERT INTO zdjecia_kart (karta_id, kolejnosc, zrodlo, adres_zrodlowy, plik, sha256,
        typ, rozmiar, szerokosc, wysokosc, utworzono_at, ai, ai_reczne, wyslane_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      nowe.forEach((z, i) => {
        const stare = starePoSha.get(z.sha256);
        const chronione = stare?.ai_reczne === 1 || Boolean(stare?.wyslane_at);
        dodaj.run(id, i, zrodlo, z.adres, z.plik, z.sha256, z.typ, z.rozmiar,
          z.szerokosc ?? null, z.wysokosc ?? null, at,
          chronione ? stare.ai : Number(adresyAi.has(z.adres)), stare?.ai_reczne ?? 0, stare?.wyslane_at ?? null);
      });
      oznacz('zdjecia');
    }
  }

  // Lista AI może zmienić się bez zmiany adresów galerii. Ręczne i już wysłane są zamrożone.
  if (wolno('zdjecia', wiersze)) {
    const popraw = db.prepare('UPDATE zdjecia_kart SET ai = ? WHERE id = ? AND ai_reczne = 0 AND (wyslane_at IS NULL OR wyslane_at = \'\')');
    for (const z of galeria(db, id).filter(z => z.zrodlo === zrodlo)) popraw.run(Number(adresyAi.has(z.adres_zrodlowy)), z.id);
  }

  const d = tresc.daneKanalu;
  db.prepare(`INSERT INTO karty_dane_kanalu (karta_id, typ_kanalu, polaczenie, oferta_id, produkt_id, kategoria_id,
    kategoria_sciezka_json, parametry_json, ai_wspoltworzone, oferta_zmieniona_at, pobrano_at)
    VALUES (?, 'allegro', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (karta_id, typ_kanalu) DO UPDATE SET polaczenie = excluded.polaczenie, oferta_id = excluded.oferta_id,
    produkt_id = excluded.produkt_id, kategoria_id = excluded.kategoria_id,
    kategoria_sciezka_json = excluded.kategoria_sciezka_json, parametry_json = excluded.parametry_json,
    ai_wspoltworzone = excluded.ai_wspoltworzone, oferta_zmieniona_at = excluded.oferta_zmieniona_at,
    pobrano_at = excluded.pobrano_at`)
    .run(id, wiersz.kanal, d.oferta_id ?? String(wiersz.produkt_id), d.produkt_id, d.kategoria_id,
      d.sciezka?.length ? JSON.stringify(d.sciezka) : null, JSON.stringify(d.parametry), d.ai_wspoltworzone,
      d.updatedAt, at);
  db.prepare('UPDATE produkty_sklepowe SET tresc_pobrana_at = ?, tresc_zmieniona_at = ? WHERE id = ?')
    .run(at, d.updatedAt, wiersz.id);
  // Trwały wpis błędu przy ofercie (pominięte zdjęcia); udane pobranie bez błędów go czyści.
  const blad = bladZdjec(zdjecia);
  db.prepare('UPDATE produkty_sklepowe SET tresc_blad = ?, tresc_blad_at = ? WHERE id = ?')
    .run(blad, blad ? at : null, wiersz.id);
}

/** „Zdjęcia pominięte: 1 z 3 — HTTP 503 …” albo null, gdy wszystkie zdjęcia są. */
function bladZdjec(zdjecia) {
  const zle = (zdjecia ?? []).filter(z => z.blad);
  if (!zle.length) return null;
  return bezAdresow(`Zdjęcia pominięte: ${zle.length} z ${zdjecia.length} — ${zle[0].blad}`);
}

function wTransakcji(db, zapis) {
  db.exec('BEGIN IMMEDIATE');
  try {
    zapis();
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * Jeden przebieg po wszystkich niepobranych ofertach powiązanych z kartami.
 * @param {object} p
 * @param {any} p.db
 * @param {Record<string, any>} [p.allegro]
 * @param {Iterable<string>} [p.kanalyAllegro]
 * @param {string} [p.katalog]
 * @param {() => Date} [p.teraz]
 * @param {Function} [p.pobierzZdjecie]
 * @param {Function} [p.zapiszZdjecie]
 * @param {(info: { zrobione: number, zTego: number }) => void} [p.postep]
 * @returns {Promise<{ razem: number, pobrane: number, bledy: Array<{kanal: string, oferta_id: string, blad: string, zdjecie?: string}>, blad: string | null }>}
 */
export async function pobierzTrescOfertAllegro({ db, allegro = {}, kanalyAllegro = [], katalog, teraz = () => new Date(),
  pobierzZdjecie = pobierzZdjecieSieci, zapiszZdjecie = zapiszZdjeciePlik, postep = () => {},
  czekaj = czekajDomyslnie, ofertaWskazana = null, karty = null }) {
  const kanaly = [...kanalyAllegro].filter(k => typeof allegro[k]?.pobierzOferte === 'function');
  const oferty = kolejka(db, kanaly, ofertaWskazana, karty);
  const wynik = { razem: oferty.length, pobrane: 0, bledy: [], blad: null };
  let zrobione = 0;
  postep({ zrobione, zTego: oferty.length });
  for (const wiersz of oferty) {
    const klient = allegro[wiersz.kanal];
    const zrodlo = `allegro:${wiersz.kanal}`;
    const ofertaId = String(wiersz.produkt_id);
    try {
      const oferta = await klient.pobierzOferte(ofertaId);
      if (!oferta) throw new Error('Allegro nie oddało tej oferty.');
      const kategoria = await opisKategoriiAllegro({ db, klient, polaczenie: wiersz.kanal,
        kategoriaId: oferta?.category?.id, teraz });
      const tresc = trescOfertyAllegro(oferta, kategoria);
      const adresy = adresyDoPobrania(db, wiersz.karta_id, zrodlo, tresc.zdjecia);
      const zdjecia = adresy ? await pobierzZdjeciaOferty(adresy, { pobierz: pobierzZdjecie, zapisz: zapiszZdjecie, katalog, czekaj }) : [];
      wTransakcji(db, () => zapiszOferte(db, { wiersz, tresc, zdjecia, zrodlo, at: teraz().toISOString() }));
      wynik.pobrane += 1;
      for (const z of zdjecia.filter(x => x.blad)) {
        wynik.bledy.push({ kanal: wiersz.kanal, oferta_id: ofertaId, zdjecie: z.adres, blad: `Zdjęcie pominięte: ${z.blad}` });
      }
    } catch (e) {
      if (odmowa(e)) { wynik.blad = komunikatOdmowy(wiersz.kanal, e); break; }
      wynik.bledy.push({ kanal: wiersz.kanal, oferta_id: ofertaId, blad: opisBledu(e) });
      // Błąd całej oferty (np. waluta ≠ PLN, 404, przekroczony czas): wpis przy ofercie, treść dalej niepobrana.
      db.prepare('UPDATE produkty_sklepowe SET tresc_blad = ?, tresc_blad_at = ? WHERE id = ?')
        .run(bezAdresow(`Treść nie pobrana: ${opisBledu(e)}`), teraz().toISOString(), wiersz.id);
    }
    zrobione += 1;
    postep({ zrobione, zTego: oferty.length });
  }
  return wynik;
}

const chwila = () => new Date().toISOString();
const STAN_POCZATKOWY = { trwa: false, zaczety_at: null, skonczony_at: null, postep: null, razem: 0, pobrane: 0, bledy: [], blad: null };

/**
 * Przebieg w tle (wzór `createMagazynPrzebieg`): `start` wraca od razu, jeden przebieg naraz.
 * @param {object} [p]
 * @param {object} [p.db]
 * @param {Record<string, any>} [p.allegro] — mapa kanał → klient Allegro (`klienciKanalow`)
 * @param {Iterable<string>} [p.kanalyAllegro] — klucze kont Allegro z konfiguracji modułu kanałów
 * @param {string} [p.katalog] — katalog zdjęć magazynu
 * @param {Function} [p.pobierzZdjecie]
 * @param {Function} [p.zapiszZdjecie]
 * @param {(...czesci: unknown[]) => void} [p.log]
 */
export function createTrescAllegroPrzebieg({ db, allegro = {}, kanalyAllegro = [], katalog, pobierzZdjecie, zapiszZdjecie, log } = {}) {
  let stan = { ...STAN_POCZATKOWY };
  const gotowy = () => [...kanalyAllegro].some(k => typeof allegro[k]?.pobierzOferte === 'function');

  // `kanaly`, `karty` (opcjonalne): ekran importu czyta treść jednego konta, a „tylko nowe"
  // — tylko kart, które utworzył. Bez nich — jak dotąd: wszystkie konta, wszystkie karty.
  function start({ ofertaWskazana = null, kanaly = null, karty = null } = {}) {
    if (!gotowy() || stan.trwa) return { wystartowal: false };
    stan = { ...STAN_POCZATKOWY, bledy: [], trwa: true, zaczety_at: chwila() };
    const konta = kanaly ? [...kanalyAllegro].filter(k => kanaly.includes(k)) : kanalyAllegro;
    pobierzTrescOfertAllegro({ db, allegro, kanalyAllegro: konta, katalog, pobierzZdjecie, zapiszZdjecie, ofertaWskazana, karty,
      postep: (info) => { stan.postep = info; } })
      .then((wynik) => { Object.assign(stan, wynik); if (wynik.blad) log?.('[tresc-allegro]', wynik.blad); })
      .catch((e) => { stan.blad = opisBledu(e); log?.('[tresc-allegro]', stan.blad); })
      .finally(() => { stan.trwa = false; stan.skonczony_at = chwila(); stan.postep = null; });
    return { wystartowal: true };
  }

  return { start, stan: () => ({ ...stan, bledy: [...stan.bledy] }), gotowy };
}
