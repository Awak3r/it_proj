import { useState } from "react";
import type { User } from "./types";

const normalize = (value: string) =>
  value.trim().toLocaleLowerCase("ru").replace(/ё/g, "е");
const pageSize = 25;

export function StudentDirectory({
  students,
  groupName,
  transfer,
}: {
  students: User[];
  groupName: (id: number | null) => string;
  transfer: (user: User) => void;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  const filtered = students.filter((user) => {
    const text = normalize(
      `${user.name} ${user.id} ${groupName(user.group_id)}`,
    );
    return terms.every((term) => text.includes(term));
  });
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pages - 1);
  return (
    <section className="panel">
      <div className="section-heading">
        <h2>Студенты</h2>
        <span>{students.length}</span>
      </div>
      <label>
        Поиск студентов
        <input
          type="search"
          placeholder="Фамилия, имя, группа или Telegram ID"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(0);
          }}
        />
      </label>
      <p className="footnote" role="status">
        Найдено: {filtered.length}
      </p>
      {filtered
        .slice(currentPage * pageSize, (currentPage + 1) * pageSize)
        .map((user) => (
          <div className="admin-row" key={user.id}>
            <span>
              {user.name || "Ожидает регистрации"}
              <small>
                {user.id} · {groupName(user.group_id)}
              </small>
            </span>
            <button className="link" onClick={() => transfer(user)}>
              Группа
            </button>
          </div>
        ))}
      {!filtered.length && <p>Студенты не найдены</p>}
      {pages > 1 && (
        <div className="actions" aria-label="Страницы студентов">
          <button
            className="secondary"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            Предыдущая
          </button>
          <span>
            Страница {currentPage + 1} из {pages}
          </span>
          <button
            className="secondary"
            disabled={currentPage + 1 === pages}
            onClick={() => setPage(currentPage + 1)}
          >
            Следующая
          </button>
        </div>
      )}
    </section>
  );
}
