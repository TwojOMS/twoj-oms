import type { Srodowisko } from '../../core/kontrakty.ts';
import { METODY_WYSYLKI } from '../../domena/wysylka.js';
import { konfiguracjaHistorii } from './historia.ts';
import { brakujaceKluczeKanalu } from './kompletnosc.ts';
import { interwal, skonfigurowanyUrl } from '../../core/konfiguracja-wartosci.ts';
export type DefinicjaKanalu = { klucz: string; typ: 'woo' | 'allegro'; prefiks: string; etykieta?: string; raport?: string };
function parsujJson(tekst: string, nazwa: string): any {
  try { return JSON.parse(tekst); }
  catch { throw new Error(`${nazwa}: niepoprawny JSON`); }
}
function obiekt(wartosc: unknown): wartosc is Record<string, any> {
  return wartosc !== null && typeof wartosc === 'object' && !Array.isArray(wartosc);
}
function mapowanieSklepu(tekst: string, nazwa: string) {
  const mapowanie = parsujJson(tekst, nazwa);
  if (!obiekt(mapowanie) || !mapowanie.instancje || !Array.isArray(mapowanie.poPozycji)) throw new Error(`${nazwa}: oczekiwano instancje i poPozycji`);
  for (const m of [...Object.values(mapowanie.instancje), ...mapowanie.poPozycji] as { metoda?: string }[]) {
    if (!obiekt(m) || !m.metoda || !METODY_WYSYLKI.includes(m.metoda) || m.metoda.startsWith('allegro_')) throw new Error(`${nazwa}: niedozwolona metoda sklepu`);
  }
  return mapowanie;
}
const WZOR_USER_AGENT_ALLEGRO = /^[^\s/()]+\/[0-9][^\s/()]*\s\(\+https?:\/\/[^\s()]+\)$/;
function parsujUserAgentAllegro(env: Srodowisko, nazwa: string) {
  const wartosc = String(env[nazwa] ?? '').trim();
  if (!WZOR_USER_AGENT_ALLEGRO.test(wartosc)) throw new Error(`${nazwa}: niepoprawny nagłówek User-Agent Allegro`);
  return wartosc;
}
function parsujDateOd(env: Srodowisko, nazwa: string, wymagana = false) {
  const surowe = (env[nazwa] ?? '').trim();
  if (!surowe) {
    if (wymagana) throw new Error(`${nazwa}: wymagana data RRRR-MM-DD dla kanału Allegro`);
    return null;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(surowe)) throw new Error(`${nazwa}: data musi mieć postać RRRR-MM-DD`);
  const [rok, miesiac, dzien] = surowe.split('-').map(Number);
  const data = new Date(Date.UTC(rok, miesiac - 1, dzien));
  if (data.getUTCFullYear() !== rok || data.getUTCMonth() !== miesiac - 1 || data.getUTCDate() !== dzien)
    throw new Error(`${nazwa}: nieistniejąca data`);
  return `${surowe}T00:00:00`;
}
export function definicjeKanalow(env: Srodowisko): DefinicjaKanalu[] {
  const d = parsujJson(env.OMS_KANALY ?? '[]', 'OMS_KANALY') as DefinicjaKanalu[];
  if (!Array.isArray(d)) throw new Error('OMS_KANALY: oczekiwano listy');
  const raporty = new Set<string>();
  const zastrzezoneRaporty = new Set(['RECZNE','B2B','DROPSHIPPING','GDD','INDYWIDUALNE','SKLEP','SKLEP_INDYWIDUALNE','ALLEGRO']);
  const nazwy = new Set<string>();
  const prefiksy = new Set<string>();
  for (const k of d) {
    if (!obiekt(k) || typeof k.klucz !== 'string' || typeof k.prefiks !== 'string' || typeof k.typ !== 'string'
      || !/^[a-z][a-z0-9_-]*$/.test(k.klucz) || !/^[A-Z][A-Z0-9_]*$/.test(k.prefiks)
      || !['woo','allegro'].includes(k.typ) || nazwy.has(k.klucz) || prefiksy.has(k.prefiks)) throw new Error('OMS_KANALY: błędna albo powtórzona definicja');
    if (['reczne','indywidualne','__proto__','constructor','prototype'].includes(k.klucz)
      || (k.etykieta !== undefined && (typeof k.etykieta !== 'string' || !k.etykieta.trim()))
      || (k.raport !== undefined && (typeof k.raport !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(k.raport)
        || zastrzezoneRaporty.has(k.raport) || raporty.has(k.raport)))) throw new Error('OMS_KANALY: błędna etykieta lub zastrzeżony/powtórzony kanał');
    if(k.raport) raporty.add(k.raport);
    nazwy.add(k.klucz);
    prefiksy.add(k.prefiks);
  }
  return d;
}
export function konfiguracjaKanalow(definicje: readonly DefinicjaKanalu[], env: Srodowisko, niekompletneJakoAlarm = false) {
  const sklepy: Record<string, any> = {}; const kanaly: Record<string, any> = {};
  const braki = Object.fromEntries(definicje.map(d => [d.klucz, brakujaceKluczeKanalu(d, env)]));
  const wymagane = (n: string, obowiazkowe = true) => { if (obowiazkowe && !env[n]) throw new Error(`Brak wymaganej zmiennej: ${n}`); return env[n] ?? ''; };
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
  return niekompletneJakoAlarm ? { sklepy, kanaly, odstepMs, braki, definicje: [...definicje] } : { sklepy, kanaly, odstepMs, definicje: [...definicje] };
}
