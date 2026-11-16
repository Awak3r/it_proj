import type { User } from "./types";
import { DirectoryList } from "./DirectoryList";

export function StudentDirectory({
  students,
  groupName,
  transfer,
}: {
  students: User[];
  groupName: (id: number | null) => string;
  transfer: (user: User) => void;
}) {
  return (
    <section className="panel">
      <div className="section-heading">
        <h2>Студенты</h2>
        <span>{students.length}</span>
      </div>
      <DirectoryList
        items={students}
        label="Поиск студентов"
        placeholder="Фамилия, имя, группа или Telegram ID"
        emptyMessage="Студенты не найдены"
        searchText={(user) =>
          `${user.name} ${user.id} ${groupName(user.group_id)}`
        }
        renderItem={(user) => (
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
        )}
      />
    </section>
  );
}
