import { useId, useState } from "react";
import type {
  GradeStatistics,
  GradeSummary,
  Lab,
  LabStatistics,
  User,
} from "./types";
import "./statistics.css";

const averageFormat = new Intl.NumberFormat("ru", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const averageText = (value: number | null | undefined) =>
  value != null && Number.isFinite(value)
    ? averageFormat.format(value)
    : "Нет данных";
const percentage = (count: number, total: number) =>
  total > 0 ? Math.min(100, Math.max(0, Math.round((count / total) * 100))) : 0;

export function GradeStatisticsPanel({
  statistics,
  labStatistics,
  labs,
  students,
  summaries,
  pending,
}: {
  statistics: GradeStatistics | undefined;
  labStatistics: LabStatistics[];
  labs: Lab[];
  students: User[];
  summaries: GradeSummary[];
  pending: boolean;
}) {
  const id = useId();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const summaryByStudent = new Map(summaries.map((s) => [s.student_id, s]));
  const statisticsByLab = new Map(labStatistics.map((s) => [s.lab_id, s]));
  const query = search.trim().toLocaleLowerCase("ru");
  const visibleStudents = students.filter((student) => {
    const summary = summaryByStudent.get(student.id);
    const debtor =
      !!summary && summary.required_passed < summary.required_total;
    const ready = summary?.final_hint != null;
    return (
      student.name.toLocaleLowerCase("ru").includes(query) &&
      (filter === "all" || (filter === "debtors" ? debtor : ready))
    );
  });
  const distribution = statistics?.distribution;
  const grades = ["2", "3", "4", "5"] as const;
  const actualTotal = distribution
    ? grades.reduce((total, grade) => total + distribution[grade], 0)
    : 0;

  return (
    <section
      className="grade-statistics"
      aria-label="Статистика ведомости"
      aria-busy={pending}
    >
      <h2>Статистика группы по предмету</h2>
      {pending ? (
        <p role="status">
          Есть несохранённые изменения. Статистика скрыта до сохранения оценок и
          обновления данных.
        </p>
      ) : (
        <>
          {!statistics && (
            <p role="status">
              Нет данных статистики для выбранной группы и предмета.
            </p>
          )}
          {statistics && (
            <>
              <dl className="statistics-cards">
                <div>
                  <dt>Средний балл группы</dt>
                  <dd>{averageText(statistics.average)}</dd>
                </div>
                <div>
                  <dt>Должники по обязательным</dt>
                  <dd>{statistics.debtors_count}</dd>
                </div>
                <div>
                  <dt>Готовы к итогу</dt>
                  <dd>{statistics.final_ready_count}</dd>
                </div>
                <div>
                  <dt>Студенты</dt>
                  <dd>{statistics.students_count}</dd>
                </div>
                <div>
                  <dt>Работы</dt>
                  <dd>
                    {statistics.labs_count}
                    <small>
                      Обязательных: {statistics.required_labs_count}
                    </small>
                  </dd>
                </div>
              </dl>
              <p>
                Средний группы — среднее индивидуальных взвешенных средних до
                округления. Обязательная работа без оценки учитывается за 2,
                необязательная без оценки не учитывается. Студенты без
                учитываемых оценок исключены из среднего группы.
              </p>
              {statistics.students_count === 0 && (
                <p>Нет студентов в выбранной группе.</p>
              )}
              {statistics.labs_count === 0 && (
                <p>Нет активных работ по выбранному предмету.</p>
              )}
              <section aria-labelledby={`${id}-distribution`}>
                <h3 id={`${id}-distribution`}>
                  Распределение выставленных оценок
                </h3>
                <p>Только реальные оценки. Пропуски не считаются двойками.</p>
                <ul
                  className="statistics-distribution"
                  aria-label="Распределение оценок"
                >
                  {grades.map((grade) => (
                    <li key={grade}>
                      <span>Оценка {grade}</span>
                      <div
                        className="statistics-track"
                        role="meter"
                        aria-label={`Оценка ${grade}`}
                        aria-valuemin={0}
                        aria-valuemax={Math.max(1, actualTotal)}
                        aria-valuenow={distribution![grade]}
                        aria-valuetext={`${distribution![grade]} из ${actualTotal} выставленных оценок`}
                      >
                        <span
                          style={{
                            width: `${percentage(distribution![grade], actualTotal)}%`,
                          }}
                        />
                      </div>
                      <strong>{distribution![grade]}</strong>
                    </li>
                  ))}
                </ul>
                <p className="statistics-missing">
                  Без оценки: <strong>{distribution!.missing}</strong> —
                  отдельно от выставленных оценок.
                </p>
              </section>
            </>
          )}
          <section aria-labelledby={`${id}-labs`}>
            <h3 id={`${id}-labs`}>Сдача работ</h3>
            <p>
              Сдано — оценка 3–5. Средний по работе — только по выставленным
              оценкам.
            </p>
            {labs.length === 0 ? (
              <p>Нет активных работ.</p>
            ) : (
              <ul className="statistics-labs">
                {labs.map((lab) => {
                  const stats = statisticsByLab.get(lab.id);
                  const percent = stats
                    ? percentage(stats.passed_count, stats.students_count)
                    : 0;
                  return (
                    <li key={lab.id}>
                      <h3>
                        ЛР {lab.number}: {lab.name}
                      </h3>
                      <p>
                        {lab.required ? "Обязательная" : "Необязательная"} ·
                        Вес: {lab.weight_text ?? lab.weight}
                      </p>
                      {stats ? (
                        <>
                          <div className="statistics-lab-result">
                            <span>
                              Сдано: {stats.passed_count} /{" "}
                              {stats.students_count} ({percent}%)
                            </span>
                            <span>Средний: {averageText(stats.average)}</span>
                          </div>
                          <div
                            className="statistics-track"
                            role="progressbar"
                            aria-label={`Сдано ЛР ${lab.number}: ${lab.name}`}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={percent}
                            aria-valuetext={`${stats.passed_count} из ${stats.students_count}, ${percent}%`}
                          >
                            <span style={{ width: `${percent}%` }} />
                          </div>
                          <p>
                            Выставлено: {stats.graded_count} · Без оценки:{" "}
                            {stats.missing_count} · Оценка 2:{" "}
                            {stats.failed_count}
                          </p>
                        </>
                      ) : (
                        <p>Нет данных по работе.</p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
          <section aria-labelledby={`${id}-students`}>
            <h3 id={`${id}-students`}>Прогресс студентов</h3>
            <p>
              Долг — только по обязательным работам. Подсказка итога не является
              выставленной оценкой.
            </p>
            <div className="statistics-filters">
              <label htmlFor={`${id}-search`}>
                Поиск студента
                <input
                  id={`${id}-search`}
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Имя студента"
                />
              </label>
              <label htmlFor={`${id}-filter`}>
                Показать студентов
                <select
                  id={`${id}-filter`}
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                >
                  <option value="all">Все</option>
                  <option value="debtors">Должники</option>
                  <option value="ready">Готовы к итогу</option>
                </select>
              </label>
            </div>
            <div
              className="statistics-table-scroll"
              role="region"
              aria-label="Таблица прогресса студентов"
              tabIndex={0}
            >
              <table>
                <caption>
                  Серверные расчёты по выбранной группе и предмету
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Студент</th>
                    <th scope="col">Обязательные сданы</th>
                    <th scope="col">Средний</th>
                    <th scope="col">Подсказка итога</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleStudents.map((student) => {
                    const summary = summaryByStudent.get(student.id);
                    return (
                      <tr key={student.id}>
                        <th scope="row">{student.name}</th>
                        <td>
                          {summary
                            ? `${summary.required_passed} / ${summary.required_total}`
                            : "Нет данных"}
                        </td>
                        <td>{averageText(summary?.average)}</td>
                        <td>
                          {!summary
                            ? "Нет данных"
                            : summary.final_hint != null
                              ? summary.final_hint
                              : summary.required_passed < summary.required_total
                                ? "Долг по обязательным"
                                : "Нет данных"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {visibleStudents.length === 0 && (
              <p role="status">
                {students.length === 0
                  ? "Нет студентов."
                  : "Студенты не найдены."}
              </p>
            )}
          </section>
        </>
      )}
    </section>
  );
}
