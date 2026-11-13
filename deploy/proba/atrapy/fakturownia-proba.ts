// PRZ-119.11a — profil próby Fakturowni w prywatnej piaskownicy (wzór: Allegro Sandbox).
// Prawdziwe konto próbne Fakturowni włącza WYŁĄCZNIE plik profilu w prywatnym katalogu konfiguracji kontenera
// (`{"srodowisko":"proba","domena":"…"}`, bez tokenu). Token w bazie bez pliku = dalej atrapa.
// Transport przepuszcza tylko `https://<domena z pliku>.fakturownia.pl`, bez przekierowań i ponowień,
// i nigdy nie niesie wysyłki do KSeF (`send_to_ksef`, `gov_save_and_send`). Osłona nie zastępuje zapory VM.
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { WZOR_DOMENY_FAKTUROWNI } from '../../../src/domena/konfiguracja-fakturownia.js';

export const SCIEZKA_PROFILU_FAKTUROWNI = '/konfiguracja/fakturownia-proba.json';
export const DOWOLNA_DOMENA = '*';
export const ZDANIE_DEMO = 'Prawdziwa Fakturownia jest dostępna tylko w prywatnej piaskownicy (OMS_TRYB=proba, bez OMS_DEMO_LOGIN i OMS_DEMO_HASLO) — usuń plik profilu z publicznego demo.';
const KLUCZ_ZNACZNIKA = 'proba.znacznik_bazy';
const ZNAKI = 'abcdefghijklmnopqrstuvwxyz0123456789';

export type ProfilFakturowni = { srodowisko: 'proba'; domena: string };
type Env = Record<string, string | undefined>;

/** Plik profilu → `{ srodowisko, domena }`; brak pliku → `null` (atrapa). Publiczne demo albo tryb inny niż
 * `proba` z plikiem → odmowa startu. Treści pliku nigdy nie wypisujemy (gdyby ktoś wkleił tam token). */
export function wczytajProfilFakturowni(env: Env, o: { sciezka?: string } = {}): ProfilFakturowni | null {
  const sciezka = o.sciezka ?? SCIEZKA_PROFILU_FAKTUROWNI;
  if (!fs.existsSync(sciezka)) return null;
  if (env.OMS_TRYB !== 'proba' || env.OMS_DEMO_LOGIN || env.OMS_DEMO_HASLO) throw new Error(ZDANIE_DEMO);
  const zly = () => new Error(`Niepoprawny profil Fakturowni próby (${sciezka}) — oczekiwane wyłącznie {"srodowisko":"proba","domena":"<część przed .fakturownia.pl>"}.`);
  let dane: unknown;
  try { dane = JSON.parse(fs.readFileSync(sciezka, 'utf8')); } catch { throw zly(); }
  if (!dane || typeof dane !== 'object' || Array.isArray(dane)) throw zly();
  const p = dane as Record<string, unknown>;
  if (Object.keys(p).sort().join(',') !== 'domena,srodowisko') throw zly();
  // PRZ-161: `"domena":"*"` = DOWOLNA DOMENA — próba „jak inny sklep”: domenę wpisuje się na ekranie, transport
  // przepuszcza każde konto https://<wzór>.fakturownia.pl. Blokada wysyłki do KSeF zostaje bez zmian.
  if (p.srodowisko !== 'proba' || typeof p.domena !== 'string' || (p.domena !== DOWOLNA_DOMENA && !WZOR_DOMENY_FAKTUROWNI.test(p.domena))) throw zly();
  return { srodowisko: 'proba', domena: p.domena };
}

function odmowa(komunikat: string): Error {
  const e = new Error(komunikat);
  // core/http.ts przepuszcza odmowę hosta bez „błędu sieci” i bez ponowień: nic nie wyszło do sieci.
  e.name = 'OdmowaHosta';
  (e as Error & { code?: string }).code = 'OMS_PROBA_FAKTUROWNIA';
  return e;
}

const WYSYLKA_KSEF = /send_to_ksef|gov_save_and_send/i;
function tekstAdresu(href: string): string {
  try { return decodeURIComponent(href); } catch { return href; }
}

/** fetch dla klienta Fakturowni w profilu próby. Bez wstrzykniętego fetch używa globalnego w chwili wywołania. */
export function transportFakturowniProby(o: { domena: string; fetchImpl?: typeof fetch }): typeof fetch {
  const dowolna = o.domena === DOWOLNA_DOMENA;
  if (!dowolna && !WZOR_DOMENY_FAKTUROWNI.test(String(o.domena ?? ''))) throw new Error('Niepoprawna domena konta próbnego Fakturowni.');
  const dozwolony = dowolna ? 'https://<domena>.fakturownia.pl' : `https://${o.domena}.fakturownia.pl`;
  const dozwolonyHost = (url: URL) => dowolna
    ? url.protocol === 'https:' && !url.port && url.hostname.endsWith('.fakturownia.pl')
      && WZOR_DOMENY_FAKTUROWNI.test(url.hostname.slice(0, -'.fakturownia.pl'.length))
    : url.origin === dozwolony;
  const fakturowniaProby = async (adres: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    let url: URL;
    try { url = new URL(adres instanceof Request ? adres.url : String(adres)); }
    catch { throw odmowa('Piaskownica: niepoprawny adres Fakturowni.'); }
    if (url.username || url.password || url.hash || !dozwolonyHost(url)) {
      throw odmowa(`Piaskownica: połączenie zablokowane — dozwolone jest wyłącznie konto próbne ${dozwolony}.`);
    }
    // Treść inna niż tekst (Blob, bajty, strumień, formularz) ominęłaby sprawdzenie KSeF niżej — klient wysyła tylko JSON.
    if (init.body != null && typeof init.body !== 'string') {
      throw odmowa('Piaskownica: do Fakturowni wolno wysłać wyłącznie treść tekstową.');
    }
    const cialo = init.body ?? '';
    if (WYSYLKA_KSEF.test(tekstAdresu(url.href)) || WYSYLKA_KSEF.test(cialo)) {
      throw odmowa('Piaskownica: wysyłka do KSeF przez prawdziwą Fakturownię jest zablokowana.');
    }
    return (o.fetchImpl ?? globalThis.fetch)(url.href, { ...init, redirect: 'error' });
  };
  return fakturowniaProby as typeof fetch;
}

type Baza = { prepare: (sql: string) => { run: (...a: unknown[]) => unknown; get: (...a: unknown[]) => unknown } };

/** Znacznik bazy próby (8 znaków [a-z0-9]) — część `oid` faktur w profilu próby. Zapisany w `ustawienia`;
 * reset zakłada nową bazę, więc po resecie znacznik jest nowy i numery zamówień demo nie zderzają się
 * z fakturami wystawionymi na koncie próbnym przed resetem. */
export function znacznikBazyProby(db: Baza): string {
  const losowy = Array.from(randomBytes(8), (b) => ZNAKI[b % ZNAKI.length]).join('');
  db.prepare('INSERT OR IGNORE INTO ustawienia (klucz, wartosc, zmienione_at) VALUES (?, ?, ?)')
    .run(KLUCZ_ZNACZNIKA, losowy, new Date().toISOString());
  const w = db.prepare('SELECT wartosc FROM ustawienia WHERE klucz = ?').get(KLUCZ_ZNACZNIKA) as { wartosc?: string } | undefined;
  return String(w?.wartosc ?? losowy);
}
