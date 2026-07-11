/** ECharts renders `null` scatter values at the category baseline in some configurations. */
export function toScatterChartValue(value: number | undefined) {
  return value === undefined ? '-' : Number(value.toFixed(2));
}
