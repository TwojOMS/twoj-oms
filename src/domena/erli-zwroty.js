// Shop API Order.returns: indeks odnosi się do surowego items i liczy od zera.
const POWODY = new Map(Object.entries({
  resign: 'Kupujący zrezygnował z zakupu',
  mistake: 'Kupujący dokonał zakupu przez pomyłkę',
  itemsQuality: 'Przedmiot wadliwy lub uszkodzony',
  itemsDescription: 'Niezgodny z opisem',
  deliveryQuality: 'Towar uszkodzony podczas transportu',
  other: 'Inny powód',
  doesNotFit: 'Nie pasuje kupującemu',
  itemIsMissing: 'Brakuje elementu',
  notDeliveredOnTime: 'Niedostarczony na czas',
  itemDamaged: 'Przedmiot uszkodzony (paczka nieuszkodzona)',
  itemAndPackageDamaged: 'Przedmiot i paczka uszkodzone',
}));

/** Czysta projekcja zgłoszeń do karty; dane konta nigdy nie są częścią wyniku. */
export function zgloszeniaZwrotowErli(returns = [], pozycje = []) {
  return (returns ?? []).map(z => ({
    data: z.created ?? null,
    powod: POWODY.get(z.reason) ?? z.reason,
    komentarz: z.comment ?? null,
    pozycje: (z.items ?? []).map(p => ({
      nazwa: Number.isInteger(p.index) && p.index >= 0 ? pozycje[p.index]?.name ?? `pozycja nr ${p.index}` : `pozycja nr ${p.index}`,
      ilosc: p.quantity,
    })),
  }));
}
