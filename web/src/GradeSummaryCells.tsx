import type { GradeSummary } from "./types";

const averageFormat = new Intl.NumberFormat("ru", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function GradeSummaryCells({
  summary,
  pending,
}: {
  summary: GradeSummary | undefined;
  pending: boolean;
}) {
  const average = summary?.average;
  const hint = pending
    ? "Есть несохранённые оценки"
    : !summary || average == null
      ? "Нет данных"
      : summary.final_hint != null
        ? String(summary.final_hint)
        : "Не все обязательные работы сданы";

  return (
    <>
      <td className="grade-average">
        {!pending && average != null ? averageFormat.format(average) : "—"}
      </td>
      <td
        className="grade-final"
        title={
          !pending && summary && average != null
            ? `Обязательные работы: ${summary.required_passed} / ${summary.required_total}. Подсказка, не выставленная оценка.`
            : undefined
        }
      >
        {hint}
      </td>
    </>
  );
}
