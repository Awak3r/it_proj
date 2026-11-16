import { expect, test } from "@playwright/test";
import type { State } from "../src/types";

// Real API + UI; deliberately outside the mocked allowlist (one worker).
// Only run against a freshly seeded disposable localhost app, never the sandbox.
test("curriculum API/UI: subject checkboxes, preserve edits, unlink errors, dependent events and isolation", async ({
  page,
  baseURL,
}) => {
  expect(["127.0.0.1", "localhost", "[::1]"]).toContain(
    new URL(baseURL!).hostname,
  );
  const config = await page.request.get("/api/config");
  expect(await config.json()).toMatchObject({ dev_auth: true });
  const send = (data: Record<string, unknown>, user = 1001) =>
    page.request.post("/api/command", {
      headers: {
        "X-Dev-User": String(user),
        "Idempotency-Key": crypto.randomUUID(),
      },
      data,
    });
  const command = async (data: Record<string, unknown>, user = 1001) => {
    const response = await send(data, user);
    expect(response.ok(), await response.text()).toBeTruthy();
  };
  const read = async (user = 1001): Promise<State> => {
    const response = await page.request.get("/api/state", {
      headers: { "X-Dev-User": String(user) },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
  const name = `Curriculum UI ${crypto.randomUUID()}`;
  const groupIDs: number[] = [];
  const subjectIDs: number[] = [];
  const student =
    Number.parseInt(crypto.randomUUID().replaceAll("-", "").slice(0, 12), 16) +
    1_000_000_000_000;
  expect((await read()).users.some((u) => u.id === student)).toBe(false);
  try {
    for (const suffix of ["A", "B", "Empty"]) {
      await command({ kind: "group", name: `${name} ${suffix}` });
      groupIDs.push(
        (await read()).groups.find((g) => g.name === `${name} ${suffix}`)!.id,
      );
    }
    await page.route("https://telegram.org/**", (route) => route.abort());
    await page.addInitScript(() => {
      if (!localStorage.getItem("dev-user"))
        localStorage.setItem("dev-user", "1001");
    });
    await page.goto("/");
    await page.getByRole("button", { name: /Управление root/ }).click();
    await page
      .locator("nav")
      .getByRole("button", { name: "Управление", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Добавить предмет", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Название", { exact: true }).fill(name);
    await dialog
      .getByRole("checkbox", { name: `${name} A`, exact: true })
      .check();
    await dialog
      .getByRole("checkbox", { name: `${name} B`, exact: true })
      .check();
    const createRequest = page.waitForRequest(
      (r) =>
        r.url().endsWith("/api/command") && r.postDataJSON().kind === "subject",
    );
    await dialog
      .getByRole("button", { name: "Сохранить", exact: true })
      .click();
    expect((await createRequest).postDataJSON()).toMatchObject({
      group_ids: groupIDs.slice(0, 2),
    });
    await expect(dialog).toHaveCount(0);
    const subject = (await read()).subjects.find((s) => s.name === name)!;
    subjectIDs.push(subject.id);
    const links = async () =>
      (await read())
        .subject_groups!.filter((l) => l.subject_id === subject.id)
        .map((l) => l.group_id)
        .sort((a, b) => a - b);
    expect(await links()).toEqual(groupIDs.slice(0, 2));
    // Omitted and null group_ids are preservation edits, including archival.
    await command({ kind: "subject", id: subject.id, name: `${name} renamed` });
    await command({
      kind: "subject",
      id: subject.id,
      name,
      enabled: true,
      group_ids: null,
    });
    expect(await links()).toEqual(groupIDs.slice(0, 2));
    await command({ kind: "subject", id: subject.id, name, enabled: false });
    await command({
      kind: "lab",
      subject_id: subject.id,
      group_id: groupIDs[0],
      number: 1,
      name,
    });
    await page.reload();
    await page.getByRole("button", { name: /Управление root/ }).click();
    await page
      .locator("nav")
      .getByRole("button", { name: "Управление", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: new RegExp(name + ".*Группы:") }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: new RegExp(name + ".*Группы:") })
      .click();
    await dialog
      .getByRole("checkbox", { name: `${name} A`, exact: true })
      .uncheck();
    await dialog
      .getByRole("button", { name: "Сохранить", exact: true })
      .click();
    await expect(dialog.getByRole("alert")).toContainText(
      "сначала архивируйте",
    );
    expect(await links()).toEqual(groupIDs.slice(0, 2));
    await dialog.locator(".icon-button").click();
    // A teacher needs no assignments and retains teaching controls for this new pair.
    const teacher = await read(2001);
    expect(teacher.me.teacher).toBe(true);
    expect(teacher.subject_groups).toEqual(
      expect.arrayContaining([
        { subject_id: subject.id, group_id: groupIDs[0] },
        { subject_id: subject.id, group_id: groupIDs[1] },
      ]),
    );
    await page.evaluate(() => localStorage.setItem("dev-user", "2001"));
    await page.reload();
    await page
      .locator("nav")
      .getByRole("button", { name: "Ведомость", exact: true })
      .click();
    await page
      .getByLabel("Группа", { exact: true })
      .selectOption(String(groupIDs[0]));
    await expect(
      page.getByLabel("Предмет", { exact: true }).locator("option"),
    ).toHaveText([name]);
    for (const control of ["Добавить работу", "Экспорт", "Статистика"]) {
      await expect(
        page.getByRole("button", { name: control, exact: true }),
      ).toBeEnabled();
    }
    await page
      .getByLabel("Группа", { exact: true })
      .selectOption(String(groupIDs[1]));
    await expect(page.getByLabel("Предмет", { exact: true })).toHaveValue(
      String(subject.id),
    );
    await page
      .getByLabel("Группа", { exact: true })
      .selectOption(String(groupIDs[2]));
    await expect(
      page.getByText("Нет предметов для этой группы", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("table")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Добавить работу", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Экспорт", exact: true }),
    ).toBeDisabled();
    await command({
      kind: "subject",
      name: `${name} other`,
      group_ids: [groupIDs[2]],
    });
    const other = (await read()).subjects.find(
      (s) => s.name === `${name} other`,
    )!;
    subjectIDs.push(other.id);
    await page.reload();
    await page
      .getByRole("button", { name: "Создать событие", exact: true })
      .click();
    await dialog
      .getByLabel("Предмет", { exact: true })
      .selectOption(String(subject.id));
    const eventGroups = dialog.getByLabel("Группы (можно выбрать несколько)");
    await expect(eventGroups.locator("option")).toHaveText([
      `${name} A`,
      `${name} B`,
    ]);
    await eventGroups.selectOption(String(groupIDs[0]));

    await dialog
      .getByLabel("Предмет", { exact: true })
      .selectOption(String(other.id));
    await expect(eventGroups.locator("option")).toHaveText([`${name} Empty`]);
    await expect(eventGroups.locator("option:checked")).toHaveCount(0);
    await dialog.getByLabel("Название события").fill(name);
    await dialog
      .getByLabel("Начало · московское время")
      .fill("2030-01-01T12:00");
    await eventGroups.selectOption(String(groupIDs[2]));
    await dialog
      .getByRole("button", { name: "Сохранить", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    expect((await read()).events.find((e) => e.name === name)).toMatchObject({
      subject_id: other.id,
      group_ids: [groupIDs[2]],
    });
    await command({ kind: "profile", name, group_id: groupIDs[0] }, student);
    const own = await read(student);
    expect(own.subject_groups).toEqual([
      { subject_id: subject.id, group_id: groupIDs[0] },
    ]);
    expect(own.subjects.some((s) => s.id === other.id)).toBe(false);
    await page.evaluate(
      (id) => localStorage.setItem("dev-user", String(id)),
      student,
    );
    await page.reload();
    await page
      .locator("nav")
      .getByRole("button", { name: "Ведомость", exact: true })
      .click();
    await expect(
      page.getByLabel("Предмет", { exact: true }).locator("option"),
    ).toHaveText([name]);
    await expect(
      page.getByRole("button", { name: "Экспорт", exact: true }),
    ).toHaveCount(0);
    const lab = (await read()).labs.find((l) => l.subject_id === subject.id)!;
    await command({ kind: "lab", ...lab, enabled: true });
    await command({ kind: "subject", id: subject.id, name, group_ids: [] });
    expect(await links()).toEqual([]);
  } finally {
    const state = await read();
    for (const event of state.events.filter(
      (e) =>
        subjectIDs.includes(e.subject_id) &&
        ["planned", "live"].includes(e.state),
    ))
      await command({
        kind: "event_action",
        event_id: event.id,
        action: "cancel",
      });
    for (const lab of state.labs.filter(
      (l) => subjectIDs.includes(l.subject_id) && !l.archived,
    ))
      await command({ kind: "lab", ...lab, enabled: true });
    for (const subject of state.subjects.filter((s) =>
      subjectIDs.includes(s.id),
    ))
      await command({
        kind: "subject",
        id: subject.id,
        name: subject.name,
        enabled: true,
      });
    for (const group of state.groups.filter((g) => groupIDs.includes(g.id)))
      await command({
        kind: "group",
        id: group.id,
        name: group.name,
        enabled: true,
      });
  }
});
