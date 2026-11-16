import { test, expect, type Page } from "@playwright/test";
import type { State } from "../src/types";

function snapshot(): State {
  const me = { id: 3001, name: "Анна Студентова", group_id: 1, teacher: false };
  return {
    me,
    users: [me],
    groups: [
      { id: 1, name: "ИВТ-101", archived: false },
      { id: 2, name: "ПИ-202", archived: false },
    ],
    subjects: [{ id: 1, name: "Программирование", archived: false }],
    subject_groups: [1, 2].map((group_id) => ({ subject_id: 1, group_id })),
    assignments: [],
    labs: [],
    grades: [],
    grade_summaries: [],
    events: [
      {
        id: 1,
        name: "Проверка очереди",
        subject_id: 1,
        teacher_id: 2001,
        teacher_name: "Преподаватель",
        group_ids: [1],
        starts_at: "2030-01-01T10:00:00Z",
        room: "101",
        description: "",
        duration: 10,
        state: "live",
        registration_open: true,
        strategy: "fifo",
        shuffled: false,
        first_called: false,
        manual_order: false,
        average_minutes: null,
      },
    ],
    entries: [],
    audit: [],
  };
}

async function open(page: Page, state: State) {
  const commands: Record<string, unknown>[] = [];
  const origin = new URL(test.info().project.use.baseURL as string).origin;
  // Only local static assets reach the network; all APIs are synthetic.
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname === "/api/config")
      return route.fulfill({ json: { dev_auth: true } });
    if (url.pathname === "/api/state") return route.fulfill({ json: state });
    if (
      url.pathname === "/api/command" &&
      route.request().method() === "POST"
    ) {
      const command = route.request().postDataJSON();
      commands.push(command);
      if (command.kind === "leave") state.entries = [];
      return route.fulfill({ json: { ok: true } });
    }
    return route.abort();
  });
  await page.addInitScript(
    (id) => localStorage.setItem("dev-user", String(id)),
    state.me.id,
  );
  await page.goto("/");
  await expect(page.locator("nav")).toBeVisible();
  if (["completed", "cancelled"].includes(state.events[0].state))
    await page
      .getByRole("button", { name: "Все события", exact: true })
      .click();
  await page
    .getByRole("button")
    .filter({
      has: page.getByRole("heading", {
        name: state.events[0].name,
        exact: true,
      }),
    })
    .click();
  await expect(page.locator(".queue-position")).toBeVisible();
  return commands;
}

async function assertLayout(page: Page, width: number) {
  const panel = page.locator(".queue-position");
  const bounds = await panel.boundingBox();
  expect(bounds).not.toBeNull();
  const children = panel.locator(
    ":scope > small, :scope > strong, :scope > p, :scope > button",
  );
  const boxes = [];
  for (const child of await children.all()) {
    await expect(child).toBeVisible();
    const box = await child.boundingBox();
    expect(box).not.toBeNull();
    boxes.push(box!);
    expect(box!.width).toBeGreaterThan(0);
    expect(box!.height).toBeGreaterThan(0);
    expect(box!.x).toBeGreaterThanOrEqual(bounds!.x - 1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(
      bounds!.x + bounds!.width + 1,
    );
    expect(box!.y).toBeGreaterThanOrEqual(bounds!.y - 1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(
      bounds!.y + bounds!.height + 1,
    );
  }
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i],
        b = boxes[j];
      const overlapWidth =
        Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const overlapHeight =
        Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      expect(
        overlapWidth <= 0 || overlapHeight <= 0,
        `children ${i} and ${j} overlap`,
      ).toBe(true);
    }
  }
  const position = (await panel.locator("p:not(#join-reason)").boundingBox())!;
  const reason = panel.locator("#join-reason");
  const button = panel.getByRole("button");
  if (await reason.count()) {
    const box = (await reason.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(position.y + position.height);
    expect(box.x).toBeCloseTo(bounds!.x, 0);
    expect(box.width).toBeCloseTo(bounds!.width, 0);
    if (await button.count()) {
      const action = (await button.boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(action.y + action.height);
    }
  }
  if (await button.count()) {
    const action = (await button.boundingBox())!;
    if (width <= 360) {
      expect(action.y).toBeGreaterThanOrEqual(position.y + position.height);
      expect(action.x).toBeCloseTo(bounds!.x, 0);
    } else if (width <= 640) {
      expect(action.x).toBeGreaterThanOrEqual(position.x + position.width);
      expect(action.x + action.width).toBeCloseTo(bounds!.x + bounds!.width, 0);
      expect(action.y).toBeLessThan(position.y + position.height);
    }
  }
  expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}

const blocked = [
  {
    name: "completed",
    reason: "Событие завершено или отменено.",
    setup: (s: State) => {
      s.events[0].state = "completed";
    },
  },
  {
    name: "cancelled",
    reason: "Событие завершено или отменено.",
    setup: (s: State) => {
      s.events[0].state = "cancelled";
    },
  },
  {
    name: "wrong group",
    reason: "Событие недоступно вашей группе.",
    setup: (s: State) => {
      s.events[0].group_ids = [2];
    },
  },
  {
    name: "registration closed",
    reason:
      "Запись закрыта преподавателем. Статус «Идёт приём» не означает, что запись открыта.",
    setup: (s: State) => {
      s.events[0].registration_open = false;
    },
  },
  {
    name: "teacher",
    reason: "Преподаватель не может записываться в студенческую очередь.",
    setup: (s: State) => {
      s.me.teacher = true;
      s.me.group_id = null;
    },
  },
];

for (const width of [320, 360, 390, 640, 1440]) {
  for (const scenario of blocked) {
    test(`${scenario.name}: separate full-width reason at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const state = snapshot();
      scenario.setup(state);
      const commands = await open(page, state);
      await expect(
        page.locator(".queue-position p:not(#join-reason)"),
      ).toHaveText("Вы пока не в очереди");
      await expect(page.locator("#join-reason")).toHaveText(scenario.reason);
      const join = page.getByRole("button", {
        name: "Записаться",
        exact: true,
      });
      if (state.me.teacher) await expect(join).toHaveCount(0);
      else {
        await expect(join).toBeDisabled();
        await expect(join).toHaveAttribute("aria-describedby", "join-reason");
      }
      await assertLayout(page, width);
      expect(commands).toEqual([]);
    });
  }

  test(`eligible join preserves button layout at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const commands = await open(page, snapshot());
    await expect(page.locator("#join-reason")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Записаться", exact: true }),
    ).toBeEnabled();
    await assertLayout(page, width);
    expect(commands).toEqual([]);
  });

  for (const entryState of ["waiting", "called"]) {
    test(`${entryState}: own position and exit layout at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const state = snapshot();
      // A legacy teacher entry must still be leaveable, without a join reason.
      state.me.teacher = entryState === "called";
      state.entries = [
        {
          id: 11,
          event_id: 1,
          user_id: state.me.id,
          user_name: state.me.name,
          group_id: 1,
          state: entryState,
          position: 1,
          score: 0,
          skipped: false,
          called_at: entryState === "called" ? "2030-01-01T10:00:00Z" : null,
          joined_at: "2030-01-01T09:00:00Z",
        },
      ];
      const commands = await open(page, state);
      const panel = page.locator(".queue-position");
      await expect(panel.locator("strong")).toHaveText(
        entryState === "called" ? "Вызван" : "01",
      );
      await expect(panel.locator("p")).toHaveText(
        entryState === "called" ? "Преподаватель ждёт вас" : "Ожидание ≈ 0 мин",
      );
      await expect(page.locator("#join-reason")).toHaveCount(0);
      await assertLayout(page, width);
      await panel
        .getByRole("button", { name: "Выйти из очереди", exact: true })
        .click();
      await expect
        .poll(() => commands)
        .toEqual([{ kind: "leave", event_id: 1, id: 11 }]);
      await expect(panel.locator("p:not(#join-reason)")).toHaveText(
        "Вы пока не в очереди",
      );
      await assertLayout(page, width);
    });
  }
}
