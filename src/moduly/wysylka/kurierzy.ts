import type { Srodowisko } from '../../core/kontrakty.ts';
import { createDpdClient, createInpostClient, createAllegroWzaClient } from '../../integracje/fabryki.ts';
import { createAllegroSledzenieClient } from '../../oms/kurierzy/allegro.js';
import type { KurierNadania, KurierSledzenia } from './nadanie-typy.ts';
import { skonfigurowanyUrl } from '../../core/konfiguracja-wartosci.ts';

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
  return { dpd, inpost, pobranieNadawca: { nazwa: nadawca?.nazwa,
    rachunek: env.OMS_RACHUNEK?.trim() } };
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
