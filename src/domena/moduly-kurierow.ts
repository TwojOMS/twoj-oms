import type { MetodaKuriera, OpisKuriera, OpisPrzewoznika } from '../core/kontrakty.ts';
import { OPISY_PRZEWOZNIKOW } from './przewoznicy.ts';

/** Opisy integracji, bez adapterów i skutków ubocznych przy imporcie. */
export const MODULY_KURIEROW = {
  dpd: {
    klucz: 'dpd', nazwa: 'DPD', logo: '/integracje/dpd.svg', idKatalogu: 'dpd',
    opisKatalogu: 'Nadaj przesyłki przez DPD.', umowa: 'wlasna', przewoznicy: ['dpd'],
    // ⚠️ „Kurier DPD", a nie samo „DPD" (prosba właściciela 25.08.2026). Odkad kolumna „Dostawa"
    // pokazuje pelne nazwy uslug Allegro („Allegro Kurier DPD", „Allegro One Box"), samotne
    // „DPD" czytalo sie jak nazwa PRZEWOZNIKA obok nazw USLUG — a to jest nasza wlasna usluga
    // kurierska, na NASZEJ umowie. Para „Kurier DPD" / „Allegro Kurier DPD" mowi teraz wprost,
    // czyja umowa jedzie paczka, i to jest cala roznica, ktora operator musi tu zobaczyc.
    metody: [{ klucz: 'dpd', etykieta: 'Kurier DPD', etykietaWyboru: 'DPD — nasza umowa',
      etykietaDrogi: 'DPD umowa własna', formularz: 'dpd', punktOdbioru: false }],
    // pobranie 'umowa': przy pobraniu na tej paczce wolno go wybrać (kurierzyDoWyboru).
    umiejetnosci: { pobranie: 'umowa', pobranieNaDosylce: true, nadanieAsynchroniczne: false, sledzenie: 'wlasne',
      etykieta: { zpl: true, zplPrzyNadaniu: true } },
    pobieranieEtykiety: false,
    sledzenieAdres: (n: string) => `https://tracktrace.dpd.com.pl/parcelDetails?typ=1&p1=${encodeURIComponent(n)}`,
    kluczeEnv: ['DPD_LOGIN', 'DPD_PASSWORD'],
    konfigurator: { sciezka: '/ustawienia/integracje/dpd', etykieta: 'DPD Polska',
      zdanie: 'login, numer klienta i hasło od DPD, typ etykiety, sprawdzenie połączenia.' },
    piaskownica: { atrapa: 'deploy/proba/atrapy/dpd.mjs',
      komunikat: 'Piaskownica: prawdziwe DPD jest tu wyłączone — nic nie poszło do DPD.' },
  },
  inpost: {
    klucz: 'inpost', nazwa: 'InPost', logo: '/integracje/inpost.svg', idKatalogu: 'inpost',
    opisKatalogu: 'Nadaj przesyłki przez InPost.', umowa: 'wlasna', przewoznicy: ['inpost'],
    metody: [{ klucz: 'inpost_paczkomat', etykieta: 'InPost Paczkomat', etykietaWyboru: 'Paczkomat InPost — nasza umowa',
      etykietaDrogi: 'Paczkomat InPost', formularz: 'paczkomat', punktOdbioru: true }],
    // ⚠️ pobranie 'adapter', NIE 'umowa' — ochrona pieniedzy (kurier-nadania.js, kurierzyDoWyboru):
    // adapter umie wyslac kwote, ale umowa z InPostem na pobranie nie jest potwierdzona, wiec przy
    // pobraniu na tej paczce paczkomatu NIE ma w wyborze (inaczej towar oddany bez inkasa).
    // PRZ-135.T2: firma z umową zaznacza ją w ustawieniach InPostu; wtedy reguły dostają
    // `umowyPobrania: ['inpost']` parametrem — ten wpis zostaje 'adapter' na zawsze.
    // PRZ-137.03: pobranieNaDosylce — z umową firmy paczkomat wiezie też zamiennik za pobraniem
    // (paczka N > 1, jawna decyzja operatora); adapter honoruje `pobranieNaTejPaczce` jak dpd.js.
    umiejetnosci: { pobranie: 'adapter', pobranieNaDosylce: true, nadanieAsynchroniczne: true, sledzenie: 'wlasne',
      etykieta: { zpl: true, zplPrzyNadaniu: true } },
    pobieranieEtykiety: true,
    sledzenieAdres: (n: string) => `https://inpost.pl/sledzenie-przesylek?number=${encodeURIComponent(n)}`,
    kluczeEnv: ['INPOST_TOKEN'],
    konfigurator: { sciezka: '/ustawienia/integracje/inpost', etykieta: 'InPost (paczkomaty)',
      zdanie: 'token API ShipX i numer organizacji, paczkomat nadawczy, sprawdzenie połączenia.' },
    piaskownica: { atrapa: 'deploy/proba/atrapy/inpost.mjs',
      komunikat: 'Piaskownica: prawdziwy InPost jest tu wyłączony — nic nie poszło do InPostu.' },
  },
  allegro_wza: {
    klucz: 'allegro_wza', nazwa: 'Wysyłam z Allegro', logo: '/integracje/allegro.svg', idKatalogu: 'wza',
    opisKatalogu: 'Nadaj przesyłki z wykorzystaniem powiązanego konta Allegro.', umowa: 'platformy',
    przewoznicy: ['dpd', 'inpost', 'dhl', 'orlen', 'allegro-one', 'packeta'],
    // Brzmienie ustalone z wlascicielem („Allegro DPD, Allegro Paczkomat, Allegro Orlen") — kazda
    // etykieta zaczyna sie od „Allegro", zeby w kolumnie „Dostawa" od razu bylo widac, ze to
    // przesylka kanalu Allegro. `allegro_punkt` zbiera automaty i punkty (ORLEN, DHL BOX, One Box)
    // w jedna nazwe: dla operatora roznica jest zadna, a slownik rozbity na przewoznikow
    // rozjezdzalby sie z kazda nowa usluga Allegro. Te etykiety sa JEDYNYM zrodlem dla
    // ETYKIETY_WYSYLKI (domena/wysylka.js); `allegro_paczkomat` nie ma kuriera i stoi tam.
    // Te 4 metody sa takze cala lista WZA_DOMYSLNIE (kurier-nadania.js) i WzA w masowe.js:
    // usuniecie wpisu metody WzA bez etykiety w ETYKIETY_KANALU powoduje wyjątek przy imporcie domena/wysylka.js.
    metody: [
      { klucz: 'allegro_dpd', etykieta: 'Allegro Kurier DPD', formularz: 'wza', punktOdbioru: false },
      { klucz: 'allegro_punkt', etykieta: 'Allegro punkt / automat', formularz: 'wza', punktOdbioru: false },
      { klucz: 'allegro_kurier', etykieta: 'Allegro One Kurier', formularz: 'wza', punktOdbioru: false },
      { klucz: 'allegro_inne', etykieta: 'Allegro — inna metoda', formularz: 'wza', punktOdbioru: false },
    ],
    // PRZ-137.03: pobranieNaDosylce false — adapter WzA bierze pobranie z zamówienia Allegro
    // i nie umie wysłać go na kolejnej paczce; zamiennik za pobraniem dostaje odmowę D3.
    umiejetnosci: { pobranie: 'umowa', pobranieNaDosylce: false, nadanieAsynchroniczne: true, sledzenie: 'przez_przewoznika',
      etykieta: { zpl: true, zplPrzyNadaniu: false } },
    pobieranieEtykiety: false,
    kluczeEnv: ['ALLEGRO_CLIENT_ID', 'ALLEGRO_CLIENT_SECRET'],
    konfigurator: { sciezka: '/ustawienia/integracje', etykieta: 'Wysyłam z Allegro', zdanie: '' },
    piaskownica: { atrapa: '', komunikat: '' },
  },
  allegro: {
    klucz: 'allegro', nazwa: 'Allegro', logo: '/integracje/allegro.svg', idKatalogu: 'allegro',
    opisKatalogu: '', umowa: 'platformy', przewoznicy: ['dpd', 'inpost', 'dhl', 'orlen', 'allegro-one', 'packeta'],
    metody: [],
    umiejetnosci: { pobranie: 'brak', pobranieNaDosylce: false, nadanieAsynchroniczne: false, sledzenie: 'wlasne',
      etykieta: { zpl: false, zplPrzyNadaniu: false } },
    pobieranieEtykiety: false,
    kluczeEnv: ['ALLEGRO_CLIENT_ID', 'ALLEGRO_CLIENT_SECRET'],
    konfigurator: { sciezka: '/ustawienia/integracje', etykieta: 'Allegro', zdanie: '' },
    piaskownica: { atrapa: '', komunikat: '' },
  },
} as const satisfies Readonly<Record<string, OpisKuriera>>;

export type KluczKuriera = keyof typeof MODULY_KURIEROW;
export type KluczKurieraNadania = {
  [K in KluczKuriera]: typeof MODULY_KURIEROW[K]['metody'] extends readonly [] ? never : K
}[KluczKuriera];

/** Rejestr podawany parametrem — domyślnie produkcyjny; test wstrzykuje tu zmyślonego kuriera. */
export type RejestrKurierow = Readonly<Record<string, OpisKuriera>>;

/** Opis kuriera albo null — dla wartości z danych (`przesylki.kurier` bywa puste albo historyczne). */
export function modulKurieraLubNull(klucz: unknown, rejestr: RejestrKurierow = MODULY_KURIEROW): OpisKuriera | null {
  if (typeof klucz !== 'string' || !Object.hasOwn(rejestr, klucz)) return null;
  return rejestr[klucz]!;
}

/**
 * PRZ-142.01: „panelu InPost" / „panelu kuriera" — do komunikatów dla operatora, które kierują go
 * do panelu przewoźnika TEJ przesyłki. Nieznany albo pusty `przesylki.kurier` → neutralnie.
 */
export function panelKuriera(klucz: unknown, rejestr: RejestrKurierow = MODULY_KURIEROW): string {
  const nazwa = modulKurieraLubNull(klucz, rejestr)?.nazwa;
  return nazwa ? `panelu ${nazwa}` : 'panelu kuriera';
}

export function modulKuriera(klucz: unknown, rejestr: RejestrKurierow = MODULY_KURIEROW): OpisKuriera {
  const opis = modulKurieraLubNull(klucz, rejestr);
  if (!opis) throw new Error('Nieznany kurier');
  return opis;
}

/** Kurier, który nadaje tę metodę; null = metoda bez kuriera (odmowa nadania). */
export function kurierDlaMetody(metoda: unknown): KluczKurieraNadania | null;
export function kurierDlaMetody(metoda: unknown, rejestr: RejestrKurierow): string | null;
export function kurierDlaMetody(metoda: unknown, rejestr: RejestrKurierow = MODULY_KURIEROW): string | null {
  for (const [klucz, opis] of Object.entries(rejestr)) {
    if (opis.metody.some(m => m.klucz === metoda)) return klucz;
  }
  return null;
}

/** Metody wszystkich kurierów, w kolejności rejestru. */
export function metodyKurierow(rejestr: RejestrKurierow = MODULY_KURIEROW): readonly MetodaKuriera[] {
  return Object.values(rejestr).flatMap(opis => [...opis.metody]);
}

/** Metody kurierów o danej umowie, w kolejności rejestru ('wlasna' = nasza umowa, 'platformy' = WzA). */
export function metodyNaUmowie(umowa: OpisKuriera['umowa'], rejestr: RejestrKurierow = MODULY_KURIEROW): readonly MetodaKuriera[] {
  return Object.values(rejestr).filter(opis => opis.umowa === umowa).flatMap(opis => [...opis.metody]);
}

export function metodaKuriera(metoda: unknown, rejestr: RejestrKurierow = MODULY_KURIEROW): MetodaKuriera | null {
  return metodyKurierow(rejestr).find(m => m.klucz === metoda) ?? null;
}

/**
 * ⚠️ Pieniądze: tylko kurier z `pobranie: 'umowa'` wolno wskazać przy pobraniu na tej paczce.
 * PRZ-135.T2: kurier z `'adapter'` awansuje, gdy firma zaznaczyła umowę na pobranie
 * (`umowyFirmy`, z `umowyPobraniaFirmy(db)`); `'brak'` nie awansuje nigdy. Rejestr się nie zmienia.
 */
export function pobranieNaUmowie(
  metoda: unknown, rejestr: RejestrKurierow = MODULY_KURIEROW, umowyFirmy: readonly string[] = [],
): boolean {
  const kurier = kurierDlaMetody(metoda, rejestr);
  if (kurier === null) return false;
  const pobranie = rejestr[kurier]!.umiejetnosci.pobranie;
  return pobranie === 'umowa' || (pobranie === 'adapter' && Array.isArray(umowyFirmy) && umowyFirmy.includes(kurier));
}

/**
 * PRZ-137.03 (D2): czy kurier metody wiezie pobranie na paczce N > 1 (zamiennik za pobraniem).
 * Tylko jawne `pobranieNaDosylce: true` w rejestrze; nieznana metoda albo brak flagi = nie.
 */
export function pobranieNaDosylce(metoda: unknown, rejestr: RejestrKurierow = MODULY_KURIEROW): boolean {
  const kurier = kurierDlaMetody(metoda, rejestr);
  return kurier !== null && rejestr[kurier]!.umiejetnosci.pobranieNaDosylce === true;
}

/** Metody, z których nadania powstaje etykieta ZPL (biała lista, kolejność rejestru). */
export function metodyZZpl(rejestr: RejestrKurierow = MODULY_KURIEROW): readonly string[] {
  return Object.values(rejestr).filter(opis => opis.umiejetnosci.etykieta.zpl).flatMap(opis => opis.metody.map(m => m.klucz));
}

/** Klucze env wszystkich kurierów bez powtórzeń (`allegro_wza` i `allegro` mają te same ALLEGRO_*). */
export function kluczeEnvKurierow(rejestr: RejestrKurierow = MODULY_KURIEROW): readonly string[] {
  return [...new Set(Object.values(rejestr).flatMap(opis => [...opis.kluczeEnv]))];
}

function kurierDomyslnyOpis(rejestr: RejestrKurierow): OpisKuriera {
  const opis = Object.values(rejestr).find(o => o.umowa === 'wlasna' && o.metody.length);
  if (!opis) throw new Error('Rejestr kurierów nie ma kuriera z metodą na własnej umowie');
  return opis;
}

/** D8: pierwsza metoda pierwszego kuriera z `umowa: 'wlasna'` (dziś 'dpd'). */
export function metodaDomyslna(rejestr: RejestrKurierow = MODULY_KURIEROW): string {
  return kurierDomyslnyOpis(rejestr).metody[0]!.klucz;
}

/** Kurier metody domyślnej — zapasowy w kurierWpisuRecznego (dziś 'dpd'). */
export function kurierDomyslny(rejestr: RejestrKurierow = MODULY_KURIEROW): string {
  return kurierDomyslnyOpis(rejestr).klucz;
}

export const METODA_DOMYSLNA = metodaDomyslna();
export const KURIER_DOMYSLNY = kurierDomyslny() as KluczKurieraNadania;

/** D5.3 wymaga adapterów: sprawdzenie ich metod należy do kontraktu składania (04b). */
export function sprawdzOpisyKurierow(
  moduly: Readonly<Record<string, OpisKuriera>> = MODULY_KURIEROW,
  przewoznicy: Readonly<Record<string, OpisPrzewoznika>> = OPISY_PRZEWOZNIKOW,
): void {
  const bledy: string[] = [];
  const kluczPoprawny = (k: string) => /^[a-z0-9_-]+$/.test(k);
  const metody = new Set<string>();
  for (const [k, opis] of Object.entries(przewoznicy)) {
    if (!kluczPoprawny(k) || !kluczPoprawny(opis.klucz) || opis.klucz !== k) {
      bledy.push(`${k}: przewoznicy.klucz niepoprawny lub różny od klucza rejestru`);
    }
  }
  for (const [k, opis] of Object.entries(moduly)) {
    if (!kluczPoprawny(k) || !kluczPoprawny(opis.klucz) || opis.klucz !== k) {
      bledy.push(`${k}: klucz niepoprawny lub różny od klucza rejestru`);
    }
    for (const m of opis.metody) {
      if (!kluczPoprawny(m.klucz)) bledy.push(`${k}: metody — niepoprawny klucz ${m.klucz}`);
      if (metody.has(m.klucz)) bledy.push(`${k}: metody — powtórzona metoda ${m.klucz}`);
      metody.add(m.klucz);
      if (m.klucz.startsWith('allegro_') !== (opis.umowa === 'platformy')) {
        bledy.push(`${k}: metody.${m.klucz} — niezgodna umowa ${opis.umowa}`);
      }
    }
    if (opis.metody.length && opis.umowa === 'wlasna') {
      if (!opis.piaskownica.atrapa.trim()) bledy.push(`${k}: piaskownica.atrapa wymagana`);
      if (!opis.konfigurator.sciezka.trim()) bledy.push(`${k}: konfigurator.sciezka wymagana`);
      if (!opis.piaskownica.komunikat.trim()) bledy.push(`${k}: piaskownica.komunikat wymagany`);
    }
    for (const p of opis.przewoznicy) {
      if (!kluczPoprawny(p) || !Object.hasOwn(przewoznicy, p)) bledy.push(`${k}: przewoznicy — nieznany lub niepoprawny klucz ${p}`);
    }
  }
  if (bledy.length) throw new Error(`Błędne opisy kurierów:\n${bledy.join('\n')}`);
}
