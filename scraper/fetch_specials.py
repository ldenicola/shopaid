"""ShopAid weekly specials fetcher.

Opens each retailer's specials pages in a headless browser, hands the visible
page text to Claude to pull out the deals as structured data, then asks Claude
for a few meal ideas built around what is on promotion.

Writes:
  docs/data/specials.json   all deals found, per store
  docs/data/meals.json      meal ideas based on this week's specials

Run locally:
  pip install -r scraper/requirements.txt && playwright install chromium
  export ANTHROPIC_API_KEY=...
  python scraper/fetch_specials.py            # all stores
  python scraper/fetch_specials.py pnp spar   # just some
"""

from __future__ import annotations

import json
import re
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

import yaml
from anthropic import Anthropic
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
CONFIG = yaml.safe_load((ROOT / "scraper" / "config.yaml").read_text())
DATA = ROOT / "docs" / "data"
SAST = timezone(timedelta(hours=2))

client = Anthropic()

EXTRACT_PROMPT = """You are reading the visible text of a South African grocery
retailer's specials / promotions web page ({store}). Pull out every product that
is on promotion.

Return ONLY a JSON array (no prose). One object per product:
{{
  "name": "full product name as shown, incl. brand",
  "size": "pack size e.g. 2L, 1kg, 6 x 330ml, or null",
  "category": one of ["meat & fish","fruit & veg","dairy & eggs","bakery",
      "pantry","frozen","snacks & sweets","drinks","household","personal care",
      "baby","pet","other"],
  "price": promo price in rand as a number (the price you pay without a card),
  "was_price": normal price as a number, or null,
  "loyalty_price": price with the {loyalty} card as a number, or null,
  "promo_text": short deal wording e.g. "Buy 2 for R50", "Save R15", or null,
  "multi_buy": {{"qty": 2, "total": 50}} if it is an "any N for R X" deal, else null,
  "valid_until": "YYYY-MM-DD" if shown, else null
}}

Rules:
- If the only price shown is a card/member price, put it in loyalty_price and
  also in price only if the page says everyone gets it.
- For multi-buys with no single price, set price to total/qty.
- Skip navigation text, banners without a product, and non-food promos unless
  they are household/personal-care groceries.
- Do not invent prices. If unsure of a number, leave the item out.

PAGE TEXT:
{text}
"""

MEALS_PROMPT = """Here are this week's grocery specials at South African
stores (JSON). Suggest 6 practical weeknight dinners for a household in
Cape Town that make the most of these specials. Mix it up (one braai-friendly,
one vegetarian, one quick under 30 min, one slow-cook or oven bake).

Return ONLY a JSON array, one object per meal:
{{
  "title": "...",
  "why": "one sentence on the saving or what's in season",
  "time_minutes": 35,
  "uses": [{{"item": "exact special name", "store": "store key", "price": 0.0}}],
  "also_need": ["pantry items not on special"],
  "method": ["3-6 short steps"]
}}

SPECIALS:
{specials}
"""


def log(msg: str) -> None:
    print(f"[{datetime.now(SAST):%H:%M:%S}] {msg}", flush=True)


# ---------------------------------------------------------------- browsing --

def page_text(browser, url: str, max_rounds: int) -> str:
    """Load a page, dismiss cookie banners, scroll / click 'load more'
    a few times, and return the visible text."""
    ctx = browser.new_context(
        locale="en-ZA",
        timezone_id="Africa/Johannesburg",
        viewport={"width": 1366, "height": 2000},
        user_agent=("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"),
    )
    page = ctx.new_page()
    texts: list[str] = []
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=60_000)
        page.wait_for_timeout(4000)
        for label in ("Accept", "Accept all", "Accept All", "I agree", "Got it", "OK"):
            try:
                page.get_by_role("button", name=label, exact=True).first.click(timeout=1500)
                break
            except Exception:
                pass
        for _ in range(max_rounds):
            page.mouse.wheel(0, 6000)
            page.wait_for_timeout(1500)
            clicked = False
            for label in ("Load more", "Show more", "View more", "Load More"):
                try:
                    page.get_by_text(label, exact=False).first.click(timeout=1500)
                    page.wait_for_timeout(2500)
                    clicked = True
                    break
                except Exception:
                    pass
            if not clicked:
                # try a "next page" link
                try:
                    page.get_by_role("link", name=re.compile(r"^(next|›|»)$", re.I)).first.click(timeout=1500)
                    page.wait_for_timeout(3000)
                    texts.append(page.inner_text("body"))
                except Exception:
                    pass
        texts.append(page.inner_text("body"))
    finally:
        ctx.close()
    # de-duplicate repeated lines across rounds, keep order
    seen, lines = set(), []
    for t in texts:
        for line in t.splitlines():
            line = line.strip()
            if line and line not in seen:
                seen.add(line)
                lines.append(line)
    return "\n".join(lines)


# -------------------------------------------------------------- extraction --

def parse_json_array(text: str) -> list:
    m = re.search(r"\[.*\]", text, re.S)
    if not m:
        return []
    try:
        data = json.loads(m.group(0))
        return data if isinstance(data, list) else []
    except json.JSONDecodeError:
        return []


def ask(model: str, prompt: str, max_tokens: int = 16000) -> str:
    for attempt in range(3):
        try:
            msg = client.messages.create(
                model=model, max_tokens=max_tokens,
                messages=[{"role": "user", "content": prompt}],
            )
            return "".join(b.text for b in msg.content if b.type == "text")
        except Exception as e:  # rate limit / overload: back off and retry
            log(f"  Claude call failed ({e}); retry {attempt + 1}/3")
            time.sleep(10 * (attempt + 1))
    return ""


def chunks(text: str, size: int):
    for i in range(0, len(text), size):
        yield text[i:i + size]


def num(v):
    try:
        return round(float(v), 2) if v is not None else None
    except (TypeError, ValueError):
        return None


def clean(item: dict, store: str) -> dict | None:
    name = (item.get("name") or "").strip()
    price = num(item.get("price"))
    loyalty = num(item.get("loyalty_price"))
    if not name or (price is None and loyalty is None):
        return None
    if price is None:
        price = loyalty
    was = num(item.get("was_price"))
    if was is not None and was <= price:
        was = None
    mb = item.get("multi_buy") if isinstance(item.get("multi_buy"), dict) else None
    return {
        "store": store,
        "name": name,
        "size": item.get("size"),
        "category": item.get("category") or "other",
        "price": price,
        "was_price": was,
        "loyalty_price": loyalty if loyalty is not None and loyalty < price else None,
        "promo_text": item.get("promo_text"),
        "multi_buy": mb,
        "valid_until": item.get("valid_until"),
    }


def fetch_store(browser, key: str, cfg: dict) -> tuple[list, dict]:
    items, status = [], {"name": cfg["name"], "loyalty": cfg.get("loyalty"), "urls": []}
    for url in cfg["urls"]:
        log(f"{key}: opening {url}")
        try:
            text = page_text(browser, url, CONFIG.get("max_pages_per_url", 6))
        except Exception as e:
            log(f"  could not load: {e}")
            status["urls"].append({"url": url, "ok": False, "error": str(e)[:200]})
            continue
        found = 0
        for part in chunks(text, CONFIG.get("max_chars_per_call", 30000)):
            raw = ask(CONFIG["model_extract"], EXTRACT_PROMPT.format(
                store=cfg["name"], loyalty=cfg.get("loyalty") or "loyalty", text=part))
            for it in parse_json_array(raw):
                c = clean(it, key) if isinstance(it, dict) else None
                if c:
                    items.append(c)
                    found += 1
        log(f"  {found} deals")
        status["urls"].append({"url": url, "ok": found > 0, "deals": found})
    # de-duplicate by name + size
    uniq = {}
    for it in items:
        uniq.setdefault((it["name"].lower(), str(it["size"]).lower()), it)
    items = list(uniq.values())
    status["status"] = "ok" if items else "empty"
    status["count"] = len(items)
    return items, status


# ------------------------------------------------------------------ meals --

def make_meals(specials: list) -> list:
    food = [s for s in specials if s["category"] in
            ("meat & fish", "fruit & veg", "dairy & eggs", "bakery", "pantry", "frozen")]
    # favour the biggest discounts so the prompt stays small
    def saving(s):
        base = s["was_price"] or s["price"]
        best = min(x for x in (s["price"], s["loyalty_price"]) if x is not None)
        return (base - best) / base if base else 0
    food.sort(key=saving, reverse=True)
    slim = [{k: s[k] for k in ("store", "name", "size", "category", "price", "loyalty_price")}
            for s in food[:120]]
    if not slim:
        return []
    raw = ask(CONFIG["model_meals"], MEALS_PROMPT.format(specials=json.dumps(slim)), 8000)
    return parse_json_array(raw)


# ------------------------------------------------------------------- main --

def main(only: list[str]) -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    out_path = DATA / "specials.json"
    previous = json.loads(out_path.read_text()) if out_path.exists() else {}
    prev_items = previous.get("items", [])

    retailers = {k: v for k, v in CONFIG["retailers"].items() if not only or k in only}
    all_items, sources = [], {}
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        for key, cfg in retailers.items():
            items, status = fetch_store(browser, key, cfg)
            if not items:
                # keep last week's deals for this store rather than showing nothing
                kept = [i for i in prev_items if i["store"] == key]
                if kept:
                    status["status"] = "stale"
                    status["note"] = "No deals found this run; showing the previous run's deals."
                    items = kept
            all_items.extend(items)
            sources[key] = status
        browser.close()

    # stores not fetched this run (when running a subset) keep their old data
    for key in CONFIG["retailers"]:
        if key not in retailers:
            all_items.extend(i for i in prev_items if i["store"] == key)
            if key in previous.get("sources", {}):
                sources[key] = previous["sources"][key]

    payload = {
        "updated": datetime.now(SAST).isoformat(timespec="minutes"),
        "sources": sources,
        "items": all_items,
    }
    out_path.write_text(json.dumps(payload, indent=1, ensure_ascii=False))
    log(f"saved {len(all_items)} deals to {out_path.relative_to(ROOT)}")

    meals = make_meals(all_items)
    if meals:
        (DATA / "meals.json").write_text(json.dumps(
            {"updated": payload["updated"], "meals": meals}, indent=1, ensure_ascii=False))
        log(f"saved {len(meals)} meal ideas")


if __name__ == "__main__":
    main(sys.argv[1:])
