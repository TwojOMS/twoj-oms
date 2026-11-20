// Cenniki dostaw w edycji hurtem: stan kart do planu, liczba wystawionych ofert, którym zmieni się cennik, i podpis
// list cenników kont z podglądu. Hurt niczego nie wysyła do kanałów — oferty dostają nowy cennik przy następnym
// przebiegu pętli, bo zmienia się ich treść (`delivery`) i skrót.
import { createHash } from 'node:crypto';
import { maCennikiOms } from '../../../oms/db/cenniki-oms.ts';
import { wyjatekCennika } from '../../../oms/db/cenniki-kart.ts';
import { zapiszCennikiHurtu } from '../../../oms/db/magazyn.js';
import { STANY_SYNCHRONIZACJI_ALLEGRO } from './petla-ofert-allegro.js';
import { STANY_SYNCHRONIZACJI_ERLI } from './petla-ofert.js';

const maTabele = (db, nazwa) =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(nazwa));

/**
 * Obecne cenniki kart do planu hurtu: id karty → `{ oms: { id, nazwa } | null, konta: Map<klucz, wartość> }`.
 * `konta` to wyłącznie wybór zapisany na karcie dla konta — nie cennik wynikowy (ten liczy `wyjatekCennika`).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {readonly number[]} ids
 */
export function cennikiKartHurtu(db, ids) {
  const mapa = new Map(ids.map((id) => [id, { oms: null, konta: new Map() }]));
  if (!ids.length) return mapa;
  const lista = JSON.stringify(ids);
  if (maCennikiOms(db)) {
    const wiersze = db
      .prepare(
        `SELECT k.karta_id, c.id, c.nazwa FROM karty_cennik_oms k JOIN cenniki_dostaw_oms c ON c.id = k.cennik_id
      WHERE k.karta_id IN (SELECT value FROM json_each(?))`,
      )
      .all(lista);
    for (const w of wiersze) {
      const stan = mapa.get(Number(w.karta_id));
      if (stan) stan.oms = { id: Number(w.id), nazwa: String(w.nazwa) };
    }
  }
  if (maTabele(db, 'karty_cenniki_kanalow')) {
    const wiersze = db
      .prepare(
        `SELECT karta_id, konto, cennik_kanalu FROM karty_cenniki_kanalow
      WHERE karta_id IN (SELECT value FROM json_each(?))`,
      )
      .all(lista);
    for (const w of wiersze) mapa.get(Number(w.karta_id))?.konta.set(String(w.konto), String(w.cennik_kanalu));
  }
  return mapa;
}

/**
 * Wystawione oferty kart z planu, którym zmieni się cennik WYNIKOWY (`wyjatekCennika` przed i po), na bieżących
 * kontach. „Po” liczone na próbę: zapis planu w SAVEPOINT i cofnięcie — ta sama funkcja zapisu co zatwierdzenie,
 * więc podgląd nie ma własnej kopii kolejności doboru. Karta z wyborem konta i zmianą cennika OMS nie zmienia
 * cennika na tym koncie, więc jej oferta tam nie wchodzi do liczby.
 * Wystawiona = zarządzana z OMS, w stanie, który pętla synchronizuje, bez ofert obcych (`ext:`).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {readonly { id: number, cennikOms?: number | null, cennikiKont?: Record<string, string | null> }[]} plan
 * @param {readonly { klucz: string, rodzaj: 'allegro' | 'erli', etykieta: string }[]} konta
 * @returns {{ razem: number, konta: { etykieta: string, ile: number }[] }}
 */
export function ofertyZmienioneCennikiem(db, plan, konta) {
  const wpisy = plan.filter((w) => Object.hasOwn(w, 'cennikOms') || Object.keys(w.cennikiKont ?? {}).length);
  if (!wpisy.length || !konta.length) return { razem: 0, konta: [] };
  const lista = JSON.stringify(wpisy.map((w) => w.id));
  const oferty = konta.map((konto) => {
    const stany = konto.rodzaj === 'allegro' ? STANY_SYNCHRONIZACJI_ALLEGRO : STANY_SYNCHRONIZACJI_ERLI;
    const wiersze = db
      .prepare(
        `SELECT karta_id, count(*) AS ile FROM oferty_kanalow
      WHERE kanal = ? AND tryb = 'zarzadzana' AND stan IN (${stany.map(() => '?').join(', ')})
        AND id_zewnetrzne NOT LIKE 'ext:%' AND karta_id IN (SELECT value FROM json_each(?))
      GROUP BY karta_id`,
      )
      .all(konto.klucz, ...stany, lista);
    return { konto, wiersze: wiersze.map((w) => ({ kartaId: Number(w.karta_id), ile: Number(w.ile) })) };
  });
  const cennik = (kartaId, konto) => wyjatekCennika(db, { kartaId, konto });
  const przed = oferty.map(({ konto, wiersze }) => wiersze.map((w) => cennik(w.kartaId, konto.klucz)));
  let po;
  db.exec('SAVEPOINT hurt_cenniki_podglad');
  try {
    for (const wpis of wpisy) zapiszCennikiHurtu(db, wpis);
    po = oferty.map(({ konto, wiersze }) => wiersze.map((w) => cennik(w.kartaId, konto.klucz)));
  } finally {
    db.exec('ROLLBACK TO hurt_cenniki_podglad');
    db.exec('RELEASE hurt_cenniki_podglad');
  }
  const naKontach = oferty
    .map(({ konto, wiersze }, i) => ({
      etykieta: konto.etykieta,
      ile: wiersze.reduce((s, w, j) => (przed[i][j] !== po[i][j] ? s + w.ile : s), 0),
    }))
    .filter((k) => k.ile > 0);
  return { razem: naKontach.reduce((s, k) => s + k.ile, 0), konta: naKontach };
}

const skrot = (tekst) => createHash('sha256').update(tekst).digest('hex').slice(0, 16);

/**
 * Podpis list cenników kont, z których polecenie wybiera nowy cennik: `klucz=skrót` po przecinku. Zatwierdzenie
 * liczy go od nowa i porównuje z podglądem — lista pobrana ponownie w międzyczasie (inne nazwy, inny zestaw)
 * znaczy, że człowiek wybierał z czegoś innego niż to, co zapiszemy. Usunięcie wyboru od listy nie zależy.
 * @param {{ cennikiKont?: readonly { konto: { klucz: string, cenniki: unknown }, wartosc: string | null }[] }} polecenie
 */
export function podpisListCennikow(polecenie) {
  return (polecenie.cennikiKont ?? [])
    .filter((w) => w.wartosc !== null)
    .map((w) => `${w.konto.klucz}=${skrot(JSON.stringify(w.konto.cenniki ?? null))}`)
    .join(',');
}

/** Pierwsze konto polecenia, którego lista różni się od podpisu z podglądu, albo `null`, gdy wszystkie zgodne. */
export function kontoZeZmienionaLista(polecenie, podpis) {
  const zPodgladu = new Map(
    String(podpis ?? '')
      .split(',')
      .filter(Boolean)
      .map((p) => /** @type {[string, string]} */ (p.split('=', 2))),
  );
  const teraz = new Map(
    podpisListCennikow(polecenie)
      .split(',')
      .filter(Boolean)
      .map((p) => /** @type {[string, string]} */ (p.split('=', 2))),
  );
  for (const w of polecenie.cennikiKont ?? []) {
    if (w.wartosc !== null && zPodgladu.get(w.konto.klucz) !== teraz.get(w.konto.klucz)) return w.konto;
  }
  return null;
}
