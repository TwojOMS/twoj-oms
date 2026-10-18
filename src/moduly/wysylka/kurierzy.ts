import type { Srodowisko } from '../../core/kontrakty.ts';
import { createDpdClient, createInpostClient, createAllegroWzaClient } from '../../integracje/fabryki.ts';
import { createAllegroSledzenieClient } from '../../oms/kurierzy/allegro.js';
import type { KurierNadania, KurierSledzenia } from './nadanie-typy.ts';
import { skonfigurowanyUrl } from '../../core/konfiguracja-wartosci.ts';
import { opcjeKlientaDpd } from '../../domena/konfiguracja-dpd.js';
import { bladOperatora } from '../../domena/bledy.js';
import { adresFirmyZEnv, adresKompletny, type AdresFirmy } from '../../core/adres-firmy.ts';
import { opcjeKlientaInpost } from '../../domena/konfiguracja-inpost.js';
import { naTelefonInPost } from '../../domena/telefon.js';

const wymagane = (env: Srodowisko, klucz: string): string => {
  const v = env[klucz]?.trim();
  if (!v) throw new Error(`${klucz}: wymagana wartość konfiguracji wysyłki`);
  return v;
};

export function wczytajKurierow(env: Srodowisko) {
  skonfigurowanyUrl(env.DPD_URL, 'DPD_URL');
  skonfigurowanyUrl(env.DPD_INFO_URL, 'DPD_INFO_URL');
  skonfigurowanyUrl(env.INPOST_URL, 'INPOST_URL');
  const nadawca = ['DPD_URL', 'INPOST_TOKEN'].some(k => env[k]?.trim()) ? {
    nazwa: wymagane(env, 'DPD_NADAWCA_NAZWA'), ulica: wymagane(env, 'DPD_NADAWCA_ULICA'),
    kod: wymagane(env, 'DPD_NADAWCA_KOD'), miasto: wymagane(env, 'DPD_NADAWCA_MIASTO'),
    kraj: env.DPD_NADAWCA_KRAJ?.trim() || 'PL',
    phone: env.DPD_NADAWCA_TELEFON?.trim() || '', email: env.DPD_NADAWCA_EMAIL?.trim() || '',
  } : null;
  const dpd = env.DPD_URL?.trim() ? {
    url: wymagane(env, 'DPD_URL'), login: wymagane(env, 'DPD_LOGIN'), haslo: wymagane(env, 'DPD_PASSWORD'),
    fid: wymagane(env, 'DPD_FID'), infoUrl: wymagane(env, 'DPD_INFO_URL'), channel: wymagane(env, 'DPD_INFO_CHANNEL'),
    nadawca: nadawca!,
  } : null;
  let inpost = null;
  if (env.INPOST_TOKEN?.trim()) {
    const organizacja = Number(wymagane(env, 'INPOST_ORGANIZACJA'));
    if (!Number.isSafeInteger(organizacja) || organizacja <= 0) throw new Error('INPOST_ORGANIZACJA: wymagany dodatni identyfikator');
    inpost = { url: env.INPOST_URL?.trim() || 'https://api-shipx-pl.easypack24.net/v1',
      token: wymagane(env, 'INPOST_TOKEN'), organizacja, nadawca: nadawca!,
      paczkomatNadawczy: env.INPOST_PACZKOMAT_NADAWCZY?.trim().toUpperCase() || null };
  }
  // PRZ-093.08: adres dla DPD z Ustawień nie siedzi już tutaj — moduł bierze go ze wspólnego źródła adresu firmy
  // (plik → Ustawienia → Firma), czytanego przy każdej paczce.
  return { dpd, inpost, adresFirmyZPliku: adresFirmyZEnv(env), pobranieNadawca: { nazwa: nadawca?.nazwa,
    rachunek: env.OMS_RACHUNEK?.trim() } };
}

type ZapisDpd = { ustawienia: Record<string, string>; sekrety: Record<string, string> };
type KlientDpd = KurierNadania & { sprawdzPolaczenie?: () => Promise<unknown> };

/**
 * PRZ-092 — kurier DPD skonfigurowany w Ustawieniach. Każde wywołanie czyta BIEŻĄCY zapis z bazy, więc zmiana
 * hasła albo typu etykiety działa od następnej paczki, bez ponownego uruchomienia OMS-u. Klienta DPD budujemy
 * od nowa tylko, gdy zapis się zmienił — porównanie całej treści, nie znacznika czasu: dwa zapisy w tej samej
 * milisekundzie nie mogą zostawić starego hasła.
 * `bezSledzenia` jest getterem: bez kanału DPD Info czuwacz nie pyta DPD o statusy (domena/sledzenie-przesylki.js).
 * PRZ-093.08: `nadawca` to funkcja — adres firmy czytany przy każdej paczce (plik → Ustawienia → Firma);
 * zmiana adresu na ekranie też buduje nowego klienta (adres wchodzi do porównania).
 */
export function kurierDpdZUstawien({ wczytaj, nadawca, fabryka }: {
  wczytaj: () => ZapisDpd | null; nadawca: () => AdresFirmy | null; fabryka: (o: any) => KlientDpd;
}) {
  let klucz: string | null = null;
  let klient: KlientDpd | null = null;
  const biezacy = (): KlientDpd => {
    const zapis = wczytaj();
    if (!zapis) throw bladOperatora('Kurier DPD nie jest skonfigurowany — Ustawienia → Integracje → Kurier DPD. Panel niczego nie nadał.');
    const adres = nadawca();
    // Bez adresu nadawcy createDpdClient rzuca zwykły Error — człowiek zobaczyłby „błąd techniczny” zamiast powodu.
    if (!adresKompletny(adres)) throw bladOperatora('Brak adresu nadawcy — wpisz adres firmy w Ustawienia → Firma (/ustawienia/firma) albo DPD_NADAWCA_… w pliku konfiguracji. Bez niego DPD nie nada paczki. Panel niczego nie nadał.');
    const nowy = JSON.stringify([zapis, adres]);
    if (nowy !== klucz || !klient) { klient = fabryka(opcjeKlientaDpd(zapis, adres)); klucz = nowy; }
    return klient;
  };
  return {
    nadaj: (...a: Parameters<KurierNadania['nadaj']>) => biezacy().nadaj(...a),
    statusPrzesylki: (numer: string) => biezacy().statusPrzesylki!(numer),
    sprawdzPolaczenie: () => biezacy().sprawdzPolaczenie!(),
    get bezSledzenia() { return !String(wczytaj()?.sekrety?.kanal ?? '').trim(); },
  };
}

type ZapisInpost = { ustawienia: Record<string, string>; sekrety: Record<string, string> };
// sprawdzPrzesylke klienta ShipX bierze tylko identyfikator (drugi parametr to wewnętrzna odpowiedź POST) — stąd
// własny typ zamiast KurierNadania, którego sprawdzPrzesylke przyjmuje zamówienie.
type KlientInpost = { nadaj: KurierNadania['nadaj']; sprawdzPrzesylke?: (id: string) => Promise<any>;
  statusPrzesylki?: (numer: string) => Promise<unknown>; pobierzEtykiete?: (...a: any[]) => Promise<unknown>;
  sprawdzPolaczenie?: () => Promise<unknown> };

/**
 * PRZ-093.09 — kurier InPost skonfigurowany w Ustawieniach; wzór: kurierDpdZUstawien wyżej. Każde wywołanie czyta
 * BIEŻĄCY zapis z bazy i bieżący adres firmy; nowy klient ShipX tylko, gdy zmieniła się treść zapisu albo adres.
 * Różnice wobec DPD wynikają z klienta InPost:
 *  • `sprawdzPrzesylke` przekazuje WYŁĄCZNIE identyfikator — jak klient z pliku w zbudujKurierow (drugi argument
 *    ShipX to wewnętrzna odpowiedź POST, a usługa nadania podaje tam zamówienie);
 *  • InPost wymaga telefonu i e-maila nadawcy (DPD nie) — nadanie odmawia przed klientem z komunikatem, gdzie je
 *    wpisać (klient z pliku mówi o .env.oms, co tu byłoby nieprawdą); telefon w formacie, którego InPost nie przyjmie,
 *    zatrzymujemy tu, bo createInpostClient rzuciłby zwykły Error („błąd techniczny” na ekranie).
 */
export function kurierInpostZUstawien({ wczytaj, nadawca, fabryka }: {
  wczytaj: () => ZapisInpost | null; nadawca: () => AdresFirmy | null; fabryka: (o: any) => KlientInpost;
}) {
  let klucz: string | null = null;
  let klient: KlientInpost | null = null;
  const biezacy = (): { klient: KlientInpost; adres: AdresFirmy } => {
    const zapis = wczytaj();
    if (!zapis) throw bladOperatora('Kurier InPost nie jest skonfigurowany — Ustawienia → Integracje → Kurier InPost. Panel niczego nie nadał.');
    const adres = nadawca();
    if (!adresKompletny(adres)) throw bladOperatora('Brak adresu nadawcy — wpisz adres firmy w Ustawienia → Firma (/ustawienia/firma) albo DPD_NADAWCA_… w pliku konfiguracji. Bez niego InPost nie nada paczki. Panel niczego nie nadał.');
    if (String(adres.phone ?? '').trim()) {
      try { naTelefonInPost(adres.phone); } catch {
        throw bladOperatora('Telefon w adresie firmy ma format, którego InPost nie przyjmie (potrzebny polski numer: 9 cyfr, może być +48). Popraw go w Ustawienia → Firma (/ustawienia/firma) albo w DPD_NADAWCA_TELEFON w pliku konfiguracji. Panel niczego nie nadał.');
      }
    }
    const nowy = JSON.stringify([zapis, adres]);
    if (nowy !== klucz || !klient) { klient = fabryka(opcjeKlientaInpost(zapis, adres)); klucz = nowy; }
    return { klient, adres };
  };
  // Metody async: odmowa (brak zapisu, adresu, telefonu) wraca jako odrzucona obietnica, jak błąd samego InPostu.
  return {
    nadaj: async (...a: Parameters<KurierNadania['nadaj']>) => {
      const { klient: k, adres } = biezacy();
      if (!String(adres.phone ?? '').trim() || !String(adres.email ?? '').trim()) {
        throw bladOperatora('InPost wymaga telefonu i e-maila nadawcy — wpisz je w Ustawienia → Firma (/ustawienia/firma) albo DPD_NADAWCA_TELEFON i DPD_NADAWCA_EMAIL w pliku konfiguracji. Panel niczego nie nadał.');
      }
      return k.nadaj(...a);
    },
    sprawdzPrzesylke: async (id: string) => biezacy().klient.sprawdzPrzesylke!(id),
    pobierzEtykiete: async (...a: any[]) => biezacy().klient.pobierzEtykiete!(...a),
    statusPrzesylki: async (numer: string) => biezacy().klient.statusPrzesylki!(numer),
    sprawdzPolaczenie: async () => biezacy().klient.sprawdzPolaczenie!(),
  };
}

export type FabrykiKurierow = Partial<{
  createDpd: (o: Parameters<typeof createDpdClient>[0]) => KurierNadania;
  createInpost: (o: Parameters<typeof createInpostClient>[0]) => KurierNadania;
  createAllegroWza: (o: Parameters<typeof createAllegroWzaClient>[0]) => KurierNadania;
  createAllegroSledzenie: (o: Parameters<typeof createAllegroSledzenieClient>[0]) => KurierSledzenia;
}>;
export type MapaKurierow = Partial<Record<string, KurierNadania | KurierSledzenia>> & {
  dpd?: KurierNadania; inpost?: KurierNadania; allegro_wza?: KurierNadania; allegro?: KurierSledzenia;
};

export function zbudujKurierow(config: ReturnType<typeof wczytajKurierow>, klienciAllegro: Record<string, any>, fabryki: FabrykiKurierow = {}) {
  const kurierzy: MapaKurierow = {};
  if (config.dpd) kurierzy.dpd = (fabryki.createDpd ?? createDpdClient)(config.dpd);
  if (config.inpost) {
    if (fabryki.createInpost) kurierzy.inpost = fabryki.createInpost(config.inpost);
    else {
      const klient = createInpostClient(config.inpost);
      // Drugi argument ShipX jest wewnętrzną odpowiedzią POST, nie zamówieniem WzA.
      kurierzy.inpost = { ...klient, sprawdzPrzesylke: id => klient.sprawdzPrzesylke(id) };
    }
  }
  if (Object.keys(klienciAllegro).length) {
    const allegroDla = (kanal: string) => klienciAllegro[kanal] ?? null;
    kurierzy.allegro_wza = (fabryki.createAllegroWza ?? createAllegroWzaClient)({ allegroDla: (z: any) => {
      const klient = klienciAllegro[z?.sklep];
      if (!klient) throw new Error(`Kanał „${z?.sklep}” nie jest podpięty do Allegro — panel niczego nie nadał.`);
      return klient;
    },
      metodaZywa: (z: any) => klienciAllegro[z?.sklep]?.pobierzMetodeDostawy(z?.zrodlo_id) ?? null,
      pobranieNadawca: config.pobranieNadawca });
    kurierzy.allegro = (fabryki.createAllegroSledzenie ?? createAllegroSledzenieClient)({ allegroDla });
  }
  return kurierzy;
}
