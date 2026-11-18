// Zdania, ktore raport MUSI powiedziec o okresie siegajacym przed ere Apilo.
//
// ⚠️ TO NIE JEST OZDOBNIK. Raport za rok sprzed Apilo pokazuje tysiące zamówień — i bez tych zdań
// czyta się je jako „tyle sprzedaliśmy”. A to jest WYŁĄCZNIE jeden sklep: Allegro
// tamtych lat nie da sie odzyskac (REST API Allegro oddaje ostatnie 12 miesiecy), hurtu
// i telefonu nikt wtedy systemowo nie zapisywal.

export function zastrzezenia({ od, sufitApilo, nazwaSklepu = null, dataImportu = null, kontoNieustawione = false }) {
  if (kontoNieustawione) {
    return [
      'Nie ustawiono konta historii (OMS_RAPORTY_KONTO_HISTORII) — granica między historią a bieżącą sprzedażą jest nieznana.',
    ];
  }
  if (!sufitApilo) {
    return [
      'Nie wiadomo, gdzie przebiega granica między historią a bieżącą sprzedażą' +
        ' — tabela `sprzedaz_historyczna` nie ma ani jednego wiersza z Apilo dla sklepu.',
    ];
  }
  if (od >= sufitApilo) return [];
  return [
    `Sprzed ${sufitApilo} archiwum zna wyłącznie sprzedaż sklepu${nazwaSklepu ? ` ${nazwaSklepu}` : ''}.` +
      ' Allegro, hurt i zamówienia telefoniczne z tamtych lat nie istnieją w żadnym' +
      ' systemie, do którego mamy dostęp — te liczby to NIE jest cała sprzedaż firmy.',
    'W tym okresie nie liczymy nowych ani powracających klientów i nie znamy podziału' +
      ' faktura / paragon: historia sklepu została zaimportowana bez danych klienta' +
      (dataImportu ? ` (decyzja z ${dataImportu}).` : '.'),
  ];
}
