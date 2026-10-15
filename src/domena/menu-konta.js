import { ROLE, ekranyRoli } from './ekrany.js';

const tenSamZbior = (a, b) => a.size === b.size && [...a].every((wartosc) => b.has(wartosc));

function opisRoli(konto) {
  if (konto.serwisowe) return 'Konto serwisowe';
  const preset = ROLE[konto.rola];
  const etykieta = preset?.etykieta ?? String(konto.rola || 'Rola niestandardowa');
  if (!preset) return `${etykieta} + zmiany`;
  const zgodneEkrany = tenSamZbior(new Set(ekranyRoli(konto.rola)), konto.uprawnienia ?? new Set());
  const zgodnyAdmin = Boolean(konto.admin) === Boolean(preset.admin);
  return zgodneEkrany && zgodnyAdmin ? etykieta : `${etykieta} + zmiany`;
}

export function menuKontaDla(konto, { powrot = '/' } = {}) {
  if (!konto) return null;
  return {
    imie: String(konto.imie || konto.login || 'Użytkownik'),
    opisRoli: opisRoli(konto),
    motywAction: '/motyw',
    wylogujAction: '/wyloguj',
    powrot,
    pokazAdministracje: konto.admin === true && konto.serwisowe !== true,
  };
}
