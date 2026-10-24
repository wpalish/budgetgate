import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import definition from "../module.js";
import { WorkStore } from "../core/store.js";

const admin = { name: "synthetic-approver", role: "admin" };
const employee = { name: "synthetic-requester", role: "operator" };
const save = (store, collection, data, id, actor = admin) => {
  const state = store.transact(
    { operation: "save", collection, data, id, revision: store.read().revision },
    actor,
  );
  return state.data[collection].find((row) => row.id === id) ||
    state.data[collection].at(-1);
};
const budget = (store, currency = "KZT") =>
  save(store, "budgets", { name: "SYNTHETIC budget", currency, limit: "10000" });
const request = (store, parent) =>
  save(store, "requests", {
    budget: parent.id, purpose: "SYNTHETIC expense", amount: "7000", status: "pending",
  }, undefined, employee);
const data = (row, overrides = {}) => ({ ...row, ...overrides });
const audit = (store) => store.db.prepare("SELECT * FROM audit ORDER BY rowid").all();
function unchangedRejection(store, action, pattern) {
  const before = store.read(), events = audit(store);
  assert.throws(action, pattern);
  assert.deepEqual(store.read(), before, "Rejected operation preserves data, totals and revision");
  assert.deepEqual(audit(store), events, "Rejected operation adds no audit event");
}

test("linked pending, approved, spent, rejected and archived requests retain their budget currency", () => {
  for (const status of ["pending", "approved", "spent", "rejected", "archived"]) {
    const store = new WorkStore(definition);
    try {
      const b = budget(store);
      let r = request(store, b);
      if (["approved", "spent"].includes(status))
        r = save(store, "requests", data(r, { status: "approved" }), r.id);
      if (status === "spent")
        r = save(store, "requests", data(r, { status: "spent" }), r.id, employee);
      if (status === "rejected")
        r = save(store, "requests", data(r, { status: "rejected" }), r.id);
      if (status === "archived")
        store.transact({ operation: "archive", collection: "requests", id: r.id,
          revision: store.read().revision }, admin);
      unchangedRejection(store,
        () => save(store, "budgets", data(b, { currency: "USD" }), b.id), /валют/i);
      // Same currency limit/name changes remain available, including a used budget.
      save(store, "budgets", data(b, { limit: "12000", name: "SYNTHETIC revised limit" }), b.id);
      assert.equal(store.read().data.budgets[0].currency, "KZT");
    } finally { store.close(); }
  }
  const store = new WorkStore(definition);
  try {
    const b = budget(store);
    save(store, "budgets", data(b, { currency: "USD" }), b.id);
    assert.equal(store.read().data.budgets[0].currency, "USD", "Empty budget can change currency");
  } finally { store.close(); }
});

test("pending request moves require matching currencies; same-currency correction stays available", () => {
  const store = new WorkStore(definition);
  try {
    const source = budget(store), other = budget(store), usd = budget(store, "USD");
    const r = request(store, source);
    unchangedRejection(store,
      () => save(store, "requests", data(r, { budget: usd.id }), r.id, employee), /валют/i);
    const moved = save(store, "requests", data(r, { budget: other.id, amount: "6500" }), r.id, employee);
    assert.equal(moved.budget, other.id);
    assert.equal(moved.amount, "6500");
    save(store, "requests", data(moved, { status: "approved" }), moved.id);
    assert.match(JSON.stringify(store.read().computed), /6500.00/);
  } finally { store.close(); }
});

test("currency rules survive file restart and restore while preserving approved and spent totals", () => {
  const folder = mkdtempSync(join(tmpdir(), "budgetgate-currency-"));
  const path = join(folder, "workspace.sqlite");
  let store = new WorkStore(definition, path);
  const restored = new WorkStore(definition);
  try {
    const b = budget(store);
    let r = request(store, b);
    r = save(store, "requests", data(r, { status: "approved" }), r.id);
    save(store, "requests", data(r, { status: "spent" }), r.id, employee);
    const before = store.read(), copy = store.export(), events = audit(store);
    store.close();
    store = new WorkStore(definition, path);
    assert.deepEqual(store.read(), before);
    assert.deepEqual(audit(store), events);
    restored.restore(copy);
    assert.deepEqual(restored.read().data, before.data);
    assert.deepEqual(restored.read().computed, before.computed);
    for (const target of [store, restored])
      unchangedRejection(target,
        () => save(target, "budgets", data(b, { currency: "USD" }), b.id), /валют/i);
  } finally {
    store.close(); restored.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
