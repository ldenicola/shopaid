/* ShopAid — weekly grocery promo helper. Plain JS, no build step. */

const STORES = {
  checkers:   { name: "Checkers / Shoprite", short: "Checkers", card: "Xtra Savings" },
  pnp:        { name: "Pick n Pay",          short: "PnP",      card: "Smart Shopper" },
  woolworths: { name: "Woolworths",          short: "Woolies",  card: "WRewards" },
  spar:       { name: "SPAR",                short: "SPAR",     card: "SPAR Rewards" },
};

const state = {
  items: [],            // specials
  sources: {},
  meals: [],
  list: [],             // my regular list
  cards: { checkers: true, pnp: true, woolworths: true, spar: true },
  storeFilter: new Set(Object.keys(STORES)),
};

/* ---------- storage (per-browser; wrapped because it can be unavailable) ---------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

/* ---------- helpers ---------- */
const $ = (s) => document.querySelector(s);
const R = (n) => "R" + (Math.round(n * 100) / 100).toFixed(2).replace(/\.00$/, "");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const uid = () => Math.random().toString(36).slice(2, 9);

function norm(s) {
  return String(s || "").toLowerCase()
    .replace(/(\d)\s*(litres?|liters?|lt)\b/g, "$1l")
    .replace(/(\d)\s*(kgs?|kilograms?)\b/g, "$1kg")
    .replace(/(\d)\s*(grams?|gr)\b/g, "$1g")
    .replace(/(\d)\s*(ml)\b/g, "$1ml")
    .replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Price you'd actually pay at that store, given which cards you have. */
function effPrice(d) {
  if (d.loyalty_price != null && state.cards[d.store]) return d.loyalty_price;
  return d.price;
}
function wasPrice(d) { return d.was_price ?? d.price; }
function saving(d) { return Math.max(0, wasPrice(d) - effPrice(d)); }
function pctOff(d) { const w = wasPrice(d); return w ? saving(d) / w : 0; }

/** Does a deal match a list item? Keywords: comma-separated alternatives;
 *  every word of one alternative must start a word in the deal name+size. */
function matches(listItem, deal) {
  const hay = norm(deal.name + " " + (deal.size || "")).split(" ");
  const alts = (listItem.keys || listItem.name).split(",").map(norm).filter(Boolean);
  return alts.some((alt) => alt.split(" ").every((w) => hay.some((h) => h.startsWith(w))));
}

function dealsFor(listItem) {
  return state.items.filter((d) => matches(listItem, d)).sort((a, b) => effPrice(a) - effPrice(b));
}

/* ---------- data loading ---------- */
async function loadJSON(path, fallback) {
  try { const r = await fetch(path + "?v=" + Date.now()); return r.ok ? await r.json() : fallback; }
  catch { return fallback; }
}

async function init() {
  const [specials, meals, seed] = await Promise.all([
    loadJSON("data/specials.json", { items: [], sources: {} }),
    loadJSON("data/meals.json", { meals: [] }),
    loadJSON("data/my-list.json", { items: [] }),
  ]);
  state.items = specials.items || [];
  state.sources = specials.sources || {};
  state.meals = meals.meals || [];
  state.list = store.get("list", null) || (seed.items || []).map((i) => ({ id: uid(), qty: 1, ...i }));
  state.cards = { ...state.cards, ...store.get("cards", {}) };

  $("#updated").textContent = specials.updated
    ? "Updated " + new Date(specials.updated).toLocaleString("en-ZA", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
    : "No specials fetched yet";
  $("#mealsUpdated").textContent = meals.updated ? "Ideas from the specials fetched " + new Date(meals.updated).toLocaleDateString("en-ZA", { day: "numeric", month: "short" }) : "";

  const notes = [];
  if (specials.sample) notes.push("Showing sample data. Real specials appear after the weekly job first runs.");
  for (const [k, s] of Object.entries(state.sources)) {
    if (s.status === "empty") notes.push(`${STORES[k]?.name || k}: no deals found on the last run. Check the store's address in scraper/config.yaml.`);
    if (s.status === "stale") notes.push(`${STORES[k]?.name || k}: couldn't refresh, showing the previous run's deals.`);
  }
  if (notes.length) { $("#banner").hidden = false; $("#banner").innerHTML = notes.map(esc).join("<br>"); }

  buildFilters();
  renderAll();
}

function save() { store.set("list", state.list); store.set("cards", state.cards); }

/* ---------- MY LIST ---------- */
function renderList() {
  const ul = $("#listItems");
  if (!state.list.length) { ul.innerHTML = `<li class="empty">Your list is empty. Add the things you buy most weeks.</li>`; return; }
  ul.innerHTML = state.list.map((li) => {
    const ds = dealsFor(li);
    const best = ds[0];
    const line = best
      ? `<div class="match"><span class="best">${R(effPrice(best))}</span> at <span class="tag ${best.store}">${STORES[best.store].short}</span>${esc(best.name)}${best.size ? " " + esc(best.size) : ""}${ds.length > 1 ? ` <span class="muted">· ${ds.length - 1} more</span>` : ""}</div>`
      : `<div class="match muted">Not on promo this week</div>`;
    return `<li class="card" data-id="${li.id}" role="button">
      <div class="body"><div class="name">${esc(li.name)}${li.qty > 1 ? ` <span class="muted">× ${li.qty}</span>` : ""}</div>${line}</div>
      ${best && saving(best) > 0 ? `<div class="price"><div class="off">save ${R(saving(best) * (li.qty || 1))}</div></div>` : ""}
    </li>`;
  }).join("");
}

$("#addForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("#addName").value.trim();
  if (!name) return;
  state.list.unshift({ id: uid(), name, keys: name, qty: 1 });
  $("#addName").value = "";
  save(); renderAll();
});

let editing = null;
$("#listItems").addEventListener("click", (e) => {
  const li = e.target.closest("[data-id]");
  if (!li) return;
  editing = state.list.find((x) => x.id === li.dataset.id);
  $("#itemTitle").textContent = editing.name;
  $("#itemName").value = editing.name;
  $("#itemKeys").value = editing.keys || editing.name;
  $("#itemQty").value = editing.qty || 1;
  previewMatches();
  $("#itemDlg").showModal();
});
$("#itemKeys").addEventListener("input", previewMatches);
function previewMatches() {
  const tmp = { keys: $("#itemKeys").value || $("#itemName").value };
  const ds = state.items.filter((d) => matches(tmp, d)).slice(0, 6);
  $("#itemMatches").innerHTML = ds.length
    ? "<p class='muted'>Matches this week:</p>" + ds.map((d) => `<div><span class="tag ${d.store}">${STORES[d.store].short}</span>${esc(d.name)} — ${R(effPrice(d))}</div>`).join("")
    : "<p class='muted'>No matches this week.</p>";
}
$("#itemDlg").addEventListener("close", () => {
  const v = $("#itemDlg").returnValue;
  if (!editing) return;
  if (v === "delete") state.list = state.list.filter((x) => x !== editing);
  if (v === "save") {
    editing.name = $("#itemName").value.trim() || editing.name;
    editing.keys = $("#itemKeys").value.trim() || editing.name;
    editing.qty = Math.max(1, parseInt($("#itemQty").value) || 1);
  }
  editing = null; save(); renderAll();
});

/* ---------- DEALS ---------- */
function buildFilters() {
  $("#storeFilter").innerHTML = Object.entries(STORES).map(([k, s]) =>
    `<button class="chip on" data-store="${k}">${s.short} <span class="muted">${state.items.filter((d) => d.store === k).length}</span></button>`).join("");
  const cats = [...new Set(state.items.map((d) => d.category))].sort();
  $("#catFilter").innerHTML = `<option value="">All categories</option>` + cats.map((c) => `<option>${esc(c)}</option>`).join("");
}
$("#storeFilter").addEventListener("click", (e) => {
  const b = e.target.closest("[data-store]"); if (!b) return;
  const k = b.dataset.store;
  state.storeFilter.has(k) ? state.storeFilter.delete(k) : state.storeFilter.add(k);
  b.classList.toggle("on"); renderDeals();
});
["#q", "#catFilter", "#sort"].forEach((s) => $(s).addEventListener("input", renderDeals));

function renderDeals() {
  const q = norm($("#q").value).split(" ").filter(Boolean);
  const cat = $("#catFilter").value;
  let ds = state.items.filter((d) => state.storeFilter.has(d.store) && (!cat || d.category === cat));
  if (q.length) ds = ds.filter((d) => { const h = norm(d.name); return q.every((w) => h.includes(w)); });
  const by = $("#sort").value;
  ds.sort(by === "price" ? (a, b) => effPrice(a) - effPrice(b) : by === "rand" ? (a, b) => saving(b) - saving(a) : (a, b) => pctOff(b) - pctOff(a));
  $("#dealCount").textContent = `${ds.length} deals`;
  const onList = (d) => state.list.some((li) => matches(li, d));
  $("#deals").innerHTML = ds.slice(0, 300).map((d, i) => {
    const usesCard = d.loyalty_price != null && state.cards[d.store];
    return `<li class="card">
      <button class="star ${onList(d) ? "on" : ""}" data-add="${state.items.indexOf(d)}" aria-label="Add to my list">★</button>
      <div class="body">
        <div class="name">${esc(d.name)}</div>
        <div class="sub"><span class="tag ${d.store}">${STORES[d.store]?.short || d.store}</span>${esc(d.size || "")}${d.valid_until ? " · until " + esc(d.valid_until) : ""}</div>
        ${d.promo_text ? `<div class="promo">${esc(d.promo_text)}</div>` : ""}
        ${usesCard ? `<span class="tag card">${STORES[d.store].card} price</span>` : d.loyalty_price != null ? `<div class="sub">${R(d.loyalty_price)} with ${STORES[d.store].card}</div>` : ""}
      </div>
      <div class="price">
        <div class="now">${R(effPrice(d))}</div>
        ${saving(d) > 0 ? `<div class="was">${R(wasPrice(d))}</div><div class="off">-${Math.round(pctOff(d) * 100)}%</div>` : ""}
      </div>
    </li>`;
  }).join("") || `<li class="empty">No deals match.</li>`;
}
$("#deals").addEventListener("click", (e) => {
  const b = e.target.closest("[data-add]"); if (!b) return;
  const d = state.items[+b.dataset.add];
  const words = norm(d.name).split(" ").filter((w) => w.length > 2 && !/^\d/.test(w)).slice(0, 4).join(" ");
  state.list.unshift({ id: uid(), name: d.name, keys: words || d.name, qty: 1 });
  save(); renderAll();
  b.classList.add("on");
});

/* ---------- BASKET ---------- */
function renderBasket() {
  const rows = Object.keys(STORES).map((k) => ({ k, n: 0, cost: 0, save: 0 }));
  const byKey = Object.fromEntries(rows.map((r) => [r.k, r]));
  const split = {}; const missing = [];
  let splitCost = 0, splitSave = 0;

  for (const li of state.list) {
    const qty = li.qty || 1;
    const ds = dealsFor(li);
    if (!ds.length) { missing.push(li.name); continue; }
    // best deal per store
    for (const k of Object.keys(STORES)) {
      const d = ds.find((x) => x.store === k);
      if (d) { byKey[k].n++; byKey[k].cost += effPrice(d) * qty; byKey[k].save += saving(d) * qty; }
    }
    const best = ds[0];
    (split[best.store] ||= []).push({ li, d: best });
    splitCost += effPrice(best) * qty; splitSave += saving(best) * qty;
  }

  rows.sort((a, b) => b.n - a.n || b.save - a.save);
  const top = rows[0];
  const listN = state.list.length;
  let verdict;
  if (!listN) verdict = `<h3>Add your regular items</h3><p>The basket view compares stores once your list has a few things on it.</p>`;
  else if (!top || !top.n) verdict = `<h3>Nothing on your list is on promo</h3><p>Shop wherever is most convenient this week.</p>`;
  else {
    const storesUsed = Object.keys(split).length;
    const extra = splitSave - top.save;
    verdict = `<h3>${STORES[top.k].name} this week</h3>
      <p>${top.n} of your ${listN} items are on promo there, saving about ${R(top.save)}.
      ${storesUsed > 1 && extra > 30 ? `Splitting across ${storesUsed} stores would save ${R(extra)} more.` : ""}</p>`;
  }
  $("#verdict").innerHTML = verdict;

  $("#storeTable").innerHTML = `<table><thead><tr><th>Store</th><th class="num">On promo</th><th class="num">Cost</th><th class="num">Saving</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td><span class="tag ${r.k}">${STORES[r.k].short}</span>${state.cards[r.k] ? `<span class="muted small" title="${STORES[r.k].card} prices used">★</span>` : ""}</td>
      <td class="num">${r.n}</td><td class="num">${r.n ? R(r.cost) : "–"}</td><td class="num">${r.n ? R(r.save) : "–"}</td></tr>`).join("")}
    </tbody></table>`;

  $("#split").innerHTML = Object.keys(split).length
    ? Object.entries(split).map(([k, xs]) => `<div class="split-store"><strong><span class="tag ${k}">${STORES[k].short}</span>${xs.length} item${xs.length > 1 ? "s" : ""}</strong>
        <ul>${xs.map(({ li, d }) => `<li>${esc(li.name)} — ${esc(d.name)} ${R(effPrice(d))}${(li.qty || 1) > 1 ? " × " + li.qty : ""}</li>`).join("")}</ul></div>`).join("")
      + `<p class="small"><strong>Total ${R(splitCost)}</strong>, saving ${R(splitSave)}</p>`
    : `<p class="muted">—</p>`;

  $("#missing").innerHTML = missing.map((m) => `<li>${esc(m)}</li>`).join("") || "<li>Everything on your list has a deal somewhere.</li>";
}

/* ---------- MEALS ---------- */
function renderMeals() {
  $("#meals").innerHTML = state.meals.length ? state.meals.map((m) => `
    <article class="meal">
      <h3>${esc(m.title)}</h3>
      <p class="muted small">${m.time_minutes ? m.time_minutes + " min · " : ""}${esc(m.why || "")}</p>
      <div class="small">${(m.uses || []).map((u) => `<div><span class="tag ${u.store}">${STORES[u.store]?.short || esc(u.store)}</span>${esc(u.item)}${u.price ? " " + R(u.price) : ""}</div>`).join("")}</div>
      ${m.also_need?.length ? `<p class="small muted">Also: ${m.also_need.map(esc).join(", ")}</p>` : ""}
      ${m.method?.length ? `<details><summary>Method</summary><ol>${m.method.map((s) => `<li>${esc(s)}</li>`).join("")}</ol></details>` : ""}
    </article>`).join("") : `<p class="empty">Meal ideas appear after the weekly job runs.</p>`;
}

/* ---------- cards dialog ---------- */
$("#cardsBtn").addEventListener("click", () => {
  $("#cardToggles").innerHTML = Object.entries(STORES).map(([k, s]) =>
    `<label class="toggle"><span><span class="tag ${k}">${s.short}</span>${s.card}</span><input type="checkbox" data-card="${k}" ${state.cards[k] ? "checked" : ""}></label>`).join("");
  $("#cardsDlg").showModal();
});
$("#cardToggles").addEventListener("change", (e) => {
  const k = e.target.dataset.card; if (!k) return;
  state.cards[k] = e.target.checked; save(); renderAll();
});

/* ---------- tabs ---------- */
document.querySelectorAll("nav.bottom button").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll("nav.bottom button").forEach((x) => x.classList.toggle("active", x === b));
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === "tab-" + b.dataset.tab));
  window.scrollTo(0, 0);
}));

function renderAll() { renderList(); renderDeals(); renderBasket(); renderMeals(); }

init();
