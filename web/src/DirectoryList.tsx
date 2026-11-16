import { useEffect, useState, type ReactNode } from "react";

const normalize = (value: string) =>
  value.trim().toLocaleLowerCase("ru").replace(/ё/g, "е");
const pageSize = 5;

export function DirectoryList<T>({
  items,
  label,
  placeholder,
  emptyMessage,
  searchText,
  renderItem,
}: {
  items: T[];
  label: string;
  placeholder: string;
  emptyMessage: string;
  searchText: (item: T) => string;
  renderItem: (item: T) => ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  const filtered = items.filter((item) => {
    const text = normalize(searchText(item));
    return terms.every((term) => text.includes(term));
  });
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pages - 1);
  useEffect(() => {
    if (page !== currentPage) setPage(currentPage);
  }, [page, currentPage]);
  return (
    <>
      <label>
        {label}
        <input
          type="search"
          placeholder={placeholder}
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
        .map(renderItem)}
      {!filtered.length && <p>{emptyMessage}</p>}
      {pages > 1 && (
        <div className="actions" aria-label={`${label}: страницы`}>
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
    </>
  );
}
