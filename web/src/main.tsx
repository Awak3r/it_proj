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
  Download,
  BarChart3,
} from "lucide-react";
import { request, devUser, authHeaders } from "./api";
import { State, Event, Entry, Lab, strategies, statuses } from "./types";
import "./style.css";
import { useTelegramTheme } from "./theme";
import { startLiveUpdates } from "./live";
import { GradeSummaryCells } from "./GradeSummaryCells";
import { GradeStatisticsPanel } from "./GradeStatisticsPanel";
import { StudentDirectory } from "./StudentDirectory";
import { DirectoryList } from "./DirectoryList";
type Cmd = Record<string, unknown>;
type Field = {
  name: string;
  label: string;
  type?: string;
  value?: string | number;
  options?: { value: string | number; label: string }[];
  optionsFor?: (
    values: Record<string, string>,
  ) => { value: string | number; label: string }[];
  required?: boolean;
  min?: number;
  max?: number;
  step?: number | "any";
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
  useTelegramTheme();
  const [data, setData] = useState<State>();
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [showStatistics, setShowStatistics] = useState(false);
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
  const snapshotVersion = useRef(0);
  const snapshot = useRef<
    { promise: Promise<boolean>; pending: boolean } | undefined
  >(undefined);
  const gradeLocks = useRef(new Set<string>());
  async function refresh(force = false): Promise<boolean> {
    if (!force && snapshot.current?.pending) return snapshot.current.promise;
    const version = ++snapshotVersion.current;
    const promise = (async () => {
      let ok = false;
      try {
        const state = await request<State>("state");
        if (version === snapshotVersion.current) {
          setData(state);
          setConnectionError("");
          ok = true;
        }
      } catch (e) {
        if (version === snapshotVersion.current)
          setConnectionError((e as Error).message);
      }
      // A mutation may have started a newer read while this one was in flight.
      // Its callers must wait for that read before releasing pending edits.
      if (version !== snapshotVersion.current) return snapshot.current!.promise;
      snapshot.current!.pending = false;
      return ok;
    })();
    snapshot.current = { promise, pending: true };
    return promise;
  }
  useEffect(() => {
    let disposed = false;
    let stopUpdates: (() => void) | undefined;
    let configRetry: ReturnType<typeof setTimeout> | undefined;
    window.Telegram?.WebApp.ready();
    window.Telegram?.WebApp.expand();
    const initialize = () =>
      request<{ dev_auth: boolean }>("config")
        .then((c) => {
          if (disposed) return;
          setError("");
          setDev(c.dev_auth);
          localStorage.setItem("dev-enabled", String(c.dev_auth));
          refresh();
          stopUpdates = startLiveUpdates(refresh);
        })
        .catch(() => {
          if (disposed) return;
          setError("Сервер недоступен");
          configRetry = setTimeout(initialize, 3000);
        });
    void initialize();
    return () => {
      disposed = true;
      clearTimeout(configRetry);
      stopUpdates?.();
    };
  }, []);
  useEffect(() => {
    setModal(undefined);
    setEventID(undefined);
    setTab("events");
    setShowStatistics(false);
  }, [data?.me.teacher, data?.me.root]);
  // Forms capture their opening snapshot. Invalidate them when curriculum changes
  // so a live update cannot submit an obsolete lab/event pair or overwrite links.
  const curriculum =
    data &&
    JSON.stringify([data.subject_groups ?? [], data.groups, data.subjects]);
  useEffect(() => {
    setModal(undefined);
  }, [curriculum]);
  useEffect(() => {
    if (!data) return;
    const privileged = role !== "student" && (data.me.teacher || data.me.root);
    const available = data.groups.filter(
      (g) => !g.archived && (privileged || g.id === data.me.group_id),
    );
    const nextGroup =
      available.find((g) => g.id === group)?.id ||
      available.find((g) => g.id === data.me.group_id)?.id ||
      available[0]?.id ||
      0;
    const availableSubjects = data.subjects.filter(
      (s) =>
        !s.archived &&
        (data.subject_groups ?? []).some(
          (link) => link.group_id === nextGroup && link.subject_id === s.id,
        ),
    );
    setGroup(nextGroup);
    setSubject(
      availableSubjects.find((s) => s.id === subject)?.id ||
        availableSubjects[0]?.id ||
        0,
    );
  }, [data, role, group, subject]);
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
    setSyncing(false);
    let refreshTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await request("command", c, key);
      commandKeys.current.delete(body);
      setSyncing(true);
      // SSE can supersede snapshots repeatedly. Bound the whole confirmation,
      // not only each individual fetch, without accepting an older snapshot.
      const confirmed = await Promise.race([
        refresh(true),
        new Promise<boolean>((resolve) => {
          refreshTimeout = setTimeout(() => resolve(false), 15000);
        }),
      ]);
      if (!confirmed)
        throw new Error(
          "Изменение сохранено, но данные не обновились. Повторите обновление.",
        );
    } finally {
      clearTimeout(refreshTimeout);
      setSyncing(false);
      setBusy(false);
    }
  }
  function changeRole(next: string) {
    if (next === "student" && data?.me.teacher) return;
    setRole(next);
    setShowStatistics(false);
    setTab("events");
    setEventID(undefined);
    setModal(undefined);
    setError("");
  }
  async function action(c: Cmd, message = "Готово") {
    setError("");
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
        <h1>LabTurn</h1>
        <p>{error || connectionError || "Загрузка…"}</p>
        {error && (
          <button onClick={() => refresh()}>Попробовать ещё раз</button>
        )}
      </div>
    );
  // The selected view can hide account privileges, never grant new ones.
  const me = {
    ...data.me,
    group_id: data.me.teacher ? null : data.me.group_id,
    teacher: data.me.teacher,
    root: role !== "student" && data.me.root,
  };
  const teacher = me.teacher || me.root;
  const groups = data.groups.filter((g) => !g.archived);
  const bound = (subjectID: number, groupID: number) =>
    (data.subject_groups ?? []).some(
      (link) => link.subject_id === subjectID && link.group_id === groupID,
    );
  const subjects = data.subjects.filter(
    (s) =>
      !s.archived && (teacher || (!!me.group_id && bound(s.id, me.group_id))),
  );
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
        ...(!data.me.teacher && !me.group_id
          ? [
              {
                name: "group",
                label: "Учебная группа",
                options: [
                  ...(data.me.root ? [{ value: 0, label: "Без группы" }] : []),
                  ...groups.map((g) => ({ value: g.id, label: g.name })),
                ],
              },
            ]
          : []),
      ],
      (v) => ({
        kind: "profile",
        name: v.name,
        group_id: data.me.teacher ? 0 : me.group_id || Number(v.group),
      }),
      data.me.teacher
        ? "Преподаватель не состоит в студенческой группе."
        : `Ваша группа: ${groupName(me.group_id)}. Для смены группы обратитесь к администратору.`,
    );
  const roleScreen =
    !role ||
    (role === "teacher" && !teacher) ||
    (role === "root" && !me.root) ||
    (role === "student" && data.me.teacher) ||
    !me.name ||
    (role === "student" && !me.group_id);
  function subjectForm(item?: State["subjects"][number]) {
    if (!me.root) return;
    if (!item && !groups.length) {
      setError("Сначала создайте действующую группу, затем добавьте предмет.");
      return;
    }
    const links = (data!.subject_groups ?? []).filter(
      (link) => link.subject_id === item?.id,
    );
    const archivedIDs = links
      .filter((link) =>
        data!.groups.some((g) => g.id === link.group_id && g.archived),
      )
      .map((link) => link.group_id);
    openForm(
      item ? "Редактирование предмета" : "Новый предмет",
      [
        { name: "name", label: "Название", value: item?.name, required: true },
        {
          name: "groups",
          label: "Группы предмета",
          type: "checkboxes",
          value: links
            .filter((link) => groups.some((g) => g.id === link.group_id))
            .map((link) => link.group_id)
            .join(","),
          options: groups.map((g) => ({ value: g.id, label: g.name })),
          required: !item,
        },
        ...(item
          ? [
              {
                name: "archive",
                label: "Статус",
                value: String(item.archived),
                options: [
                  { value: "false", label: "Действует" },
                  { value: "true", label: "В архиве" },
                ],
              },
            ]
          : []),
      ],
      (values) => ({
        kind: "subject",
        ...(item ? { id: item.id, enabled: values.archive === "true" } : {}),
        name: values.name,
        group_ids: [
          ...values.groups.split(",").filter(Boolean).map(Number),
          ...archivedIDs,
        ],
      }),
      archivedIDs.length
        ? `Связи с архивными группами сохраняются: ${archivedIDs.map(groupName).join(", ")}.`
        : "Выберите группы, в которых изучается предмет. Удалить связь можно только без действующих работ и событий.",
    );
  }
  function eventForm() {
    const available = subjects.filter((s) =>
      groups.some((g) => bound(s.id, g.id)),
    );
    if (!available.length) {
      setError(
        "Нет предметов с действующими группами. Попросите администратора назначить группы предмету.",
      );
      return;
    }
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
          value: "",
          optionsFor: (values) =>
            groups
              .filter((g) => bound(Number(values.subject), g.id))
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
        group_ids: v.groups.split(",").filter(Boolean).map(Number),
        starts_at: new Date(v.starts + ":00+03:00").toISOString(),
        room: v.room,
        duration: Number(v.duration),
        strategy: v.strategy,
        description: v.description,
      }),
    );
  }
  function labForm(l?: Lab) {
    if (
      !teacher ||
      !currentSubject ||
      !currentGroup ||
      (l && (l.subject_id !== currentSubject || l.group_id !== currentGroup))
    )
      return;
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
        {
          name: "weight",
          label: "Вес работы",
          type: "number",
          value: l?.weight_text ?? l?.weight ?? 1,
          min: 0,
          max: 1000000,
          step: "any",
          required: true,
        },
        {
          name: "required",
          label: "Обязательность",
          value: String(l?.required ?? true),
          options: [
            { value: "true", label: "Обязательная" },
            { value: "false", label: "Необязательная" },
          ],
        },
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
      (v) => {
        // Keep decimal text intact: rounding the weight can change the final hint.
        const weight = v.weight
          .trim()
          .replace(/^\+/, "")
          .replace(/^\./, "0.")
          .replace(/\.(?=[eE]|$)/, "")
          .replace(/^0+(?=\d)/, "");
        if (
          !/^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(weight) ||
          !/[1-9]/.test(weight.split(/[eE]/)[0]) ||
          !Number.isFinite(Number(weight)) ||
          Number(weight) > 1000000
        )
          throw new Error(
            "Вес работы должен быть больше 0 и не больше 1000000",
          );
        return {
          kind: "lab",
          id: l?.id || 0,
          subject_id: currentSubject,
          group_id: currentGroup,
          number: Number(v.number),
          name: v.name,
          enabled: v.archive === "true",
          weight,
          required: v.required === "true",
        };
      },
      "Вес задаёт относительный вклад работы в средний балл. Необязательная работа без оценки не учитывается.",
    );
  }
  async function saveGrade(
    user: number,
    lab: number,
    value: string,
    version: number,
    retryKey?: string,
  ) {
    const work = data!.labs.find((item) => item.id === lab);
    if (
      !teacher ||
      !work ||
      work.archived ||
      !bound(work.subject_id, work.group_id) ||
      !groups.some((g) => g.id === work.group_id) ||
      !subjects.some((s) => s.id === work.subject_id) ||
      !data!.users.some((u) => u.id === user && u.group_id === work.group_id)
    )
      return;
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
      if (!(await refresh(true)))
        throw new Error(
          "Оценка сохранена, но ведомость не обновилась. Повторите проверку.",
        );
      setPending((p) => {
        const n = { ...p };
        delete n[cell];
        return n;
      });
    } catch (e) {
      setPending((p) => ({
        ...p,
        [cell]: { value, error: (e as Error).message, user, lab, version, key },
      }));
    } finally {
      gradeLocks.current.delete(cell);
    }
  }
  async function cancelGrade(cell: string) {
    const entry = pending[cell];
    if (!entry || gradeLocks.current.has(cell)) return;
    gradeLocks.current.add(cell);
    setPending((p) => ({ ...p, [cell]: { ...entry, error: "" } }));
    try {
      // The previous write may have committed even when its response was lost.
      if (!(await refresh(true)))
        throw new Error(
          "Не удалось обновить ведомость. Повторите отмену правки.",
        );
      setPending((p) => {
        const next = { ...p };
        delete next[cell];
        return next;
      });
    } catch (e) {
      setPending((p) => ({
        ...p,
        [cell]: { ...entry, error: (e as Error).message },
      }));
    } finally {
      gradeLocks.current.delete(cell);
    }
  }
  async function exportGradebook() {
    if (!currentSubject || !currentGroup) return;
    setExporting(true);
    try {
      const res = await fetch(
        `/api/export?subject_id=${currentSubject}&group_id=${currentGroup}`,
        { method: "POST", headers: authHeaders() },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Не удалось выгрузить ведомость");
      }
      setNotice("Ведомость отправлена в личный чат с ботом");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setExporting(false);
    }
  }
  const accessibleGroups = groups.filter(
    (g) => teacher || g.id === me.group_id,
  );
  const currentGroup = accessibleGroups.some((g) => g.id === group)
    ? group
    : accessibleGroups.find((g) => g.id === me.group_id)?.id ||
      accessibleGroups[0]?.id ||
      0;
  const groupSubjects = subjects.filter((s) => bound(s.id, currentGroup));
  const currentSubject = groupSubjects.some((s) => s.id === subject)
    ? subject
    : groupSubjects[0]?.id || 0;
  const canGrade = teacher;
  const rootMode = role === "root" && !!me.root;
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
          <h1 className="brand">LabTurn</h1>

          <section className="welcome-panel">
            <h2>{!role ? "Вход" : "Профиль"}</h2>

            {!role ? (
              <>
                {!data.me.teacher && (
                  <button
                    className="role-card"
                    onClick={() => changeRole("student")}
                  >
                    <GraduationCap />
                    <span>
                      <b>Я студент</b>
                    </span>
                    <ArrowRight />
                  </button>
                )}
                <button
                  className="role-card"
                  onClick={() => changeRole("teacher")}
                >
                  <BookOpen />
                  <span>
                    <b>Я преподаватель</b>
                  </span>
                  <ArrowRight />
                </button>
                {data.me.root && (
                  <button className="link" onClick={() => changeRole("root")}>
                    Управление root →
                  </button>
                )}
              </>
            ) : role === "student" && data.me.teacher ? (
              <>
                <div className="info">
                  Вам назначена роль преподавателя. Студенческий режим
                  недоступен.
                </div>
                <button onClick={() => changeRole("")}>Назад</button>
              </>
            ) : role === "teacher" && !teacher ? (
              <>
                <div className="info">
                  Роль преподавателя выдаёт root. Сообщите ему свой Telegram ID:{" "}
                  <b>{me.id}</b>.
                </div>
                <button onClick={() => changeRole("")}>Назад</button>
              </>
            ) : (
              <Profile
                me={me}
                groups={groups}
                role={role}
                save={async (name, group_id) => {
                  await command({ kind: "profile", name, group_id });
                }}
                back={() => changeRole("")}
              />
            )}
          </section>
        </main>
      ) : (
        <div className="shell">
          <aside className="sidebar">
            <div className="app-header">
              <button
                className="brand"
                onClick={() => {
                  setTab("events");
                  setEventID(undefined);
                }}
              >
                LabTurn
              </button>
              <div className="account-actions">
                <button
                  className="profile"
                  onClick={changeProfile}
                  aria-label="Профиль"
                >
                  <Settings2 size={17} />
                  <span>{me.name}</span>
                </button>
                <button className="switch-role" onClick={() => changeRole("")}>
                  Сменить роль
                </button>
              </div>
            </div>
            <nav>
              {[
                { id: "events", label: "События", icon: LayoutGrid },
                ...(!data.me.teacher || mine.length > 0
                  ? [{ id: "mine", label: "Мои очереди", icon: ListOrdered }]
                  : []),
                ...(!data.me.teacher
                  ? [{ id: "group", label: "Моя группа", icon: Users }]
                  : []),
                { id: "grades", label: "Ведомость", icon: BookOpen },
                ...(teacher
                  ? [
                      {
                        id: "teaching",
                        label: "Мои события",
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
          </aside>
          <main className="main">
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
                      <span className="subject-label">
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
                      const targetGroup = selected.group_ids.find(
                        (id) =>
                          accessibleGroups.some((g) => g.id === id) &&
                          bound(selected.subject_id, id),
                      );
                      if (
                        !targetGroup ||
                        !subjects.some((s) => s.id === selected.subject_id)
                      ) {
                        setError(
                          "Ведомость события недоступна: предмет или группа в архиве либо предмет больше не назначен группе. Сохранённые данные не удалены.",
                        );
                        return;
                      }
                      setGroup(targetGroup);
                      setSubject(selected.subject_id);
                      setShowStatistics(false);
                      setEventID(undefined);
                      setTab("grades");
                    }}
                  />
                </>
              ) : ["events", "mine", "teaching"].includes(tab) ? (
                <>
                  <div className="page-title">
                    <div>
                      <h1>
                        {tab === "events"
                          ? "События"
                          : tab === "mine"
                            ? "Мои очереди"
                            : "Мой кабинет"}
                      </h1>
                    </div>
                    {teacher && (
                      <button onClick={eventForm}>
                        <Plus size={18} /> Создать событие
                      </button>
                    )}
                  </div>
                  <div className="section-heading">
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
                          <div className="event-info">
                            <span className="card-subject">
                              {subjectName(ev.subject_id)}
                            </span>
                            <h3>{ev.name}</h3>
                            <p className="card-teacher">
                              {ev.teacher_name || "Преподаватель"} ·{" "}
                              {ev.group_ids.map(groupName).join(", ")}
                            </p>
                            <div className="card-meta">
                              <span>{date(ev.starts_at)} МСК</span>
                              {ev.room && <span>ауд. {ev.room}</span>}
                              <span>{board(ev).length} в очереди</span>
                            </div>
                          </div>
                          <div className="event-status">
                            <span className={"badge " + ev.state}>
                              {statuses[ev.state]}
                            </span>
                            <span className="registration-status">
                              {mine.some((q) => q.event_id === ev.id)
                                ? "Вы записаны"
                                : ev.registration_open
                                  ? "Запись открыта"
                                  : "Запись закрыта"}
                            </span>
                            <ChevronRight size={17} />
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
                        tab === "mine" ? "Нет активных записей" : "Нет событий"
                      }
                      text={tab === "mine" ? "" : ""}
                    />
                  )}
                </>
              ) : tab === "group" && !data.me.teacher ? (
                <>
                  <div className="page-title">
                    <div>
                      <h1>Моя группа</h1>
                      <p>{groupName(me.group_id)}</p>
                    </div>
                  </div>
                  <section className="panel">
                    <h2>Студенты группы</h2>
                    {data.users
                      .filter(
                        (u) =>
                          !u.teacher &&
                          !!me.group_id &&
                          u.group_id === me.group_id,
                      )
                      .map((u) => (
                        <div className="admin-row" key={u.id}>
                          <span>
                            {u.name || "Имя не указано"}
                            {u.id === me.id ? " (вы)" : ""}
                          </span>
                        </div>
                      ))}
                    {!me.group_id && (
                      <p>Группа не выбрана. Укажите её в профиле.</p>
                    )}
                    <p className="footnote">
                      Для смены группы обратитесь к администратору.
                    </p>
                  </section>
                </>
              ) : tab === "grades" ? (
                <>
                  <div className="page-title">
                    <div>
                      <h1>Ведомость</h1>
                    </div>
                    {canGrade && (
                      <div
                        style={{
                          display: "flex",
                          gap: 8,
                          flexWrap: "wrap",
                          justifyContent: "flex-end",
                        }}
                      >
                        <button
                          className="secondary"
                          disabled={!currentGroup || !currentSubject}
                          aria-pressed={showStatistics}
                          onClick={() => setShowStatistics((value) => !value)}
                        >
                          <BarChart3 size={18} />{" "}
                          {showStatistics ? "К оценкам" : "Статистика"}
                        </button>
                        <button
                          disabled={!currentGroup || !currentSubject}
                          onClick={() => labForm()}
                        >
                          <Plus size={18} /> Добавить работу
                        </button>
                        <button
                          className="secondary"
                          disabled={
                            !currentGroup || !currentSubject || exporting
                          }
                          onClick={exportGradebook}
                        >
                          <Download size={18} /> Экспорт
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="filters">
                    <label>
                      Группа
                      <select
                        aria-label="Группа"
                        value={currentGroup}
                        onChange={(e) => {
                          const nextGroup = Number(e.target.value);
                          setGroup(nextGroup);
                          setSubject(
                            subjects
                              .filter((s) => bound(s.id, nextGroup))
                              .find((s) => s.id === currentSubject)?.id ||
                              subjects.find((s) => bound(s.id, nextGroup))
                                ?.id ||
                              0,
                          );
                        }}
                      >
                        {!accessibleGroups.length && (
                          <option value={0}>Нет действующих групп</option>
                        )}
                        {accessibleGroups.map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Предмет
                      <select
                        aria-label="Предмет"
                        value={currentSubject}
                        onChange={(e) => setSubject(Number(e.target.value))}
                      >
                        {!groupSubjects.length && (
                          <option value={0}>Нет назначенных предметов</option>
                        )}
                        {groupSubjects.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <span className="save-hint">
                      {Object.keys(pending).length
                        ? "Есть несохранённые изменения"
                        : "Сохранено"}
                    </span>
                  </div>
                  {!currentSubject ? (
                    <Empty
                      title="Нет предметов для этой группы"
                      text="Администратор должен назначить группе предмет в разделе «Управление»."
                    />
                  ) : showStatistics && canGrade ? (
                    <GradeStatisticsPanel
                      key={`${currentGroup}-${currentSubject}`}
                      statistics={data.grade_statistics?.find(
                        (s) =>
                          s.group_id === currentGroup &&
                          s.subject_id === currentSubject,
                      )}
                      labStatistics={(data.lab_statistics ?? []).filter(
                        (s) =>
                          s.group_id === currentGroup &&
                          s.subject_id === currentSubject,
                      )}
                      labs={data.labs.filter(
                        (l) =>
                          l.group_id === currentGroup &&
                          l.subject_id === currentSubject &&
                          !l.archived,
                      )}
                      students={data.users.filter(
                        (u) => !u.teacher && u.group_id === currentGroup,
                      )}
                      summaries={data.grade_summaries.filter(
                        (s) =>
                          s.group_id === currentGroup &&
                          s.subject_id === currentSubject,
                      )}
                      pending={Object.keys(pending).length > 0}
                    />
                  ) : (
                    <>
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
                                      <small className="lab-policy">
                                        Вес: {l.weight_text ?? l.weight ?? 1} ·{" "}
                                        {l.required === false
                                          ? "необязательная"
                                          : "обязательная"}
                                      </small>
                                    </button>
                                  </th>
                                ))}
                              <th>Прогресс</th>
                              <th>Средний балл</th>
                              <th>Итог (подсказка)</th>
                            </tr>
                          </thead>
                          <tbody>
                            {data.users
                              .filter(
                                (u) =>
                                  !u.teacher && u.group_id === currentGroup,
                              )
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
                                              value={
                                                p?.value ?? grade?.value ?? ""
                                              }
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
                                      <div
                                        className="progress-label"
                                        title="Все активные работы, включая необязательные. Необязательные работы не блокируют итог."
                                      >
                                        {done} / {labs.length}
                                        <small>
                                          осталось {labs.length - done}
                                        </small>
                                      </div>
                                    </td>
                                    <GradeSummaryCells
                                      summary={data.grade_summaries?.find(
                                        (s) =>
                                          s.student_id === u.id &&
                                          s.subject_id === currentSubject &&
                                          s.group_id === currentGroup,
                                      )}
                                      pending={labs.some(
                                        (l) => !!pending[u.id + "-" + l.id],
                                      )}
                                    />
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
                                onClick={() => cancelGrade(cell)}
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
                          title="Нет лабораторных"
                          text={canGrade ? "" : ""}
                        />
                      )}
                      <p className="footnote">
                        2 — не сдано · 3, 4, 5 — сдано · Пустая ячейка — оценки
                        ещё нет
                      </p>
                      <p className="footnote">
                        Средний балл учитывает веса работ: обязательная без
                        оценки считается за 2, необязательная без оценки не
                        учитывается. Итог — подсказка с округлением до целого
                        только после сдачи всех обязательных работ. Оценка
                        автоматически не выставляется. Расчёты выполняются по
                        сохранённым данным; округлённый средний не используется
                        для повторного округления итога.
                      </p>
                    </>
                  )}
                </>
              ) : tab === "admin" && me.root ? (
                <>
                  <div className="page-title">
                    <div>
                      <h1>Управление</h1>
                    </div>
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
                              kind === "subject"
                                ? subjectForm()
                                : openForm(
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
                        <DirectoryList
                          items={kind === "group" ? data.groups : data.subjects}
                          label={
                            kind === "group" ? "Поиск групп" : "Поиск предметов"
                          }
                          placeholder={
                            kind === "group"
                              ? "Название или ID"
                              : "Название, ID или группа"
                          }
                          emptyMessage={
                            kind === "group"
                              ? "Группы не найдены"
                              : "Предметы не найдены"
                          }
                          searchText={(v) =>
                            `${v.name} ${v.id} ${v.archived ? "архив" : ""} ${
                              kind === "subject"
                                ? (data.subject_groups ?? [])
                                    .filter((link) => link.subject_id === v.id)
                                    .map((link) => groupName(link.group_id))
                                    .join(" ")
                                : ""
                            }`
                          }
                          renderItem={(v) => (
                            <button
                              className="admin-row"
                              key={v.id}
                              onClick={() =>
                                kind === "subject"
                                  ? subjectForm(v)
                                  : openForm(
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
                                            {
                                              value: "false",
                                              label: "Действует",
                                            },
                                            {
                                              value: "true",
                                              label: "В архиве",
                                            },
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
                                {kind === "subject" && (
                                  <small>
                                    Группы:{" "}
                                    {(data.subject_groups ?? [])
                                      .filter(
                                        (link) => link.subject_id === v.id,
                                      )
                                      .map(
                                        (link) =>
                                          `${groupName(link.group_id)}${data.groups.find((g) => g.id === link.group_id)?.archived ? " (архив)" : ""}`,
                                      )
                                      .join(", ") || "не назначены"}
                                  </small>
                                )}
                              </span>
                              <ChevronRight size={16} />
                            </button>
                          )}
                        />
                      </section>
                    ))}
                    {rootMode && (
                      <section className="panel">
                        <div className="section-heading">
                          <h2>Преподаватели</h2>
                          <button
                            className="icon-button"
                            aria-label="Добавить преподавателя"
                            onClick={() =>
                              openForm(
                                "Добавить преподавателя",
                                [
                                  {
                                    name: "user",
                                    label: "Telegram ID",
                                    type: "number",
                                    required: true,
                                  },
                                ],
                                (v) => ({
                                  kind: "role",
                                  user_id: Number(v.user),
                                  enabled: true,
                                }),
                              )
                            }
                          >
                            <Plus size={18} />
                          </button>
                        </div>
                        <DirectoryList
                          items={data.users.filter((u) => u.teacher)}
                          label="Поиск преподавателей"
                          placeholder="Фамилия, имя или Telegram ID"
                          emptyMessage="Преподаватели не найдены"
                          searchText={(u) => `${u.name} ${u.id}`}
                          renderItem={(u) => (
                            <div className="admin-row" key={u.id}>
                              <span>
                                {u.name || "Ожидает регистрации"}
                                <small>{u.id}</small>
                              </span>
                              <button
                                className="link danger"
                                aria-label={`Отозвать роль преподавателя ${u.name || u.id}`}
                                onClick={() => {
                                  if (
                                    confirm(
                                      "Отозвать роль преподавателя? Доступ ко всем группам и предметам будет закрыт.",
                                    )
                                  )
                                    action({
                                      kind: "role",
                                      user_id: u.id,
                                      enabled: false,
                                    });
                                }}
                              >
                                Отозвать роль
                              </button>
                            </div>
                          )}
                        />
                        <p className="footnote">
                          Преподаватель сразу получает доступ ко всем группам и
                          предметам.
                        </p>
                      </section>
                    )}
                    {rootMode && (
                      <StudentDirectory
                        students={data.users.filter(
                          (u) => !u.teacher && u.group_id !== null,
                        )}
                        groupName={groupName}
                        transfer={(u) =>
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
                      />
                    )}
                  </div>
                  {rootMode && (
                    <section className="panel audit">
                      <h2>Последние изменения</h2>
                      <DirectoryList
                        items={data.audit}
                        label="Поиск изменений"
                        placeholder="Действие, пользователь или дата"
                        emptyMessage="Изменения не найдены"
                        searchText={(a) =>
                          `${a.action} ${a.actor_id} ${data.users.find((u) => u.id === a.actor_id)?.name ?? ""} ${date(a.at)}`
                        }
                        renderItem={(a) => (
                          <div className="admin-row" key={a.id}>
                            <span>
                              {a.action}
                              <small>Пользователь {a.actor_id}</small>
                            </span>
                            <small>{date(a.at)}</small>
                          </div>
                        )}
                      />
                    </section>
                  )}
                </>
              ) : null}
            </div>
          </main>
        </div>
      )}
      {notice && (
        <div role="status" className="toast">
          <Check size={18} />
          {notice}
        </div>
      )}
      {!roleScreen && modal && (
        <FormModal modal={modal} close={() => setModal(undefined)} />
      )}
      {busy && (
        <div className="busy">
          <LoaderCircle className="spin" size={16} />{" "}
          {syncing ? "Обновляем…" : "Сохраняем…"}
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
        if (role === "student" && (!groups.length || !g)) return;
        setBusy(true);
        try {
          await save(n, me.teacher ? 0 : g);
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
      {role === "student" && !groups.length ? (
        <div className="info" role="status">
          <b>Групп пока нет.</b> Обратитесь к администратору, чтобы он добавил
          вашу учебную группу.
        </div>
      ) : role === "student" ? (
        <label>
          Ваша группа
          <select
            value={g || ""}
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
      ) : null}
      {err && <div className="alert">{err}</div>}
      <button
        disabled={
          busy || !n.trim() || (role === "student" && (!groups.length || !g))
        }
      >
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
        String(
          f.value ??
            (f.type === "multi" || f.type === "checkboxes"
              ? ""
              : f.options?.[0]?.value) ??
            "",
        ),
      ]),
    ),
  );
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const options = (field: Field, values = v) =>
    field.optionsFor?.(values) ?? field.options;
  const change = (name: string, value: string) => {
    setV((previous) => {
      const next = { ...previous, [name]: value };
      for (const field of modal.fields) {
        if (!field.optionsFor) continue;
        const allowed = new Set(
          field.optionsFor(next).map((option) => String(option.value)),
        );
        next[field.name] = next[field.name]
          .split(",")
          .filter((id) => allowed.has(id))
          .join(",");
      }
      return next;
    });
  };
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
              for (const field of modal.fields) {
                if (
                  field.required &&
                  (field.type === "multi" || field.type === "checkboxes") &&
                  !v[field.name]
                )
                  throw new Error(
                    `Выберите хотя бы одну группу: ${field.label}`,
                  );
              }
              await modal.submit(v);
              close();
            } catch (e) {
              setErr((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {modal.fields.map((f) =>
            f.type === "checkboxes" ? (
              <fieldset key={f.name} className="group-checkboxes">
                <legend>{f.label}</legend>
                {options(f)?.map((option) => (
                  <label key={option.value}>
                    <input
                      type="checkbox"
                      checked={v[f.name]
                        .split(",")
                        .includes(String(option.value))}
                      onChange={(e) =>
                        change(
                          f.name,
                          options(f)!
                            .filter((o) =>
                              String(o.value) === String(option.value)
                                ? e.target.checked
                                : v[f.name]
                                    .split(",")
                                    .includes(String(o.value)),
                            )
                            .map((o) => o.value)
                            .join(","),
                        )
                      }
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
                {!options(f)?.length && <p>Нет действующих групп</p>}
              </fieldset>
            ) : (
              <label key={f.name}>
                {f.label}
                {options(f) ? (
                  <select
                    aria-label={f.label}
                    multiple={f.type === "multi"}
                    value={
                      f.type === "multi" ? v[f.name].split(",") : v[f.name]
                    }
                    onChange={(e) =>
                      change(
                        f.name,
                        f.type === "multi"
                          ? Array.from(e.target.selectedOptions)
                              .map((o) => o.value)
                              .join(",")
                          : e.target.value,
                      )
                    }
                    required={f.type === "multi" ? f.required : true}
                  >
                    {options(f)!.map((o) => (
                      <option value={o.value} key={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type={f.type || "text"}
                    min={f.min}
                    max={f.max}
                    step={f.step}
                    value={v[f.name]}
                    onChange={(e) => change(f.name, e.target.value)}
                    required={f.required}
                  />
                )}
              </label>
            ),
          )}
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
      <h3>{title}</h3>
      {text && <p>{text}</p>}
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
  const joinReason = me.teacher
    ? "Преподаватель не может записываться в студенческую очередь."
    : ev.teacher_id === me.id
      ? "Нельзя записаться на собственное событие."
      : closed
        ? "Событие завершено или отменено."
        : !ev.registration_open
          ? "Запись закрыта преподавателем. Статус «Идёт приём» не означает, что запись открыта."
          : !me.group_id
            ? "Для записи укажите учебную группу в профиле."
            : !ev.group_ids.includes(me.group_id)
              ? "Событие недоступно вашей группе."
              : "";
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
          <small>Позиция</small>
          <strong>
            {my
              ? my.state === "called"
                ? "Вызван"
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
                    ? `Ожидание ≈ ${Math.ceil(wait)} мин`
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
          ) : !me.teacher && ev.teacher_id !== me.id ? (
            <button
              disabled={busy || !!joinReason}
              aria-describedby={joinReason ? "join-reason" : undefined}
              onClick={() => command("join")}
            >
              Записаться <Plus size={16} />
            </button>
          ) : null}
          {!my && joinReason && (
            <p id="join-reason" className="footnote">
              {joinReason}
            </p>
          )}
        </section>
        <section className="panel">
          <div className="section-heading">
            <h2>Порядок приёма</h2>
            <Shuffle size={20} />
          </div>
          <p>{strategies[ev.strategy]}</p>
          {unshuffled && (
            <div className="info">Ожидает перемешивания root.</div>
          )}
          {ev.shuffled && (
            <p className="footnote">Перемешано. Новые участники — в конец.</p>
          )}
          {ev.manual_order && ev.strategy !== "random" && (
            <p className="footnote">
              Ручной порядок. Новые участники — в начало.
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
          {window.Telegram?.WebApp.requestWriteAccess && (
            <button
              className="link"
              onClick={() =>
                window.Telegram?.WebApp.requestWriteAccess?.(() => {})
              }
            >
              <Bell size={16} /> Уведомления
            </button>
          )}
        </section>
      </div>
      {owner && (
        <section className="panel controls">
          <div className="section-heading">
            <h2>Управление очередью</h2>
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
                  <div>
                    <small>На приёме</small>
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
            title={closed ? "Активных записей нет" : "Очередь пуста"}
            text={
              closed ? "Событие закрыто. Оценки сохранены в ведомости." : ""
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
