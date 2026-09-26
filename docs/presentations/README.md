# Vexi Hakari demo presentations

## Six-minute integrated pitch and demo

- [English PowerPoint](Vexi-Hakari-6min-EN.pptx) and [speaker script](Speaker-notes-6min-EN.md)
- [Traditional Chinese PowerPoint](Vexi-Hakari-6min-ZH-TW.pptx) and [speaker script](Speaker-notes-6min-ZH-TW.md)

Each deck has **14 timed slides for six minutes**, followed by **six optional discussion slides**. The Vexi
logo and dark pink/green palette continue the website. Eleven native charts, two native tables, editable
flow diagrams and timed speaker notes explain the options basics, motivation, shared inventory, price
observations, quote refusals, exercise and returns. The fonts are Arial and Arial Unicode MS.

Google Slides import retains the text, tables, diagrams and notes, but converts the data charts to images.
Use the original PowerPoint files above to edit chart data; the Google versions are intended for presenting.

| Time | Slides | Focus |
|---|---|---|
| 0:00–1:05 | 1–3 | Vexi Hakari, options basics, idle collateral and stale quotes |
| 1:05–2:40 | 4–7 | Aqua architecture, promises, inventory guard and exact collateral pull |
| 2:40–4:15 | 8–11 | Hook observations, fixed band, size/premium curves and independent refusals |
| 4:15–4:40 | 12 | Physical exercise, close and premium return |
| 4:40–5:20 | 13 | Website replay: steps 05, 07, 09 and 14 |
| 5:20–6:00 | 14 | Contributions for Aqua/SwapVM and Uniswap v4 |
| Optional | A1–A6 | Settlement, v4 details, Q&A, provenance, historical motivation and reproduction |

Slide 13 links to the [public replay](https://vexi-v1.github.io/vexi-hakari/?lang=en#replay), with the matching
locale in each deck. Open it before presenting. The four static checkpoints remain usable if the browser is
unavailable. Stop after slide 14 for the six-minute version; use A1–A6 only for questions. Local hosting remains
an optional fallback described below.

The supplied *HAKARI Pitch Deck.html* informed the options introduction, motivation, oracle explanation,
partner contribution and discussion pages. Its example amounts are kept distinct from the continuous replay:
the teaching call has a 5 USDG premium, the calculator uses a 400 center and 8 base ask, and the recorded fork
has an approximately 378 USDG reference. The HIMS appendix is historical motivation at different timestamps,
not evidence that the present band prevented that event. Aggregate historical volume, an unverified peak,
old gas measurements and inconsistent total-test counts are omitted. The reproducible website evidence is
one lifecycle plus four independent cases, five tests in total. Current code and documentation determine
mechanism and deployment claims. Private Vexi pricing and risk policy remain outside the deck.

## Three-minute cut

Six slides in two languages, using the Vexi dark palette and original logo:

- [English PowerPoint](Vexi-Hakari-3min-EN.pptx) and [speaker script](Speaker-notes-EN.md)
- [Traditional Chinese PowerPoint](Vexi-Hakari-3min-ZH-TW.pptx) and [speaker script](Speaker-notes-ZH-TW.md)

Both decks contain timed speaker notes and browser actions. Text, flow diagrams and the band chart remain
editable. The chart includes an embedded workbook with its five illustrative data points. The decks use
Helvetica Neue (English) and Arial Unicode MS (Traditional Chinese).

| Time | Slide | Focus |
|---|---|---|
| 0:00–0:15 | 1 | Vexi Hakari |
| 0:15–0:45 | 2 | One wallet, two strategies |
| 0:45–1:15 | 3 | Collateral moves at the fill |
| 1:15–1:55 | 4 | Fixed band and size taper |
| 1:55–2:45 | 5 | Website replay: steps 05, 07, 09 |
| 2:45–3:00 | 6 | Reproducible evidence |

Before presenting, build and serve the [website](../website.md), then keep the replay open at
`http://127.0.0.1:8787/?lang=en#replay` or `http://127.0.0.1:8787/?lang=zh-Hant#replay`.
Slide 5 links to the local replay and allocates roughly 20 seconds for switching and clicking. Its three
checkpoints also serve as a fallback if the browser is unavailable. Rehearse once with the intended language.

The three-minute cut focuses on shared liquidity, collateral pulls and quote refusals. Settlement details and
the four independent adverse fixtures remain in the website for discussion. The band chart uses the illustrative
400 USDG center and 8 USDG base premium; it is distinct from the recorded fork's approximately 378 USDG center.
Source citations, local-fork scope and protocol attribution appear in the speaker notes.
