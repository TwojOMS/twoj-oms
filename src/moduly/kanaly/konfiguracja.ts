import { bladKonfiguracji } from '../../core/blad-konfiguracji.ts';
import type { Srodowisko } from '../../core/kontrakty.ts'; import { czyTypKanalu, TYPY_KANALOW, sprawdzOpisyKanalow, type TypKanaluZnany } from '../../domena/moduly-kanalow.ts';
import { METODY_WYSYLKI } from '../../domena/wysylka.js';
import { konfiguracjaHistorii } from './historia.ts';
import { brakujaceKluczeKanalu } from './kompletnosc.ts';
import { interwal, skonfigurowanyUrl } from '../../core/konfiguracja-wartosci.ts';
import {readFileSync} from 'node:fs';
const wersjaProduktu: string = JSON.parse(readFileSync(new URL('../../../package.json',import.meta.url),'utf8')).version;
export type AplikacjeDeviceEnv = Partial<Record<'produkcja'|'sandbox',{clientId:string;clientSecret:string}>>;
export function userAgentAllegro(env: Srodowisko) {
  const wartosc=String(env.OMS_ALLEGRO_USER_AGENT??'').trim()||`TwojOMS/${wersjaProduktu} (+https://twojoms.pl)`;
  if(!WZOR_USER_AGENT_ALLEGRO.test(wartosc))throw bladKonfiguracji('OMS_ALLEGRO_USER_AGENT: niepoprawny nagłówek User-Agent Allegro');
  return wartosc;
}
function aplikacjeDeviceEnv(env: Srodowisko): AplikacjeDeviceEnv {
  const produkcja={clientId:env.OMS_ALLEGRO_DEVICE_CLIENT_ID??'',clientSecret:env.OMS_ALLEGRO_DEVICE_CLIENT_SECRET??''};
  const sandbox={clientId:env.OMS_ALLEGRO_SANDBOX_DEVICE_CLIENT_ID??'',clientSecret:env.OMS_ALLEGRO_SANDBOX_DEVICE_CLIENT_SECRET??''};
  const nazwy={produkcja:'OMS_ALLEGRO_DEVICE_CLIENT_',sandbox:'OMS_ALLEGRO_SANDBOX_DEVICE_CLIENT_'},wynik:AplikacjeDeviceEnv={};
  for(const [s,p] of Object.entries({produkcja,sandbox})) {
    if(!p.clientId&&!p.clientSecret)continue;
    const zla=[['ID',p.clientId],['SECRET',p.clientSecret]].find(([,v])=>!(v.length>0&&v.length<=200&&!/\s/.test(v)));if(zla)throw bladKonfiguracji(`${nazwy[s as keyof typeof nazwy]}${zla[0]}: aplikacja Device Allegro (${s}) wymaga razem Client ID i Client Secret bez białych znaków, do 200 znaków.`);
    wynik[s as keyof AplikacjeDeviceEnv]=p;
  }
  return wynik;
}
export type DefinicjaKanalu = { klucz: string; typ: TypKanaluZnany; prefiks: string; etykieta?: string; raport?: string };
function parsujJson(tekst: string, nazwa: string): any {
  try { return JSON.parse(tekst); }
  catch { throw bladKonfiguracji(`${nazwa}: niepoprawny JSON`); }
}
function obiekt(wartosc: unknown): wartosc is Record<string, any> {
  return wartosc !== null && typeof wartosc === 'object' && !Array.isArray(wartosc);
}
export function mapowanieSklepu(tekst: string, nazwa: string) { // PRZ-134: opcjonalne bramkiPobrania (identyfikatory payment_method Woo); brak pola = jak dziś
  const mapowanie = parsujJson(tekst, nazwa);
  if (!obiekt(mapowanie) || !mapowanie.instancje || !Array.isArray(mapowanie.poPozycji)) throw bladKonfiguracji(`${nazwa}: oczekiwano instancje i poPozycji`);
  for (const m of [...Object.values(mapowanie.instancje), ...mapowanie.poPozycji] as { metoda?: string }[]) {
    if (!obiekt(m) || !m.metoda || !METODY_WYSYLKI.includes(m.metoda) || m.metoda.startsWith('allegro_')) throw bladKonfiguracji(`${nazwa}: niedozwolona metoda sklepu`);
  }
  if ('bramkiPobrania' in mapowanie) { const b: unknown = mapowanie.bramkiPobrania; if (!Array.isArray(b) || b.length > 20 || !b.every((x) => typeof x === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(x))) throw bladKonfiguracji(`${nazwa}: niepoprawne bramkiPobrania`); } return mapowanie;
}
const WZOR_USER_AGENT_ALLEGRO = /^[^\s/()]+\/[0-9][^\s/()]*\s\(\+https?:\/\/[^\s()]+\)$/;
function parsujUserAgentAllegro(env: Srodowisko, nazwa: string) {
  const wartosc = String(env[nazwa] ?? '').trim();
  if (!WZOR_USER_AGENT_ALLEGRO.test(wartosc)) throw bladKonfiguracji(`${nazwa}: niepoprawny nagłówek User-Agent Allegro`);
  return wartosc;
}
function parsujDateOd(env: Srodowisko, nazwa: string, wymagana = false) {
  const surowe = (env[nazwa] ?? '').trim();
  if (!surowe) {
    if (wymagana) throw bladKonfiguracji(`${nazwa}: wymagana data RRRR-MM-DD dla kanału Allegro`);
    return null;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(surowe)) throw bladKonfiguracji(`${nazwa}: data musi mieć postać RRRR-MM-DD`);
  const [rok, miesiac, dzien] = surowe.split('-').map(Number);
  const data = new Date(Date.UTC(rok, miesiac - 1, dzien));
  if (data.getUTCFullYear() !== rok || data.getUTCMonth() !== miesiac - 1 || data.getUTCDate() !== dzien)
    throw bladKonfiguracji(`${nazwa}: nieistniejąca data`);
  return `${surowe}T00:00:00`;
}
// Treści błędów OMS_KANALY mówią, którą pozycję listy (od 1) i które pole poprawić, ale nie przepisują wartości
// z wejścia — poza kluczem kanału, i to dopiero po sprawdzeniu, że ma dozwoloną postać (nazwa, nie sekret).
const PRZYKLAD_KANALOW = '[{"klucz":"woo_sklep","typ":"woo","prefiks":"WOO_SKLEP"}]';
const OPIS_KANALOW = 'docs/instalacja-docker.md, sekcja 9';
const WZOR_KLUCZA = /^[a-z][a-z0-9_-]*$/;
const WZOR_PREFIKSU = /^[A-Z][A-Z0-9_]*$/;
const KLUCZE_ZASTRZEZONE = ['reczne', 'indywidualne', '__proto__', 'constructor', 'prototype'];
export const RAPORTY_ZASTRZEZONE = ['RECZNE', 'B2B', 'DROPSHIPPING', 'GDD', 'INDYWIDUALNE', 'SKLEP', 'SKLEP_INDYWIDUALNE', 'ALLEGRO'];
function odczytajListeKanalow(tekst: string): unknown {
  try { return JSON.parse(tekst); }
  catch (e) {
    const komunikat = e instanceof Error ? e.message : '';
    const znak = /position (\d+)/.exec(komunikat)?.[1];
    const gdzie = !tekst.trim() ? 'wartość jest pusta — wpisz [] (brak kanałów) albo listę kanałów'
      : /end of JSON/.test(komunikat) || (znak !== undefined && Number(znak) >= tekst.trimEnd().length) ? 'wartość kończy się za wcześnie — brakuje zamknięcia ] albo }'
      : znak !== undefined ? `błąd w znaku nr ${Number(znak) + 1}`
      : !tekst.trimStart().startsWith('[') ? 'lista musi zaczynać się od znaku [ (bez cudzysłowów wokół całej wartości)'
      : 'błąd składni';
    throw bladKonfiguracji(`OMS_KANALY: niepoprawny JSON (${gdzie}). Oczekiwano listy kanałów, np. ${PRZYKLAD_KANALOW}; cudzysłowy w środku muszą być proste ("), a po ostatnim polu nie stawia się przecinka. Opis: ${OPIS_KANALOW}.`);
  }
}
/** Pierwsza wada pozycji listy `OMS_KANALY` jako zdanie z numerem pozycji (od 1) albo `null`, gdy pozycja jest dobra. */
function wadaDefinicji(k: unknown, numer: number, nazwy: Map<string, number>, prefiksy: Map<string, number>, raporty: Map<string, number>): string | null {
  const gdzie = `OMS_KANALY: pozycja ${numer}`;
  if (!obiekt(k)) return `${gdzie} nie jest obiektem — oczekiwano {"klucz":…,"typ":…,"prefiks":…}`;
  const nazwa = typeof k.klucz === 'string' && WZOR_KLUCZA.test(k.klucz) && k.klucz.length <= 64 ? ` (klucz „${k.klucz}”)` : '';
  const pozycja = `${gdzie}${nazwa}`;
  if (typeof k.klucz !== 'string' || !WZOR_KLUCZA.test(k.klucz)) return `${pozycja}: pole „klucz” ma być tekstem z małych liter, cyfr, _ i -, zaczynającym się od litery (np. woo_sklep)`;
  if (!czyTypKanalu(k.typ)) return `${pozycja}: pole „typ” ma być ${TYPY_KANALOW.map(typ => `„${typ}”`).join(' albo ')}`;
  if (typeof k.prefiks !== 'string' || !WZOR_PREFIKSU.test(k.prefiks)) return `${pozycja}: pole „prefiks” ma być tekstem z wielkich liter, cyfr i _, zaczynającym się od litery (np. WOO_SKLEP)`;
  const kluczPowtorzony = nazwy.get(k.klucz);
  if (kluczPowtorzony !== undefined) return `${pozycja}: pole „klucz” powtarza pozycję ${kluczPowtorzony} — każdy kanał ma mieć inny klucz`;
  const prefiksPowtorzony = prefiksy.get(k.prefiks);
  if (prefiksPowtorzony !== undefined) return `${pozycja}: pole „prefiks” (${k.prefiks}) powtarza pozycję ${prefiksPowtorzony} — każdy kanał ma mieć własny prefiks`;
  if (KLUCZE_ZASTRZEZONE.includes(k.klucz)) return `${pozycja}: pole „klucz” ma nazwę zastrzeżoną przez OMS — wybierz inną`;
  if (k.etykieta !== undefined && (typeof k.etykieta !== 'string' || !k.etykieta.trim())) return `${pozycja}: pole „etykieta” ma być niepustym tekstem (albo pomiń to pole)`;
  if (k.raport !== undefined) {
    if (typeof k.raport !== 'string' || !WZOR_PREFIKSU.test(k.raport)) return `${pozycja}: pole „raport” ma być tekstem z wielkich liter, cyfr i _, zaczynającym się od litery (albo pomiń to pole)`;
    if (RAPORTY_ZASTRZEZONE.includes(k.raport)) return `${pozycja}: pole „raport” (${k.raport}) to nazwa zastrzeżona — wybierz inną`;
    const raportPowtorzony = raporty.get(k.raport);
    if (raportPowtorzony !== undefined) return `${pozycja}: pole „raport” (${k.raport}) powtarza pozycję ${raportPowtorzony} — każdy kanał ma mieć inną nazwę w raporcie`;
  }
  return null;
}
export function definicjeKanalow(env: Srodowisko, moduly?: Parameters<typeof sprawdzOpisyKanalow>[0]): DefinicjaKanalu[] { sprawdzOpisyKanalow(moduly);
  const d = odczytajListeKanalow(env.OMS_KANALY ?? '[]') as DefinicjaKanalu[];
  if (!Array.isArray(d)) throw bladKonfiguracji(`OMS_KANALY: oczekiwano listy kanałów w nawiasach [ ], np. ${PRZYKLAD_KANALOW}. Opis: ${OPIS_KANALOW}.`);
  const raporty = new Map<string, number>();
  const nazwy = new Map<string, number>();
  const prefiksy = new Map<string, number>();
  d.forEach((k, i) => {
    const wada = wadaDefinicji(k, i + 1, nazwy, prefiksy, raporty);
    if (wada) throw bladKonfiguracji(wada);
    if (k.raport) raporty.set(k.raport, i + 1);
    nazwy.set(k.klucz, i + 1);
    prefiksy.set(k.prefiks, i + 1);
  });
  return d;
}
export function konfiguracjaKanalow(definicje: readonly DefinicjaKanalu[], env: Srodowisko, niekompletneJakoAlarm = false) {
  const sklepy: Record<string, any> = {}; const kanaly: Record<string, any> = {};
  const braki = Object.fromEntries(definicje.map(d => [d.klucz, brakujaceKluczeKanalu(d, env)]));
  const wymagane = (n: string, obowiazkowe = true) => { if (obowiazkowe && !env[n]) throw bladKonfiguracji(`Brak wymaganej zmiennej: ${n}`); return env[n] ?? ''; };
  for (const { klucz, typ, prefiks: p } of definicje) {
    // Niepusta obecna wartość podlega D07 także bez aktywnego klienta.
    // W pełnej kompozycji puste wymagane URL to brak raportowany przez D01.
    if (typ === 'woo') {
      const url = env[`${p}_URL`];
      if (!niekompletneJakoAlarm || (url !== undefined && url !== '')) skonfigurowanyUrl(url, `${p}_URL`);
    } else {
      skonfigurowanyUrl(env[`${p}_API`], `${p}_API`);
      skonfigurowanyUrl(env[`${p}_AUTH`], `${p}_AUTH`);
    }
    // D01: obecna, lecz błędna wartość jest odmową startu także wtedy, gdy inny klucz
    // tego kanału brakuje. Pusty wpis zostaje brakiem raportowanym przez /health.
    if (niekompletneJakoAlarm && env[`${p}_OD`] !== undefined && env[`${p}_OD`] !== '') parsujDateOd(env, `${p}_OD`);
    if (niekompletneJakoAlarm && typ === 'allegro' && env[`${p}_USER_AGENT`] !== undefined && env[`${p}_USER_AGENT`] !== '')
      parsujUserAgentAllegro(env, `${p}_USER_AGENT`);
    // Pełny produkt zachowuje panel i zgłasza brak kanału przez /health (D01).
    // Ścisły konfigurator/CLI nadal odmawia częściowej konfiguracji.
    const obecneMapowanie = niekompletneJakoAlarm && typ === 'woo' ? wymagane(`${p}_MAPOWANIE`, false) : '';
    const sprawdzoneMapowanie = obecneMapowanie.trim() ? mapowanieSklepu(obecneMapowanie, `${p}_MAPOWANIE`) : undefined;
    if (niekompletneJakoAlarm && braki[klucz].length) continue;
    if (typ === 'woo') {
      if (!env[`${p}_CK`] && !env[`${p}_CS`]) continue;
      const mapowanie = sprawdzoneMapowanie ?? mapowanieSklepu(wymagane(`${p}_MAPOWANIE`), `${p}_MAPOWANIE`);
      sklepy[klucz] = { baseUrl: wymagane(`${p}_URL`).replace(/\/+$/, ''), ck: wymagane(`${p}_CK`), cs: wymagane(`${p}_CS`),
        mapowanie, od: parsujDateOd(env, `${p}_OD`), historia: env[`${p}_HISTORIA_KONTO_APILO`] ? konfiguracjaHistorii(env, klucz, p) : null };
    } else {
      if (!env[`${p}_CLIENT_ID`] && !env[`${p}_CLIENT_SECRET`]) continue;
      kanaly[klucz] = { clientId: wymagane(`${p}_CLIENT_ID`), clientSecret: wymagane(`${p}_CLIENT_SECRET`),
        api: (env[`${p}_API`] || 'https://api.allegro.pl').replace(/\/+$/, ''), auth: (env[`${p}_AUTH`] || 'https://allegro.pl/auth/oauth').replace(/\/+$/, ''),
        userAgent: parsujUserAgentAllegro(env, `${p}_USER_AGENT`), od: parsujDateOd(env, `${p}_OD`, true) };
    }
  }
  const odstepMs = interwal(env.OMS_POLLER_MS, 'OMS_POLLER_MS', 120000, 30000);
  const wspolne={sklepy,kanaly,odstepMs,definicje:[...definicje],deviceEnv:aplikacjeDeviceEnv(env),userAgent:userAgentAllegro(env),userAgentZEnv:String(env.OMS_ALLEGRO_USER_AGENT??'').trim()};
  return {...wspolne,...(niekompletneJakoAlarm?{braki}:{})};
}
export type PolaUserAgentAllegro = {nazwa:string;wersja:string;adres:string};
/** Puste pola przywracają nagłówek produktu; cudza nazwa wymaga własnego kontaktu. */
export function zlozUserAgentAllegro(pola:PolaUserAgentAllegro):string {
  const nazwa=pola.nazwa.trim(),wersja=pola.wersja.trim(),adres=pola.adres.trim();
  // Nagłówek HTTP przyjmuje tylko ASCII: „Półcień” zapisane bez tej odmowy wywraca każde żądanie do Allegro.
  if(/[^\x21-\x7E]/.test(nazwa+wersja+adres))throw new Error('Nazwa, wersja i adres mogą zawierać tylko litery bez polskich znaków, cyfry i znaki interpunkcyjne (np. PracowniaPolcien zamiast Pracownia Półcień).');
  if(nazwa&&!adres)throw new Error('Podaj adres strony z informacją o aplikacji — Allegro kontaktuje się przez niego z autorem integracji.');
  if(adres){
    let url:URL;try{url=new URL(adres);}catch{throw new Error('Podaj poprawny adres strony z informacją o aplikacji (http lub https).');}
    if(!['http:','https:'].includes(url.protocol)||!url.hostname)throw new Error('Podaj poprawny adres strony z informacją o aplikacji (http lub https).');
  }
  const naglowek=`${nazwa||'TwojOMS'}/${wersja||wersjaProduktu} (+${adres||'https://twojoms.pl'})`;
  if(!WZOR_USER_AGENT_ALLEGRO.test(naglowek))throw new Error('Nazwa i wersja nie mogą zawierać spacji, ukośników ani nawiasów. Wersja musi zaczynać się cyfrą. Adres musi używać http lub https i nie zawierać spacji ani nawiasów.');
  return naglowek;
}
/** Zapis z panelu jako nagłówek; uszkodzony wiersz w bazie nie blokuje Allegro — wraca nagłówek produktu. */
export function userAgentZZapisu(ustawienia:Partial<PolaUserAgentAllegro>|undefined):string|null {
  if(!ustawienia)return null;
  try{return zlozUserAgentAllegro({nazwa:'',wersja:'',adres:'',...ustawienia});}catch{return null;}
}
