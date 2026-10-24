import {
  F,
  S,
  R,
  C,
  live,
  rows,
  byId,
  unique,
  required,
  minor,
  amount,
  interval,
  noOverlap,
  changed,
  immutable,
  admin,
  totalLines,
  summary,
  clock,
  label,
} from "./core/rules.js";
const definition = {
  slug: "budgetgate",
  reference: 66,
  title: "BudgetGate",
  description:
    "Заявки на расходы, независимое согласование и резервирование лимита подразделения. Деньги не переводятся.",
  limitations:
    "Одна организация · Собственный сервер · Ручной ввод · Без банковских и внешних интеграций",
  collections: [
    C(
      "budgets",
      "Лимиты",
      [
        F("name", "Подразделение / период"),
        S("currency", "Валюта", ["KZT", "USD", "KGS", "UZS"]),
        F("limit", "Лимит", "money"),
      ],
      { writeRole: "admin" },
    ),
    C("requests", "Заявки", [
      R("budget", "Лимит", "budgets"),
      F("purpose", "Цель расхода"),
      F("amount", "Сумма", "money"),
      S("status", "Состояние", [
        ["pending", "Запрошено"],
        ["approved", "Одобрено"],
        ["rejected", "Отклонено"],
        ["spent", "Расход отмечен"],
      ]),
    ]),
  ],
  validate(state, before, command, actor) {
    for (const r of rows(state, "requests")) {
      required(minor(r.amount) > 0, "Сумма должна быть положительной.");
      const old = changed(before, "requests", r.id);
      if (old && old.budget !== r.budget)
        required(
          byId(before, "budgets", old.budget).currency ===
            byId(state, "budgets", r.budget).currency,
          "Перенос заявки возможен только в лимит той же валюты. Для другой валюты создайте новую заявку с явно указанной суммой.",
        );
      if (!old)
        required(r.status === "pending", "Новая заявка создаётся в ожидании.");
      if (old && r.status !== old.status) {
        required(
          (old.status === "pending" &&
            ["approved", "rejected"].includes(r.status)) ||
            (old.status === "approved" && r.status === "spent"),
          "Недопустимый переход состояния заявки.",
        );
        if (["approved", "rejected"].includes(r.status)) {
          admin(actor);
          required(
            old.status === "pending" && old.createdBy !== actor.name,
            "Согласует другой сотрудник с ролью администратора.",
          );
        }
        if (r.status === "spent")
          required(
            old.status === "approved" &&
              (actor.role === "admin" || actor.name === old.createdBy),
            "Сначала получите одобрение.",
          );
      }
      if (old && ["approved", "spent", "rejected"].includes(old.status))
        immutable(old, r, ["budget", "purpose", "amount", "archived"]);
      if (old?.status === "spent") immutable(old, r, ["status"]);
    }
    for (const b of rows(state, "budgets")) {
      const old = changed(before, "budgets", b.id);
      if (old && old.currency !== b.currency)
        required(
          !rows(state, "requests").some((x) => x.budget === b.id),
          "В лимите есть заявки: валюту менять нельзя. Создайте отдельный лимит для другой валюты.",
        );
      const used = rows(state, "requests")
        .filter(
          (x) => x.budget === b.id && ["approved", "spent"].includes(x.status),
        )
        .reduce((s, x) => s + minor(x.amount), 0);
      required(
        used <= minor(b.limit),
        "Лимит превышен с учётом согласованных заявок.",
      );
      if (b.archived)
        required(used === 0, "В лимите есть зафиксированные расходы.");
    }
  },
  summarize(state) {
    return rows(state, "budgets").map((b) => {
      const used = rows(state, "requests")
        .filter(
          (x) => x.budget === b.id && ["approved", "spent"].includes(x.status),
        )
        .reduce((s, x) => s + minor(x.amount), 0);
      return summary(
        b.name + " · " + b.currency,
        "Зарезервировано и отмечено: " + amount(used),
        "Доступно: " + amount(minor(b.limit) - used),
      );
    });
  },
};
export default definition;
