#!/usr/bin/env node
// Check a course page: it loads without errors, every data binding resolves,
// every chart finds its trace data, every linked trace file exists.
//
//   node lab/harness/check-page.mjs frames.html [--shots DIR]   # optionally a screenshot per step

import { existsSync, mkdirSync } from "node:fs";
import { chromium } from "playwright-core";
import { CHROME, LAB } from "./browser.mjs";

const REPO = LAB + "../";
const page = process.argv[2];
const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : null;
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const p = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const problems = [];
p.on("console", (m) => m.type() === "error" && problems.push("console error: " + m.text().slice(0, 200)));
p.on("pageerror", (e) => problems.push("page error: " + String(e).slice(0, 300)));
await p.goto(`file://${REPO}${page}`);
await p.waitForTimeout(300);
const steps = await p.evaluate(() => document.querySelectorAll(".step").length);
// Show everything, so every chart is drawn.
if (steps) await p.click("#all");
await p.waitForTimeout(1500 + steps * 60);
const report = await p.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll("[data-m]")) if (el.textContent === "—") out.push(`unresolved data-m="${el.dataset.m}"`);
  for (const t of document.querySelectorAll("table.mtable")) for (const td of t.querySelectorAll("td.num")) if (td.textContent === "—") out.push(`empty cell in mtable rows="${t.dataset.rows}" (${td.parentElement.firstChild.textContent})`);
  for (const el of document.querySelectorAll(".lanes")) {
    if (!el.querySelector("svg")) out.push("lane chart not drawn: " + el.dataset.lanes.slice(0, 80));
    else if (el.innerHTML.includes("no data for")) out.push("lane chart without data: " + el.dataset.lanes.slice(0, 80));
    else if (el.querySelectorAll("rect[rx], rect[fill='#1baf7a'], line[stroke-width='1.5'], path").length < 2) out.push("lane chart looks empty (check from/to): " + el.dataset.lanes.slice(0, 120));
  }
  for (const el of document.querySelectorAll(".prof")) if (el.querySelectorAll("tr").length < 2) out.push("empty profile table: " + el.dataset.prof);
  const steps = [...document.querySelectorAll(".step")];
  const noAdd = steps.filter((s) => !s.querySelector("ul.add li")).map((s) => s.dataset.title);
  const words = steps.map((s) => s.innerText.split(/\s+/).length);
  return { out, traces: [...document.querySelectorAll(".tracelink[data-trace]")].map((e) => e.dataset.trace), steps: steps.length, noLedger: noAdd, words: words.reduce((a, b) => a + b, 0), predictions: document.querySelectorAll(".predict").length, charts: document.querySelectorAll(".lanes").length };
});
for (const t of new Set(report.traces)) if (!existsSync(`${REPO}traces/${t}.json.gz`)) report.out.push(`missing trace file traces/${t}.json.gz`);
if (shots) {
  mkdirSync(shots, { recursive: true });
  await p.click("#all"); // back to one step at a time
  for (let i = 1; i <= steps; i++) {
    await p.goto(`file://${REPO}${page}#${i}`);
    await p.waitForTimeout(700);
    await p.screenshot({ path: `${shots}/${page.replace(".html", "")}-${String(i).padStart(2, "0")}.png`, fullPage: true });
  }
}
await browser.close();
console.log(`${page}: ${report.steps} steps, ${report.words} words, ${report.charts} lane charts, ${report.predictions} predictions, ${new Set(report.traces).size} traces linked`);
if (report.noLedger.length) console.log("steps without ledger items:", report.noLedger.join(" | "));
for (const line of [...problems, ...report.out]) console.log("PROBLEM:", line);
console.log(problems.length + report.out.length ? "FAILED" : "OK");
