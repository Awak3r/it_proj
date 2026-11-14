import React, { useEffect, useState, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowUpRight,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  CalendarDays,
  Check,
  ChevronRight,
  Clock,
  GraduationCap,
  LayoutGrid,
  ListOrdered,
  LoaderCircle,
  LogOut,
  Plus,
  Settings2,
  ShieldCheck,
  Shuffle,
  Users,
  X,
  Bell,
  RefreshCw,
} from "lucide-react";
import { request, devUser } from "./api";
import { State, Event, Entry, Lab, strategies, statuses } from "./types";
import "./style.css";
type Cmd = Record<string, unknown>;
type Field = {
  name: string;
  label: string;
  type?: string;
  value?: string | number;
  options?: { value: string | number; label: string }[];
  required?: boolean;
};
type Modal = {
  title: string;
  description?: string;
  fields: Field[];
  submit: (values: Record<string, string>) => Promise<void>;
};
const date = (v: string) =>
  new Intl.DateTimeFormat("ru", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Moscow",
  }).format(new Date(v));
const active = (e: Entry) => ["waiting", "called"].includes(e.state);
function App() {
  const [data, setData] = useState<State>();
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [dev, setDev] = useState(false);
  const [role, setRole] = useState("");
  const [tab, setTab] = useState("events");
  const [eventID, setEventID] = useState<number>();
  const [modal, setModal] = useState<Modal>();
  const [filter, setFilter] = useState("active");
  const [subject, setSubject] = useState(0);
  const [group, setGroup] = useState(0);
  const [pending, setPending] = useState<
    Record<
      string,
      {
        value: string;
        error: string;
        user: number;
        lab: number;
        version: number;
        key: string;
      }
    >
  >({});
  const commandKeys = useRef(new Map<string, string>());
  const inflight = useRef(false);
  const gradeLocks = useRef(new Set<string>());
  async function refresh() {
    if (inflight.current) return;
    inflight.current = true;
    try {
      setData(await request<State>("state"));
      setConnectionError("");
    } catch (e) {
      setConnectionError((e as Error).message);
    } finally {
      inflight.current = false;
    }
  }
  useEffect(() => {
    window.Telegram?.WebApp.ready();
    window.Telegram?.WebApp.expand();
    request<{ dev_auth: boolean }>("config")
      .then((c) => {
        setDev(c.dev_auth);
        localStorage.setItem("dev-enabled", String(c.dev_auth));
        refresh();
      })
      .catch(() => setError("Сервер недоступен"));
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (notice) {
      const t = setTimeout(() => setNotice(""), 4000);
      return () => clearTimeout(t);
    }
  }, [notice]);
  async function command(c: Cmd) {
    const body = JSON.stringify(c);
    const key = commandKeys.current.get(body) || crypto.randomUUID();
    commandKeys.current.set(body, key);
    setBusy(true);
    try {
      await request("command", c, key);
      commandKeys.current.delete(body);
      await refresh();
    } finally {
      setBusy(false);
    }
  }
  async function action(c: Cmd, message = "Готово") {
    try {
      await command(c);
      setNotice(message);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const openForm = (
    title: string,
    fields: Field[],
    make: (v: Record<string, string>) => Cmd,
    description?: string,
  ) =>
    setModal({
      title,
      fields,
      description,
      submit: async (v) => {
        await command(make(v));
        setNotice("Сохранено");
      },
    });
  if (!data)
    return (
      <div className="boot">
        <div className="brand-mark">
          <ListOrdered />
        </div>
        <h1>
          LabTurn
          <ArrowUpRight size={22} />
        </h1>
        <p>{error || connectionError || "Подключаемся к вашей очереди…"}</p>
        {error && <button onClick={refresh}>Попробовать ещё раз</button>}
      </div>
    );
  const me = data.me;
  const teacher = me.teacher || me.root;
  const groups = data.groups.filter((g) => !g.archived);
  const subjects = data.subjects.filter((s) => !s.archived);
  const groupName = (id: number | null) =>
    data.groups.find((g) => g.id === id)?.name || "Без группы";
  const subjectName = (id: number) =>
    data.subjects.find((s) => s.id === id)?.name || "Предмет";
  const changeProfile = () =>
    openForm(
      "Ваш профиль",
      [
        {
          name: "name",
          label: "Имя и фамилия",
          value: me.name,
          required: true,
        },
        ...(!me.group_id
          ? [
              {
                name: "group",
                label: "Учебная группа",
                options: [
                  { value: 0, label: "Без группы (преподаватель)" },
                  ...groups.map((g) => ({ value: g.id, label: g.name })),
                ],
              },
            ]
          : []),
      ],
      (v) => ({
        kind: "profile",
        name: v.name,
        group_id: me.group_id || Number(v.group),
      }),
    );
  const roleScreen =
    !role ||
    (role === "teacher" && !teacher) ||
    !me.name ||
    (role === "student" && !me.group_id);
  function eventForm() {
    const available = me.root
      ? subjects
      : subjects.filter((s) =>
          data!.assignments.some((a) => a.subject_id === s.id),
        );
    openForm(
      "Новое событие",
      [
        { name: "name", label: "Название события", required: true },
        {
          name: "subject",
          label: "Предмет",
          options: available.map((s) => ({ value: s.id, label: s.name })),
        },
        {
          name: "groups",
          label: "Группы (можно выбрать несколько)",
          type: "multi",
          options: groups
            .filter(
              (g) =>
                me.root || data!.assignments.some((a) => a.group_id === g.id),
            )
            .map((g) => ({ value: g.id, label: g.name })),
          required: true,
        },
        {
          name: "starts",
          label: "Начало · московское время",
          type: "datetime-local",
          required: true,
        },
        { name: "room", label: "Аудитория" },
        {
          name: "duration",
          label: "Минут на одного студента (0 — неизвестно)",
          type: "number",
          value: 10,
        },
        {
          name: "strategy",
          label: "Порядок очереди",
          options: Object.entries(strategies).map(([value, label]) => ({
            value,
            label,
          })),
        },
        { name: "description", label: "Что нужно подготовить" },
      ],
      (v) => ({
        kind: "event_create",
        name: v.name,
        subject_id: Number(v.subject),
        group_ids: v.groups.split(",").map(Number),
        starts_at: new Date(v.starts + ":00+03:00").toISOString(),
        room: v.room,
        duration: Number(v.duration),
        strategy: v.strategy,
        description: v.description,
      }),
    );
  }
  function labForm(l?: Lab) {
    openForm(
      l ? "Редактировать работу" : "Новая лабораторная",
      [
        {
          name: "number",
          label: "Номер",
          type: "number",
          value:
            l?.number ||
            data!.labs.filter(
              (l) =>
                l.subject_id === currentSubject &&
                l.group_id === currentGroup &&
                !l.archived,
            ).length + 1,
          required: true,
        },
        { name: "name", label: "Название", value: l?.name, required: true },
        ...(l
          ? [
              {
                name: "archive",
                label: "Статус",
                value: String(l.archived),
                options: [
                  { value: "false", label: "Действующая" },
                  { value: "true", label: "В архиве" },
                ],
              },
            ]
          : []),
      ],
      (v) => ({
        kind: "lab",
        id: l?.id || 0,
        subject_id: currentSubject,
        group_id: currentGroup,
        number: Number(v.number),
        name: v.name,
        enabled: v.archive === "true",
      }),
    );
  }
  async function saveGrade(
    user: number,
    lab: number,
    value: string,
    version: number,
    retryKey?: string,
  ) {
    const cell = user + "-" + lab;
    if (gradeLocks.current.has(cell)) return;
    gradeLocks.current.add(cell);
    const key = retryKey || crypto.randomUUID();
    setPending((p) => ({
      ...p,
      [cell]: { value, error: "", user, lab, version, key },
    }));
    try {
      await request(
        "command",
        {
          kind: "grade",
          user_id: user,
          lab_id: lab,
          value: value === "" ? null : Number(value),
          version,
        },
        key,
      );
      setPending((p) => {
        const n = { ...p };
        delete n[cell];
        return n;
      });
      await refresh();
    } catch (e) {
      setPending((p) => ({
        ...p,
        [cell]: { value, error: (e as Error).message, user, lab, version, key },
      }));
    } finally {
      gradeLocks.current.delete(cell);
    }
  }
  const accessibleGroups = groups.filter(
    (g) =>
      me.root ||
      g.id === me.group_id ||
      data.assignments.some((a) => a.group_id === g.id),
  );
  const currentGroup = group || me.group_id || accessibleGroups[0]?.id || 0;
  const currentSubject = subject || subjects[0]?.id || 0;
  const canGrade =
    !!me.root ||
    (me.teacher &&
      data.assignments.some(
        (a) => a.subject_id === currentSubject && a.group_id === currentGroup,
      ));
  const mine = data.entries.filter((e) => e.user_id === me.id && active(e));
  const selected = data.events.find((e) => e.id === eventID);
  const board = (ev: Event) =>
    data.entries
      .filter((e) => e.event_id === ev.id && active(e))
      .sort(
        (a, b) =>
          (a.state === "called" ? -1 : b.state === "called" ? 1 : 0) ||
          a.position - b.position ||
          a.id - b.id,
      );
  const name = me.name.split(" ")[0] || "друг";
  const devPicker = dev && (
    <div className="devbar">
      <span>Режим разработки</span>
      <select
        aria-label="Тестовый пользователь"
        value={devUser()}
        onChange={(e) => {
          localStorage.setItem("dev-user", e.target.value);
          location.reload();
        }}
      >
        <option value="1001">Root · 1001</option>
        <option value="2001">Преподаватель · 2001</option>
        <option value="3001">Студент · 3001</option>
        <option value="3002">Студент · 3002</option>
        <option value="3003">Студент · 3003</option>
      </select>
    </div>
  );
  return (
    <>
      {devPicker}
      {roleScreen ? (
        <main className="welcome">
          <a className="brand">
            <div className="brand-mark">
              <ListOrdered size={23} />
            </div>
            LabTurn
            <ArrowUpRight size={22} />
          </a>
          <div className="welcome-copy">
            <span className="eyebrow">ТВОЯ ОЧЕРЕДЬ СДАВАТЬ</span>
            <h1>
              Меньше ожидания.
              <br />
              <em>Больше ясности.</em>
            </h1>
            <p>
              Записывайтесь LabTurn, следите за очередью
              <br />и держите все результаты под рукой.
            </p>
          </div>
          <section className="welcome-panel">
            <h2>{!role ? "Как вы входите?" : "Давайте познакомимся"}</h2>
            <p>
              {!role
                ? "Выберите, что будете делать сегодня."
                : "Имя будет видно в очереди и ведомости."}
            </p>
            {!role ? (
              <>
                <button
                  className="role-card"
                  onClick={() => setRole("student")}
                >
                  <GraduationCap />
                  <span>
                    <b>Я студент</b>
                    <small>Очереди и результаты</small>
                  </span>
                  <ArrowRight />
                </button>
                <button
                  className="role-card"
                  onClick={() => setRole("teacher")}
                >
                  <BookOpen />
                  <span>
                    <b>Я преподаватель</b>
                    <small>Приём работ и ведомость</small>
                  </span>
                  <ArrowRight />
                </button>
                {me.root && (
                  <button className="link" onClick={() => setRole("root")}>
                    Управление root →
                  </button>
                )}
              </>
            ) : role === "teacher" && !teacher ? (
              <>
                <div className="info">
                  Роль преподавателя выдаёт root. Сообщите ему свой Telegram ID:{" "}
                  <b>{me.id}</b>.
                </div>
                <button onClick={() => setRole("")}>Назад</button>
              </>
            ) : (
              <Profile
                me={me}
                groups={groups}
                role={role}
                save={async (name, group_id) => {
                  await command({ kind: "profile", name, group_id });
                }}
                back={() => setRole("")}
              />
            )}
          </section>
          <footer>Ваша очередь — под контролем.</footer>
        </main>
      ) : (
        <div className="shell">
          <aside className="sidebar">
            <a
              className="brand"
              onClick={() => {
                setTab("events");
                setEventID(undefined);
              }}
            >
              <div className="brand-mark">
                <ListOrdered size={22} />
              </div>
              LabTurn
              <ArrowUpRight size={22} />
            </a>
            <div className="workspace">
              <div className="workspace-icon">
                <GraduationCap size={20} />
              </div>
              <div>
                <b>Учебное пространство</b>
                <small>
                  {role === "student"
                    ? groupName(me.group_id)
                    : me.root
                      ? "Администратор"
                      : "Преподаватель"}
                </small>
              </div>
            </div>
            <small className="nav-caption">ВАШЕ ПРОСТРАНСТВО</small>
            <nav>
              {[
                { id: "events", label: "События", icon: LayoutGrid },
                { id: "mine", label: "Мои очереди", icon: ListOrdered },
                { id: "grades", label: "Ведомость", icon: BookOpen },
                ...(teacher
                  ? [
                      {
                        id: "teaching",
                        label: "Мой кабинет",
                        icon: GraduationCap,
                      },
                    ]
                  : []),
                ...(me.root
                  ? [{ id: "admin", label: "Управление", icon: Settings2 }]
                  : []),
              ].map((n) => (
                <button
                  key={n.id}
                  className={tab === n.id ? "nav-active" : ""}
                  onClick={() => {
                    setTab(n.id);
                    setEventID(undefined);
                  }}
                >
                  <n.icon size={19} />
                  {n.label}
                  {n.id === "mine" && mine.length > 0 && (
                    <span className="count">{mine.length}</span>
                  )}
                </button>
              ))}
            </nav>
            <div className="sidebar-note">
              <span className="live-dot" />
              <b>Всё по порядку</b>
              <p>Очереди обновляются автоматически каждые 3 секунды.</p>
            </div>
            <button className="profile" onClick={changeProfile}>
              <div className="avatar">{me.name.slice(0, 1)}</div>
              <span>
                <b>{me.name}</b>
                <small>
                  {me.root
                    ? "Root"
                    : role === "teacher"
                      ? "Преподаватель"
                      : "Студент"}
                </small>
              </span>
              <Settings2 size={16} />
            </button>
            <button className="switch-role" onClick={() => setRole("")}>
              <LogOut size={14} /> Сменить режим
            </button>
          </aside>
          <main className="main">
            <header className="topbar">
              <span>
                Учёба <ChevronRight size={14} />{" "}
                {selected
                  ? "Событие"
                  : {
                      events: "События",
                      mine: "Мои очереди",
                      grades: "Ведомость",
                      teaching: "Кабинет",
                      admin: "Управление",
                    }[tab]}
              </span>
              <span>
                <span className="live-dot" /> Онлайн{" "}
                <button className="mobile-role" onClick={() => setRole("")}>
                  Сменить роль
                </button>
                <span className="top-date">
                  {new Intl.DateTimeFormat("ru", {
                    day: "numeric",
                    month: "long",
                    timeZone: "Europe/Moscow",
                  }).format(new Date())}
                </span>
              </span>
            </header>
            <div className="content">
              {(error || connectionError) && (
                <div role="alert" className="alert">
                  {error || connectionError}
                  <button
                    onClick={() => {
                      setError("");
                      refresh();
                    }}
                  >
                    <RefreshCw size={16} />
                  </button>
                </div>
              )}
              {selected ? (
                <>
                  <button
                    className="back"
                    onClick={() => setEventID(undefined)}
                  >
                    <ArrowLeft size={16} /> К событиям
                  </button>
                  <div className="page-title">
                    <div>
                      <span className="eyebrow">
                        {subjectName(selected.subject_id)}
                      </span>
                      <h1>{selected.name}</h1>
                      <p>
                        {date(selected.starts_at)} МСК ·{" "}
                        {selected.room
                          ? "ауд. " + selected.room
                          : "Аудитория не указана"}{" "}
                        · {selected.teacher_name || "Преподаватель"}
                      </p>
                    </div>
                    <span className={"badge " + selected.state}>
                      {statuses[selected.state]}
                    </span>
                  </div>
                  {selected.description && (
                    <p className="description">{selected.description}</p>
                  )}
                  <EventView
                    ev={selected}
                    entries={board(selected)}
                    history={data.entries.filter(
                      (e) => e.event_id === selected.id && !active(e),
                    )}
                    me={me}
                    subjectName={subjectName(selected.subject_id)}
                    owner={
                      !!me.root || (me.teacher && selected.teacher_id === me.id)
                    }
                    busy={busy}
                    pending={Object.keys(pending).length > 0}
                    action={action}
                    openForm={openForm}
                    grades={() => {
                      setGroup(selected.group_ids[0]);
                      setSubject(selected.subject_id);
                      setEventID(undefined);
                      setTab("grades");
                    }}
                  />
                </>
              ) : ["events", "mine", "teaching"].includes(tab) ? (
                <>
                  <div className="page-title">
                    <div>
                      <span className="eyebrow">
                        {tab === "mine"
                          ? "ВАШЕ ВРЕМЯ ПОД КОНТРОЛЕМ"
                          : tab === "teaching"
                            ? "ПРОСТРАНСТВО ПРЕПОДАВАТЕЛЯ"
                            : "УЧЕБНОЕ ПРОСТРАНСТВО"}
                      </span>
                      <h1>
                        {tab === "events"
                          ? `Привет, ${name}`
                          : tab === "mine"
                            ? "Мои очереди"
                            : "Мой кабинет"}
                        <span className="title-dot">.</span>
                      </h1>
                      <p>
                        {tab === "events"
                          ? "Хороший день, чтобы сдать ещё одну лабораторную."
                          : tab === "mine"
                            ? "Все ваши активные записи в одном месте."
                            : "Создавайте события и принимайте работы в удобном темпе."}
                      </p>
                    </div>
                    {teacher && (
                      <button onClick={eventForm}>
                        <Plus size={18} /> Создать событие
                      </button>
                    )}
                  </div>
                  {tab === "events" && (
                    <>
                      <section className="hero">
                        <div>
                          <span className="hero-tag">
                            <span className="live-dot" /> ВАША УЧЁБА, ВАШ ТЕМП
                          </span>
                          <h2>
                            Сдавайте работы.
                            <br />
                            Не тратьте время в очереди.
                          </h2>
                          <p>
                            Запишитесь на событие — мы подскажем,
                            <br />
                            когда будет ваш выход.
                          </p>
                          <button
                            className="hero-button"
                            onClick={() => setTab("mine")}
                          >
                            Мои очереди <ArrowUpRight size={18} />
                          </button>
                        </div>
                        <div className="queue-art" aria-hidden="true">
                          <span className="orbit orbit-one" />
                          <span className="orbit orbit-two" />
                          <div className="art-ticket">
                            <span>ВАША ОЧЕРЕДЬ</span>
                            <strong>
                              {mine.length
                                ? String(
                                    board(
                                      data.events.find(
                                        (ev) => ev.id === mine[0].event_id,
                                      )!,
                                    ).findIndex((e) => e.id === mine[0].id) + 1,
                                  ).padStart(2, "0")
                                : "↗"}
                            </strong>
                            <div>
                              <span className="live-dot" /> Всё идёт по плану
                            </div>
                          </div>
                          <div className="art-label">
                            <Check size={16} /> Ещё на шаг ближе
                          </div>
                          <span className="spark">✳</span>
                        </div>
                      </section>
                      <div className="stats">
                        <div>
                          <div className="stat-icon">
                            <CalendarDays />
                          </div>
                          <span>
                            <b>
                              {
                                data.events.filter((e) =>
                                  ["planned", "live"].includes(e.state),
                                ).length
                              }
                            </b>
                            <small>Доступных событий</small>
                          </span>
                        </div>
                        <div>
                          <div className="stat-icon mint">
                            <ListOrdered />
                          </div>
                          <span>
                            <b>{mine.length.toString().padStart(2, "0")}</b>
                            <small>Активных очередей</small>
                          </span>
                        </div>
                        <div>
                          <div className="stat-icon sand">
                            <Check />
                          </div>
                          <span>
                            <b>
                              {data.grades
                                .filter(
                                  (g) =>
                                    g.student_id === me.id &&
                                    (g.value || 0) >= 3 &&
                                    data.labs.some(
                                      (l) =>
                                        l.id === g.lab_id &&
                                        !l.archived &&
                                        l.group_id === me.group_id,
                                    ),
                                )
                                .length.toString()
                                .padStart(2, "0")}
                            </b>
                            <small>Сданных работ</small>
                          </span>
                        </div>
                      </div>
                    </>
                  )}
                  <div className="section-heading">
                    <h2>
                      {tab === "mine"
                        ? "Вы записаны"
                        : tab === "teaching"
                          ? "Мои события"
                          : "Ближайшие события"}{" "}
                      <span>
                        {
                          data.events.filter((e) =>
                            tab === "mine"
                              ? mine.some((q) => q.event_id === e.id)
                              : tab === "teaching"
                                ? e.teacher_id === me.id
                                : true,
                          ).length
                        }
                      </span>
                    </h2>
                    {tab !== "mine" && (
                      <div className="segments">
                        <button
                          className={filter === "active" ? "selected" : ""}
                          onClick={() => setFilter("active")}
                        >
                          Предстоящие
                        </button>
                        <button
                          className={filter === "all" ? "selected" : ""}
                          onClick={() => setFilter("all")}
                        >
                          Все события
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="event-grid">
                    {data.events
                      .filter(
                        (e) =>
                          (tab === "mine"
                            ? mine.some((q) => q.event_id === e.id)
                            : tab === "teaching"
                              ? e.teacher_id === me.id
                              : true) &&
                          (tab === "mine" ||
                            filter === "all" ||
                            ["planned", "live"].includes(e.state)),
                      )
                      .sort(
                        (a, b) =>
                          Date.parse(a.starts_at) - Date.parse(b.starts_at),
                      )
                      .map((ev, i) => (
                        <button
                          className="event-card"
                          key={ev.id}
                          onClick={() => setEventID(ev.id)}
                        >
                          <div className="card-top">
                            <div className={"subject-icon color-" + (i % 3)}>
                              <BookOpen size={22} />
                            </div>
                            <span className={"badge " + ev.state}>
                              {statuses[ev.state]}
                            </span>
                          </div>
                          <span className="card-subject">
                            {subjectName(ev.subject_id)}
                          </span>
                          <h3>{ev.name}</h3>
                          <p className="card-teacher">
                            {ev.teacher_name || "Преподаватель"} ·{" "}
                            {ev.group_ids.map(groupName).join(", ")}
                          </p>
                          <div className="card-meta">
                            <span>
                              <CalendarDays size={16} />
                              {date(ev.starts_at)} МСК
                            </span>
                            <span>
                              <Users size={16} />
                              {board(ev).length} в очереди{" "}
                              {ev.room && "· ауд. " + ev.room}
                            </span>
                          </div>
                          <div className="card-bottom">
                            <span>
                              {mine.some((q) => q.event_id === ev.id)
                                ? "✓ Вы записаны"
                                : ev.registration_open
                                  ? "Запись открыта"
                                  : "Запись закрыта"}
                            </span>
                            <ArrowUpRight size={20} />
                          </div>
                        </button>
                      ))}
                  </div>
                  {!data.events.some(
                    (e) =>
                      (tab === "mine"
                        ? mine.some((q) => q.event_id === e.id)
                        : tab === "teaching"
                          ? e.teacher_id === me.id
                          : true) &&
                      (tab === "mine" ||
                        filter === "all" ||
                        ["planned", "live"].includes(e.state)),
                  ) && (
                    <Empty
                      title={
                        tab === "mine"
                          ? "Вы пока не записаны"
                          : "Событий пока нет"
                      }
                      text={
                        tab === "mine"
                          ? "Выберите подходящее событие и займите место в очереди."
                          : "Новые события появятся здесь после создания преподавателем."
                      }
                    />
                  )}
                </>
              ) : tab === "grades" ? (
                <>
                  <div className="page-title">
                    <div>
                      <span className="eyebrow">
                        КАЖДАЯ РАБОТА — ШАГ ВПЕРЁД
                      </span>
                      <h1>
                        Ведомость<span className="title-dot">.</span>
                      </h1>
                      <p>Одна таблица. Все работы и результаты.</p>
                    </div>
                    {canGrade && (
                      <button
                        disabled={!currentGroup || !currentSubject}
                        onClick={() => labForm()}
                      >
                        <Plus size={18} /> Добавить работу
                      </button>
                    )}
                  </div>
                  <div className="filters">
                    <label>
                      Группа
                      <select
                        value={currentGroup}
                        onChange={(e) => setGroup(Number(e.target.value))}
                      >
                        {groups
                          .filter(
                            (g) =>
                              me.root ||
                              g.id === me.group_id ||
                              data.assignments.some((a) => a.group_id === g.id),
                          )
                          .map((g) => (
                            <option key={g.id} value={g.id}>
                              {g.name}
                            </option>
                          ))}
                      </select>
                    </label>
                    <label>
                      Предмет
                      <select
                        value={currentSubject}
                        onChange={(e) => setSubject(Number(e.target.value))}
                      >
                        {subjects.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <span className="save-hint">
                      {Object.keys(pending).length
                        ? "Есть несохранённые изменения"
                        : "Изменения сохраняются автоматически"}
                    </span>
                  </div>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Студент</th>
                          {data.labs
                            .filter(
                              (l) =>
                                l.group_id === currentGroup &&
                                l.subject_id === currentSubject &&
                                !l.archived,
                            )
                            .map((l) => (
                              <th key={l.id}>
                                <button
                                  className="lab-heading"
                                  title={l.name}
                                  disabled={!canGrade}
                                  onClick={() => labForm(l)}
                                >
                                  ЛР {l.number}
                                  <small>{l.name}</small>
                                </button>
                              </th>
                            ))}
                          <th>Прогресс</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.users
                          .filter((u) => u.group_id === currentGroup)
                          .map((u) => {
                            const labs = data.labs.filter(
                              (l) =>
                                l.group_id === currentGroup &&
                                l.subject_id === currentSubject &&
                                !l.archived,
                            );
                            const done = labs.filter((l) =>
                              data.grades.some(
                                (g) =>
                                  g.student_id === u.id &&
                                  g.lab_id === l.id &&
                                  (g.value || 0) >= 3,
                              ),
                            ).length;
                            return (
                              <tr key={u.id}>
                                <td>
                                  <div className="student-name">
                                    <span className="avatar small">
                                      {u.name.slice(0, 1) || "?"}
                                    </span>
                                    {u.name || "Без имени"}
                                    {u.id === me.id && <small>вы</small>}
                                  </div>
                                </td>
                                {labs.map((l) => {
                                  const grade = data.grades.find(
                                    (g) =>
                                      g.student_id === u.id &&
                                      g.lab_id === l.id,
                                  );
                                  const p = pending[u.id + "-" + l.id];
                                  return (
                                    <td key={l.id}>
                                      {canGrade ? (
                                        <select
                                          aria-label={`${u.name}, ЛР ${l.number}`}
                                          className={
                                            "grade grade-" +
                                            (p?.value ??
                                              grade?.value ??
                                              "empty")
                                          }
                                          disabled={!!p}
                                          value={p?.value ?? grade?.value ?? ""}
                                          onChange={(e) =>
                                            saveGrade(
                                              u.id,
                                              l.id,
                                              e.target.value,
                                              grade?.version || 0,
                                            )
                                          }
                                        >
                                          {["", 2, 3, 4, 5].map((v) => (
                                            <option key={v} value={v}>
                                              {v === "" ? "—" : v}
                                            </option>
                                          ))}
                                        </select>
                                      ) : (
                                        <span
                                          className={
                                            "grade grade-" +
                                            (grade?.value ?? "empty")
                                          }
                                        >
                                          {grade?.value ?? "—"}
                                        </span>
                                      )}
                                    </td>
                                  );
                                })}
                                <td>
                                  <div className="progress-label">
                                    {done} / {labs.length}
                                    <small>осталось {labs.length - done}</small>
                                  </div>
                                  <div className="progress">
                                    <span
                                      style={{
                                        width: `${labs.length ? (done / labs.length) * 100 : 0}%`,
                                      }}
                                    />
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                      </tbody>
                    </table>
                  </div>
                  {Object.entries(pending).map(([cell, p]) => (
                    <div key={cell} className={p.error ? "alert" : "info"}>
                      {p.error || "Сохраняем оценку…"}
                      {p.error && (
                        <>
                          <button
                            onClick={() =>
                              saveGrade(
                                p.user,
                                p.lab,
                                p.value,
                                p.version,
                                p.key,
                              )
                            }
                          >
                            Повторить
                          </button>
                          <button
                            className="secondary"
                            onClick={() => {
                              setPending((n) => {
                                const v = { ...n };
                                delete v[cell];
                                return v;
                              });
                              refresh();
                            }}
                          >
                            Отменить правку
                          </button>
                        </>
                      )}
                    </div>
                  ))}
                  {!data.labs.some(
                    (l) =>
                      l.group_id === currentGroup &&
                      l.subject_id === currentSubject &&
                      !l.archived,
                  ) && (
                    <Empty
                      title="Здесь будут лабораторные"
                      text={
                        canGrade
                          ? "Добавьте первую работу, чтобы начать заполнять ведомость."
                          : "Преподаватель ещё не добавил работы."
                      }
                    />
                  )}
                  <p className="footnote">
                    2 — не сдано · 3, 4, 5 — сдано · Пустая ячейка — оценки ещё
                    нет
                  </p>
                </>
              ) : tab === "admin" && me.root ? (
                <>
                  <div className="page-title">
                    <div>
                      <span className="eyebrow">ROOT</span>
                      <h1>
                        Управление<span className="title-dot">.</span>
                      </h1>
                      <p>Группы, предметы и доступ преподавателей.</p>
                    </div>
                    <ShieldCheck size={36} />
                  </div>
                  <div className="admin-grid">
                    {(["group", "subject"] as const).map((kind) => (
                      <section className="panel" key={kind}>
                        <div className="section-heading">
                          <h2>{kind === "group" ? "Группы" : "Предметы"}</h2>
                          <button
                            className="icon-button"
                            aria-label={
                              kind === "group"
                                ? "Добавить группу"
                                : "Добавить предмет"
                            }
                            onClick={() =>
                              openForm(
                                kind === "group"
                                  ? "Новая группа"
                                  : "Новый предмет",
                                [
                                  {
                                    name: "name",
                                    label: "Название",
                                    required: true,
                                  },
                                ],
                                (v) => ({ kind, name: v.name }),
                              )
                            }
                          >
                            <Plus size={18} />
                          </button>
                        </div>
                        {(kind === "group" ? data.groups : data.subjects).map(
                          (v) => (
                            <button
                              className="admin-row"
                              key={v.id}
                              onClick={() =>
                                openForm(
                                  "Редактирование",
                                  [
                                    {
                                      name: "name",
                                      label: "Название",
                                      value: v.name,
                                      required: true,
                                    },
                                    {
                                      name: "archive",
                                      label: "Статус",
                                      value: String(v.archived),
                                      options: [
                                        { value: "false", label: "Действует" },
                                        { value: "true", label: "В архиве" },
                                      ],
                                    },
                                  ],
                                  (x) => ({
                                    kind,
                                    id: v.id,
                                    name: x.name,
                                    enabled: x.archive === "true",
                                  }),
                                )
                              }
                            >
                              <span>
                                {v.name}
                                <small>
                                  #{v.id}
                                  {v.archived ? " · архив" : ""}
                                </small>
                              </span>
                              <ChevronRight size={16} />
                            </button>
                          ),
                        )}
                      </section>
                    ))}
                    <section className="panel">
                      <div className="section-heading">
                        <h2>Пользователи</h2>
                        <button
                          className="icon-button"
                          aria-label="Выдать роль"
                          onClick={() =>
                            openForm(
                              "Роль преподавателя",
                              [
                                {
                                  name: "user",
                                  label: "Telegram ID",
                                  type: "number",
                                  required: true,
                                },
                                {
                                  name: "enabled",
                                  label: "Доступ",
                                  options: [
                                    { value: "true", label: "Выдать" },
                                    { value: "false", label: "Отозвать" },
                                  ],
                                },
                              ],
                              (v) => ({
                                kind: "role",
                                user_id: Number(v.user),
                                enabled: v.enabled === "true",
                              }),
                            )
                          }
                        >
                          <Plus size={18} />
                        </button>
                      </div>
                      {data.users.map((u) => (
                        <div className="admin-row" key={u.id}>
                          <span>
                            {u.name || "Ожидает регистрации"}
                            <small>
                              {u.id} ·{" "}
                              {u.teacher
                                ? "Преподаватель"
                                : groupName(u.group_id)}
                            </small>
                          </span>
                          <button
                            className="link"
                            onClick={() =>
                              openForm(
                                "Перевод в другую группу",
                                [
                                  {
                                    name: "group",
                                    label: "Новая группа",
                                    options: groups.map((g) => ({
                                      value: g.id,
                                      label: g.name,
                                    })),
                                  },
                                ],
                                (v) => ({
                                  kind: "transfer",
                                  user_id: u.id,
                                  group_id: Number(v.group),
                                }),
                                "Старые оценки сохраняются в прежней ведомости. Активные записи нужно закрыть заранее.",
                              )
                            }
                          >
                            Группа
                          </button>
                        </div>
                      ))}
                    </section>
                    <section className="panel">
                      <div className="section-heading">
                        <h2>Назначения</h2>
                        <button
                          className="icon-button"
                          aria-label="Добавить назначение"
                          onClick={() =>
                            openForm(
                              "Назначить преподавателя",
                              [
                                {
                                  name: "teacher",
                                  label: "Преподаватель",
                                  options: data.users
                                    .filter((u) => u.teacher)
                                    .map((u) => ({
                                      value: u.id,
                                      label: u.name || String(u.id),
                                    })),
                                },
                                {
                                  name: "subject",
                                  label: "Предмет",
                                  options: subjects.map((s) => ({
                                    value: s.id,
                                    label: s.name,
                                  })),
                                },
                                {
                                  name: "group",
                                  label: "Группа",
                                  options: groups.map((g) => ({
                                    value: g.id,
                                    label: g.name,
                                  })),
                                },
                              ],
                              (v) => ({
                                kind: "assignment",
                                teacher_id: Number(v.teacher),
                                subject_id: Number(v.subject),
                                group_id: Number(v.group),
                                enabled: true,
                              }),
                            )
                          }
                        >
                          <Plus size={18} />
                        </button>
                      </div>
                      {data.assignments.map((a) => (
                        <div
                          className="admin-row"
                          key={`${a.teacher_id}-${a.subject_id}-${a.group_id}`}
                        >
                          <span>
                            {data.users.find((u) => u.id === a.teacher_id)
                              ?.name || a.teacher_id}
                            <small>
                              {subjectName(a.subject_id)} ·{" "}
                              {groupName(a.group_id)}
                            </small>
                          </span>
                          <button
                            className="icon-button danger"
                            aria-label="Отозвать назначение"
                            onClick={() => {
                              if (confirm("Отозвать назначение?"))
                                action({
                                  kind: "assignment",
                                  ...a,
                                  enabled: false,
                                });
                            }}
                          >
                            <X size={16} />
                          </button>
                        </div>
                      ))}
                    </section>
                  </div>
                  <section className="panel audit">
                    <h2>Последние изменения</h2>
                    {data.audit.slice(0, 20).map((a) => (
                      <div className="admin-row" key={a.id}>
                        <span>
                          {a.action}
                          <small>Пользователь {a.actor_id}</small>
                        </span>
                        <small>{date(a.at)}</small>
                      </div>
                    ))}
                  </section>
                </>
              ) : null}
            </div>
            <footer className="main-footer">
              LabTurn <span>Меньше суеты. Больше сданных работ.</span>
              <small>Время — московское</small>
            </footer>
          </main>
        </div>
      )}
      {notice && (
        <div role="status" className="toast">
          <Check size={18} />
          {notice}
        </div>
      )}
      {modal && <FormModal modal={modal} close={() => setModal(undefined)} />}
      {busy && (
        <div className="busy">
          <LoaderCircle className="spin" size={16} /> Сохраняем…
        </div>
      )}
    </>
  );
}
function Profile({
  me,
  groups,
  role,
  save,
  back,
}: {
  me: State["me"];
  groups: State["groups"];
  role: string;
  save: (n: string, g: number) => Promise<void>;
  back: () => void;
}) {
  const [n, setN] = useState(me.name);
  const [g, setG] = useState(me.group_id || 0);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await save(n, g);
        } catch (e) {
          setErr((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label>
        Имя и фамилия
        <input
          value={n}
          onChange={(e) => setN(e.target.value)}
          required
          maxLength={200}
        />
      </label>
      {role === "student" && (
        <label>
          Ваша группа
          <select
            value={g}
            disabled={!!me.group_id}
            onChange={(e) => setG(Number(e.target.value))}
            required
          >
            <option value="">Выберите группу</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {err && <div className="alert">{err}</div>}
      <button disabled={busy || !n.trim() || (role === "student" && !g)}>
        Продолжить <ArrowRight size={18} />
      </button>
      <button type="button" className="link" onClick={back}>
        Назад
      </button>
    </form>
  );
}
function FormModal({ modal, close }: { modal: Modal; close: () => void }) {
  const [v, setV] = useState<Record<string, string>>(
    Object.fromEntries(
      modal.fields.map((f) => [
        f.name,
        String(f.value ?? f.options?.[0]?.value ?? ""),
      ]),
    ),
  );
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) close();
      }}
    >
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={modal.title}
      >
        <div className="section-heading">
          <h2>{modal.title}</h2>
          <button disabled={busy} className="icon-button" onClick={close}>
            <X size={20} />
          </button>
        </div>
        {modal.description && <p>{modal.description}</p>}
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setErr("");
            try {
              await modal.submit(v);
              close();
            } catch (e) {
              setErr((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {modal.fields.map((f) => (
            <label key={f.name}>
              {f.label}
              {f.options ? (
                <select
                  multiple={f.type === "multi"}
                  value={f.type === "multi" ? v[f.name].split(",") : v[f.name]}
                  onChange={(e) =>
                    setV({
                      ...v,
                      [f.name]:
                        f.type === "multi"
                          ? Array.from(e.target.selectedOptions)
                              .map((o) => o.value)
                              .join(",")
                          : e.target.value,
                    })
                  }
                  required
                >
                  {f.options.map((o) => (
                    <option value={o.value} key={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type={f.type || "text"}
                  value={v[f.name]}
                  onChange={(e) => setV({ ...v, [f.name]: e.target.value })}
                  required={f.required}
                />
              )}
            </label>
          ))}
          {err && (
            <div role="alert" className="alert">
              {err}
            </div>
          )}
          <button disabled={busy}>
            {busy ? "Сохраняем…" : "Сохранить"}
            <Check size={16} />
          </button>
        </form>
      </section>
    </div>
  );
}
function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="empty">
      <ListOrdered size={28} />
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}
function EventView({
  ev,
  entries,
  history,
  me,
  owner,
  busy,
  pending,
  action,
  openForm,
  grades,
}: {
  ev: Event;
  entries: Entry[];
  history: Entry[];
  me: State["me"];
  subjectName: string;
  owner: boolean;
  busy: boolean;
  pending: boolean;
  action: (c: Cmd, m?: string) => Promise<void>;
  openForm: (
    title: string,
    fields: Field[],
    make: (v: Record<string, string>) => Cmd,
    description?: string,
  ) => void;
  grades: () => void;
}) {
  const current = entries.find((e) => e.state === "called");
  const my = entries.find((e) => e.user_id === me.id);
  const closed = ["completed", "cancelled"].includes(ev.state);
  const unshuffled = ev.strategy === "random" && !ev.shuffled;
  const position = my ? entries.findIndex((e) => e.id === my.id) + 1 : 0;
  const average = ev.average_minutes || ev.duration;
  let wait = average ? Math.max(0, position - 1) * average : 0;
  if (current?.called_at && position > 1)
    wait = Math.max(
      0,
      wait -
        Math.min(average, (Date.now() - Date.parse(current.called_at)) / 60000),
    );
  if (ev.state === "planned")
    wait += Math.max(0, (Date.parse(ev.starts_at) - Date.now()) / 60000);
  const command = (kind: string, extra: Cmd = {}) =>
    action({ kind, event_id: ev.id, ...extra });
  return (
    <>
      <div className="event-summary">
        <section className="panel queue-position">
          <small>ВАША ПОЗИЦИЯ</small>
          <strong>
            {my
              ? my.state === "called"
                ? "Ваш выход"
                : unshuffled
                  ? "—"
                  : String(position).padStart(2, "0")
              : "—"}
          </strong>
          <p>
            {my
              ? my.state === "called"
                ? "Преподаватель ждёт вас"
                : unshuffled
                  ? "Порядок определит root"
                  : average
                    ? `Примерно ${Math.ceil(wait)} мин ожидания`
                    : "Пока недостаточно данных"
              : "Вы пока не в очереди"}
          </p>
          {my ? (
            <button
              className="secondary"
              disabled={busy}
              onClick={() => command("leave", { id: my.id })}
            >
              Выйти из очереди
            </button>
          ) : (
            <button
              disabled={
                busy ||
                closed ||
                !ev.registration_open ||
                !me.group_id ||
                !ev.group_ids.includes(me.group_id)
              }
              onClick={() => command("join")}
            >
              Записаться <Plus size={16} />
            </button>
          )}
        </section>
        <section className="panel">
          <div className="section-heading">
            <h2>Порядок приёма</h2>
            <Shuffle size={20} />
          </div>
          <p>{strategies[ev.strategy]}</p>
          {unshuffled && (
            <div className="info">
              Root перемешает участников один раз до первого вызова. До этого
              позиция не определена.
            </div>
          )}
          {ev.shuffled && (
            <p className="footnote">
              Порядок перемешивания сохранён. Новые участники — в конец.
            </p>
          )}
          {ev.manual_order && ev.strategy !== "random" && (
            <p className="footnote">
              Root изменил порядок. Новые участники — в начало.
            </p>
          )}
          {owner && !closed && (
            <div className="actions">
              {(!ev.first_called || me.root) && (
                <button
                  className="secondary"
                  onClick={() =>
                    openForm(
                      "Изменить стратегию",
                      [
                        {
                          name: "strategy",
                          label: "Стратегия",
                          value: ev.strategy,
                          options: Object.entries(strategies).map(
                            ([value, label]) => ({ value, label }),
                          ),
                        },
                      ],
                      (v) => ({
                        kind: "strategy",
                        event_id: ev.id,
                        strategy: v.strategy,
                      }),
                      "Порядок ожидающих будет пересчитан. Ручные перемещения сбросятся.",
                    )
                  }
                >
                  Изменить
                </button>
              )}
              {me.root && unshuffled && !ev.first_called && (
                <button
                  disabled={busy || !entries.length}
                  onClick={() => {
                    if (
                      confirm(
                        "Перемешать очередь? Повторное перемешивание невозможно.",
                      )
                    )
                      command("shuffle");
                  }}
                >
                  <Shuffle size={16} /> Перемешать один раз
                </button>
              )}
            </div>
          )}
          <button
            className="link"
            onClick={() =>
              window.Telegram?.WebApp.requestWriteAccess?.(() => {})
            }
          >
            <Bell size={16} /> Разрешить уведомления бота
          </button>
        </section>
      </div>
      {owner && (
        <section className="panel controls">
          <div className="section-heading">
            <h2>Пульт преподавателя</h2>
            {!closed && (
              <button
                className="icon-button"
                aria-label="Изменить событие"
                onClick={() =>
                  openForm(
                    "Параметры события",
                    [
                      {
                        name: "name",
                        label: "Название",
                        value: ev.name,
                        required: true,
                      },
                      {
                        name: "starts",
                        label: "Начало · московское время",
                        type: "datetime-local",
                        value: new Date(Date.parse(ev.starts_at) + 3 * 3600000)
                          .toISOString()
                          .slice(0, 16),
                        required: true,
                      },
                      { name: "room", label: "Аудитория", value: ev.room },
                      {
                        name: "description",
                        label: "Описание",
                        value: ev.description,
                      },
                      {
                        name: "duration",
                        label: "Минут на студента",
                        type: "number",
                        value: ev.duration,
                      },
                    ],
                    (v) => ({
                      kind: "event_update",
                      event_id: ev.id,
                      name: v.name,
                      starts_at: new Date(v.starts + ":00+03:00").toISOString(),
                      room: v.room,
                      description: v.description,
                      duration: Number(v.duration),
                    }),
                  )
                }
              >
                <Settings2 size={16} />
              </button>
            )}
            <button className="secondary" onClick={grades}>
              <BookOpen size={16} /> Ведомость
            </button>
          </div>
          {!closed && (
            <>
              <div className="actions">
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    command("event_action", {
                      action: ev.registration_open ? "close" : "open",
                    })
                  }
                >
                  {ev.registration_open ? "Закрыть запись" : "Открыть запись"}
                </button>
                {ev.state === "planned" ? (
                  <button
                    disabled={busy}
                    onClick={() => command("event_action", { action: "start" })}
                  >
                    Начать приём
                  </button>
                ) : (
                  <button
                    disabled={busy || !!current || unshuffled}
                    onClick={() => command("next")}
                  >
                    Вызвать следующего <ArrowRight size={16} />
                  </button>
                )}
                <button
                  className="secondary"
                  disabled={busy || pending}
                  onClick={() => {
                    if (
                      confirm(
                        "Завершить событие и закрыть все оставшиеся записи?",
                      )
                    )
                      command("event_action", { action: "complete" });
                  }}
                >
                  Завершить событие
                </button>
                <button
                  className="link danger"
                  disabled={busy || pending}
                  onClick={() => {
                    if (
                      confirm("Отменить событие? Сохранённые оценки останутся.")
                    )
                      command("event_action", { action: "cancel" });
                  }}
                >
                  Отменить событие
                </button>
              </div>
              {current && (
                <div className="current-student">
                  <span className="avatar">
                    {current.user_name.slice(0, 1)}
                  </span>
                  <div>
                    <small>СЕЙЧАС ПРИНИМАЕТЕ</small>
                    <h3>{current.user_name}</h3>
                  </div>
                  <div className="actions">
                    <button
                      className="secondary"
                      disabled={busy || pending}
                      onClick={() => command("skip", { id: current.id })}
                    >
                      Пропустить
                    </button>
                    <button
                      disabled={busy || pending}
                      onClick={() => command("finish", { id: current.id })}
                    >
                      <Check size={16} /> Завершить приём
                    </button>
                  </div>
                </div>
              )}
              {pending && (
                <div className="alert">
                  Сохраните или отмените правки в ведомости перед завершением
                  приёма.
                </div>
              )}
            </>
          )}
        </section>
      )}
      <section className="panel queue-list">
        <div className="section-heading">
          <h2>
            {unshuffled ? "Участники" : "Очередь"} <span>{entries.length}</span>
          </h2>
          <span className="footnote">
            <span className="live-dot" /> Обновляется автоматически
          </span>
        </div>
        {entries.length ? (
          entries.map((e, i) => (
            <div
              className={"queue-row " + (e.user_id === me.id ? "own-row" : "")}
              key={e.id}
            >
              <span className="queue-number">
                {unshuffled ? (
                  "·"
                ) : e.state === "called" ? (
                  <ArrowRight size={18} />
                ) : (
                  String(i + 1).padStart(2, "0")
                )}
              </span>
              <span className="avatar small">
                {e.user_name.slice(0, 1) || "?"}
              </span>
              <span className="queue-name">
                {e.user_name || "Студент"}
                {e.user_id === me.id && <small>вы</small>}
              </span>
              <span className={"badge " + (e.state === "called" ? "live" : "")}>
                {e.state === "called"
                  ? "Вызван"
                  : e.skipped
                    ? "Пропущен"
                    : "Ожидает"}
              </span>
              {me.root && !closed && (
                <div className="row-controls">
                  {e.state === "waiting" && (
                    <button
                      className="icon-button"
                      aria-label={`Переместить ${e.user_name}`}
                      onClick={() =>
                        openForm(
                          "Переместить участника",
                          [
                            {
                              name: "position",
                              label: "Позиция среди ожидающих",
                              type: "number",
                              value: 1,
                              required: true,
                            },
                          ],
                          (v) => ({
                            kind: "move",
                            event_id: ev.id,
                            id: e.id,
                            position: Number(v.position),
                          }),
                        )
                      }
                    >
                      <ListOrdered size={16} />
                    </button>
                  )}
                  <button
                    className="icon-button danger"
                    aria-label={`Удалить ${e.user_name}`}
                    onClick={() => {
                      if (confirm("Удалить участника из очереди?"))
                        command("remove", { id: e.id });
                    }}
                  >
                    <X size={16} />
                  </button>
                </div>
              )}
            </div>
          ))
        ) : (
          <Empty
            title={closed ? "Активных записей нет" : "Здесь пока свободно"}
            text={
              closed
                ? "Событие закрыто. Оценки сохранены в ведомости."
                : "Участники появятся после записи на событие."
            }
          />
        )}
      </section>
      {history.length > 0 && (
        <details className="panel history">
          <summary>История участия · {history.length}</summary>
          {history.map((e) => (
            <div className="admin-row" key={e.id}>
              <span>
                {e.user_name}
                <small>Записался {date(e.joined_at)}</small>
              </span>
              <span className="badge">
                {
                  {
                    completed: "Приём завершён",
                    left: "Вышел",
                    removed: "Удалён root",
                    closed: "Закрыто с событием",
                  }[e.state]
                }
              </span>
            </div>
          ))}
        </details>
      )}
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
