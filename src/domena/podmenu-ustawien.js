const POZYCJE = [
  { klucz: 'konta', etykieta: 'Użytkownicy i uprawnienia', href: '/ustawienia/konta', tylkoAdmin: true },
  { klucz: 'zamowienia-i-wysylka', etykieta: 'Zamówienia i wysyłka', href: '/ustawienia/zamowienia-i-wysylka' },
  { klucz: 'integracje', etykieta: 'Integracje', href: '/ustawienia/integracje' },
  { klucz: 'wiadomosci-i-automatyzacje', etykieta: 'Wiadomości i automatyzacje', href: '/ustawienia/wiadomosci-i-automatyzacje' },
  { klucz: 'diagnostyka', etykieta: 'Diagnostyka', href: '/ustawienia/lacznosc' },
];

export function podmenuUstawien(sciezka = '/ustawienia', { admin = false } = {}) {
  const czysta = String(sciezka).split('?')[0];
  const aktywnyKlucz = czysta === '/ustawienia/paczka' || czysta === '/ustawienia/dostawa'
    ? 'zamowienia-i-wysylka'
    : czysta === '/ustawienia/formulka'
      ? 'wiadomosci-i-automatyzacje'
      : czysta.startsWith('/ustawienia/kanaly/') || czysta.startsWith('/ustawienia/integracje/')
        ? 'integracje'
        : czysta === '/ustawienia/konta' || czysta.startsWith('/ustawienia/konta/')
          ? 'konta'
          : POZYCJE.find((pozycja) => pozycja.href === czysta)?.klucz ?? null;
  return POZYCJE
    .filter((pozycja) => !pozycja.tylkoAdmin || admin)
    .map(({ tylkoAdmin: _tylkoAdmin, ...pozycja }) => ({ ...pozycja, aktywna: aktywnyKlucz === pozycja.klucz }));
}
