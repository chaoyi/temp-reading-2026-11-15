One file per course module (`frames.mjs`, `network.mjs`, …), each exporting
`scenarios`: a list of entries shaped like those in `../scenarios.mjs`
(`{ id, asks, query, actions, … }`; `page` defaults to `grid.html`).
`scenarios.mjs` appends them to its own list.
