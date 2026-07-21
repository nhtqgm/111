export function mergeStockCodeLists(...lists: ReadonlyArray<ReadonlyArray<string>>) {
  return [
    ...new Set(
      lists
        .flat()
        .map((code) => code.replace(/\D/g, '').slice(0, 6))
        .filter((code) => code.length === 6),
    ),
  ].sort();
}
