// PRZ-083 — atrapa Diagnostyki (/ustawienia/lacznosc) w piaskownicy i demo. Prawdziwa diagnostyka przy KAŻDYM wejściu
// łączy się z serwerami integracji (DNS + HTTP); w kontenerze bez sieci to same timeouty, a w demo każde wejście gościa
// byłoby próbą wyjścia na zewnątrz. Atrapa nie wykonuje żadnego połączenia — zwraca wynik „działa” dla tych samych
// celów, które sprawdzałaby prawdziwa (sklepy i kanały z konfiguracji demo) oraz dla integracji z demo.
// Adresy IP z zakresu dokumentacyjnego 203.0.113.0/24 (RFC 5737) — żadnego prawdziwego hosta.
import { celeLacznosci } from '../../../src/domena/lacznosc.js';
import { wymagajTrybuProby } from './tryb.mjs';

const INTEGRACJE_DEMO = {
  infakt: { baseUrl: 'https://api.infakt.pl' },
  ksef: { api: 'https://ksef.mf.gov.pl/api' },
  dpd: { url: 'https://dpdservices.dpd.com.pl' },
  inpost: { url: 'https://api-shipx-pl.easypack24.net' },
  gus: { url: 'https://wyszukiwarkaregon.stat.gov.pl/wsBIR/UslugaBIRzewnPubl.svc' },
};

function adresNaEkran(cel) {
  if (cel.klucz.startsWith('sklep:')) return { url: 'https://sklep.pracownia-polcien.example', host: 'sklep.pracownia-polcien.example' };
  if (cel.klucz.startsWith('allegro:')) return { url: 'https://api.allegro.pl', host: 'api.allegro.pl' };
  return { url: cel.url, host: cel.host };
}

export function createAtrapaLacznosci({ config = {}, env = process.env } = {}) {
  wymagajTrybuProby(env, 'atrapa diagnostyki');
  return {
    async sprawdz() {
      return celeLacznosci({ ...config, ...INTEGRACJE_DEMO }).map((cel, i) => ({
        // Sklepy i kanały atrap mają w konfiguracji adres „atrapa.example.invalid” — na ekranie stoi adres jak w firmie.
        klucz: cel.klucz, nazwa: cel.nazwa, ...adresNaEkran(cel),
        ok: true, warstwa: null, adresIp: `203.0.113.${10 + i}`, status: 200,
        msDns: 4 + (i % 5), msHttp: 70 + ((i * 37) % 120), komunikat: '',
      }));
    },
    atrapa: true,
  };
}
