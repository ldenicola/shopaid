# ShopAid

A phone app for the weekly grocery shop. Twice a week a job on GitHub reads the
specials pages of **Checkers / Shoprite, Pick n Pay, Woolworths and SPAR**,
has Claude pull out every deal (including Xtra Savings, Smart Shopper,
WRewards and SPAR Rewards card prices), and suggests meals built around what's
on promo. The app then shows:

- **My list** – your regular items, each with the cheapest deal this week
- **Deals** – every special, searchable, filterable by store and category
- **Basket** – which single store saves you most on your list, and the cheapest split
- **Meals** – dinner ideas using this week's specials

The app is a plain static site in `docs/` (no build step), hosted free on
GitHub Pages. Your list and loyalty-card settings are kept on your phone.

## Set up (about 10 minutes)

1. **Create the repo.** On github.com → **New repository** → name it
   `shopaid` → *Private* or *Public* → Create. (GitHub Pages on a private repo
   needs a paid plan; public is fine since no personal data is stored in it.)
2. **Upload the files.** Unzip this folder, then either drag everything into
   the repo's *Add file → Upload files* page, or from a terminal:
   ```bash
   cd shopaid
   git init && git add . && git commit -m "First version"
   git branch -M main
   git remote add origin https://github.com/<you>/shopaid.git
   git push -u origin main
   ```
   Note the `.github` folder is hidden on Mac — make sure it's uploaded
   (press Cmd+Shift+. in Finder to show it).
3. **Add your Claude API key.** Repo → *Settings → Secrets and variables →
   Actions → New repository secret*. Name `ANTHROPIC_API_KEY`, value your key
   from console.anthropic.com.
4. **Turn on Pages.** *Settings → Pages* → Source: *Deploy from a branch* →
   Branch `main`, folder `/docs` → Save. The app's address appears there
   after a minute (`https://<you>.github.io/shopaid/`).
5. **Run the first fetch.** *Actions* tab → *ShopAid weekly specials* →
   *Run workflow*. Takes 10–20 minutes. When it finishes, the sample data in
   the app is replaced by real specials.
6. **Add to your home screen.** Open the address on your phone → Share →
   *Add to Home Screen*.

After that it runs by itself every Monday and Thursday at 04:47.

## When a store comes back empty

Retailers change their websites from time to time. The app shows a yellow
note if a store returned no deals (it keeps the previous run's deals meanwhile).
To fix: open that store's specials page in your browser, copy the address,
and replace the URL under that store in `scraper/config.yaml`. You can list
several URLs per store (e.g. separate meat and fresh produce promo pages).

## Matching your list

Tap an item in *My list* to set its match words. Use commas for alternatives;
every word in one alternative must appear in the product name.
`coffee beans, ground coffee` matches either; `full cream milk 2l` won't match
1L bottles. The dialog previews this week's matches as you type.

The basket compares promo prices only; items not on special anywhere are
listed separately. It doesn't yet compare price per kg/litre, so a smaller
pack can look "cheapest".

## Costs

GitHub Actions and Pages are free at this usage. Claude API cost is small:
reading the pages uses Haiku and the meal ideas use Sonnet, roughly a few rand
per run depending on how many pages each store has. Change the models in
`scraper/config.yaml`.

## Files

```
docs/                 the app (GitHub Pages serves this folder)
  index.html, app.js, styles.css
  data/specials.json  written by the weekly job (sample data until first run)
  data/meals.json     written by the weekly job
  data/my-list.json   starter list loaded the first time you open the app
scraper/
  fetch_specials.py   headless browser + Claude extraction
  config.yaml         store URLs, models, limits
.github/workflows/fetch-specials.yml   the schedule
```

Run the fetcher on your own machine:
```bash
pip install -r scraper/requirements.txt
python -m playwright install chromium
export ANTHROPIC_API_KEY=sk-ant-...
python scraper/fetch_specials.py          # all stores
python scraper/fetch_specials.py pnp      # one store
```

This is for personal use: it reads each store's public specials pages twice a
week, much like a person browsing them.
