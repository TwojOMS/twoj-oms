import { isIP } from 'node:net';
import { BladKonfiguracji } from './blad-konfiguracji.ts';
import type { Srodowisko } from './kontrakty.ts';

/** Zwraca wyłącznie konkretną, jawną listę proxy akceptowaną przez Fastify. */
export function zaufaneProxy(env: Srodowisko): false | string[] {
  const wartosc = env.OMS_TRUST_PROXY;
  if (wartosc === undefined || wartosc === '') return false;
  if (wartosc !== wartosc.trim()) throw bladProxy();

  const proxy = wartosc.split(',');
  if (!proxy.length || proxy.some((adres) => !poprawnyAdresLubCidr(adres)) || obejmujeWszystkieAdresy(proxy)) {
    throw bladProxy();
  }
  return proxy;
}

function bladProxy() {
  return new BladKonfiguracji('OMS_TRUST_PROXY', 'Niepoprawna konfiguracja OMS_TRUST_PROXY',
    'na listę zaufanych adresów IP lub CIDR oddzielonych przecinkami, bez spacji, albo usuń zmienną przy dostępie bez proxy.');
}

function obejmujeWszystkieAdresy(proxy: readonly string[]): boolean {
  return [4, 6].some((rodzina) => {
    const bity = rodzina === 4 ? 32 : 128;
    const przedzialy = proxy.flatMap((adres) => przedzialCidr(adres, rodzina, bity));
    if (!przedzialy.length) return false;
    przedzialy.sort(([odA], [odB]) => (odA < odB ? -1 : odA > odB ? 1 : 0));
    let koniec = -1n;
    for (const [od, do_] of przedzialy) {
      if (od > koniec + 1n) return false;
      if (do_ > koniec) koniec = do_;
    }
    return koniec === (1n << BigInt(bity)) - 1n;
  });
}

function przedzialCidr(adres: string, rodzina: number, bity: number): [bigint, bigint][] {
  const [ip, zapisMaski] = adres.split('/');
  if (isIP(ip) !== rodzina) return [];
  const maska = zapisMaski === undefined ? bity : Number(zapisMaski);
  const liczba = liczbaAdresu(ip, rodzina);
  if (liczba === null) return [];
  const przesuniecie = BigInt(bity - maska);
  const od = (liczba >> przesuniecie) << przesuniecie;
  return [[od, od + (1n << przesuniecie) - 1n]];
}

function liczbaAdresu(ip: string, rodzina: number): bigint | null {
  if (rodzina === 4) return ip.split('.').reduce((wynik, czesc) => wynik * 256n + BigInt(czesc), 0n);
  let bezStrefy = ip.split('%')[0];
  const ostatniDwukropek = bezStrefy.lastIndexOf(':');
  const osadzonyIpv4 = bezStrefy.slice(ostatniDwukropek + 1);
  if (osadzonyIpv4.includes('.')) {
    const oktety = osadzonyIpv4.split('.').map(Number);
    if (oktety.length !== 4 || oktety.some((oktet) => !Number.isInteger(oktet) || oktet < 0 || oktet > 255)) return null;
    bezStrefy = `${bezStrefy.slice(0, ostatniDwukropek + 1)}${(oktety[0] * 256 + oktety[1]).toString(16)}:${(oktety[2] * 256 + oktety[3]).toString(16)}`;
  }
  const [lewa = '', prawa = ''] = bezStrefy.split('::');
  const heksy = [...(lewa ? lewa.split(':') : []), ...Array(8 - (lewa ? lewa.split(':').length : 0) - (prawa ? prawa.split(':').length : 0)).fill('0'), ...(prawa ? prawa.split(':') : [])];
  if (heksy.length !== 8 || heksy.some((czesc) => !/^[0-9a-f]{1,4}$/i.test(czesc))) return null;
  return heksy.reduce((wynik, czesc) => wynik * 65536n + BigInt(`0x${czesc}`), 0n);
}

function poprawnyAdresLubCidr(wartosc: string): boolean {
  const czesci = wartosc.split('/');
  if (czesci.length > 2 || !czesci[0]) return false;
  const rodzina = isIP(czesci[0]);
  if (!rodzina || (rodzina === 6 && adresIpv4Mapped(czesci[0]))) return false;
  if (czesci.length === 1) return true;
  if (!/^\d+$/.test(czesci[1])) return false;
  const maska = Number(czesci[1]);
  return Number.isSafeInteger(maska) && maska >= 1 && maska <= (rodzina === 4 ? 32 : 128);
}

function adresIpv4Mapped(ip: string): boolean {
  const liczba = liczbaAdresu(ip, 6);
  return liczba !== null && liczba >> 32n === 0xffffn;
}
