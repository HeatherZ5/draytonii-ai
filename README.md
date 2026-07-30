# Project Draytonii

A personal dashboard that estimates the prompts, tokens, energy, and CO2
footprint of your ChatGPT, Claude, and Gemini usage, built from the
official data export zip files those platforms let you download.

## What it does

- Simulated login page (any input, or none, logs you in — no real accounts).
- Dashboard with a Day / Week / Month / Year toggle.
- Row 1: Prompts Written, Tokens Inputted, Tokens Outputted (big numbers).
- Row 2: Total CO2 Emissions as a pie chart, one color per assistant.
- Row 3: Estimated Energy, switchable between a numeric breakdown and a pie chart.
- Upload your export zip and the dashboard updates immediately.

## Quick start

```bash
npm install
npm start
```

Then open **http://localhost:3000** in your browser. That's the login page;
click "Log In" (fields are optional) to reach the dashboard.

## Try it instantly with sample data

You don't need your own export to see it working. The `sample-exports/`
folder has three small synthetic zip files (`sample-chatgpt-export.zip`,
`sample-claude-export.zip`, `sample-gemini-takeout.zip`) with made-up
conversations spread across the last several months. Upload any (or all)
of them from the dashboard's upload box.

## Using your real data

**ChatGPT:** Settings -> Data Controls -> Export Data. OpenAI emails you a
link to a zip containing `conversations.json`. Upload that zip as-is.

**Claude:** claude.ai -> Settings -> Account -> Export Data. You'll get a
zip containing `conversations.json`. Upload it as-is.

**Gemini:** Go to [Google Takeout](https://takeout.google.com), deselect
everything, select only **"My Activity"**, then under "All activity data
included" choose **Gemini Apps** only, and export. Upload the resulting
zip as-is (the app looks for `.../Gemini Apps/MyActivity.json` inside it).

All parsing happens locally in your own server process — nothing is
uploaded anywhere except the small per-response calls to the EcoLogits API
described below.

## How the numbers are calculated (read this before trusting the numbers)

This app estimates real-world impact from data the platforms don't fully
provide, so please treat every number as a **directionally useful estimate
for personal awareness**, not a precise measurement:

- **Token counts:** none of the three export formats include real token
  counts, so tokens are approximated from message character length
  (roughly 1 token per 4 characters of English text — a common rule of
  thumb, not an exact tokenizer).
- **Energy & CO2:** each assistant reply is sent to the free, public
  [EcoLogits API](https://ecologits.ai) (`api.ecologits.ai`) with its
  provider, model name, and estimated output token count, and EcoLogits
  returns an energy (kWh) and CO2 (kgCO2eq) estimate based on published
  research into model architecture and datacenter efficiency. If that API
  can't be reached (no internet, network firewall, or an unrecognized
  model name) the app automatically falls back to a much rougher local
  formula so the dashboard still shows something — the dashboard's footer
  tells you how many responses used the live API vs. the fallback.
- **Claude model:** Claude's export doesn't record which model handled
  each message, so the app assumes `claude-3-5-sonnet-20241022` unless a
  `model` field happens to be present.
- **Gemini:** Google Takeout's activity log only records your prompt text
  and a timestamp — not Gemini's reply or which model answered. The app
  estimates prompt tokens from your real prompt text, but assumes a fixed
  average reply length and a default model for the response side. Gemini
  numbers are the least precise of the three.
- **Time windows:** Day/Week/Month/Year are rolling windows anchored to
  the most recent date in your imported data (not necessarily today's
  real-world date), so older exports still show up immediately instead of
  looking empty.

## Project structure

```
server.js                 Express app + API routes
src/parsers/detect.js      Figures out which platform a zip came from
src/parsers/chatgptParser.js
src/parsers/claudeParser.js
src/parsers/geminiParser.js
src/tokenizer.js           Character-based token approximation
src/ecologits.js           EcoLogits API client + local fallback formula
src/aggregator.js          Turns parsed messages into per-day totals
src/periods.js             Builds day/week/month/year views for the dashboard
src/store.js               Simple JSON-file persistence (data/store.json)
public/                    Login page, dashboard page, styles, dashboard JS
sample-exports/            Synthetic sample zips for trying the app out
```

## Notes / ideas for extending it

- Data is stored in a plain JSON file (`data/store.json`) — fine for one
  person on one machine, not meant for multiple concurrent users.
- To wipe all imported data, `POST /api/reset` (e.g. `curl -X POST
  http://localhost:3000/api/reset`).
- `GET /api/ecologits-status` tells you whether your machine can currently
  reach the live EcoLogits API.
- Real login/accounts, a proper database, and richer per-conversation
  drill-down views would all be natural next steps if you want to keep
  building this out.
