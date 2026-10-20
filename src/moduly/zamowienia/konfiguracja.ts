import type { Srodowisko } from '../../core/kontrakty.ts';
import { wczytajSprzedawce } from '../../core/sprzedawca.ts';
import { wczytajKlientowWdt } from '../../core/klienci-wdt.ts';
import { skonfigurowanyUrl } from '../../core/konfiguracja-wartosci.ts';
import { parsujCenniki } from '../../domena/magazyn-do-zamowienia.js';
import { kanalIndywidualnyWlaczony } from '../kanaly/klasyfikacja.ts';
import { adresFirmyZEnv } from '../../core/adres-firmy.ts';
import { ADRES_GUS } from '../../domena/konfiguracja-gus.js';
import { efektywnyTryb } from '../../core/tryb.ts';
export function konfiguracjaZamowien(env: Srodowisko) {
  skonfigurowanyUrl(env.GUS_URL, 'GUS_URL');
  const klienciWdt = wczytajKlientowWdt(env);
  const sprzedawca = wczytajSprzedawce(env);
  // PRZ-060: cenniki „Dodaj z magazynu"; null = sklepy Woo z OMS_KANALY (kontekst zamówień).
  const cenniki = parsujCenniki(env.OMS_CENNIKI);
  return { klienciWdt, cenniki, kanalIndywidualny: kanalIndywidualnyWlaczony(env),
    gus: env.GUS_KLUCZ ? {klucz:env.GUS_KLUCZ,url:env.GUS_URL||ADRES_GUS} : null,
    // PRZ-102.11: adres usługi także dla klucza z Ustawień (GUS_URL tylko w pliku); próba = klucz z ekranu nie wychodzi.
    gusAdres: env.GUS_URL||ADRES_GUS, proba: efektywnyTryb(env)==='proba',
    // PRZ-093.08: adres z pliku; adres z Ustawień dokłada zbuduj modułu (config.adresFirmy).
    nadawca: adresFirmyZEnv(env),
    proforma:{nip:sprzedawca.nip,bdo:sprzedawca.bdo},
  };
}
