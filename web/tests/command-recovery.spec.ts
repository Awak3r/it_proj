import { test, expect, type Page } from "@playwright/test";
import type { State } from "../src/types";

type CommandMode = "normal" | "slow" | "lost" | "body-stall";
type FakeAPI = {
  commandMode: CommandMode;
  holdState: boolean;
  staleState: boolean;
  commands: { key: string; body: string }[];
  commits: number;
  stateReads: number;
  commandAborts: number;
  bodyReads: number;
  releaseCommand: () => void;
  releaseStates: () => void;
  change: () => void;
};

declare global {
  interface Window {
    commandRecovery: FakeAPI;
  }
}

const unknownResult =
  "Сервер не ответил вовремя. Результат команды неизвестен. Повторите действие: повтор защищён от дублирования.";
const savedNotUpdated =
  "Изменение сохранено, но данные не обновились. Повторите обновление.";
const finishBody = { kind: "finish", event_id: 1, id: 11 };

function snapshot(): State {
  const me = {
    id: 2001,
    name: "Преподаватель очереди",
    group_id: null,
    teacher: true,
    root: false,
  };
  return {
    me,
    users: [
      me,
      { id: 3001, name: "Анна Студентова", group_id: 1, teacher: false },
    ],
    groups: [{ id: 1, name: "ИВТ-101", archived: false }],
    subjects: [{ id: 1, name: "Программирование", archived: false }],
    subject_groups: [{ subject_id: 1, group_id: 1 }],
    assignments: [],
    labs: [],
    grades: [],
    grade_summaries: [],
    events: [
      {
        id: 1,
        name: "Восстановление приёма",
        subject_id: 1,
        teacher_id: me.id,
        teacher_name: me.name,
        group_ids: [1],
        starts_at: "2030-01-01T10:00:00Z",
        room: "101",
        description: "",
        duration: 10,
        state: "live",
        registration_open: true,
        strategy: "fifo",
        shuffled: false,
        first_called: true,
        manual_order: false,
        average_minutes: null,
      },
    ],
    entries: [
      {
        id: 11,
        event_id: 1,
        user_id: 3001,
        user_name: "Анна Студентова",
        group_id: 1,
        state: "called",
        position: 1,
        score: 0,
        skipped: false,
        called_at: "2030-01-01T10:00:00Z",
        joined_at: "2030-01-01T09:00:00Z",
      },
    ],
    audit: [],
  };
}

async function open(page: Page, commandMode: CommandMode = "normal") {
  const origin = new URL(test.info().project.use.baseURL as string).origin;
  // No backend, Telegram script, or external resource may escape this fixture.
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return url.origin === origin && !url.pathname.startsWith("/api/")
      ? route.continue()
      : route.abort();
  });
  const now = new Date("2030-01-01T10:00:00Z");
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now);
  await page.addInitScript(
    ({ state, commandMode }) => {
      localStorage.setItem("dev-user", String(state.me.id));
      const originalFetch = window.fetch.bind(window);
      const stale = structuredClone(state);
      const results = new Map<string, string>();
      const pendingStates: (() => void)[] = [];
      let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
      const api: FakeAPI = (window.commandRecovery = {
        commandMode,
        holdState: false,
        staleState: false,
        commands: [],
        commits: 0,
        stateReads: 0,
        commandAborts: 0,
        bodyReads: 0,
        releaseCommand: () => {},
        releaseStates: () =>
          pendingStates.splice(0).forEach((release) => release()),
        change: () =>
          stream?.enqueue(
            new TextEncoder().encode("event: change\ndata: {}\n\n"),
          ),
      });
      const json = (data: unknown) =>
        new Response(JSON.stringify(data), {
          headers: { "Content-Type": "application/json" },
        });
      const wait = (
        signal: AbortSignal | null | undefined,
        command = false,
      ) => {
        let release!: () => void;
        const promise = new Promise<void>((resolve, reject) => {
          const abort = () => {
            if (command) api.commandAborts++;
            reject(new DOMException("Aborted", "AbortError"));
          };
          release = () => {
            signal?.removeEventListener("abort", abort);
            resolve();
          };
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        });
        return { promise, release };
      };
      window.fetch = async (input, init) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
          location.href,
        );
        if (url.origin !== location.origin)
          throw new Error("External fetch blocked");
        if (!url.pathname.startsWith("/api/"))
          return originalFetch(input, init);
        if (url.pathname === "/api/config") return json({ dev_auth: true });
        if (url.pathname === "/api/updates") {
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
              api.change();
              init?.signal?.addEventListener(
                "abort",
                () => controller.close(),
                { once: true },
              );
            },
          });
          return new Response(body, {
            headers: { "Content-Type": "text/event-stream" },
          });
        }
        if (url.pathname === "/api/state") {
          api.stateReads++;
          if (api.holdState) {
            const held = wait(init?.signal);
            pendingStates.push(held.release);
            await held.promise;
          }
          return json(api.staleState ? stale : state);
        }
        if (url.pathname === "/api/command" && init?.method === "POST") {
          const body = String(init.body);
          const key = new Headers(init.headers).get("Idempotency-Key") || "";
          api.commands.push({ key, body });
          if (api.commandMode === "slow") {
            const held = wait(init.signal, true);
            api.releaseCommand = held.release;
            await held.promise;
          }
          if (results.has(key)) {
            return results.get(key) === body
              ? json({ ok: true })
              : new Response(JSON.stringify({ error: "Key/body mismatch" }), {
                  status: 409,
                });
          }
          const command = JSON.parse(body);
          if (
            command.kind !== "finish" ||
            command.event_id !== 1 ||
            command.id !== 11
          )
            throw new Error("Unexpected command");
          results.set(key, body);
          api.commits++;
          state.entries[0].state = "finished";
          if (api.commandMode === "lost") {
            await wait(init.signal, true).promise;
          }
          if (api.commandMode === "body-stall") {
            const response = json({ ok: true });
            // Headers arrive, but decoding the body waits until the request is aborted.
            response.json = async () => {
              api.bodyReads++;
              await wait(init.signal, true).promise;
              return { ok: true };
            };
            return response;
          }
          return json({ ok: true });
        }
        throw new Error(
          `Unmocked API: ${init?.method || "GET"} ${url.pathname}`,
        );
      };
    },
    { state: snapshot(), commandMode },
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: "Я преподаватель", exact: true })
    .click();
  await page
    .getByRole("button")
    .filter({
      has: page.getByRole("heading", {
        name: "Восстановление приёма",
        exact: true,
      }),
    })
    .click();
  await page.clock.runFor(100);
  await expect(page.locator(".current-student")).toContainText(
    "Анна Студентова",
  );
  await expect(finish(page)).toBeEnabled();
}

function finish(page: Page) {
  return page.getByRole("button", { name: "Завершить приём", exact: true });
}

async function idle(page: Page) {
  await expect(page.locator(".busy")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Закрыть запись", exact: true }),
  ).toBeEnabled();
}

async function finished(page: Page) {
  await idle(page);
  await expect(page.locator(".current-student")).toHaveCount(0);
  await expect(
    page.locator(".queue-row").filter({ hasText: "Анна Студентова" }),
  ).toHaveCount(0);
  await expect(finish(page)).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Вызвать следующего", exact: false }),
  ).toBeEnabled();
}

test("normal finish removes the called entry and releases controls", async ({
  page,
}) => {
  await open(page);
  await finish(page).click();
  await finished(page);
  const result = await page.evaluate(() => ({
    commands: window.commandRecovery.commands,
    commits: window.commandRecovery.commits,
  }));
  expect(result.commits).toBe(1);
  expect(result.commands).toHaveLength(1);
  expect(JSON.parse(result.commands[0].body)).toEqual(finishBody);
  expect(result.commands[0].key.length).toBeGreaterThanOrEqual(8);
});

test("slow finish sends one POST and cannot be submitted again while busy", async ({
  page,
}) => {
  await open(page, "slow");
  await finish(page).click();
  await expect(page.locator(".busy")).toHaveText("Сохраняем…");
  await expect(finish(page)).toBeDisabled();
  await page.clock.runFor(14000);
  // Native activation of a disabled button must not dispatch another command.
  await finish(page).evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  expect(
    await page.evaluate(() => window.commandRecovery.commands.length),
  ).toBe(1);
  await expect(page.locator(".busy")).toHaveText("Сохраняем…");
  await page.evaluate(() => window.commandRecovery.releaseCommand());
  await finished(page);
  expect(await page.evaluate(() => window.commandRecovery.commits)).toBe(1);
});

for (const mode of ["lost", "body-stall"] as const) {
  test(`${mode} POST times out and retry reuses the exact key and body once`, async ({
    page,
  }) => {
    await open(page, mode);
    await page.evaluate(() => {
      window.commandRecovery.staleState = true;
    });
    await finish(page).click();
    await expect
      .poll(() => page.evaluate(() => window.commandRecovery.commits))
      .toBe(1);
    if (mode === "body-stall")
      await expect
        .poll(() => page.evaluate(() => window.commandRecovery.bodyReads))
        .toBe(1);
    await expect(page.locator(".busy")).toHaveText("Сохраняем…");
    await page.clock.runFor(15001);
    await expect(page.getByText(unknownResult, { exact: true })).toBeVisible();
    await idle(page);
    await expect(finish(page)).toBeEnabled();
    await expect(page.locator(".current-student")).toContainText(
      "Анна Студентова",
    );
    await expect(page.getByText("Готово", { exact: true })).toHaveCount(0);
    expect(
      await page.evaluate(() => window.commandRecovery.commandAborts),
    ).toBe(1);
    expect(
      await page.evaluate(() => window.commandRecovery.commands.length),
    ).toBe(1);
    await page.evaluate(() => {
      window.commandRecovery.commandMode = "normal";
      window.commandRecovery.staleState = false;
    });
    await finish(page).click();
    await finished(page);
    const result = await page.evaluate(() => ({
      commands: window.commandRecovery.commands,
      commits: window.commandRecovery.commits,
    }));
    expect(result.commands).toHaveLength(2);
    expect(result.commands[1]).toEqual(result.commands[0]);
    expect(JSON.parse(result.commands[1].body)).toEqual(finishBody);
    expect(result.commits).toBe(1);
  });
}

test("acknowledged finish shows updating, not saving, until its snapshot arrives", async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() => {
    window.commandRecovery.holdState = true;
  });
  await finish(page).click();
  await expect(page.locator(".busy")).toHaveText("Обновляем…");
  await expect(page.getByText("Сохраняем…", { exact: true })).toHaveCount(0);
  await expect(finish(page)).toBeDisabled();
  await page.clock.runFor(14000);
  await expect(page.locator(".busy")).toHaveText("Обновляем…");
  await page.evaluate(() => {
    window.commandRecovery.holdState = false;
    window.commandRecovery.releaseStates();
  });
  await finished(page);
});

test("state timeout reports saved-but-not-updated and online recovery removes stale entry", async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() => {
    window.commandRecovery.holdState = true;
  });
  await finish(page).click();
  await expect(page.locator(".busy")).toHaveText("Обновляем…");
  await page.clock.runFor(15001);
  await idle(page);
  await expect(page.getByText(savedNotUpdated, { exact: true })).toBeVisible();

  await expect(page.getByText("Готово", { exact: true })).toHaveCount(0);
  await expect(finish(page)).toBeEnabled();
  await expect(page.locator(".current-student")).toContainText(
    "Анна Студентова",
  );
  await page.evaluate(() => {
    window.commandRecovery.holdState = false;
    window.dispatchEvent(new Event("online"));
  });
  await page.clock.runFor(100);
  await finished(page);
  expect(
    await page.evaluate(() => window.commandRecovery.commands.length),
  ).toBe(1);
  expect(await page.evaluate(() => window.commandRecovery.commits)).toBe(1);
});

test("SSE superseding state reads cannot extend the whole confirmation beyond 15 seconds", async ({
  page,
}) => {
  await open(page);
  const before = await page.evaluate(() => {
    window.commandRecovery.holdState = true;
    return window.commandRecovery.stateReads;
  });
  await finish(page).click();
  await expect(page.locator(".busy")).toHaveText("Обновляем…");
  for (let i = 0; i < 3; i++) {
    await page.clock.runFor(4000);
    await page.evaluate(() => window.commandRecovery.change());
    await page.clock.runFor(50);
    await expect
      .poll(() => page.evaluate(() => window.commandRecovery.stateReads))
      .toBe(before + i + 2);
  }
  await page.clock.runFor(2750);
  await expect(page.locator(".busy")).toHaveText("Обновляем…");
  await page.clock.runFor(101);
  await idle(page);
  await expect(page.getByText(savedNotUpdated, { exact: true })).toBeVisible();
  await expect(page.getByText("Готово", { exact: true })).toHaveCount(0);
  await expect(finish(page)).toBeEnabled();
  // Newer reads are still pending; release them without another mutation.
  await page.evaluate(() => {
    window.commandRecovery.holdState = false;
    window.commandRecovery.releaseStates();
  });
  await finished(page);
  expect(
    await page.evaluate(() => window.commandRecovery.commands.length),
  ).toBe(1);
});
