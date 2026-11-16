import { test, expect, Page } from "@playwright/test";
import { State, Event, Entry } from "../src/types";

const now = new Date("2026-11-15T10:00:00Z");
const minutes = (n: number) =>
  new Date(now.getTime() + n * 60000).toISOString();

function snapshot(): State {
  const me = { id: 3003, name: "ETA student", group_id: 1, teacher: false };
  return {
    me,
    groups: [{ id: 1, name: "Synthetic group", archived: false }],
    subjects: [{ id: 1, name: "Synthetic subject", archived: false }],
    subject_groups: [{ subject_id: 1, group_id: 1 }],
    users: [me],
    labs: [],
    grades: [],
    grade_summaries: [],
    assignments: [],
    audit: [],
    events: [
      {
        id: 1,
        name: "Synthetic ETA event",
        subject_id: 1,
        teacher_id: 2001,
        teacher_name: "Synthetic teacher",
        group_ids: [1],
        starts_at: minutes(-30),
        room: "404",
        description: "",
        duration: 9,
        state: "live",
        registration_open: true,
        strategy: "fifo",
        shuffled: false,
        first_called: false,
        manual_order: false,
        average_minutes: null,
      },
    ],
    entries: [1, 2, 3].map((id) => ({
      id,
      event_id: 1,
      user_id: 3000 + id,
      user_name: id === 3 ? me.name : `Synthetic student ${id}`,
      group_id: 1,
      state: "waiting",
      position: id,
      score: 0,
      skipped: false,
      called_at: null,
      joined_at: minutes(-60),
    })),
  };
}

async function openQueue(page: Page, state: State) {
  // These are rendering tests: all API/Telegram traffic is intercepted, and
  // the fixed clock makes planned-start and elapsed-call arithmetic exact.
  await page.clock.setFixedTime(now);
  await page.route("https://telegram.org/**", (route) => route.abort());
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/config")
      return route.fulfill({ json: { dev_auth: true } });
    if (path === "/api/state") return route.fulfill({ json: state });
    return route.abort();
  });
  await page.addInitScript(() => localStorage.setItem("dev-user", "3003"));
  await page.goto("/");
  await page
    .getByRole("button")
    .filter({
      has: page.getByRole("heading", {
        name: "Synthetic ETA event",
        exact: true,
      }),
    })
    .click();
  await expect(page.locator(".queue-position")).toBeVisible();
}

type Scenario = {
  name: string;
  event?: Partial<Event>;
  entries?: (entries: Entry[]) => Entry[];
  position?: string;
  text: string;
};

const scenarios: Scenario[] = [
  {
    name: "uses configured duration before any completed visit",
    text: "Ожидание ≈ 18 мин",
  },
  {
    name: "uses completed-visit mean instead of configured duration and rounds up",
    event: { average_minutes: 4.25 },
    text: "Ожидание ≈ 9 мин",
  },
  {
    name: "uses completed-visit mean without configured duration",
    event: { average_minutes: 6, duration: 0 },
    text: "Ожидание ≈ 12 мин",
  },
  {
    name: "shows insufficient data without samples or configured duration",
    event: { duration: 0 },
    text: "Пока недостаточно данных",
  },
  {
    name: "adds time until planned start",
    event: { state: "planned", starts_at: minutes(30) },
    text: "Ожидание ≈ 48 мин",
  },
  {
    name: "does not subtract an overdue planned start",
    event: { state: "planned", starts_at: minutes(-30) },
    text: "Ожидание ≈ 18 мин",
  },
  {
    name: "does not add scheduled delay once reception is live",
    event: { starts_at: minutes(30) },
    text: "Ожидание ≈ 18 мин",
  },
  {
    name: "does not invent an estimate from planned delay alone",
    event: { state: "planned", starts_at: minutes(30), duration: 0 },
    text: "Пока недостаточно данных",
  },
  {
    name: "subtracts elapsed current visit and sorts called ahead of waiting",
    entries: (entries) =>
      entries.map((entry) =>
        entry.id === 1
          ? { ...entry, state: "called", position: 99, called_at: minutes(-3) }
          : entry,
      ),
    text: "Ожидание ≈ 15 мин",
  },
  {
    name: "caps elapsed subtraction at one mean visit",
    entries: (entries) =>
      entries.map((entry) =>
        entry.id === 1
          ? { ...entry, state: "called", called_at: minutes(-90) }
          : entry,
      ),
    text: "Ожидание ≈ 9 мин",
  },
  {
    name: "counts active people rather than stored position gaps or history",
    entries: (entries) => [
      { ...entries[0], state: "completed", position: 0 },
      { ...entries[1], position: 30 },
      { ...entries[2], position: 90 },
    ],
    position: "02",
    text: "Ожидание ≈ 9 мин",
  },
  {
    name: "first waiting student has zero estimated queue delay",
    entries: (entries) => [entries[2]],
    position: "01",
    text: "Ожидание ≈ 0 мин",
  },
  {
    name: "hides exact position and ETA before random shuffle",
    event: { strategy: "random" },
    position: "—",
    text: "Порядок определит root",
  },
  {
    name: "shows position and ETA after random shuffle",
    event: { strategy: "random", shuffled: true },
    text: "Ожидание ≈ 18 мин",
  },
  {
    name: "called student sees current state instead of an ETA",
    entries: (entries) =>
      entries.map((entry) =>
        entry.id === 3
          ? { ...entry, state: "called", called_at: minutes(0) }
          : entry,
      ),
    position: "Вызван",
    text: "Преподаватель ждёт вас",
  },
];

for (const scenario of scenarios) {
  test(`FR-16 / FR-15 position: ${scenario.name}`, async ({ page }) => {
    const state = snapshot();
    Object.assign(state.events[0], scenario.event);
    if (scenario.entries) state.entries = scenario.entries(state.entries);
    await openQueue(page, state);
    const summary = page.locator(".queue-position");
    await expect(summary.locator("strong")).toHaveText(
      scenario.position ?? "03",
    );
    await expect(summary.locator("p")).toHaveText(scenario.text);
    if (!scenario.text.startsWith("Ожидание ≈"))
      await expect(summary).not.toContainText("Ожидание");
  });
}
